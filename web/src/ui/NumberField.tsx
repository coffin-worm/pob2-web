import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from './icons';
import styles from './NumberField.module.css';

interface Props {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  label?: string;
  disabled?: boolean;
  width?: number;
  /** For fields whose meaning is carried by a neighbouring column rather
   * than by a visible label of their own. */
  'aria-label'?: string;
}

/**
 * A number field whose steppers stay out of the way.
 *
 * The Lua version put two permanent 20px buttons inside a 24px field, which
 * left the value fighting them for room and the buttons crowding the field's
 * own border. Here the primary interaction is typing, arrow keys step by one
 * (ten with Shift), and the steppers only appear on hover or focus, so the
 * resting state is just the number.
 */
export function NumberField({
  value,
  min,
  max,
  onChange,
  label,
  disabled,
  width,
  'aria-label': ariaLabel,
}: Props) {
  // Held as text while editing so a half-typed value does not get clamped
  // out from under the caret: typing "100" would otherwise snap at "1".
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const clamp = (n: number) => Math.max(min, Math.min(max, n));

  const commit = (raw: string) => {
    const n = parseInt(raw, 10);
    const next = Number.isNaN(n) ? value : clamp(n);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  const step = (delta: number) => {
    const next = clamp(value + delta);
    setDraft(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <div
      className={styles.field}
      data-disabled={disabled || undefined}
      style={width ? { width } : undefined}
    >
      {label && <span className={styles.label}>{label}</span>}
      <input
        className={styles.input}
        value={draft}
        disabled={disabled}
        inputMode="numeric"
        aria-label={ariaLabel ?? label}
        onFocus={(e) => {
          focused.current = true;
          e.target.select();
        }}
        onBlur={() => {
          focused.current = false;
          commit(draft);
        }}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            step(e.shiftKey ? 10 : 1);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            step(e.shiftKey ? -10 : -1);
          } else if (e.key === 'Enter') {
            commit(draft);
          }
        }}
      />
      <div className={styles.steppers}>
        <button
          className={styles.stepper}
          disabled={disabled || value >= max}
          onClick={() => step(1)}
          tabIndex={-1}
          aria-label="Increase"
        >
          <ChevronUp size={12} />
        </button>
        <button
          className={styles.stepper}
          disabled={disabled || value <= min}
          onClick={() => step(-1)}
          tabIndex={-1}
          aria-label="Decrease"
        >
          <ChevronDown size={12} />
        </button>
      </div>
    </div>
  );
}
