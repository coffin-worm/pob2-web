import { create } from 'zustand';
import { bridge } from './bridge';
import type {
  Connection,
  GemSearchResult,
  SkillDetail,
  SkillsSnapshot,
} from './types';

/**
 * The skills screen.
 *
 * The group list is small and refetched on every recalculation. One group's
 * gems come with it when a group is expanded, because the engine has to
 * reprocess that group to resolve its gems anyway. The two tooltips (what
 * a group does, and what a gem does) are fetched on demand.
 */
interface SkillsStore {
  connection: Connection;
  snapshot: Extract<SkillsSnapshot, { ready: true }> | null;

  /** The expanded socket group. */
  groupIndex: number | null;
  /** The gem whose panel is open, within that group. */
  gemIndex: number | null;
  detail: SkillDetail | null;
  detailLoading: boolean;

  query: string;
  results: GemSearchResult[];
  searchTotal: number;
  searching: boolean;

  refresh(): Promise<void>;
  openGroup(index: number | null): Promise<void>;
  openGem(index: number | null): Promise<void>;
  search(query: string): Promise<void>;
  act(action: string, value?: unknown): Promise<string | null>;
}

export const useSkillsStore = create<SkillsStore>((set, get) => {
  /** Whichever panel is open: the gem's, or the group's. */
  const loadDetail = async () => {
    const { groupIndex, gemIndex } = get();
    if (groupIndex === null) {
      set({ detail: null });
      return;
    }
    set({ detailLoading: true });
    const token = `${groupIndex}:${gemIndex}`;
    try {
      const detail =
        gemIndex === null
          ? await bridge.socketGroup(groupIndex)
          : await bridge.gem(groupIndex, gemIndex);
      // Another selection may have landed while this was in flight.
      if (`${get().groupIndex}:${get().gemIndex}` === token) set({ detail });
    } catch {
      if (`${get().groupIndex}:${get().gemIndex}` === token) set({ detail: { ready: false } });
    } finally {
      if (`${get().groupIndex}:${get().gemIndex}` === token) set({ detailLoading: false });
    }
  };

  const refresh = async () => {
    try {
      const snapshot = await bridge.skills(get().groupIndex ?? undefined);
      if (!snapshot.ready) {
        set({ connection: 'live', snapshot: null });
        return;
      }
      set({ connection: 'live', snapshot });

      // A group can vanish under the selection: deleting one, or switching
      // skill sets, renumbers the list.
      const { groupIndex, gemIndex } = get();
      if (groupIndex !== null && !snapshot.groups.some((g) => g.index === groupIndex)) {
        set({ groupIndex: null, gemIndex: null, detail: null });
        return;
      }
      if (gemIndex !== null && !(snapshot.gems ?? []).some((g) => g.index === gemIndex)) {
        set({ gemIndex: null });
      }
      if (groupIndex !== null) await loadDetail();
    } catch {
      set({ connection: 'offline' });
    }
  };

  return {
    connection: 'connecting',
    snapshot: null,
    groupIndex: null,
    gemIndex: null,
    detail: null,
    detailLoading: false,
    query: '',
    results: [],
    searchTotal: 0,
    searching: false,

    refresh,

    openGroup: async (index) => {
      // Opening a different group closes whichever gem was open in the old
      // one: the index means nothing outside its group.
      set({ groupIndex: index, gemIndex: null, detail: null });
      await refresh();
    },

    openGem: async (index) => {
      set({ gemIndex: index });
      await loadDetail();
    },

    search: async (query) => {
      set({ query });
      if (query.trim().length < 2) {
        set({ results: [], searchTotal: 0, searching: false });
        return;
      }
      set({ searching: true });
      try {
        const found = await bridge.gemSearch(query.trim());
        if (get().query === query) {
          set({ results: found.results, searchTotal: found.total ?? found.results.length });
        }
      } catch {
        if (get().query === query) set({ results: [], searchTotal: 0 });
      } finally {
        if (get().query === query) set({ searching: false });
      }
    },

    act: async (action, value) => {
      try {
        await bridge.act(action, value);
        await refresh();
        return null;
      } catch (error) {
        // A refusal is an answer, "that group comes from Tabula Rasa and
        // cannot be deleted", and is worth showing rather than swallowing.
        await refresh();
        return error instanceof Error ? error.message : String(error);
      }
    },
  };
});
