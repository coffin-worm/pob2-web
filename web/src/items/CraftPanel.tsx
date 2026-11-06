import { useEffect, useRef, useState } from 'react';
import { bridge } from '../pob/bridge';
import { useCraftStore } from '../pob/craftStore';
import { Segmented } from '../ui/Segmented';
import { Select } from '../ui/Select';
import { Lines } from '../ui/TooltipLines';
import type {
  AnointWhatIf,
  CraftAffixOption,
  CraftAffixRow,
  CraftAnoint,
  CraftAnointSlot,
  CraftRune,
  CraftRuneRow,
} from '../pob/types';
import styles from './CraftPanel.module.css';

/**
 * Crafting the item on the bench.
 *
 * The desktop tab draws nine affix dropdowns down one column, each with a
 * slider under it, and the slider does two jobs at once: it spans every
 * tier of the chosen modifier, so its left third is tier 1 at every roll,
 * its next third tier 2, and so on. That is why PoB has to flip the range
 * on tiers whose values run the other way, to keep one control monotonic
 * over what is really two numbers.
 *
 * They are two numbers here. An affix slot is stored as `{ modId, range }`,
 * which is a tier and where in that tier's range it rolled, so the tier is
 * a stepper and the roll is its own slider. Nothing about the file changes;
 * only the control does.
 *
 * Which modifiers a slot may hold is never decided here. That is
 * `UpdateAffixControl` in the engine, which knows the base's spawn weights
 * and which groups the other slots have used up.
 */

function rollLabel(roll: number) {
  return `${Math.round(roll * 100)}%`;
}

