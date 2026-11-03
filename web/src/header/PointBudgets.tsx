import type { BuildPoints, PointBudget } from '../pob/types';
import styles from './PointBudgets.module.css';

interface Props {
  points: BuildPoints;
}

const SEGMENTS: { key: keyof BuildPoints; label: string; title: string }[] = [
  { key: 'passives', label: 'Passives', title: 'Passive skill points' },
  { key: 'weaponSet1', label: 'Set I', title: 'Weapon set I passive points' },
  { key: 'weaponSet2', label: 'Set II', title: 'Weapon set II passive points' },
  { key: 'ascendancy', label: 'Asc', title: 'Ascendancy points' },
];

/**
 * The four point budgets.
 *
 * This is the number the user watches while speccing a tree, so it gets a
 * label per figure and tabular digits that do not reflow as they count up.
 * Colour appears for one reason only -- over budget -- which is what makes
 * it readable at a glance rather than decorative.
 */
export function PointBudgets({ points }: Props) {
  return (
    <div className={styles.group}>
      {SEGMENTS.map(({ key, label, title }) => {
        const budget: PointBudget = points[key];
        // The engine reports this itself; the comparison is only a fallback
        // for the shape of the data, not a second opinion on the rules.
        const over = budget.over ?? budget.used > budget.max;
        const spent = budget.max > 0 && budget.used === budget.max;

        return (
          <div key={key} className={styles.segment} title={title}>
            <span className={styles.label}>{label}</span>
            <span
              className={styles.value}
              data-over={over || undefined}
              data-spent={spent || undefined}
            >
              {budget.used}
              <span className={styles.slash}>/</span>
              {budget.max}
            </span>
          </div>
        );
      })}
    </div>
  );
}
