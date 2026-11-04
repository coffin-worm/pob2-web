import { useEffect, useState } from 'react';
import { bridge } from '../pob/bridge';
import { useBridgeStore } from '../pob/bridgeStore';
import { useCompareStore } from '../pob/compareStore';
import { Button } from '../ui/Button';
import type { CompareBuild } from '../pob/types';
import styles from './CompareView.module.css';

/**
 * This build against another.
 *
 * The comparison build is a `CompareEntry`: PoB's own lightweight build
 * wrapper, which loads the XML, creates the tabs and runs the calculation
 * without any of the UI chrome. So the right-hand column is a second full
 * calculation, not a stored snapshot of numbers.
 *
 * This is the one screen where PoB's rules are reproduced rather than
 * called. Every other panel here reads something the engine already built;
 * the side-by-side comparison exists only inside
 * `CompareTab:DrawStatList`, interleaved with the `DrawString` calls that
 * put it on screen, and there is no data-only version. The bridge
 * transcribes that function's sequence and keeps its rules: the stat's
 * own format string, its `condFunc`, its `lowerIsBetter`. Noted in the
 * README as the exception it is.
 */

function Who({ build, tone }: { build?: CompareBuild; tone: 'primary' | 'compare' }) {
  if (!build) return null;
  return (
    <div className={styles.who} data-tone={tone}>
      <span className={styles.whoName}>{build.name || 'Unnamed'}</span>
      <span className={styles.whoMeta}>
        {[build.ascendancy ?? build.class, build.level && `level ${build.level}`]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </div>
  );
}

export function CompareView() {
  const outputRevision = useBridgeStore((s) => s.outputRevision);

  const snapshot = useCompareStore((s) => s.snapshot);
  const loadError = useCompareStore((s) => s.error);
  const busy = useCompareStore((s) => s.busy);
  const refresh = useCompareStore((s) => s.refresh);
  const runCommand = useCompareStore((s) => s.run);

  const [code, setCode] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(false);

  // Both sides are live calculations, so this follows the engine rather
  // than a timer.
  useEffect(() => {
    void refresh();
  }, [outputRevision, refresh]);

  const run = async (work: () => Promise<unknown>) => {
    setRefusal(await runCommand(work));
  };

  if (!snapshot) {
    return <div className={styles.empty}>{loadError ?? 'Asking the engine…'}</div>;
  }

  const rows = snapshot.rows ?? [];
  const changed = rows.filter((row) => row.diff).length;
  const shown = onlyChanged ? rows.filter((row) => row.diff) : rows;

  return (
    <div className={styles.view}>
      <section className={styles.panel}>
        <h3 className={styles.title}>Compare against</h3>

        <div className={styles.actions}>
          <input
            className={styles.field}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Paste a build code, or a link to one"
            aria-label="Build code to compare against"
            spellCheck={false}
          />
          <Button
            variant="primary"
            disabled={busy || !code.trim()}
            onClick={() =>
              void run(async () => {
                await bridge.act('addCompare', { code: code.trim() });
                setCode('');
              })
            }
          >
            Load it
          </Button>
        </div>

        <p className={styles.hint}>
          Each one is a second full calculation, so the right-hand column moves when you
          change its own configuration, not a snapshot of numbers. Export the current
          build on the Import tab to compare it against a later version of itself.
        </p>

        {snapshot.entries.length > 0 && (
          <div className={styles.entries}>
            {snapshot.entries.map((entry) => (
              <div
                key={entry.index}
                className={styles.entry}
                data-active={entry.active ? 'true' : undefined}
              >
                <button
                  className={styles.entryName}
                  disabled={busy || entry.active}
                  onClick={() => void run(() => bridge.act('setCompare', entry.index))}
                >
                  {entry.label}
                  <span className={styles.entryMeta}>
                    {[entry.ascendancy ?? entry.class, entry.level && `level ${entry.level}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </button>
                <button
                  className={styles.remove}
                  disabled={busy}
                  onClick={() => void run(() => bridge.act('removeCompare', entry.index))}
                  aria-label={`Remove ${entry.label}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {refusal && (
        <div className={styles.refusal} role="status">
          {refusal}
          <button className={styles.dismiss} onClick={() => setRefusal(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {snapshot.active === 0 ? (
        <p className={styles.hint}>Nothing loaded to compare against yet.</p>
      ) : (
        <section className={styles.panel}>
          <div className={styles.heads}>
            <span className={styles.statHead}>Stat</span>
            <Who build={snapshot.primary} tone="primary" />
            <Who build={snapshot.compare} tone="compare" />
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={onlyChanged}
                onChange={(e) => setOnlyChanged(e.target.checked)}
              />
              Only what differs
              <span className={styles.count}>
                {changed} of {rows.filter((r) => !r.gap).length}
              </span>
            </label>
          </div>

          <div className={styles.table}>
            {shown.map((row, i) =>
              row.gap ? (
                <div key={`gap-${i}`} className={styles.gap} />
              ) : (
                <div key={row.label ?? i} className={styles.row} data-changed={row.diff ? 'true' : undefined}>
                  <span className={styles.label} data-tone={row.tone}>
                    {row.label}
                  </span>
                  <span className={styles.value}>{row.primary}</span>
                  <span className={styles.value} data-tone="compare">
                    {row.compare}
                  </span>
                  <span
                    className={styles.diff}
                    data-better={row.diff ? String(row.better ?? false) : undefined}
                  >
                    {row.diff}
                    {row.percent !== undefined && (
                      <span className={styles.percent}>
                        {` (${row.percent >= 0 ? '+' : ''}${row.percent.toFixed(1)}%)`}
                      </span>
                    )}
                  </span>
                </div>
              ),
            )}
          </div>
        </section>
      )}
    </div>
  );
}
