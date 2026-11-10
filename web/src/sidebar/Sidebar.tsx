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
        <div className={styles.warningBox} role="status">
          <div className={styles.warningHead}>
            <svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
              <path d="M8 1.5a.9.9 0 0 1 .78.45l6.1 10.6A.9.9 0 0 1 14.1 14H1.9a.9.9 0 0 1-.78-1.45l6.1-10.6A.9.9 0 0 1 8 1.5Zm0 3.6a.75.75 0 0 0-.75.78l.2 3.6a.55.55 0 0 0 1.1 0l.2-3.6A.75.75 0 0 0 8 5.1Zm0 5.6a.85.85 0 1 0 0 1.7.85.85 0 0 0 0-1.7Z" />
            </svg>
            {warnings.length === 1 ? 'The engine raised a warning' : `${warnings.length} warnings`}
          </div>
          <ul className={styles.warnings}>
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
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
