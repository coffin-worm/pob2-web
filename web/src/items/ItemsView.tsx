import { useEffect, useMemo, useRef, useState } from 'react';
import { useBridgeStore } from '../pob/bridgeStore';
import { useItemsStore } from '../pob/itemsStore';
import { Select } from '../ui/Select';
import { Segmented } from '../ui/Segmented';
import { Button } from '../ui/Button';
import { ItemEditor } from './ItemEditor';
import type { ItemLine, ItemSlot } from '../pob/types';
import styles from './ItemsView.module.css';

/**
 * The Items tab.
 *
 * Almost none of this screen is its own work. The slots are PoB's, including
 * which of them exist right now: the third ring appears only behind a tree
 * flag, the weapon swaps follow the active set, and a jewel socket exists
 * only while its passive is allocated. Which items may go in a slot is
 * `IsItemValidForSlot`, a real game rule about two-handers and jewel
 * rarities. And the item panel on the right is PoB's own `AddItemTooltip`,
 * line for line, including the comparison it runs against a slot.
 *
 * What this file decides is layout: PoB draws nineteen dropdowns in one
 * column, and these are grouped. The order inside each group is still the
 * engine's.
 */

/** Groups, in display order. A slot not matched here falls to the last one. */
const GROUPS: { id: string; title: string; match: (slot: ItemSlot) => boolean }[] = [
  { id: 'weapon', title: 'Weapons', match: (s) => s.name.startsWith('Weapon') },
  {
    id: 'armour',
    title: 'Armour',
    match: (s) => ['Helmet', 'Body Armour', 'Gloves', 'Boots'].includes(s.name),
  },
  {
    id: 'jewellery',
    title: 'Jewellery',
    match: (s) => s.name === 'Amulet' || s.name === 'Belt' || s.name.startsWith('Ring'),
  },
  {
    id: 'consumable',
    title: 'Charms and flasks',
    match: (s) => s.name.startsWith('Charm') || s.name.startsWith('Flask'),
  },
  { id: 'jewel', title: 'Jewels', match: (s) => Boolean(s.socket || s.jewel) },
  { id: 'other', title: 'Other', match: () => true },
];

const toneOfRarity = (rarity: string) => rarity.toLowerCase();

/** PoB's tooltip lines, grouped by the block they belong to. */
function blocksOf(lines: ItemLine[]): ItemLine[][] {
  const blocks: ItemLine[][] = [];
  for (const line of lines) {
    const index = Math.max(1, line.block) - 1;
    (blocks[index] ??= []).push(line);
  }
  return blocks.filter(Boolean);
}

