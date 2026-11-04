import { useRef, useState } from 'react';
import { bridge } from '../pob/bridge';
import { useBridgeStore } from '../pob/bridgeStore';
import { Button } from '../ui/Button';
import type { BuildCode, CodeInspection } from '../pob/types';
import { AccountImport } from './AccountImport';
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

  const debounce = useRef<number | undefined>(undefined);

  const inspect = (value: string) => {
    setPaste(value);
    setError(null);
    window.clearTimeout(debounce.current);
    if (value.trim().length < 8) {
      setInspection(null);
      return;
    }
    setInspecting(true);
    debounce.current = window.setTimeout(() => {
      void bridge
        .inspectCode(value.trim())
        .then(setInspection)
        .catch(() => setInspection({ valid: false, error: 'the engine could not read that' }))
        .finally(() => setInspecting(false));
    }, 200);
  };

  const doImport = async () => {
    setImporting(true);
    setError(null);
    try {
      await bridge.importCode(paste.trim());
      setPaste('');
      setInspection(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
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
          Paste a build code, or a link to one: the code is read out of the link here,
          and the link is never opened.
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
          <Button
            variant="primary"
            disabled={!inspection?.valid || importing}
            onClick={() => void doImport()}
          >
            {importing ? 'Importing…' : 'Replace this build'}
          </Button>

          {inspecting && <span className={styles.status}>reading…</span>}

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

        {/* The import replaces the open build outright, which is what PoB
            warns about before doing it. Said here rather than behind a
            dialog, because the button is right next to it. */}
        <p className={styles.warn}>
          This replaces {buildName ? <strong>{buildName}</strong> : 'the open build'} entirely.
          Export it first if you want it back.
        </p>

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
