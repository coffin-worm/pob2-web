import { useEffect, useState } from 'react';
import { useCraftStore } from '../pob/craftStore';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import styles from './CraftPanel.module.css';

/**
 * Making an item to craft on.
 *
 * Four choices, which are PoB's own: rarity, type, base and a name. The
 * item itself is built by the engine, because `makeItem` inside its craft
 * dialog carries the whole of what a base implies, from the socket count a
 * martial weapon gets to the rarity downgrade a flask takes when you ask
 * for a rare one.
 *
 * Only magic and rare come back with affix slots. Normal has no modifiers
 * to give and unique carries its own as text, so both of those land on the
 * bench as something to edit rather than to craft, and this says so rather
 * than letting the empty panel say it for us.
 */
export function CraftNew({
  onDone,
  onRefusal,
}: {
  onDone: () => void;
  onRefusal: (reason: string | null) => void;
}) {
  const bases = useCraftStore((s) => s.bases);
  const busy = useCraftStore((s) => s.busy);
  const loadBases = useCraftStore((s) => s.loadBases);
  const create = useCraftStore((s) => s.create);

  const [type, setType] = useState<string | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [rarity, setRarity] = useState('RARE');
  const [name, setName] = useState('');

  useEffect(() => {
    void loadBases();
  }, [loadBases]);

  const types = bases?.types ?? [];
  // Derived rather than stored, so the control never shows a type that is
  // not actually selected. Nothing is chosen until the list arrives, and
  // a dropdown sitting on its first entry while the one beside it says
  // "pick a type first" is the control lying about its own state.
  const activeType = type ?? types[0] ?? null;

  // The base list belongs to one type, so it is fetched when the type
  // settles rather than all at once: there are sixty-six of them.
  useEffect(() => {
    if (activeType) void loadBases(activeType);
  }, [activeType, loadBases]);

  const list = bases?.type === activeType ? (bases?.bases ?? []) : [];
  // The same again: the list arrives after the type is chosen, so the
  // base settles on its first entry rather than on nothing.
  const activeBase = base ?? list[0]?.name ?? null;
  const rarities = bases?.rarities ?? ['NORMAL', 'MAGIC', 'RARE', 'UNIQUE'];
  const craftable = rarity === 'MAGIC' || rarity === 'RARE';

  return (
    <div className={styles.create}>
      <div className={styles.createRow}>
        <Select
          value={Math.max(0, rarities.indexOf(rarity))}
          options={rarities.map((r, i) => ({ id: i, name: r.toLowerCase() }))}
          onChange={(i) => setRarity(rarities[i] ?? 'RARE')}
          label="Rarity"
          aria-label="Rarity"
          width={150}
        />
        <Select
          value={Math.max(0, types.indexOf(activeType ?? ''))}
          options={
            types.length > 0
              ? types.map((t, i) => ({ id: i, name: t }))
              : [{ id: 0, name: 'Loading…' }]
          }
          onChange={(i) => {
            setType(types[i] ?? null);
            setBase(null);
          }}
          label="Type"
          aria-label="Item type"
          width={260}
        />
        <Select
          value={Math.max(0, list.findIndex((entry) => entry.name === activeBase))}
          options={
            list.length > 0
              ? list.map((entry, i) => ({
                  id: i,
                  name: entry.level ? `${entry.label} (level ${entry.level})` : entry.label,
                }))
              : [{ id: 0, name: 'Loading…' }]
          }
          onChange={(i) => setBase(list[i]?.name ?? null)}
          label="Base"
          aria-label="Base type"
          width={260}
          disabled={list.length === 0}
        />
      </div>

      <div className={styles.createRow}>
        <input
          className={styles.nameInput}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Name it, or leave this for New Item"
          aria-label="Item name"
        />
        <Button
          variant="primary"
          disabled={busy || !activeType || !activeBase}
          onClick={() => {
            if (!activeType || !activeBase) return;
            void create({ rarity, type: activeType, base: activeBase, name }).then((refused) => {
              onRefusal(refused);
              if (!refused) onDone();
            });
          }}
        >
          Put it on the bench
        </Button>
      </div>

      {!craftable && (
        <p className={styles.note}>
          A {rarity.toLowerCase()} item has no affix slots: the first has no modifiers to
          give and the second carries its own as text. It will land on the bench as
          something to edit rather than to craft.
        </p>
      )}
    </div>
  );
}
