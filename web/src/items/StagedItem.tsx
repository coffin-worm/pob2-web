import { Button } from '../ui/Button';
import { Lines, blocksOf } from './TooltipLines';
import type { StagedItem as Staged, StagedSlot } from '../pob/types';
import styles from './StagedItem.module.css';

/**
 * The item on the bench.
 *
 * This is the desktop tab's working loop, and it was the one thing this
 * screen did not have. Pasting used to equip on arrival, so finding out
 * whether an item was an upgrade meant equipping it, reading the sidebar,
 * and unequipping it again: three steps, the middle one against a build
 * that had already changed, and an interruption anywhere in the sequence
 * leaving the build wrong.
 *
 * PoB keeps a pasted item as `displayItem` and equips nothing until told
 * to. Its tooltip then answers "what would this do here?" one slot at a
 * time, on hover. A web UI has room for a list where the desktop had a
 * tooltip and a mouse, so every candidate slot is answered at once.
 *
 * The order of those slots is the engine's and it carries meaning: an
 * empty slot first, then the slot holding whatever this item is an
 * alternative to, then by what the build would actually do. The top row is
 * the one worth reading, which is the whole point of sorting it.
 */

/** Resulting values, not deltas: the numbers the ordering turns on. */
const round = (n: number) =>
  n >= 100 ? Math.round(n).toLocaleString() : (Math.round(n * 10) / 10).toLocaleString();

function SlotRow({
  slot,
  busy,
  onEquip,
}: {
  slot: StagedSlot;
  busy: boolean;
  onEquip: () => void;
}) {
  const compare = slot.compare;

  // Why this slot is where it is in the list. PoB sorts by these and then
  // says nothing about it; saying it is most of what makes the order
  // readable rather than arbitrary.
  const badges: { label: string; title: string }[] = [];
  if (slot.empty) {
    badges.push({ label: 'empty', title: 'Nothing is in this slot, so nothing is given up' });
  }
  if (slot.similar) {
    badges.push({
      label: 'like for like',
      title: 'This slot holds the same unique, or the same base type: a direct alternative',
    });
  }
  if (slot.primary) {
    badges.push({
      label: 'default',
      title: "Where PoB's own auto-equip would put this item",
    });
  }
  if (slot.weaponSet) {
    badges.push({ label: `set ${slot.weaponSet}`, title: 'Belongs to this weapon set' });
  }

  return (
    <li className={styles.slot}>
      <div className={styles.slotHead}>
        <span className={styles.slotLabel}>{slot.label}</span>
        {badges.map((badge) => (
          <span key={badge.label} className={styles.badge} title={badge.title}>
            {badge.label}
          </span>
        ))}
        <Button
          variant="primary"
          disabled={busy}
          onClick={onEquip}
          title={`Equip it in ${slot.label}`}
        >
          {slot.removing ? 'Take it out' : 'Equip here'}
        </Button>
      </div>

      <p className={styles.replaces}>
        {slot.removing ? (
          <>It is already in this slot: below is what removing it would do.</>
        ) : slot.replaces ? (
          <>
            replacing{' '}
            <span className={styles.replaced} data-tone={slot.replaces.rarity.toLowerCase()}>
              {slot.replaces.name}
            </span>
          </>
        ) : (
          <>filling an empty slot</>
        )}
      </p>

      {compare && !compare.ready && (
        <p className={styles.bad}>{compare.error ?? 'the comparison failed'}</p>
      )}
      {compare?.ready && compare.unchanged && (
        <p className={styles.unchanged}>Nothing moves.</p>
      )}
      {compare?.ready && !compare.unchanged && (
        <div className={styles.compare}>
          <Lines lines={compare.lines} />
        </div>
      )}
      {!compare && (
        <p className={styles.unchanged}>
          The engine has not finished its first calculation, so there is nothing to compare
          against yet.
        </p>
      )}

      {/* The resulting values, not the deltas above. Here because they are
          what the list is sorted by, and an order nobody can see looks
          like no order at all. */}
      {(slot.fullDPS !== undefined ||
        slot.combinedDPS !== undefined ||
        slot.totalEHP !== undefined) && (
        <p className={styles.numbers} title="What the build would come to with it equipped here">
          {slot.fullDPS !== undefined && <span>full DPS {round(slot.fullDPS)}</span>}
          {slot.combinedDPS !== undefined && <span>combined DPS {round(slot.combinedDPS)}</span>}
          {slot.totalEHP !== undefined && <span>effective hit pool {round(slot.totalEHP)}</span>}
        </p>
      )}
    </li>
  );
}

export function StagedItem({
  staged,
  busy,
  onEquip,
  onDiscard,
}: {
  staged: Extract<Staged, { ready: true }>;
  busy: boolean;
  onEquip: (slot?: string) => void;
  onDiscard: () => void;
}) {
  return (
    <section className={styles.panel}>
      <div className={styles.head}>
        <h3 className={styles.title}>
          On the bench:{' '}
          <span className={styles.name} data-tone={staged.rarity.toLowerCase()}>
            {staged.name}
          </span>
        </h3>
        <Button variant="ghost" disabled={busy} onClick={onDiscard}>
          Discard
        </Button>
      </div>

      <p className={styles.hint}>
        Nothing is equipped yet. Each slot below is a full recalculation of the build with this
        item in it, in PoB's own order: an empty slot first, then whatever this is a direct
        alternative to, then by what the build would come to.
      </p>

      <div className={styles.body}>
        <div className={styles.item}>
          {blocksOf(staged.lines).map((block, index) => (
            <div
              key={index}
              className={styles.block}
              data-rarity={index === 0 ? staged.rarity.toLowerCase() : undefined}
            >
              <Lines lines={block} />
            </div>
          ))}
        </div>

        <div className={styles.slots}>
          {staged.fitsNothing && (
            <p className={styles.hint}>
              No slot will take this item. A jewel needs an allocated socket, and an off-hand
              needs a one-handed weapon in front of it.
            </p>
          )}

          {staged.limited && (
            <p className={styles.note}>
              You are already wearing {staged.limit} of this unique, which is as many as it
              allows, so only the slots holding one are offered.
            </p>
          )}

          {staged.slots.length > 0 && (
            <ul className={styles.list}>
              {staged.slots.map((slot) => (
                <SlotRow
                  key={slot.name}
                  slot={slot}
                  busy={busy}
                  onEquip={() => onEquip(slot.name)}
                />
              ))}
            </ul>
          )}

          <p className={styles.cost}>
            {staged.slots.length} slot{staged.slots.length === 1 ? '' : 's'} compared in{' '}
            {staged.buildMs} ms
            {staged.primarySlot ? ` · PoB would default to ${staged.primarySlot}` : ''}
          </p>
        </div>
      </div>
    </section>
  );
}
