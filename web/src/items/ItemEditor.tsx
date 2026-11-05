import { useState } from 'react';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import type { ItemEdit } from '../pob/types';
import styles from './ItemEditor.module.css';

/**
 * Changing an item, rather than replacing it.
 *
 * Three things, which between them are what the desktop tab's editor panel
 * is for:
 *
 * - **The modifier rolls.** A unique's "+(30-50) to Evasion Rating" is a
 *   range, and PoB keeps one `rangeLineList` entry per such line with its
 *   position between the bounds. Moving it is the control people actually
 *   use, and the engine recalculates the whole build from it.
 * - **The variant**, for uniques with more than one version.
 * - **The raw text**, which is the escape hatch. A PoB item *is* its text:
 *   it is parsed back from it, so this covers crafting, custom
 *   modifiers, quality and corruption without a control for each.
 *
 * What the item looks like afterwards is not drawn here: that is the panel
 * above, which is PoB's own tooltip.
 *
 * Mounted with the item's text as its key, so moving a roll, which
 * rewrites that text, gives a fresh editor rather than one holding a
 * draft of the item as it used to be. The disclosure is the caller's, so
 * remounting does not close it.
 */
export function ItemEditor({
  edit,
  busy,
  onRange,
  onVariant,
  onText,
}: {
  edit: Extract<ItemEdit, { ready: true }>;
  busy?: boolean;
  onRange: (line: number, range: number) => void;
  onVariant: (variant: number) => void;
  onText: (text: string) => void;
}) {
  const raw = edit.raw ?? '';
  const [draft, setDraft] = useState(raw);
  const dirty = draft !== raw;

  /**
   * Where each slider is while it is being dragged.
   *
   * The engine recalculates the whole build from a roll, so sending every
   * intermediate position would be dozens of full passes for one drag,
   * each one rewriting the item's text and so remounting this editor
   * underneath the pointer. The slider shows the local value and the
   * engine hears about it once, on release.
   *
   * Nothing resets this: the editor is keyed on the item's text, so a
   * committed roll replaces this component outright.
   */
  const [rolls, setRolls] = useState<Record<number, number>>({});
  const commitRoll = (index: number, at: number) => {
    const settled = rolls[index];
    if (settled === undefined || settled === at) return;
    onRange(index, settled);
  };

  return (
        <div className={styles.body}>
          {edit.ranges.length > 0 && (
            <div className={styles.group}>
              <h4 className={styles.heading}>Rolls</h4>
              {edit.ranges.map((range) => {
                const at = rolls[range.index] ?? range.range;
                return (
                  <label key={range.index} className={styles.range}>
                    <span className={styles.rangeLine}>{range.line}</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={at}
                      disabled={busy}
                      aria-label={range.line}
                      // Moving is local; committing is not. Release,
                      // keyboard release and losing focus each end a
                      // gesture, and only then does the engine hear it.
                      onChange={(e) =>
                        setRolls((prev) => ({ ...prev, [range.index]: Number(e.target.value) }))
                      }
                      onPointerUp={() => commitRoll(range.index, range.range)}
                      onKeyUp={() => commitRoll(range.index, range.range)}
                      onBlur={() => commitRoll(range.index, range.range)}
                    />
                    <span className={styles.rangePct}>{Math.round(at * 100)}%</span>
                  </label>
                );
              })}
            </div>
          )}

          {edit.variants.length > 1 && !edit.variantGroups && (
            <div className={styles.group}>
              <h4 className={styles.heading}>Variant</h4>
              <Select
                value={edit.variant ?? 1}
                options={edit.variants.map((v) => ({ id: v.index, name: v.name }))}
                onChange={onVariant}
                disabled={busy}
                aria-label="Item variant"
              />
            </div>
          )}

          {edit.variantGroups && (
            <p className={styles.note}>
              This item picks its variants from several independent groups, which this
              editor does not set yet: the text below still works.
            </p>
          )}

          <div className={styles.group}>
            <h4 className={styles.heading}>
              Text
              <span className={styles.headingHint}>
                the item as PoB stores it; anything valid here is valid in the game
              </span>
            </h4>
            <textarea
              className={styles.raw}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={12}
              spellCheck={false}
              aria-label="Item text"
            />
            <div className={styles.actions}>
              <Button
                variant="primary"
                disabled={busy || !dirty}
                onClick={() => onText(draft)}
              >
                Apply
              </Button>
              <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(raw)}>
                Revert
              </Button>
            </div>
          </div>
        </div>
  );
}
