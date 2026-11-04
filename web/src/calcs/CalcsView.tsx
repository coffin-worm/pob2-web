import { Select } from '../ui/Select';
import { useCalcsStore } from '../pob/calcsStore';
import type { CalcRow, CalcSection, CalcSubSection } from '../pob/types';
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
function Row({ row, columns, header }: { row: CalcRow; columns: number; header: boolean }) {
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
      {row.values.map((value, i) => (
        <span key={i} className={styles.cell} data-tone={row.tones?.[i]}>
          {value}
        </span>
      ))}
    </div>
  );
}

function SubSection({ sub }: { sub: CalcSubSection }) {
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
          />
        ))}
      </div>
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

  if (!ready) {
    return <p className={styles.empty}>Waiting for the engine.</p>;
  }

  // PoB asks for three columns for the damage matrices and one for the rest.
  // The wide ones get a grid of their own, because a multi-column board
  // cannot span part of itself.
  const wide = sections.filter((s) => s.width > 1);
  const narrow = sections.filter((s) => s.width <= 1);

  const card = (section: CalcSection) => (
    <section key={section.id} className={styles.section} data-tone={section.tone}>
      {section.subSections.map((sub, i) => (
        <SubSection key={`${i}-${sub.label}`} sub={sub} />
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

      {wide.length > 0 && <div className={styles.wideBoard}>{wide.map(card)}</div>}
      <div className={styles.board}>{narrow.map(card)}</div>
    </div>
  );
}