function Lines({ lines }: { lines: ItemLine[] }) {
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

export function ItemsView() {
  const outputRevision = useBridgeStore((s) => s.outputRevision);
  const snapshot = useItemsStore((s) => s.snapshot);
  const selectedId = useItemsStore((s) => s.selectedId);
  const selectedSlot = useItemsStore((s) => s.selectedSlot);
  const detail = useItemsStore((s) => s.detail);
  const detailLoading = useItemsStore((s) => s.detailLoading);
  const edit = useItemsStore((s) => s.edit);
  const query = useItemsStore((s) => s.query);
  const results = useItemsStore((s) => s.results);
  const searchTotal = useItemsStore((s) => s.searchTotal);
  const searching = useItemsStore((s) => s.searching);
  const refresh = useItemsStore((s) => s.refresh);
  const select = useItemsStore((s) => s.select);
  const search = useItemsStore((s) => s.search);
  const act = useItemsStore((s) => s.act);

  const [refusal, setRefusal] = useState<string | null>(null);
  const [paste, setPaste] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [editing, setEditing] = useState(false);
  const debounce = useRef<number | undefined>(undefined);
  const detailRef = useRef<HTMLDivElement>(null);

  // The engine bumps outputRevision on every recalculation, and equipping
  // something is one. Refetching on that rather than on a timer means the
  // screen moves exactly when the build does.
  useEffect(() => {
    void refresh();
  }, [outputRevision, refresh]);

  // In the one-column layout the item panel is well below the slots, so
  // clicking a slot's inspect button would otherwise do something the user
  // cannot see. Only on a change of selection: re-running it on every
  // refresh would yank the page around while you read.
  useEffect(() => {
    if (selectedId === null) return;
    detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selectedId, selectedSlot]);

  const groups = useMemo(() => {
    const slots = snapshot?.slots ?? [];
    return GROUPS.map((group) => ({
      ...group,
      slots: slots.filter(
        (slot) => GROUPS.find((candidate) => candidate.match(slot))?.id === group.id,
      ),
    })).filter((group) => group.slots.length > 0);
  }, [snapshot]);

  const run = async (action: string, value?: unknown) => {
    setRefusal(await act(action, value));
  };

  const onSearch = (value: string) => {
    window.clearTimeout(debounce.current);
    // A scan of every unique and rare PoB knows, so not on every keystroke.
    debounce.current = window.setTimeout(() => void search(value), 180);
    void useItemsStore.setState({ query: value });
  };

  if (!snapshot) {
    return <div className={styles.empty}>Waiting for the engine…</div>;
  }

  const items = snapshot.items;

  return (
    <div className={styles.view}>
      <div className={styles.bar}>
        {snapshot.sets.length > 1 && (
          <Select
            value={snapshot.setId}
            options={snapshot.sets}
            onChange={(id) => void run('setItemSet', id)}
            label="Item set"
            aria-label="Item set"
          />
        )}
        <Segmented
          aria-label="Weapon set"
          value={String(snapshot.weaponSet)}
          onChange={(value) => void run('setWeaponSet', Number(value))}
          options={[
            { value: '1', label: 'Set I', title: 'First weapon set' },
            { value: '2', label: 'Set II', title: 'Second weapon set' },
          ]}
        />
        <div className={styles.barSpacer} />
        <Button onClick={() => setShowPaste((open) => !open)}>
          {showPaste ? 'Close' : 'Paste item'}
        </Button>
      </div>

      {showPaste && (
        <form
          className={styles.paste}
          onSubmit={(e) => {
            e.preventDefault();
            if (!paste.trim()) return;
            void run('addItemText', { text: paste }).then(() => setPaste(''));
          }}
        >
          <textarea
            className={styles.pasteBox}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder={'Rarity: RARE\nDread Hold\nFelt Cap\n…'}
            rows={6}
            aria-label="Item text"
          />
          <Button type="submit" variant="primary" disabled={!paste.trim()}>
            Add to build
          </Button>
        </form>
      )}

      {refusal && (
        <div className={styles.refusal} role="status">
          {refusal}
          <button className={styles.dismiss} onClick={() => setRefusal(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <div className={styles.columns}>
        <div className={styles.left}>
          {groups.map((group) => (
            <section key={group.id} className={styles.group}>
              <h3 className={styles.groupTitle}>{group.title}</h3>
              {group.slots.map((slot) => (
                <div className={styles.slot} key={slot.name}>
                  <span className={styles.slotLabel} title={slot.name}>
                    {slot.label}
                  </span>
                  {/* The cell is always there, empty or not: a conditional
                      child would shift every following cell into the wrong
                      grid track on the rows that have no checkbox. */}
                  {slot.flask ? (
                    <input
                      type="checkbox"
                      className={styles.flask}
                      checked={slot.active ?? false}
                      disabled={slot.itemId === 0}
                      onChange={(e) =>
                        void run('setSlotActive', { slot: slot.name, active: e.target.checked })
                      }
                      aria-label={`${slot.label} active`}
                    />
                  ) : (
                    <span className={styles.noFlask} aria-hidden="true" />
                  )}
                  <div className={styles.slotSelect}>
                    <Select
                      value={slot.itemId}
                      options={slot.options}
                      onChange={(id) => void run('setSlotItem', { slot: slot.name, item: id })}
                      disabled={slot.options.length < 2}
                      aria-label={slot.name}
                    />
                  </div>
                  <button
                    className={styles.inspect}
                    disabled={slot.itemId === 0}
                    onClick={() => void select(slot.itemId, slot.name)}
                    // The comparison is against this slot, so which slot you
                    // came in from is part of the question.
                    title="Show this item, compared against this slot"
                  >
                    ?
                  </button>
                </div>
              ))}
            </section>
          ))}

          <section className={styles.group}>
            <h3 className={styles.groupTitle}>
              In this build <span className={styles.count}>{items.length}</span>
            </h3>
            {items.length === 0 && (
              <p className={styles.hint}>
                Nothing yet. Search PoB's uniques on the right, or paste an item.
              </p>
            )}
            {items.map((item) => (
              <div
                key={item.id}
                className={styles.item}
                data-selected={item.id === selectedId ? 'true' : undefined}
              >
                <button
                  className={styles.itemName}
                  data-tone={toneOfRarity(item.rarity)}
                  onClick={() => void select(item.id, item.equipped ?? null)}
                >
                  {item.name}
                  {item.equipped && <span className={styles.equipped}>{item.equipped}</span>}
                </button>
                <button
                  className={styles.delete}
                  onClick={() => void run('deleteItem', item.id)}
                  aria-label={`Delete ${item.name}`}
                  title="Remove from the build"
                >
                  ×
                </button>
              </div>
            ))}
          </section>
        </div>

        <div className={styles.right}>
          <form className={styles.search} onSubmit={(e) => e.preventDefault()}>
            <input
              className={styles.searchInput}
              type="search"
              value={query}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Search PoB's uniques and rares"
              aria-label="Search the item database"
            />
            {query.trim().length >= 2 && (
              <span className={styles.searchCount}>
                {searching ? '…' : `${searchTotal} found`}
              </span>
            )}
          </form>

          {results.length > 0 && (
            <div className={styles.results}>
              {results.map((result) => (
                <button
                  key={result.name}
                  className={styles.result}
                  onClick={() => void run('addDbItem', { name: result.name })}
                  title={`Add and equip in ${result.slot ?? 'the first free slot'}`}
                >
                  <span className={styles.resultName} data-tone={toneOfRarity(result.rarity)}>
                    {result.name}
                  </span>
                  {result.slot && <span className={styles.resultSlot}>{result.slot}</span>}
                </button>
              ))}
            </div>
          )}

          <div className={styles.detail} ref={detailRef}>
            {selectedId === null && (
              <p className={styles.hint}>
                Pick an item to see it as PoB draws it, with what equipping it would change.
              </p>
            )}
            {selectedId !== null && detailLoading && !detail && (
              <p className={styles.hint}>Comparing…</p>
            )}
            {detail && !detail.ready && (
              <p className={styles.hint}>{detail.error ?? 'That item is no longer here.'}</p>
            )}
            {detail?.ready &&
              blocksOf(detail.lines).map((block, index) => (
                <div
                  key={index}
                  className={styles.block}
                  data-rarity={index === 0 ? toneOfRarity(detail.rarity) : undefined}
                >
                  <Lines lines={block} />
                </div>
              ))}
            {detail?.ready && selectedSlot && (
              <p className={styles.against}>compared against {selectedSlot}</p>
            )}
            {/* The editor sits under the item it edits, so a change and
                its effect are in the same place. The disclosure is held
                here rather than inside it, because the editor remounts
                whenever the item's text changes. */}
            {detail?.ready && edit?.ready && (
              <button
                className={styles.editToggle}
                onClick={() => setEditing((open) => !open)}
                aria-expanded={editing}
              >
                {editing ? 'Done editing' : 'Edit this item'}
              </button>
            )}
            {detail?.ready && edit?.ready && editing && (
              <ItemEditor
                key={edit.raw}
                edit={edit}
                onRange={(line, range) =>
                  void run('setItemRange', { item: detail.id, line, range })
                }
                onVariant={(variant) =>
                  void run('setItemVariant', { item: detail.id, variant })
                }
                onText={(text) => void run('setItemText', { item: detail.id, text })}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
