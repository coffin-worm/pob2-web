import { useState } from 'react';
import type { ItemLine, WhatIf as WhatIfResult } from '../pob/types';
import styles from './WhatIf.module.css';

/**
 * "What would this change?"
 *
 * PoB answers this behind the tooltips on its own checkboxes: it flips the
 * setting, reruns the calculator, compares, and flips back. The lines are
 * the engine's, the same ones the Items tab shows for equipping something.
 *
 * Asked on click rather than on hover. Each one is a full recalculation of
 * the build, and a list of seventy options would otherwise fire one every
 * time the pointer crossed a row.
 */
export function WhatIf({
  label,
  ask,
}: {
  /** What the button describes, for screen readers. */
  label: string;
  ask: () => Promise<WhatIfResult>;
}) {
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (result) {
      setResult(null);
      return;
    }
    setLoading(true);
    try {
      setResult(await ask());
    } catch (e) {
      setResult({ ready: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button
        className={styles.ask}
        onClick={() => void toggle()}
        aria-label={`What would changing ${label} do?`}
        aria-expanded={result !== null}
        title="What would this change?"
      >
        {loading ? '…' : result ? '×' : '±'}
      </button>

      {result && (
        <div className={styles.result}>
          {!result.ready && (
            <p className={styles.note}>{result.error ?? 'The engine could not answer that.'}</p>
          )}
          {result.ready && result.unchanged && (
            <p className={styles.note}>Nothing moves.</p>
          )}
          {result.ready &&
            result.lines.map((line: ItemLine, i: number) =>
              line.separator ? null : (
                <div key={i} className={styles.line} data-tone={line.tone}>
                  {line.text}
                </div>
              ),
            )}
          {result.ready && <p className={styles.cost}>{result.buildMs} ms to work out</p>}
        </div>
      )}
    </>
  );
}
