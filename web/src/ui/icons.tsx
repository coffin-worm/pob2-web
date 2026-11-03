/**
 * Line icons, drawn on a 16px grid with a 1.5px stroke.
 *
 * The Lua UI used a filled triangle for every dropdown and `<<` for back,
 * which is most of what reads as dated before you even get to the typeface.
 * These inherit `currentColor` so a control's own state drives them.
 */

interface IconProps {
  size?: number;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export const ChevronDown = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 6.5 8 10.5 12 6.5" />
  </svg>
);

export const ChevronUp = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 9.5 8 5.5 12 9.5" />
  </svg>
);

export const ArrowLeft = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12.5 8H3.5" />
    <path d="M7 3.5 3.5 8 7 12.5" />
  </svg>
);

export const Check = ({ size = 16 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
  </svg>
);
