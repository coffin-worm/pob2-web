import styles from './Segmented.module.css';

interface Props<T extends string | number> {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
  'aria-label'?: string;
}

/**
 * A small set of mutually exclusive choices, shown all at once.
 *
 * PoB uses a button that cycles its own label for these, "Auto" that you
 * click to get "Manual", so the control shows the current state and the
 * available one in the same place and you cannot tell which it is. Laying
 * the options out side by side costs a few pixels and removes the question.
 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  'aria-label': ariaLabel,
}: Props<T>) {
  return (
    <div className={styles.group} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={styles.segment}
          data-selected={o.value === value || undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
