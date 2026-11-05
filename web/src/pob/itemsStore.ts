import { create } from 'zustand';
import { bridge } from './bridge';
import type {
  Connection,
  ItemDetail,
  ItemEdit,
  ItemSearchResult,
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

  query: string;
  results: ItemSearchResult[];
  searchTotal: number;
  searching: boolean;

  refresh(): Promise<void>;
  select(id: number | null, slot?: string | null): Promise<void>;
  search(query: string): Promise<void>;
  act(action: string, value?: unknown): Promise<string | null>;

  /** Put pasted text on the bench without equipping it. */
  stage(text: string): Promise<string | null>;
  refreshStaged(): Promise<void>;
  /** Commit it, into a slot or wherever PoB would put it. */
  equipStaged(slot?: string): Promise<string | null>;
  clearStaged(): Promise<string | null>;
}

export const useItemsStore = create<ItemsStore>((set, get) => {
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
    query: '',
    results: [],
    searchTotal: 0,
    searching: false,

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

    search: async (query) => {
      set({ query });
      if (query.trim().length < 2) {
        set({ results: [], searchTotal: 0, searching: false });
        return;
      }
      set({ searching: true });
      try {
        const found = await bridge.itemSearch(query.trim());
        // Only the latest query's results are kept; an earlier one landing
        // late would overwrite them with the wrong answer.
        if (get().query === query) {
          set({ results: found.results, searchTotal: found.total ?? found.results.length });
        }
      } catch {
        if (get().query === query) set({ results: [], searchTotal: 0 });
      } finally {
        if (get().query === query) set({ searching: false });
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