/** The list a slot opens onto: every modifier it could hold. */
function Picker({
  kind,
  index,
  selected,
  onPick,
  onClose,
}: {
  kind: 'prefix' | 'suffix';
  index: number;
  selected?: string;
  onPick: (option: CraftAffixOption) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<CraftAffixOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => {
      void bridge
        .craftAffixes(kind, index, query)
        .then((found) => {
          if (!live) return;
          setOptions(found.options ?? []);
          setError(found.ready ? null : (found.error ?? 'The engine could not answer that.'));
        })
        .catch((reason: unknown) => {
          if (live) setError(reason instanceof Error ? reason.message : String(reason));
        });
    }, query ? 140 : 0);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [kind, index, query]);

  return (
    <div className={styles.picker}>
      <div className={styles.pickerHead}>
        <input
          ref={input}
          className={styles.pickerSearch}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${kind}es this base can roll`}
          aria-label={`Search ${kind} modifiers`}
          onKeyDown={(event) => event.key === 'Escape' && onClose()}
        />
        <button className={styles.pickerClose} onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {error && <p className={styles.note}>{error}</p>}
      {!error && options === null && <p className={styles.note}>Asking the engine…</p>}
      {!error && options?.length === 0 && (
        <p className={styles.note}>
          Nothing matches. This base can only roll what the game lets it, and the other
          slots have already used up their groups.
        </p>
      )}

      <div className={styles.options}>
        {options?.map((option) => (
          <button
            key={option.key}
            className={styles.option}
            data-current={option.modIds.includes(selected ?? '') || undefined}
            onClick={() => onPick(option)}
          >
            <span className={styles.optionLabel}>{option.label}</span>
            <span className={styles.optionMeta}>
              {option.tierCount > 1 ? `${option.tierCount} tiers` : 'one tier'}
              {option.affix && <span className={styles.affixName}>{option.affix}</span>}
            </span>
            {/* What the top tier reads, because the label above hides the
                numbers behind `#` as soon as a modifier has more than one
                tier. */}
            {option.preview.length > 0 && (
              <span className={styles.optionPreview}>{option.preview.join(' · ')}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function Row({
  kind,
  row,
  busy,
  open,
  onOpen,
  onClose,
  onSet,
}: {
  kind: 'prefix' | 'suffix';
  row: CraftAffixRow;
  busy: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSet: (modId: string | null, roll?: number) => void;
}) {
  // Where the roll slider is while it is being dragged. Every commit
  // rebuilds the item, so the engine hears about it once, on release.
  const [dragging, setDragging] = useState<number | null>(null);
  const roll = dragging ?? row.roll ?? 0.5;

  const commit = () => {
    if (dragging === null || !row.modId) return;
    const at = dragging;
    setDragging(null);
    if (at !== row.roll) onSet(row.modId, at);
  };

  if (!row.modId) {
    return (
      <div className={styles.row} data-empty>
        <button className={styles.add} onClick={onOpen} disabled={busy}>
          {open ? 'Close' : `Add a ${kind}`}
        </button>
        {open && (
          <Picker
            kind={kind}
            index={row.index}
            onPick={(option) => onSet(option.modIds[option.modIds.length - 1])}
            onClose={onClose}
          />
        )}
      </div>
    );
  }

  return (
    <div className={styles.row}>
      <div className={styles.rowHead}>
        <button className={styles.rowName} onClick={onOpen} disabled={busy} title="Change it">
          {row.unknown ? (
            <span className={styles.unknown}>
              {row.modId}: this base can no longer roll it
            </span>
          ) : (
            (row.lines ?? []).map((line, i) => (
              <span key={i} className={styles.line}>
                {line}
              </span>
            ))
          )}
        </button>
        <button
          className={styles.clear}
          onClick={() => onSet(null)}
          disabled={busy}
          aria-label={`Remove this ${kind}`}
          title="Remove it"
        >
          ×
        </button>
      </div>

      {row.tierCount !== undefined && row.tier !== undefined && (
        <div className={styles.dials}>
          {/* Tier and roll are the two numbers a slot actually stores. The
              desktop app runs them together on one slider. */}
          <label className={styles.dial}>
            <span className={styles.dialName}>Tier</span>
            <input
              className={styles.tier}
              type="range"
              min={1}
              max={row.tierCount}
              step={1}
              value={row.tier}
              disabled={busy || row.tierCount === 1}
              onChange={(event) => {
                const tier = Number(event.target.value);
                const id = row.modIds?.[tier - 1];
                if (id) onSet(id, row.roll);
              }}
              aria-label="Tier"
            />
            <span className={styles.dialValue}>
              {row.tier}/{row.tierCount}
              {row.level !== undefined && (
                <span className={styles.ilvl}> at level {row.level}</span>
              )}
            </span>
          </label>

          <label className={styles.dial}>
            <span className={styles.dialName}>Roll</span>
            <input
              className={styles.roll}
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={roll}
              disabled={busy}
              onChange={(event) => setDragging(Number(event.target.value))}
              onPointerUp={commit}
              onKeyUp={commit}
              onBlur={commit}
              aria-label="Roll within the tier"
            />
            <span className={styles.dialValue}>{rollLabel(roll)}</span>
          </label>
        </div>
      )}

      {open && (
        <Picker
          kind={kind}
          index={row.index}
          selected={row.modId}
          onPick={(option) => onSet(option.modIds[option.modIds.length - 1])}
          onClose={onClose}
        />
      )}
    </div>
  );
}

/**
 * The runes and soul cores one socket will take.
 *
 * Which ones those are is `GetValidRunesForItem`, and it is a real rule
 * rather than a list: the socket's own augment type, the soul core types
 * the base names, the SocketedRunesOnly and SocketedSoulCoresOnly flags a
 * unique can carry, and the blanket restrictions on uniques and on
 * jewellery. An Iron Cuirass takes 120 of them.
 */
function RunePicker({
  onPick,
  onClose,
}: {
  onPick: (rune: CraftRune) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<CraftRune[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(
      () => {
        void bridge
          .craftRunes(query)
          .then((found) => {
            if (!live) return;
            setOptions(found.options ?? []);
            setError(found.ready ? null : (found.error ?? 'The engine could not answer that.'));
          })
          .catch((reason: unknown) => {
            if (live) setError(reason instanceof Error ? reason.message : String(reason));
          });
      },
      query ? 140 : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className={styles.picker}>
      <div className={styles.pickerHead}>
        <input
          ref={input}
          className={styles.pickerSearch}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search runes and soul cores"
          aria-label="Search runes"
          onKeyDown={(event) => event.key === 'Escape' && onClose()}
        />
        <button className={styles.pickerClose} onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {error && <p className={styles.note}>{error}</p>}
      {!error && options === null && <p className={styles.note}>Asking the engine…</p>}
      {!error && options?.length === 0 && (
        <p className={styles.note}>Nothing matches what these sockets will take.</p>
      )}

      <div className={styles.options}>
        {options?.map((rune) => (
          <button key={rune.name} className={styles.option} onClick={() => onPick(rune)}>
            <span className={styles.optionLabel}>{rune.name}</span>
            <span className={styles.optionMeta}>
              {rune.type === 'SoulCore' ? 'soul core' : 'rune'}
              {rune.socketBound && <span className={styles.bound}>cannot be removed</span>}
            </span>
            <span className={styles.optionPreview}>{rune.lines.join(' · ')}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RuneRow({
  row,
  busy,
  open,
  onOpen,
  onClose,
  onSet,
}: {
  row: CraftRuneRow;
  busy: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSet: (name: string | null) => void;
}) {
  const picker = open && (
    <RunePicker
      onPick={(rune) => onSet(rune.name)}
      onClose={onClose}
    />
  );

  if (!row.name) {
    return (
      <div className={styles.row} data-empty>
        <button className={styles.add} onClick={onOpen} disabled={busy}>
          {open ? 'Close' : `Socket ${row.index}: empty`}
        </button>
        {picker}
      </div>
    );
  }

  return (
    <div className={styles.row}>
      <div className={styles.rowHead}>
        <button className={styles.rowName} onClick={onOpen} disabled={busy} title="Change it">
          <span className={styles.runeName}>{row.name}</span>
          {row.unknown ? (
            <span className={styles.unknown}>this item can no longer take it</span>
          ) : (
            (row.lines ?? []).map((line, i) => (
              <span key={i} className={styles.line}>
                {line}
              </span>
            ))
          )}
        </button>
        <button
          className={styles.clear}
          onClick={() => onSet(null)}
          disabled={busy}
          aria-label={`Empty socket ${row.index}`}
          title="Take it out"
        >
          ×
        </button>
      </div>
      {picker}
    </div>
  );
}

/**
 * The notables this item could be anointed with.
 *
 * All 875 of them, which is why this is a search and not a list. The three
 * modes are the desktop control's own; what it has above them, and this
 * does not, is thirteen checkboxes for the distilled emotions. "Anywhere"
 * searches the emotions instead, so typing Greed finds every notable that
 * costs one, in the box that was already there.
 *
 * The preview strip is PoB's hover tooltip, moved somewhere it can stay.
 * It sits above the list rather than over it, so the lines a pointer is
 * reading never move out from under it, and it reports the two answers
 * that are not comparisons: a notable already on the tree, or already
 * anointed, cannot give you the same thing twice.
 */
function AnointPicker({
  slot,
  selected,
  onPick,
  onClose,
}: {
  slot: number;
  selected?: string;
  onPick: (anoint: CraftAnoint) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'anywhere' | 'names' | 'modifiers'>('anywhere');
  const [options, setOptions] = useState<CraftAnoint[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [preview, setPreview] = useState<AnointWhatIf | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(
      () => {
        void bridge
          .craftAnoints(query, mode)
          .then((found) => {
            if (!live) return;
            setOptions(found.options ?? []);
            setTotal(found.total ?? 0);
            setError(found.ready ? null : (found.error ?? 'The engine could not answer that.'));
          })
          .catch((reason: unknown) => {
            if (live) setError(reason instanceof Error ? reason.message : String(reason));
          });
      },
      query ? 140 : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [query, mode]);

  // One calculation per notable the pointer rests on, which the engine
  // answers in about ten milliseconds. Debounced, because dragging down
  // the list would otherwise ask for every row it crosses.
  useEffect(() => {
    if (hover === null) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void bridge
        .anointWhatIf(slot, hover)
        .then((answer) => {
          if (live) setPreview(answer);
        })
        .catch((reason: unknown) => {
          if (live) {
            setPreview({
              ready: false,
              error: reason instanceof Error ? reason.message : String(reason),
            });
          }
        });
    }, 160);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [hover, slot]);

  const previewBody = () => {
    if (!preview) {
      return <span className={styles.previewHint}>Rest on a notable to see what it would do.</span>;
    }
    if (!preview.ready) {
      return <span className={styles.previewHint}>{preview.error}</span>;
    }
    if (preview.lines.length === 0) {
      return <span className={styles.previewHint}>{preview.reason ?? 'Nothing would move.'}</span>;
    }
    return <Lines lines={preview.lines} />;
  };

  return (
    <div className={styles.picker}>
      <div className={styles.pickerHead}>
        <input
          ref={input}
          className={styles.pickerSearch}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search notables, modifiers and emotions"
          aria-label="Search notables"
          onKeyDown={(event) => event.key === 'Escape' && onClose()}
        />
        <button className={styles.pickerClose} onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <Segmented
        value={mode}
        options={[
          { value: 'anywhere' as const, label: 'Anywhere', title: 'Name, modifiers and emotions' },
          { value: 'names' as const, label: 'Names' },
          { value: 'modifiers' as const, label: 'Modifiers' },
        ]}
        onChange={setMode}
        aria-label="What to search"
      />

      <div className={styles.anointPreview} aria-live="polite">
        {previewBody()}
      </div>

      {error && <p className={styles.note}>{error}</p>}
      {!error && options === null && <p className={styles.note}>Asking the engine…</p>}
      {!error && options?.length === 0 && (
        <p className={styles.note}>No anointable notable matches that.</p>
      )}

      <div className={styles.options} onMouseLeave={() => setHover(null)}>
        {options?.map((anoint) => (
          <button
            key={anoint.id}
            className={styles.option}
            data-current={anoint.name === selected || undefined}
            onMouseEnter={() => setHover(anoint.id)}
            onFocus={() => setHover(anoint.id)}
            onClick={() => onPick(anoint)}
          >
            <span className={styles.optionLabel}>{anoint.name}</span>
            <span className={styles.optionMeta}>
              <span className={styles.recipe}>{anoint.recipe.join(' + ')}</span>
              {anoint.allocated && (
                <span className={styles.bound}>already on your tree</span>
              )}
            </span>
            {anoint.lines.map((line, i) => (
              <span key={i} className={styles.optionPreview}>
                {line}
              </span>
            ))}
          </button>
        ))}
      </div>

      {/* A list that stops at a hundred and fifty of eight hundred and
          says nothing reads as the whole answer. */}
      {options && total > options.length && (
        <p className={styles.note}>
          Showing {options.length} of {total}. Narrow the search for the rest.
        </p>
      )}
    </div>
  );
}

function AnointRow({
  slot,
  busy,
  open,
  onOpen,
  onClose,
  onSet,
}: {
  slot: CraftAnointSlot;
  busy: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onSet: (node: number | null) => void;
}) {
  const picker = open && (
    <AnointPicker
      slot={slot.index}
      selected={slot.node}
      onPick={(anoint) => onSet(anoint.id)}
      onClose={onClose}
    />
  );

  if (!slot.node) {
    return (
      <div className={styles.row} data-empty>
        <button className={styles.add} onClick={onOpen} disabled={busy}>
          {open ? 'Close' : `Anoint ${slot.index}: empty`}
        </button>
        {/* An anoint is an enchant line, and PoB replaces the line in that
            slot whatever it holds. Said before the click. */}
        {slot.other && (
          <p className={styles.warn}>Anointing this would replace "{slot.other}".</p>
        )}
        {picker}
      </div>
    );
  }

  return (
    <div className={styles.row}>
      <div className={styles.rowHead}>
        <button className={styles.rowName} onClick={onOpen} disabled={busy} title="Change it">
          {/* Only the name: the item's own tooltip above already lists
              what the notable grants, under its Allocates line. */}
          <span className={styles.anointName}>{slot.node}</span>
        </button>
        <button
          className={styles.clear}
          onClick={() => onSet(null)}
          disabled={busy}
          aria-label={`Remove the anoint in slot ${slot.index}`}
          title="Take it off"
        >
          ×
        </button>
      </div>
      {picker}
    </div>
  );
}

export function CraftPanel({ onRefusal }: { onRefusal: (reason: string | null) => void }) {
  const state = useCraftStore((s) => s.state);
  const busy = useCraftStore((s) => s.busy);
  const refresh = useCraftStore((s) => s.refresh);
  const setAffix = useCraftStore((s) => s.setAffix);
  const setQuality = useCraftStore((s) => s.setQuality);
  const setRune = useCraftStore((s) => s.setRune);
  const setSocketCount = useCraftStore((s) => s.setSocketCount);
  const setAnoint = useCraftStore((s) => s.setAnoint);

  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!state?.ready) return null;

  const apply = (kind: 'prefix' | 'suffix', index: number) =>
    (modId: string | null, roll?: number) => {
      setOpen(null);
      void setAffix(kind, index, modId, roll).then(onRefusal);
    };

  const column = (kind: 'prefix' | 'suffix', rows: CraftAffixRow[]) => (
    <section className={styles.column}>
      <h4 className={styles.columnTitle}>
        {kind === 'prefix' ? 'Prefixes' : 'Suffixes'}
        <span className={styles.used}>
          {rows.filter((row) => row.modId).length} of {rows.length}
        </span>
      </h4>
      {rows.map((row) => {
        const id = `${kind}:${row.index}`;
        return (
          <Row
            key={id}
            kind={kind}
            row={row}
            busy={busy}
            open={open === id}
            onOpen={() => setOpen(open === id ? null : id)}
            onClose={() => setOpen(null)}
            onSet={apply(kind, row.index)}
          />
        );
      })}
    </section>
  );

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <h3 className={styles.title}>
          Crafting <span className={styles.base}>{state.baseName}</span>
        </h3>
        {state.qualityEditable && (
          <label className={styles.quality}>
            <span className={styles.dialName}>Quality</span>
            <Select
              value={state.quality ?? 0}
              options={[0, 5, 10, 15, 20, 25, 30].map((q) => ({ id: q, name: `${q}%` }))}
              onChange={(q) => void setQuality(q).then(onRefusal)}
              disabled={busy}
              aria-label="Quality"
              width={88}
            />
          </label>
        )}
        {state.corrupted && <span className={styles.corrupted}>corrupted</span>}
      </div>

      {!state.crafted ? (
        <p className={styles.note}>
          This item has no affix slots. PoB gives them only to a magic or rare item made
          in its craft dialog: a unique, or a rare copied out of the game, carries its
          modifiers as text instead, which the box below edits.
        </p>
      ) : (
        <div className={styles.columns}>
          {column('prefix', state.prefixes ?? [])}
          {column('suffix', state.suffixes ?? [])}
        </div>
      )}

      {/* Sockets come last because a rune is the last thing you put in,
          and they are shown for any base that can carry them, crafted or
          not: a unique with sockets takes runes just the same. */}
      {state.sockets && (
        <section className={styles.sockets}>
          <h4 className={styles.columnTitle}>
            Sockets
            <span className={styles.used}>
              {(state.runes ?? []).filter((row) => row.name).length} of {state.sockets.rune}
            </span>
          </h4>

          <div className={styles.socketCounts}>
            <label className={styles.dial}>
              <span className={styles.dialName}>Rune</span>
              <input
                className={styles.tier}
                type="range"
                min={0}
                max={state.sockets.max}
                step={1}
                value={state.sockets.rune}
                disabled={busy}
                onChange={(event) =>
                  void setSocketCount('rune', Number(event.target.value)).then(onRefusal)
                }
                aria-label="Rune sockets"
              />
              <span className={styles.dialValue}>
                {state.sockets.rune}
                {state.sockets.natural !== undefined && (
                  <span className={styles.ilvl}> of {state.sockets.natural} on this base</span>
                )}
              </span>
            </label>

            <label className={styles.dial}>
              <span className={styles.dialName}>Jewel</span>
              <input
                className={styles.tier}
                type="range"
                min={0}
                max={state.sockets.max}
                step={1}
                value={state.sockets.jewel}
                disabled={busy}
                onChange={(event) =>
                  void setSocketCount('jewel', Number(event.target.value)).then(onRefusal)
                }
                aria-label="Jewel sockets"
              />
              <span className={styles.dialValue}>{state.sockets.jewel}</span>
            </label>
          </div>

          {/* Taking sockets away drops the runes in them for good: the
              engine rebuilds the item from the sockets that remain. */}
          <div className={styles.runeRows}>
            {(state.runes ?? []).map((row) => {
              const id = `rune:${row.index}`;
              return (
                <RuneRow
                  key={id}
                  row={row}
                  busy={busy}
                  open={open === id}
                  onOpen={() => setOpen(open === id ? null : id)}
                  onClose={() => setOpen(null)}
                  onSet={(name) => {
                    setOpen(null);
                    void setRune(row.index, name).then(onRefusal);
                  }}
                />
              );
            })}
          </div>
        </section>
      )}

      {/* Anoints are enchant lines rather than affixes, so an amulet
          carries them whether or not it was crafted. PoB puts its Anoint
          buttons under the socket section too. */}
      {state.anoint && (
        <section className={styles.sockets}>
          <h4 className={styles.columnTitle}>
            Anoint
            <span className={styles.used}>
              {state.anoint.slots.filter((row) => row.node).length} of{' '}
              {state.anoint.slots.length}
            </span>
          </h4>

          {/* One row per enchant line this item will take an anoint in,
              which is one for most amulets: a second needs the item to
              say it allows another instilled modifier. */}
          <div className={styles.runeRows}>
            {state.anoint.slots.map((row) => {
              const id = `anoint:${row.index}`;
              return (
                <AnointRow
                  key={id}
                  slot={row}
                  busy={busy}
                  open={open === id}
                  onOpen={() => setOpen(open === id ? null : id)}
                  onClose={() => setOpen(null)}
                  onSet={(node) => {
                    setOpen(null);
                    void setAnoint(row.index, node).then(onRefusal);
                  }}
                />
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
