import * as RSelect from '@radix-ui/react-select';
import { Check, ChevronDown } from './icons';
import type { NamedOption } from '../pob/types';
import styles from './Select.module.css';

interface Props {
  value: number;
  options: NamedOption[];
  onChange: (id: number) => void;
  /** Rendered inside the trigger, before the value. */
  label?: string;
  disabled?: boolean;
  /** Fixed trigger width; otherwise it sizes to its content. */
  width?: number;
  'aria-label'?: string;
}

/**
 * A dropdown on Radix's Select.
 *
 * Worth the dependency for what it brings rather than what it saves: type-
 * ahead, roving focus, Home/End, Escape, a focus trap and a correctly
 * announced listbox. PoB has well over a hundred dropdowns and its own
 * handles none of that.
 */
export function Select({
  value,
  options,
  onChange,
  label,
  disabled,
  width,
  'aria-label': ariaLabel,
}: Props) {
  const selected = options.find((o) => o.id === value);

  return (
    <RSelect.Root
      value={String(value)}
      onValueChange={(v) => onChange(Number(v))}
      disabled={disabled}
    >
      <RSelect.Trigger
        className={styles.trigger}
        style={width ? { width } : undefined}
        aria-label={ariaLabel ?? label}
      >
        {label && <span className={styles.label}>{label}</span>}
        <span className={styles.value}>
          <RSelect.Value>{selected?.name}</RSelect.Value>
        </span>
        <RSelect.Icon className={styles.chevron}>
          <ChevronDown size={14} />
        </RSelect.Icon>
      </RSelect.Trigger>

      <RSelect.Portal>
        <RSelect.Content
          className={styles.content}
          position="popper"
          sideOffset={4}
        >
          <RSelect.Viewport className={styles.viewport}>
            {options.map((o) => (
              <RSelect.Item key={o.id} value={String(o.id)} className={styles.item}>
                <span className={styles.itemCheck}>
                  <RSelect.ItemIndicator>
                    <Check size={14} />
                  </RSelect.ItemIndicator>
                </span>
                <RSelect.ItemText>{o.name}</RSelect.ItemText>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}
