import { useEffect, useRef } from 'react';
import { Select } from '../ui/Select';
import { useCalcsStore } from '../pob/calcsStore';
import type { CalcBreakdownPart, CalcRow, CalcSection, CalcSubSection } from '../pob/types';
import styles from './CalcsView.module.css';

/**
 * The Calcs tab.
 *
 * Thirty sections of calculation breakdown, of which the selected skill
 * decides about twenty. Every row's visibility and every value is the
 * engine's: `CalcsTab:CheckFlag` decides what applies to this skill, and
 * `formatCalcStr` resolves templates like `{2:output:Speed}`. Nothing here
 * knows what a modifier is.
 *
 * The one thing this file decides is shape. A damage section is a matrix:
 * damage types across, modifiers down, while most sections are plain
 * label/value pairs, and a row with an empty label is the column header for
 * the rows beneath it.
 */
function Row({
  row,
  columns,
  header,
  openRef,
  onAsk,
}: {
  row: CalcRow;
  columns: number;
  header: boolean;
  openRef: string | null;
  onAsk: (ref: string, label: string, value: string) => void;
}) {
  return (
    <div
      className={header ? `${styles.row} ${styles.headerRow}` : styles.row}
      data-cols={columns}
      style={
        columns > 1
          ? { gridTemplateColumns: `minmax(0, 1.3fr) repeat(${columns}, minmax(0, 1fr))` }
          : undefined
      }
    >
      <span className={styles.rowLabel}>{row.label}</span>
      {row.values.map((value, i) => {
        const ref = row.refs?.[i];
        // Only a cell the engine can explain is clickable. Most cannot be,
        // so making every cell look interactive would be a lie about
        // three quarters of the screen.
        return ref ? (
          <button
            key={i}
            type="button"
            className={`${styles.cell} ${styles.askable}`}
            data-tone={row.tones?.[i]}
            data-open={openRef === ref ? 'true' : undefined}
            onClick={() => void onAsk(ref, row.label, value)}
            title="Where does this number come from?"
          >
            {value}
          </button>
        ) : (
          <span key={i} className={styles.cell} data-tone={row.tones?.[i]}>
            {value}
          </span>
        );
      })}
    </div>
  );
}

function SubSection({
  sub,
  openRef,
  onAsk,
}: {
  sub: CalcSubSection;
  openRef: string | null;
  onAsk: (ref: string, label: string, value: string) => void;
}) {
  const columns = sub.rows.reduce((max, row) => Math.max(max, row.values.length), 1);
  // PoB emits the column names as a leading row with no label of its own.
  const hasHeader = sub.rows.length > 0 && sub.rows[0].label === '';

  return (
    <div className={styles.subSection}>
      <div className={styles.subHeader}>
        <h3 className={styles.subTitle}>{sub.label}</h3>
        {sub.extra && <span className={styles.extra}>{sub.extra}</span>}
      </div>
      <div className={styles.table}>
        {sub.rows.map((row, i) => (
          <Row
            key={`${i}-${row.label}`}
            row={row}
            columns={columns}
            header={hasHeader && i === 0}
            openRef={openRef}
            onAsk={onAsk}
          />
        ))}
      </div>
    </div>
  );
}

/** One part of the working: PoB's text lines, its tables, its radius. */
function Part({ part }: { part: CalcBreakdownPart }) {
  if (part.type === 'text') {
    return (
      <div className={styles.bkText}>
        {part.lines.map((line, i) => (
          <div key={i} className={styles.bkLine} data-tone={line.tone}>
            {line.text}
          </div>
        ))}
      </div>
    );
  }

  if (part.type === 'radius') {
    return (
      <p className={styles.bkNote}>
        Radius {part.radius}. The desktop app draws this one to scale.
      </p>
    );
  }

  return (
    <div className={styles.bkTable}>
      {part.label && <h4 className={styles.bkTableLabel}>{part.label}</h4>}
      <div
        className={styles.bkGrid}
        style={{ gridTemplateColumns: `repeat(${part.cols.length}, auto)` }}
      >
        {part.cols.map((col) => (
          <span key={col.key} className={styles.bkHead} data-right={col.right ? 'true' : undefined}>
            {col.label}
          </span>
        ))}
        {part.rows.map((row, r) =>
          row.map((cell, c) => (
            <span
              key={`${r}-${c}`}
              className={styles.bkCell}
              data-tone={cell.tone}
              data-right={part.cols[c]?.right ? 'true' : undefined}
            >
              {cell.text}
            </span>
          )),
        )}
      </div>
      {part.footer && <p className={styles.bkFooter}>{part.footer}</p>}
    </div>
  );
}

