import type { ItemLine } from '../pob/types';
import styles from './TooltipLines.module.css';

/**
 * PoB's own tooltip, as lines.
 *
 * The engine builds every tooltip the same way: a list of
 * {size, text, block, separatorImage}, where `block` separates the thing
 * itself from whatever comparison follows it. Nothing here interprets the
 * content, only the shape, which is why one renderer covers an item, a
 * socket group, a gem and a slot comparison alike.
 */

/** PoB's tooltip lines, grouped by the block they belong to. */
export function blocksOf(lines: ItemLine[]): ItemLine[][] {
  const blocks: ItemLine[][] = [];
  for (const line of lines) {
    const index = Math.max(1, line.block) - 1;
    (blocks[index] ??= []).push(line);
  }
  return blocks.filter(Boolean);
}

export function Lines({ lines }: { lines: ItemLine[] }) {
  return (
    <>
      {lines.map((line, i) =>
        line.separator ? (
          <hr key={i} className={styles.rule} />
        ) : (
          <div
            key={i}
            className={styles.line}
            data-tone={line.tone}
            data-size={line.size && line.size >= 20 ? 'title' : undefined}
            data-centre={line.centre ? 'true' : undefined}
          >
            {line.text}
          </div>
        ),
      )}
    </>
  );
}
