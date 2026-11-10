import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bridge } from '../pob/bridge';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import styles from './AccountImport.module.css';

/**
 * Import a character from your pathofexile.com account.
 *
 * The desktop app's import tab does this, and none of it survives the
 * headless host: `LaunchSubScript` and `OpenURL` are empty stubs, and
 * `launch:DownloadPage` is a Lua source string handed to the first of them.
 * So the OAuth dance and the two API calls happen in the dev server
 * (`web/plugins/poe-account.ts`), which has TLS and sockets already.
 *
 * What does *not* move is the import. The character JSON goes to the
 * bridge's `POST /code/character` exactly as GGG sent it, and PoB's own
 * `ImportItemsAndSkills` and `ImportPassiveTreeAndJewels` read it. The same
 * rule as everywhere else here: read what PoB computed, write by calling
 * PoB's own code.
 *
 * Signing in is a plain link, not a scripted navigation. The credentials are
 * typed on GGG's page, the tab is opened by the user's own click, and this
 * app never sees a password or a token: the dev server holds the token in
 * memory and tells the browser only whether there is one.
 */

interface Character {
  name: string;
  class: string;
  level: number;
  league: string | null;
  current: boolean;
  expired: boolean;
  deleted: boolean;
}

interface Status {
  authenticated: boolean;
  signInPending: boolean;
  expiresAt: number | null;
  error: string | null;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: 'no-store' });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${url} did not return JSON`);
  }
  if (!response.ok) {
    const message = (parsed as { error?: string } | null)?.error;
    const retry = (parsed as { retryAfter?: number } | null)?.retryAfter;
    throw new Error(
      retry ? `${message ?? response.statusText}, try again in ${retry}s` : message ?? response.statusText,
    );
  }
  return parsed as T;
}

export function AccountImport() {
  const [status, setStatus] = useState<Status | null>(null);
  const [characters, setCharacters] = useState<Character[] | null>(null);
  const [listing, setListing] = useState(false);
  const [importing, setImporting] = useState<'tree' | 'items' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when the sign-in tab is opened, so the poll knows to watch. */
  const [waiting, setWaiting] = useState(false);
  /** The sign-in URL, once asked for, to paste into another browser. */
  const [linkCopied, setLinkCopied] = useState(false);

  /** Which character the two import buttons act on. */
  const [selected, setSelected] = useState('');
  /** A league to narrow the list by, or everything. */
  const [league, setLeague] = useState('');
  /** What the last import brought in, so the panel can say so. */
  const [imported, setImported] = useState<'tree' | 'items' | null>(null);

  // PoB's own four checkboxes, at PoB's own defaults. Three delete what is
  // there before importing, which is what makes an import an import rather
  // than a merge; the fourth is off because most builds have no weapon
  // swap and leaving it on would silently drop one that did.
  const [deleteJewels, setDeleteJewels] = useState(true);
  const [deleteSkills, setDeleteSkills] = useState(true);
  const [deleteEquipment, setDeleteEquipment] = useState(true);
  const [ignoreWeaponSwap, setIgnoreWeaponSwap] = useState(false);

  const poll = useRef<number | undefined>(undefined);
  /**
   * The error text the user has already dismissed.
   *
   * The server keeps reporting its last failure until the next sign-in:
   * clearing it on read made it unreadable, since a poll would eat it,
   * so dismissing has to be remembered here, or the next poll two seconds
   * later puts it straight back.
   */
  const dismissed = useRef<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await getJson<Status>('/poe/status');
      setStatus(next);
      if (next.error && next.error !== dismissed.current) setError(next.error);
      if (next.authenticated || next.error) setWaiting(false);
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, []);

  const listCharacters = useCallback(async () => {
    setListing(true);
    setError(null);
    try {
      const result = await getJson<{ characters: Character[] }>('/poe/characters');
      setCharacters(result.characters);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setListing(false);
    }
  }, []);

  // One status read on mount. Not a set-state-in-effect: the state lands in
  // a promise callback, after the effect has returned.
  useEffect(() => {
    void refreshStatus().then((next) => {
      if (next?.authenticated) void listCharacters();
    });
  }, [refreshStatus, listCharacters]);

  // While the sign-in tab is open there is nothing to react to (the
  // redirect lands on the dev server, not here) so this asks.
  useEffect(() => {
    if (!waiting) return;
    poll.current = window.setInterval(() => {
      void refreshStatus().then((next) => {
        if (next?.authenticated) void listCharacters();
      });
    }, 2000);
    return () => window.clearInterval(poll.current);
  }, [waiting, refreshStatus, listCharacters]);

  /**
   * Put the sign-in URL on the clipboard instead of following it.
   *
   * The browser showing this page is not always one that can complete a
   * sign-in: an embedded or automated browser loops Cloudflare's challenge
   * indefinitely, with no way through and nothing saying why. The redirect
   * comes back to a loopback port, so any browser on the machine can
   * finish the job and this one will see the result.
   */
  const copySignInLink = async () => {
    setError(null);
    try {
      const { authUrl } = await getJson<{ authUrl: string }>('/poe/signin?format=json');
      await navigator.clipboard.writeText(authUrl);
      setLinkCopied(true);
      setWaiting(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const signOut = async () => {
    setError(null);
    try {
      await getJson('/poe/signout', { method: 'POST' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setCharacters(null);
    setWaiting(false);
    void refreshStatus();
  };

  /** Every league the account has a character in, newest list first. */
  const leagues = useMemo(() => {
    const seen = new Set<string>();
    for (const char of characters ?? []) if (char.league) seen.add(char.league);
    return ['', ...[...seen].sort()];
  }, [characters]);

  const shown = useMemo(
    () => (characters ?? []).filter((char) => !league || char.league === league),
    [characters, league],
  );

  /**
   * The character the buttons act on.
   *
   * Derived rather than kept in sync: `selected` is only an override, and
   * falling back to the first of the list means changing the league filter
   * cannot leave a character selected that is no longer on screen.
   */
  const current = shown.find((char) => char.name === selected) ?? shown[0];

  /**
   * Import one half of the chosen character, as the desktop's two buttons do.
   *
   * Separate halves because they answer separate questions: a respec means
   * re-importing the tree and keeping the gear, a trade means the other way
   * round. Importing both at once is two clicks, which is what the desktop
   * asks for too.
   *
   * The character JSON is fetched as text and forwarded untouched.
   * Reshaping it here would put a second opinion about GGG's schema in the
   * browser, where it would drift from the engine's.
   */
  const importPart = async (part: 'tree' | 'items') => {
    if (!current) return;
    setImporting(part);
    setError(null);
    setImported(null);
    try {
      const response = await fetch(`/poe/character?name=${encodeURIComponent(current.name)}`, {
        cache: 'no-store',
      });
      const text = await response.text();
      if (!response.ok) {
        const message = (JSON.parse(text) as { error?: string; retryAfter?: number }) ?? {};
        throw new Error(
          message.retryAfter
            ? `${message.error}, try again in ${message.retryAfter}s`
            : message.error ?? response.statusText,
        );
      }
      await bridge.importCharacterInto(text, {
        tree: part === 'tree',
        items: part === 'items',
        deleteJewels,
        deleteSkills,
        deleteEquipment,
        ignoreWeaponSwap,
      });
      setImported(part);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(null);
    }
  };

  const signedIn = status?.authenticated ?? false;

  return (
    <section className={styles.panel}>
      <h3 className={styles.title}>Import from your account</h3>

      {!signedIn && (
        <>
          <p className={styles.hint}>
            Sign in at pathofexile.com and your characters are listed here. The sign-in
            happens on their site: this app never sees your password, and the token stays
            in the dev server's memory rather than on disk or in the browser.
          </p>
          <div className={styles.actions}>
            {/* A real link, so the navigation is the user's own click. The
                route it hits sets up PKCE and redirects to GGG. */}
            <a
              className={styles.signIn}
              href="/poe/signin"
              target="_blank"
              rel="noreferrer"
              onClick={() => {
                setError(null);
                setWaiting(true);
              }}
            >
              Sign in at pathofexile.com
            </a>
            <Button onClick={() => void copySignInLink()}>
              {linkCopied ? 'Link copied' : 'Copy the link instead'}
            </Button>
            {waiting && (
              <span className={styles.status}>
                waiting for the sign-in tab…
                <button className={styles.dismiss} onClick={() => setWaiting(false)}>
                  stop waiting
                </button>
              </span>
            )}
          </div>
          <p className={styles.note}>
            Asks for the scopes PoB asks for: profile, leagues, characters, trade.
            It identifies itself as PoB because it is a build of PoB: the OAuth client
            id is PoB's registered one.
          </p>
          <p className={styles.note}>
            If the sign-in page gets stuck on “verify you are human”, copy the link and
            open it in an ordinary browser window: embedded ones loop that check
            forever. It comes back to this app either way.
          </p>
        </>
      )}

      {signedIn && (
        <>
          <p className={styles.hint}>
            Signed in. These import into the build you have open, the same as the
            desktop app: the tree and the gear are separate imports, so bringing one
            over again keeps the other.
          </p>
          <div className={styles.actions}>
            <Button onClick={() => void listCharacters()} disabled={listing}>
              {listing ? 'Loading…' : characters ? 'Refresh' : 'List my characters'}
            </Button>
            <Button onClick={() => void signOut()}>Sign out</Button>
          </div>

          {characters && characters.length === 0 && (
            <p className={styles.note}>The account has no PoE 2 characters.</p>
          )}

          {characters && characters.length > 0 && (
            <>
              <div className={styles.choose}>
                <Select
                  label="League"
                  value={Math.max(0, leagues.indexOf(league))}
                  onChange={(id) => setLeague(leagues[id] ?? '')}
                  options={leagues.map((name, id) => ({
                    id,
                    name: name || 'Every league',
                  }))}
                  aria-label="League"
                />
                <Select
                  label="Character"
                  value={Math.max(0, shown.findIndex((char) => char.name === current?.name))}
                  onChange={(id) => setSelected(shown[id]?.name ?? '')}
                  options={shown.map((char, id) => ({
                    id,
                    name:
                      `${char.name} — ${char.class} lvl ${char.level}` +
                      // Worth marking: these import fine, but they are not
                      // what somebody usually means by "my character".
                      (char.expired ? ' (expired)' : '') +
                      (char.deleted ? ' (deleted)' : ''),
                  }))}
                  aria-label="Character"
                  width={340}
                />
              </div>

              <div className={styles.importRow}>
                <span className={styles.importLabel}>Import:</span>
                <Button
                  variant="primary"
                  disabled={!current || importing !== null}
                  onClick={() => void importPart('tree')}
                >
                  {importing === 'tree' ? 'Importing…' : 'Passive Tree and Jewels'}
                </Button>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={deleteJewels}
                    onChange={(e) => setDeleteJewels(e.target.checked)}
                  />
                  Delete jewels
                </label>
              </div>

              <div className={styles.importRow}>
                <span className={styles.importLabel} />
                <Button
                  variant="primary"
                  disabled={!current || importing !== null}
                  onClick={() => void importPart('items')}
                >
                  {importing === 'items' ? 'Importing…' : 'Items and Skills'}
                </Button>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={deleteSkills}
                    onChange={(e) => setDeleteSkills(e.target.checked)}
                  />
                  Delete skills
                </label>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={deleteEquipment}
                    onChange={(e) => setDeleteEquipment(e.target.checked)}
                  />
                  Delete equipment
                </label>
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={ignoreWeaponSwap}
                    onChange={(e) => setIgnoreWeaponSwap(e.target.checked)}
                  />
                  Ignore weapon swap
                </label>
              </div>

              {imported && (
                <p className={styles.status}>
                  {imported === 'tree'
                    ? 'Passive tree and jewels imported.'
                    : 'Items and skills imported.'}
                </p>
              )}
            </>
          )}
        </>
      )}

      {error && (
        <div className={styles.error} role="status">
          {error}
          <button
            className={styles.dismiss}
            onClick={() => {
              dismissed.current = error;
              setError(null);
            }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
    </section>
  );
}
