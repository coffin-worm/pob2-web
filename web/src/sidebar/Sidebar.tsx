import { Select } from '../ui/Select';
import { useStatsStore } from '../pob/statsStore';
import type { StatLine } from '../pob/types';
import styles from './Sidebar.module.css';

/**
 * The stat sidebar.
 *
 * Every line here was built by PoB: the filtering (which stats apply to this
 * skill), the formatting (how many decimals, what suffix) and the emphasis
 * are all the engine's, because they are game rules. What this component
 * owns is the typography, the alignment and the palette: the parts that are
 * presentation, and the parts PoB's bitmap renderer could not do well.
 */
function StatRow({ line }: { line: StatLine }) {
  if (line.note) {
    return <div className={styles.note}>{line.label}</div>;
  }

  return (
    <div className={styles.row} data-size={line.size}>
      <span className={styles.label}>{line.label}</span>
      {line.value !== undefined && (
        <span className={styles.value} data-tone={line.tone}>
          {line.value}
        </span>
      )}
    </div>
  );
}

export function Sidebar() {
  const ready = useStatsStore((s) => s.ready);
  const lines = useStatsStore((s) => s.lines);
  const warnings = useStatsStore((s) => s.warnings);
  const socketGroupId = useStatsStore((s) => s.socketGroupId);
  const socketGroups = useStatsStore((s) => s.socketGroups);
  const skillId = useStatsStore((s) => s.skillId);
  const skills = useStatsStore((s) => s.skills);
  const setSocketGroup = useStatsStore((s) => s.setSocketGroup);
  const setMainSkill = useStatsStore((s) => s.setMainSkill);

  return (
    <aside className={styles.sidebar}>
      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Main skill</h2>
        <div className={styles.fields}>
          <Select
            aria-label="Socket group"
            value={socketGroupId}
            options={socketGroups}
            onChange={setSocketGroup}
          />
          <Select
            aria-label="Active skill"
            value={skillId}
            options={skills}
            onChange={setMainSkill}
          />
        </div>
      </div>

      {warnings.length > 0 && (
        <ul className={styles.warnings}>
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}

      {ready && lines.length > 0 ? (
        <div className={styles.stats}>
          {lines.map((line, index) => (
            // Labels repeat across sections (two "Unreserved Spirit" rows in
            // one real build), so the position is the only stable identity.
            <StatRow key={`${index}-${line.label}`} line={line} />
          ))}
        </div>
      ) : (
        <p className={styles.empty}>
          {ready
            ? 'No stats yet. This build has nothing allocated and no skill selected.'
            : 'Waiting for the engine.'}
        </p>
      )}
    </aside>
  );
}
