import { create } from 'zustand';
import { bridge } from './bridge';
import type {
  Connection,
  ItemDetail,
  ItemEdit,
  ItemFilterOptions,
  ItemFilters,
  ItemSearchResult,
  ItemSearchSnapshot,
  ItemsSnapshot,
  StagedItem,
} from './types';

/**
 * The items screen.
 *
 * Three fetches with different costs. The slot and item lists are small and
 * refetched whenever the engine recalculates. One item's detail is PoB's own
 * tooltip, and against a slot it runs a whole comparison pass, so it is
 * fetched only for the item being looked at. The database search is a scan
 * of every unique and rare PoB knows, so it is debounced.
 */
/**
 * The question the database starts on, which is PoB's own starting point:
 * everything, obtainable only, in name order. These have to agree with the
 * bridge's defaults, or the first answer would be to a different question
 * than the controls are showing.
 */
const EMPTY_FILTERS: ItemFilters = {
  q: '',
  mode: 'anywhere',
  db: 'all',
  slot: '',
  type: '',
  league: '',
  req: 'any',
  source: 'obtainable',
  sort: 'name',
};

interface ItemsStore {
  connection: Connection;
  snapshot: Extract<ItemsSnapshot, { ready: true }> | null;

  /** The item whose detail is on screen, and the slot it is read against. */
  selectedId: number | null;
  selectedSlot: string | null;
  detail: ItemDetail | null;
  detailLoading: boolean;
  /** The editable side of the selected item, fetched alongside it. */
  edit: ItemEdit | null;

  /**
   * The item on the bench, if there is one, with what it would do in each
   * slot it fits. Null means nothing is staged; a `ready: false` payload
   * means the engine was asked and said so.
   */
  staged: StagedItem | null;
  stagedLoading: boolean;

  /**
   * The database question, as PoB asks it: a needle, where to look for it,
   * and six filters. Held whole rather than as eight pieces of state
   * because the bridge keys its scan on the lot, and a scan that has run
   * half way is only resumable while the question has not moved.
   */
  filters: ItemFilters;
  /** What each filter offers. Asked once; the database does not change. */
  options: ItemFilterOptions | null;
  results: ItemSearchResult[];
  searching: boolean;
  /** The last answer's own account of itself: progress, cost, caveats. */
  found: ItemSearchSnapshot | null;
  /**
   * How far a stopped scan got, or null if none was stopped.
   *
   * Kept apart from the answer itself because it is this side's business
   * rather than the bridge's: the bridge was never told to stop, it simply
   * stopped being asked, and its half-measured scan is still sitting there
   * ready to carry on from exactly here.
   */
  stoppedAt: number | null;

  refresh(): Promise<void>;
  select(id: number | null, slot?: string | null): Promise<void>;
  /** Change part of the question and ask it again. */
  setFilters(patch: Partial<ItemFilters>): void;
  /** Stop a stat sort where it is, keeping what it has measured. */
  cancelScan(): void;
  /** Carry a stopped scan on from where it got to. */
  resumeScan(): void;
  /** Ask the current question again, because the build moved under it. */
  reask(): void;
  /** Ask the opening question once, so the list is not empty on arrival. */
  openDatabase(): void;
  /** The filter values, learned from the database. Asked once. */
  loadOptions(): Promise<void>;
  act(action: string, value?: unknown): Promise<string | null>;

  /** Put pasted text on the bench without equipping it. */
  stage(text: string): Promise<string | null>;
  /** The same, for an item picked out of PoB's database. */
  stageFromDb(name: string): Promise<string | null>;
  refreshStaged(): Promise<void>;
  /** Commit it, into a slot or wherever PoB would put it. */
  equipStaged(slot?: string): Promise<string | null>;
  clearStaged(): Promise<string | null>;
}

