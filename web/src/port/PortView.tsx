import { useEffect, useRef, useState } from 'react';
import { bridge } from '../pob/bridge';
import { useBridgeStore } from '../pob/bridgeStore';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import type { BuildCode, CodeInspection } from '../pob/types';
import { AccountImport } from './AccountImport';
import { sites, type BuildSite } from './sites';
import styles from './PortView.module.css';

/**
 * Getting a build in and out.
 *
 * A build code is base64 of the deflated build XML, so this is PoB's own
 * two transforms in both directions and a code from here opens in the
 * desktop app. Making that work headless meant supplying zlib: the
 * headless wrapper stubs `Deflate` and `Inflate` to return an empty
 * string, which is the kind of failure that produces a build rather than
 * an error. The bridge binds the zlib PoB already ships over those stubs.
 *
 * Nothing here reaches the network. A build-site link is accepted because
 * the code is the last path segment of it and reading that is friendlier
 * than asking someone to trim a URL, but the link is read, never fetched.
 * Fetching one would be sending the user's build off the machine, and that
 * is a decision for them to make explicitly rather than a side effect of
 * pasting.
 */
export function PortView() {
  const buildName = useBridgeStore((s) => s.buildName);
  // 0 before the first snapshot arrives, so the comparison below is
  // always between two numbers.
  const outputRevision = useBridgeStore((s) => s.outputRevision) ?? 0;

  const [paste, setPaste] = useState('');
  const [inspection, setInspection] = useState<CodeInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The code is tagged with the revision it was made from rather than
  // cleared by an effect watching that revision: "this code is for
  // revision N" is the actual fact, and deriving staleness from it during
  // render is both simpler and one less cascading re-render.
  const [exported, setExported] = useState<{ at: number; result: BuildCode } | null>(null);
  const [copied, setCopied] = useState(false);
  const stale = exported !== null && exported.at !== outputRevision;
  const current = stale ? null : exported?.result ?? null;

  const [character, setCharacter] = useState('');
  const [showCharacter, setShowCharacter] = useState(false);

  /** Where an imported code should land, as the desktop's dropdown puts it. */
  const [mode, setMode] = useState<'this' | 'new' | 'compare'>('new');

  /** The build sites, asked for once: the list never changes while running. */
  const [siteList, setSiteList] = useState<BuildSite[]>([]);
  const [shareTo, setShareTo] = useState('');
  const [sharing, setSharing] = useState(false);
  const [shared, setShared] = useState<string | null>(null);
  const [sharedCopied, setSharedCopied] = useState(false);

  /** Which site the pasted text is a link to, when it is a link at all. */
  const [linkSite, setLinkSite] = useState<{ site: string; label: string } | null>(null);
  const [fetching, setFetching] = useState(false);

  const exportBuffs = useBridgeStore((s) => s.exportBuffs) ?? false;
  // Through the store rather than straight at the bridge, so the snapshot
  // the engine answers with lands in the store and the checkbox moves. A
  // direct call changed the build and left the box looking untouched
  // until the next poll came round.
  const setExportBuffs = useBridgeStore((s) => s.setExportBuffs);

  const debounce = useRef<number | undefined>(undefined);

  // One read on arrival. Not a set-state-in-effect: the state lands in a
  // promise callback, after the effect has returned.
  useEffect(() => {
    void sites
      .list()
      .then((result) => {
        setSiteList(result.sites);
        setShareTo(result.sites.find((site) => site.uploads)?.id ?? '');
      })
      .catch(() => {
        // No transport for the sites means no Share button, which the
        // render handles. It is not worth an error banner on arrival.
      });
  }, []);

  const inspect = (value: string) => {
    setPaste(value);
    setError(null);
    setLinkSite(null);
    window.clearTimeout(debounce.current);
    const text = value.trim();
    if (text.length < 8) {
      setInspection(null);
      return;
    }

    // A build code is base64url, which has no dots and no slashes, so
    // anything carrying a host is a link. Links go to the sites transport
    // to be recognised and fetched, which is what the desktop does the
    // moment one is pasted.
    if (/[a-z0-9-]+\.[a-z]{2,}\//i.test(text)) {
      setInspecting(true);
      debounce.current = window.setTimeout(() => {
        void sites
          .recognise(text)
          .then(async (known) => {
            if (!known.site) {
              setInspection({ valid: false, error: 'that is not a build site this knows' });
              return;
            }
            setLinkSite({ site: known.site, label: known.label ?? known.site });
            setFetching(true);
            // The code replaces the link in the box, so what gets imported
            // is visibly the thing that was fetched.
            const { code } = await sites.fetch(text);
            setPaste(code);
            setInspection(await bridge.inspectCode(code));
          })
          .catch((e: unknown) => {
            setInspection({
              valid: false,
              error: e instanceof Error ? e.message : String(e),
            });
          })
          .finally(() => {
            setFetching(false);
            setInspecting(false);
          });
      }, 400);
      return;
    }

    setInspecting(true);
    debounce.current = window.setTimeout(() => {
      void bridge
        .inspectCode(text)
        .then(setInspection)
        .catch(() => setInspection({ valid: false, error: 'the engine could not read that' }))
        .finally(() => setInspecting(false));
    }, 200);
  };

  const doImport = async () => {
    setImporting(true);
    setError(null);
    try {
      const code = paste.trim();
      if (mode === 'this') await bridge.importCodeHere(code);
      else if (mode === 'compare') await bridge.importCodeAsComparison(code);
      else await bridge.importCode(code);
      setPaste('');
      setInspection(null);
      setLinkSite(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  /**
   * Upload the code and get a link back.
   *
   * This publishes the build: the code goes to whichever site is chosen
   * and comes back as a URL anyone can open. Nothing here does it without
   * the button being pressed.
   */
  const doShare = async () => {
    if (!current?.ready || !shareTo) return;
    setSharing(true);
    setShared(null);
    setSharedCopied(false);
    setError(null);
    try {
      const { url } = await sites.share(shareTo, current.code);
      setShared(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSharing(false);
    }
  };

  const doExport = async () => {
    setCopied(false);
    const at = outputRevision;
    try {
      setExported({ at, result: await bridge.buildCode() });
    } catch (e) {
      setExported({
        at,
        result: { ready: false, error: e instanceof Error ? e.message : String(e) },
      });
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard access can be refused; the textarea is still selectable.
      setCopied(false);
    }
  };

  const doCharacter = async () => {
    setImporting(true);
    setError(null);
    try {
      await bridge.importCharacter(character);
      setCharacter('');
      setShowCharacter(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className={styles.view}>
      {/* First, because it is the way in that does not involve copying
          anything by hand. The code box below is the fallback, not the
          headline. */}
      <AccountImport />

      <section className={styles.panel}>
        <h3 className={styles.title}>Import a build</h3>
        <p className={styles.hint}>
          Paste a build code, or a link to one on pobb.in, Maxroll, poe.ninja, poe2db,
          Pastebin or Rentry. A link is recognised and the build fetched from it, the
          same as the desktop app does.
        </p>

        <textarea
          className={styles.code}
          value={paste}
          onChange={(e) => inspect(e.target.value)}
          placeholder="eNqtW1t34jgSfu75FRz2lQ73Wx8ycwghCWdCwgLdvbsvfRRbgCay5bbkJPSv35JkGxtikEjnwbHl..."
          rows={5}
          spellCheck={false}
          aria-label="Build code"
        />

        <div className={styles.actions}>
          {/* PoB's own three, in PoB's own order and words. */}
          <Select
            value={['this', 'new', 'compare'].indexOf(mode)}
            onChange={(id) => setMode((['this', 'new', 'compare'] as const)[id] ?? 'new')}
            options={[
              { id: 0, name: 'Import to this build' },
              { id: 1, name: 'Import to a new build' },
              { id: 2, name: 'Import as comparison' },
            ]}
            aria-label="Where to import"
            width={210}
          />
          <Button
            variant="primary"
            disabled={!inspection?.valid || importing}
            onClick={() => void doImport()}
          >
            {importing ? 'Importing…' : 'Import'}
          </Button>

          {inspecting && (
            <span className={styles.status}>
              {fetching && linkSite ? `fetching from ${linkSite.label}…` : 'reading…'}
            </span>
          )}

          {!inspecting && linkSite && inspection?.valid && (
            <span className={styles.status}>from {linkSite.label}</span>
          )}

          {!inspecting && inspection?.valid && (
            <span className={styles.good}>
              {[inspection.ascendancy ?? inspection.class, inspection.level && `level ${inspection.level}`]
                .filter(Boolean)
                .join(' · ')}
              <span className={styles.sizes}>
                {inspection.codeBytes.toLocaleString()} chars →{' '}
                {inspection.xmlBytes.toLocaleString()} bytes of XML
              </span>
            </span>
          )}

          {!inspecting && inspection && !inspection.valid && (
            <span className={styles.bad}>{inspection.error}</span>
          )}
        </div>

        {/* Importing into this build erases it, which is what PoB warns
            about before doing it. Said here rather than behind a dialog,
            because the button is right next to it, and only for the mode
            that actually does it. */}
        {mode === 'this' && (
          <p className={styles.warn}>
            This replaces {buildName ? <strong>{buildName}</strong> : 'the open build'} entirely,
            keeping its name and its file. Export it first if you want it back.
          </p>
        )}
        {mode === 'new' && (
          <p className={styles.hint}>
            Opens as a new unsaved build. Whatever is open now is left alone, but it is
            not saved either.
          </p>
        )}
        {mode === 'compare' && (
          <p className={styles.hint}>
            Loads beside the build rather than over it, for the Compare view.
          </p>
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

      <section className={styles.panel}>
        <h3 className={styles.title}>Export this build</h3>
        <p className={styles.hint}>
          The same code the desktop app produces, so it opens there and on the build sites.
        </p>

        <div className={styles.actions}>
          <Button onClick={() => void doExport()}>
            {current ? 'Regenerate' : 'Generate a code'}
          </Button>
          {/* PoB's own checkbox, and PoB's own confusing name for it: it
              is a party setting, not an export one. With it on, this
              build's buffs reach whoever imports it as a party member. */}
          <label
            className={styles.check}
            title="Send this build's buffs to anyone who imports it as a party member"
          >
            <input
              type="checkbox"
              checked={exportBuffs}
              onChange={(e) => setExportBuffs(e.target.checked)}
            />
            Export Support
          </label>
          {current?.ready && (
            <>
              <Button variant="primary" onClick={() => void copy(current.code)}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <span className={styles.sizes}>
                {current.xmlBytes.toLocaleString()} bytes of XML →{' '}
                {current.codeBytes.toLocaleString()} chars
              </span>
            </>
          )}
          {current && !current.ready && (
            <span className={styles.bad}>{current.error ?? 'the build would not export'}</span>
          )}
          {stale && (
            <span className={styles.status}>the build changed: generate it again</span>
          )}
        </div>

        {/* Sharing is a separate row because it does something the rest of
            this panel does not: it sends the build somewhere. */}
        {current?.ready && siteList.some((site) => site.uploads) && (
          <div className={styles.actions}>
            <Select
              value={Math.max(
                0,
                siteList.filter((site) => site.uploads).findIndex((site) => site.id === shareTo),
              )}
              onChange={(id) =>
                setShareTo(siteList.filter((site) => site.uploads)[id]?.id ?? '')
              }
              options={siteList
                .filter((site) => site.uploads)
                .map((site, id) => ({ id, name: site.label }))}
              aria-label="Where to share"
            />
            <Button onClick={() => void doShare()} disabled={sharing}>
              {sharing ? 'Uploading…' : 'Share'}
            </Button>
            <span className={styles.status}>
              {shared ? 'uploaded' : 'this uploads the build and gives you a link'}
            </span>
          </div>
        )}

        {shared && (
          <div className={styles.actions}>
            <input
              className={styles.link}
              value={shared}
              readOnly
              onFocus={(e) => e.target.select()}
              aria-label="Shared build link"
            />
            <Button
              variant="primary"
              onClick={() => {
                void navigator.clipboard
                  .writeText(shared)
                  .then(() => setSharedCopied(true))
                  .catch(() => setSharedCopied(false));
              }}
            >
              {sharedCopied ? 'Copied' : 'Copy the link'}
            </Button>
          </div>
        )}

        {current?.ready && (
          <textarea
            className={styles.code}
            value={current.code}
            readOnly
            rows={5}
            spellCheck={false}
            onFocus={(e) => e.target.select()}
            aria-label="Exported build code"
          />
        )}
      </section>

      <section className={styles.panel}>
        <h3 className={styles.title}>
          Import a character by hand
          <button
            className={styles.disclosure}
            onClick={() => setShowCharacter((open) => !open)}
            aria-expanded={showCharacter}
          >
            {showCharacter ? 'Hide' : 'Show'}
          </button>
        </h3>
        <p className={styles.hint}>
          Paste the JSON the game's character API returns, if you already have it: the
          whole response or just the character object inside it, either works. Signing in
          above does the same thing without the copying.
        </p>

        {showCharacter && (
          <>
            <textarea
              className={styles.code}
              value={character}
              onChange={(e) => setCharacter(e.target.value)}
              placeholder={'{ "character": { … }, "items": [ … ] }'}
              rows={5}
              spellCheck={false}
              aria-label="Character JSON"
            />
            <div className={styles.actions}>
              <Button
                variant="primary"
                disabled={!character.trim() || importing}
                onClick={() => void doCharacter()}
              >
                Replace this build
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
