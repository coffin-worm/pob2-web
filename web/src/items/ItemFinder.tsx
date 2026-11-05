import { useEffect, useState } from 'react';
import { useBridgeStore } from '../pob/bridgeStore';
import { useItemsStore } from '../pob/itemsStore';
import { Select } from '../ui/Select';
import { Segmented } from '../ui/Segmented';
import { Button } from '../ui/Button';
import type { ItemSearchResult } from '../pob/types';
import styles from './ItemFinder.module.css';

/**
 * PoB's item database, with PoB's filters on it.
 *
 * The desktop app filters on eight axes and, when asked to sort by a stat,
 * answers the only question that matters about an item you do not own yet:
 * what would it be worth here. It gets that by running the calculator
 * against every candidate in every slot it fits, which takes seconds, so it
 * reports "Sorting... (41%)" while it works.
 *
 * None of that arithmetic is repeated on this side. The bridge runs PoB's
 * own loop in budgeted slices and says how far it got; this drives it and
 * draws the progress. What is new here is the delta column: PoB ranks the
 * candidates but never says what the winner is worth against what you are
 * wearing, and that comparison is free once the number has been measured.
 */

/** Select speaks in numbers. These filters speak in keys. */
function KeySelect({
  value,
  options,
  onChange,
  label,
  width,
  'aria-label': ariaLabel,
}: {
  value: string;
  options: { key: string; label: string }[];
  onChange: (key: string) => void;
  label?: string;
  width?: number;
  'aria-label'?: string;
}) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.key === value),
  );
  return (
    <Select
      value={index}
      options={options.map((option, i) => ({ id: i, name: option.label }))}
      onChange={(i) => onChange(options[i]?.key ?? '')}
      label={label}
      width={width}
      aria-label={ariaLabel}
    />
  );
}

/**
 * Four significant figures and a thousands separator, which is what these
 * numbers need: a DPS figure runs to six digits and a block chance to two,
 * and the same column holds both.
 */
const format = (value: number) => {
  const size = Math.abs(value);
  const places = size >= 100 ? 0 : size >= 10 ? 1 : size >= 1 ? 2 : 3;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
};

const signed = (value: number) => (value > 0 ? `+${format(value)}` : format(value));

function Row({
  result,
  sorted,
  onAdd,
  onStage,
}: {
  result: ItemSearchResult;
  sorted: boolean;
  onAdd: () => void;
  onStage: () => void;
}) {
  return (
    <div className={styles.row} data-db={result.db}>
      {/* The name is in the title as well as in the row because a long one
          is cut off in a narrow list, and the hover is then the only way
          to read the rest of it. */}
      <button
        className={styles.rowMain}
        onClick={onStage}
        title={`${result.name}: put it on the bench, against every slot it fits`}
      >
        <span className={styles.rowName} data-tone={result.rarity.toLowerCase()}>
          {result.name}
        </span>
        <span className={styles.rowMeta}>
          {result.slot && <span>{result.slot}</span>}
          {result.level ? <span>level {result.level}</span> : null}
          {result.league && <span className={styles.league}>{result.league}</span>}
        </span>
      </button>

      {sorted && (
        <span className={styles.rowValue}>
          {/* An item that fits no slot this build has was still counted by
              the filters, so it is listed rather than quietly dropped. */}
          {result.fits ? (
            <>
              <span className={styles.value}>{format(result.value ?? 0)}</span>
              {result.delta !== undefined && (
                <span
                  className={styles.delta}
                  data-tone={result.delta > 0 ? 'positive' : result.delta < 0 ? 'negative' : 'flat'}
                >
                  {signed(result.delta)}
                </span>
              )}
            </>
          ) : (
            <span className={styles.noFit} title="No slot on this build takes it">
              no slot
            </span>
          )}
        </span>
      )}

      <button
        className={styles.equip}
        onClick={onAdd}
        title={`Equip it now, in ${result.slot ?? 'the first slot that takes it'}`}
      >
        Equip
      </button>
    </div>
  );
}

