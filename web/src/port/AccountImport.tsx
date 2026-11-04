import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../pob/bridge';
import { Button } from '../ui/Button';
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
 * app never sees a password or a token -- the dev server holds the token in
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
      retry ? `${message ?? response.statusText} — try again in ${retry}s` : message ?? response.statusText,
    );
  }
  return parsed as T;
}

export function AccountImport() {
  const [status, setStatus] = useState<Status | null>(null);
  const [characters, setCharacters] = useState<Character[] | null>(null);
  const [listing, setListing] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when the sign-in tab is opened, so the poll knows to watch. */
  const [waiting, setWaiting] = useState(false);

  const poll = useRef<number | undefined>(undefined);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await getJson<Status>('/poe/status');
      setStatus(next);
      // The server reports an error once and clears it, so it is surfaced
      // here rather than left to be fetched again and lost.
      if (next.error) setError(next.error);
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

  // While the sign-in tab is open there is nothing to react to -- the
  // redirect lands on the dev server, not here -- so this asks.
  useEffect(() => {
    if (!waiting) return;
    poll.current = window.setInterval(() => {
      void refreshStatus().then((next) => {
        if (next?.authenticated) void listCharacters();
      });
    }, 2000);
    return () => window.clearInterval(poll.current);
  }, [waiting, refreshStatus, listCharacters]);

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

  const importCharacter = async (name: string) => {
    setImporting(name);
    setError(null);
    try {
      // Fetched as text and forwarded untouched. Reshaping it here would put
      // a second opinion about GGG's schema in the browser, where it would
      // drift from the engine's.
      const response = await fetch(`/poe/character?name=${encodeURIComponent(name)}`, {
        cache: 'no-store',
      });
      const text = await response.text();
      if (!response.ok) {
        const message = (JSON.parse(text) as { error?: string; retryAfter?: number }) ?? {};
        throw new Error(
          message.retryAfter
            ? `${message.error} — try again in ${message.retryAfter}s`
            : message.error ?? response.statusText,
        );
      }
      await bridge.importCharacter(text);
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
            happens on their site — this app never sees your password, and the token stays
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
            It identifies itself as PoB because it is a build of PoB — the OAuth client
            id is PoB's registered one.
          </p>
        </>
      )}

      {signedIn && (
        <>
          <p className={styles.hint}>
            Signed in. Importing a character replaces the open build, the same as the
            desktop app's import does.
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
            <ul className={styles.list}>
              {characters.map((char) => (
                <li key={char.name} className={styles.row}>
                  <span className={styles.name}>{char.name}</span>
                  <span className={styles.meta}>
                    {[
                      `level ${char.level}`,
                      char.class,
                      char.league,
                      // Worth marking: these import fine but are not what
                      // someone usually means by "my character".
                      char.expired && 'expired',
                      char.deleted && 'deleted',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <Button
                    variant="primary"
                    disabled={importing !== null}
                    onClick={() => void importCharacter(char.name)}
                  >
                    {importing === char.name ? 'Importing…' : 'Import'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {error && (
        <div className={styles.error} role="status">
          {error}
          <button className={styles.dismiss} onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
    </section>
  );
}
