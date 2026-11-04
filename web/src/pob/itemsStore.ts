import { create } from 'zustand';
import { bridge } from './bridge';
import type {
  Connection,
  ItemDetail,
  ItemEdit,
  ItemSearchResult,
  ItemsSnapshot,
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

  query: string;
  results: ItemSearchResult[];
  searchTotal: number;
  searching: boolean;

  refresh(): Promise<void>;
  select(id: number | null, slot?: string | null): Promise<void>;
  search(query: string): Promise<void>;
  act(action: string, value?: unknown): Promise<string | null>;
}

export const useItemsStore = create<ItemsStore>((set, get) => {
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
  };
});