export function CalcsView() {
  const ready = useCalcsStore((s) => s.ready);
  const sections = useCalcsStore((s) => s.sections);
  const rowCount = useCalcsStore((s) => s.rowCount);
  const buildMs = useCalcsStore((s) => s.buildMs);
  const selector = useCalcsStore((s) => s.selector);
  const setSocketGroup = useCalcsStore((s) => s.setSocketGroup);
  const setSkill = useCalcsStore((s) => s.setSkill);
  const opened = useCalcsStore((s) => s.opened);
  const breakdown = useCalcsStore((s) => s.breakdown);
  const breakdownLoading = useCalcsStore((s) => s.breakdownLoading);
  const openBreakdown = useCalcsStore((s) => s.openBreakdown);
  const closeBreakdown = useCalcsStore((s) => s.closeBreakdown);

  const panelRef = useRef<HTMLElement>(null);

  // Beside the board there is nothing to do: the panel is sticky and
  // already in view. Stacked below it, which is what happens when there
  // is no room for two columns, the answer lands thousands of pixels
  // down and clicking a cell appears to do nothing at all. Only on a
  // change of cell, so it does not yank the page while you read.
  useEffect(() => {
    const el = panelRef.current;
    if (!opened || !el) return;
    if (getComputedStyle(el).position === 'sticky') return;
    // Instant rather than animated. A smooth scroll is a no-op in the
    // app's own browser pane, which is where this gets looked at, and
    // 3700px of animation is not what you want after clicking a cell
    // anyway: you asked a question and the answer should be there.
    el.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  }, [opened]);

  if (!ready) {
    return <p className={styles.empty}>Waiting for the engine.</p>;
  }

  // PoB asks for three columns for the damage matrices and one for the rest.
  // The wide ones get a grid of their own, because a multi-column board
  // cannot span part of itself.
  const wide = sections.filter((s) => s.width > 1);
  const narrow = sections.filter((s) => s.width <= 1);

  const ask = (ref: string, label: string, value: string) =>
    void openBreakdown(ref, label, value);

  const card = (section: CalcSection) => (
    <section key={section.id} className={styles.section} data-tone={section.tone}>
      {section.subSections.map((sub, i) => (
        <SubSection
          key={`${i}-${sub.label}`}
          sub={sub}
          openRef={opened?.ref ?? null}
          onAsk={ask}
        />
      ))}
    </section>
  );

  return (
    <div className={styles.view}>
      {selector && (
        <div className={styles.toolbar}>
          {/* Deliberately not the sidebar's main skill. PoB keeps the two
              apart: the sidebar always reports Effective DPS for the main
              skill, while this tab details whichever skill you point it at. */}
          <span className={styles.toolbarLabel}>Detailing</span>
          <Select
            aria-label="Calcs socket group"
            value={selector.socketGroupId}
            options={selector.socketGroups}
            onChange={setSocketGroup}
            width={200}
          />
          <Select
            aria-label="Calcs active skill"
            value={selector.skillId}
            options={selector.skills}
            onChange={setSkill}
            width={200}
          />
          <span className={styles.count}>
            {sections.length} sections · {rowCount} rows · built in {buildMs}ms
          </span>
        </div>
      )}

      <div className={styles.body} data-open={opened ? 'true' : undefined}>
        <div className={styles.boards}>
          {wide.length > 0 && <div className={styles.wideBoard}>{wide.map(card)}</div>}
          <div className={styles.board}>{narrow.map(card)}</div>
        </div>

        {/* Docked rather than floating over the cell it explains. PoB's
            pane can be dragged out of the way; this one never needs to
            be, because it never covers anything. */}
        {opened && (
          <aside className={styles.breakdown} ref={panelRef}>
            <div className={styles.bkHeader}>
              <div>
                <h3 className={styles.bkTitle}>{opened.label || 'This number'}</h3>
                <p className={styles.bkValue}>{opened.value}</p>
              </div>
              <button
                className={styles.bkClose}
                onClick={closeBreakdown}
                aria-label="Close the breakdown"
              >
                ×
              </button>
            </div>

            {breakdownLoading && !breakdown && <p className={styles.bkNote}>Working it out…</p>}
            {breakdown && !breakdown.ready && (
              <p className={styles.bkNote}>{breakdown.error ?? 'The engine could not answer that.'}</p>
            )}
            {breakdown?.ready && breakdown.empty && (
              <p className={styles.bkNote}>
                Nothing to show: every part of this cell's working is gated on a flag the
                current skill does not set.
              </p>
            )}
            {breakdown?.ready &&
              breakdown.sections.map((part, i) => <Part key={i} part={part} />)}
            {breakdown?.ready && !breakdown.empty && (
              <p className={styles.bkCost}>{breakdown.buildMs} ms to read</p>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