export const useItemsStore = create<ItemsStore>((set, get) => {
  /**
   * Which question the answers in flight belong to.
   *
   * A stat sort is driven in a loop of requests rather than one, so there
   * is always a chance the user has moved on between two of them. Bumping
   * this is how the loop learns to walk away from an answer nobody is
   * waiting for any more.
   */
  let generation = 0;

  /**
   * Ask, and keep asking while the bridge says it is still measuring.
   *
   * A stat sort runs the engine against every candidate item in every slot
   * it fits, which is a few hundred full passes: far too long for a single
   * request. The bridge spends a fixed budget on each one and reports how
   * far it got, so this drives it in a loop. That is what makes the
   * progress real rather than a spinner over an unknown wait, and it is
   * what makes stopping possible at all.
   */
  const ask = async (filters: ItemFilters) => {
    const mine = ++generation;
    // Deliberately not clearing the previous answer: a filter change is
    // answered in milliseconds, and blanking the list first would be a
    // flicker rather than feedback.
    set({ searching: true, stoppedAt: null });
    try {
      for (;;) {
        const found = await bridge.itemSearch(filters);
        if (generation !== mine) return;
        set({
          connection: 'live',
          results: found.results ?? [],
          found,
        });
        if (!found.scanning) return;
        // Yield to the browser between chunks. Without this the loop holds
        // the task queue for the whole scan and the progress bar goes
        // straight from nothing to finished.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (generation !== mine) return;
      }
    } catch {
      if (generation === mine) set({ results: [], found: null });
    } finally {
      if (generation === mine) set({ searching: false });
    }
  };

  const refreshStaged = async () => {
    set({ stagedLoading: true });
    try {
      const staged = await bridge.stagedItem();
      set({ staged: staged.ready ? staged : null });
    } catch {
      set({ staged: null });
    } finally {
      set({ stagedLoading: false });
    }
  };

  const refresh = async () => {
    try {
      const snapshot = await bridge.items();
      if (!snapshot.ready) {
        set({ connection: 'live', snapshot: null });
        return;
      }
      set({ connection: 'live', snapshot });

      // An item can vanish under the selection: deleted, or unequipped
      // from the slot it was being compared against. Re-reading it keeps
      // the detail honest rather than stale.
      const { selectedId, selectedSlot } = get();
      if (selectedId !== null) {
        if (snapshot.items.some((item) => item.id === selectedId)) {
          await get().select(selectedId, selectedSlot);
        } else {
          set({ selectedId: null, selectedSlot: null, detail: null });
        }
      }

      // Every delta on the bench is measured against the build as it was.
      // Equip something, move a roll, allocate a node, and all of them are
      // answers to a question nobody is asking any more, so they are asked
      // again. It costs a calculation per candidate slot, which is why
      // this only runs while something is actually staged.
      if (get().staged) await refreshStaged();
    } catch {
      set({ connection: 'offline' });
    }
  };

  return {
    connection: 'connecting',
    snapshot: null,
    selectedId: null,
    selectedSlot: null,
    detail: null,
    detailLoading: false,
    edit: null,
    staged: null,
    stagedLoading: false,
    filters: EMPTY_FILTERS,
    options: null,
    results: [],
    searching: false,
    found: null,
    stoppedAt: null,

    refresh,

    select: async (id, slot) => {
      if (id === null) {
        set({ selectedId: null, selectedSlot: null, detail: null, edit: null });
        return;
      }
      set({ selectedId: id, selectedSlot: slot ?? null, detailLoading: true });
      try {
        // Both together: the tooltip is what the item looks like and the
        // edit payload is what can be changed about it, and the panel
        // shows them side by side.
        const [detail, edit] = await Promise.all([
          bridge.item(id, slot ?? undefined),
          bridge.itemEdit(id),
        ]);
        // Another selection may have landed while these were in flight.
        if (get().selectedId === id) set({ detail, edit });
      } catch {
        if (get().selectedId === id) set({ detail: { ready: false }, edit: null });
      } finally {
        if (get().selectedId === id) set({ detailLoading: false });
      }
    },

    setFilters: (patch) => {
      const filters = { ...get().filters, ...patch };
      set({ filters });
      void ask(filters);
    },

    cancelScan: () => {
      // Nothing to call off on the bridge: it only works while it is being
      // asked. Walking away from the loop is the whole of cancelling.
      //
      // The last answer said it was still measuring, which stops being
      // true the moment nobody is asking, so it is corrected here. The
      // list is kept: it is a ranking of what did get measured, and
      // saying how far that goes is more use than throwing it away.
      generation += 1;
      const found = get().found;
      set({
        searching: false,
        stoppedAt: found?.scanned ?? 0,
        found: found ? { ...found, scanning: false } : null,
      });
    },

    // The bridge still holds the half-finished scan, keyed on this exact
    // question, so this genuinely carries on from where it stopped rather
    // than starting the measurements again.
    resumeScan: () => {
      void ask(get().filters);
    },

    // Only when the answer could have changed. A filtered list in name
    // order is pure data and cannot have moved, but a stat sort is
    // measured against the build, and the requirement filters are read
    // against its level and attributes.
    reask: () => {
      const { filters, found } = get();
      if (!found) return;
      if (filters.sort === 'name' && filters.req === 'any') return;
      void ask(filters);
    },

    // PoB's database list is populated from the moment the tab opens. An
    // empty panel would hide eight filters behind a search nobody knew to
    // type, and in name order the whole list costs a few milliseconds.
    openDatabase: () => {
      if (get().found) return;
      void ask(get().filters);
    },

    loadOptions: async () => {
      // Cached, because the database does not change while the app runs.
      // An answer taken while PoB was still parsing is not cached, or the
      // league list would be whichever half had loaded.
      const held = get().options;
      if (held?.ready && !held.loading) return;
      try {
        set({ options: await bridge.itemFilters() });
      } catch {
        // Left null. The controls fall back to the search box alone, and
        // the next mount asks again.
      }
    },

    /** Run a command and refresh. Returns the engine's reason on refusal. */
    act: async (action, value) => {
      try {
        await bridge.act(action, value);
        await refresh();
        return null;
      } catch (error) {
        // A refusal is an answer, "that item does not fit Boots", and is
        // worth showing rather than swallowing.
        await refresh();
        return error instanceof Error ? error.message : String(error);
      }
    },

    refreshStaged,

    stage: async (text) => {
      try {
        await bridge.act('stageItemText', { text });
      } catch (error) {
        // "that is not an item PoB recognises" is the engine's own answer
        // and the only failure worth reporting: everything else it parses
        // leniently and marks unsupported on the item itself.
        return error instanceof Error ? error.message : String(error);
      }
      await refreshStaged();
      return null;
    },

    // Not act(): a plain refresh only refetches the bench when something
    // is already on it, which is never true the first time an item is put
    // there, and the panel would stay hidden until the next reload.
    stageFromDb: async (name) => {
      try {
        await bridge.act('stageDbItem', { name });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      await refreshStaged();
      return null;
    },

    equipStaged: async (slot) => {
      // Staging is cleared by the engine on its way through
      // AddDisplayItem, so the panel goes away on its own rather than
      // being hidden here and contradicted by the next fetch.
      const refusal = await get().act('equipStagedItem', slot ? { slot } : {});
      await refreshStaged();
      return refusal;
    },

    clearStaged: async () => {
      const refusal = await get().act('clearStagedItem');
      await refreshStaged();
      return refusal;
    },
  };
});