export function ItemFinder({
  onAdd,
  onStage,
}: {
  onAdd: (name: string) => void;
  onStage: (name: string) => void;
}) {
  const outputRevision = useBridgeStore((s) => s.outputRevision);
  const filters = useItemsStore((s) => s.filters);
  const options = useItemsStore((s) => s.options);
  const results = useItemsStore((s) => s.results);
  const searching = useItemsStore((s) => s.searching);
  const found = useItemsStore((s) => s.found);
  const stoppedAt = useItemsStore((s) => s.stoppedAt);
  const setFilters = useItemsStore((s) => s.setFilters);
  const cancelScan = useItemsStore((s) => s.cancelScan);
  const resumeScan = useItemsStore((s) => s.resumeScan);
  const reask = useItemsStore((s) => s.reask);
  const loadOptions = useItemsStore((s) => s.loadOptions);
  const openDatabase = useItemsStore((s) => s.openDatabase);

  // The input echoes every keystroke; the question only moves once typing
  // settles, because asking it is a scan of every item PoB knows.
  const [needle, setNeedle] = useState(filters.q);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void loadOptions();
    openDatabase();
  }, [loadOptions, openDatabase]);

  useEffect(() => {
    if (needle === filters.q) return;
    const timer = window.setTimeout(() => setFilters({ q: needle }), 180);
    return () => window.clearTimeout(timer);
  }, [needle, filters.q, setFilters]);

  // A stat sort is measured against the build, so equipping something
  // invalidates it. PoB rebuilds its list on the same signal.
  useEffect(() => {
    reask();
  }, [outputRevision, reask]);

  const sorted = (found?.sort ?? 'name') !== 'name';
  const scanning = Boolean(found?.scanning);
  const percent =
    found?.total && found.total > 0
      ? Math.floor(((found.scanned ?? 0) / found.total) * 100)
      : 0;

  // Four groups, then whatever types the data happens to contain. PoB
  // offers the same two kinds of entry in one dropdown.
  const typeOptions = [
    { key: '', label: 'Any type' },
    ...(options?.typeGroups ?? []),
    ...(options?.types ?? []).map((type) => ({ key: type, label: type })),
  ];

  const slotOptions = [
    { key: '', label: 'Any slot' },
    ...(options?.slots ?? []).map((slot) => ({ key: slot, label: slot })),
  ];

  const leagueOptions = [
    { key: '', label: 'Any league' },
    { key: 'none', label: 'No league' },
    ...(options?.leagues ?? []).map((league) => ({ key: league, label: league })),
  ];

  return (
    <section className={styles.finder}>
      <div className={styles.head}>
        <input
          className={styles.search}
          type="search"
          value={needle}
          onChange={(event) => setNeedle(event.target.value)}
          placeholder="Search PoB's uniques and rares"
          aria-label="Search the item database"
        />
        <Segmented
          value={filters.mode}
          options={(options?.modes ?? []).map((mode) => ({
            value: mode.key,
            label: mode.label,
          }))}
          onChange={(mode) => setFilters({ mode })}
          aria-label="Where to search"
        />
        <button
          className={styles.more}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {open ? 'Fewer filters' : 'More filters'}
        </button>
      </div>

      <div className={styles.sortRow}>
        <KeySelect
          value={filters.sort}
          options={options?.sorts ?? [{ key: 'name', label: 'Name' }]}
          onChange={(sort) => setFilters({ sort })}
          label="Sort by"
          width={232}
          aria-label="Sort the database by"
        />
        <KeySelect
          value={filters.slot}
          options={slotOptions}
          onChange={(slot) => setFilters({ slot })}
          width={168}
          aria-label="Filter by slot"
        />
        <KeySelect
          value={filters.type}
          options={typeOptions}
          onChange={(type) => setFilters({ type })}
          width={168}
          aria-label="Filter by type"
        />
      </div>

      {open && (
        <div className={styles.sortRow}>
          <KeySelect
            value={filters.league}
            options={leagueOptions}
            onChange={(league) => setFilters({ league })}
            width={168}
            aria-label="Filter by league"
          />
          <KeySelect
            value={filters.source}
            options={options?.sources ?? []}
            onChange={(source) => setFilters({ source })}
            width={168}
            aria-label="Filter by how it is obtained"
          />
          <KeySelect
            value={filters.req}
            options={options?.requirements ?? []}
            onChange={(req) => setFilters({ req })}
            width={180}
            aria-label="Filter by requirements"
          />
          <Segmented
            value={filters.db}
            options={[
              { value: 'all', label: 'Both' },
              { value: 'unique', label: 'Uniques' },
              { value: 'rare', label: 'Rares' },
            ]}
            onChange={(db) => setFilters({ db })}
            aria-label="Which database"
          />
        </div>
      )}

      <div className={styles.status}>
        {found?.error && <span className={styles.error}>{found.error}</span>}

        {scanning ? (
          <>
            {/* PoB's own progress line, which it earns the same way: the
                engine has genuinely run this many times. */}
            <span className={styles.progress}>
              Measuring {found?.scanned ?? 0} of {found?.total ?? 0} ({percent}%)
            </span>
            <span className={styles.bar} aria-hidden>
              <span className={styles.barFill} style={{ width: `${percent}%` }} />
            </span>
            <Button variant="ghost" onClick={cancelScan}>
              Stop
            </Button>
          </>
        ) : stoppedAt !== null ? (
          <>
            {/* Not "551 found": only this many were measured, so the
                ranking below goes exactly this far and no further. */}
            <span className={styles.count}>
              Stopped at {stoppedAt} of {found?.total ?? 0}
            </span>
            <Button variant="ghost" onClick={resumeScan}>
              Carry on
            </Button>
          </>
        ) : (
          <span className={styles.count}>
            {searching ? 'Looking…' : `${found?.total ?? 0} found`}
            {sorted && found?.baseline !== undefined && (
              <span className={styles.baseline}>
                {found.sortLabel} now {format(found.baseline)}
              </span>
            )}
          </span>
        )}

        {/* The obtainability filter is on by default, as it is in PoB.
            Without this line a search for a legacy unique finds nothing
            and the app looks broken rather than filtered. */}
        {!scanning && found?.hiddenBySource ? (
          <button
            className={styles.hidden}
            onClick={() => setFilters({ source: 'any' })}
            title="Show items that can no longer be obtained"
          >
            {found.hiddenBySource} hidden as unobtainable
          </button>
        ) : null}
      </div>

      {results.length > 0 && (
        <div className={styles.rows} data-sorted={sorted || undefined}>
          {results.map((result) => (
            <Row
              key={`${result.db}:${result.name}`}
              result={result}
              sorted={sorted}
              onAdd={() => onAdd(result.name)}
              onStage={() => onStage(result.name)}
            />
          ))}
          {found?.truncated && (
            <p className={styles.truncated}>
              Showing the first {results.length} of {found.total}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
