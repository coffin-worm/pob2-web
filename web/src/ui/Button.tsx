import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './Button.module.css';

type Variant = 'default' | 'primary' | 'ghost' | 'icon';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

/**
 * One button, four roles.
 *
 * The Lua UI drew every button identically and then tried to signal state
 * with a 0.06 difference in fill, which is why nothing in that toolbar had a
 * hierarchy. Here the variant is the hierarchy: exactly one `primary` per
 * region, `default` for the rest, `ghost` where a button should not look
 * like an object until you reach for it.
 */
export function Button({ variant = 'default', children, ...rest }: Props) {
  return (
    <button className={`${styles.button} ${styles[variant]}`} {...rest}>
      {children}
    </button>
  );
}
