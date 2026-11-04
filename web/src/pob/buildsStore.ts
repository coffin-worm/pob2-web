import { create } from 'zustand';
import { bridge } from './bridge';
import type { BuildSort, BuildsSnapshot, Connection } from './types';

/**
 * The builds folder.
 *
 * One fetch, re-read whenever the engine recalculates: saving moves a
 * file's modified time and opening moves which row is the open one. The
 * scan itself is PoB's `BuildListHelpers`, which reads each build's class
 * and level out of the first 2 kB of the file rather than loading it.
 */
interface BuildsStore {
  connection: Connection;
  snapshot: Extract<BuildsSnapshot, { ready: true }> | null;
  error: string | null;
  sort: BuildSort;
  busy: boolean;

  refresh(): Promise<void>;
  setSort(sort: BuildSort): Promise<void>;
  /** Run a command, refresh, and return the engine's reason on refusal. */
  run(work: () => Promise<unknown>): Promise<string | null>;
}

export const useBuildsStore = create<BuildsStore>((set, get) => {
  const refresh = async () => {
    try {
      const snapshot = await bridge.builds(get().sort);
      set({
        connection: 'live',
        snapshot: snapshot.ready ? snapshot : null,
        error: snapshot.ready ? null : (snapshot.error ?? 'no builds folder'),
      });
    } catch (e) {
      set({ connection: 'offline', error: e instanceof Error ? e.message : String(e) });
    }
  };

  return {
    connection: 'connecting',
    snapshot: null,
    error: null,
    sort: 'EDITED',
    busy: false,

    refresh,

    setSort: async (sort) => {
      set({ sort });
      await refresh();
    },

    run: async (work) => {
      set({ busy: true });
      try {
        await work();
        return null;
      } catch (e) {
        // A refusal is an answer, "that build is open; open another one
        // first", and worth showing rather than swallowing.
        return e instanceof Error ? e.message : String(e);
      } finally {
        set({ busy: false });
        await refresh();
      }
    },
  };
});
