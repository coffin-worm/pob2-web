import { create } from 'zustand';
import { bridge } from './bridge';
import type { CompareSnapshot, Connection } from './types';

/**
 * This build against another.
 *
 * One fetch, re-read whenever the engine recalculates — which is whenever
 * either side moves, since a comparison build is a full second
 * calculation rather than a stored snapshot.
 */
interface CompareStore {
  connection: Connection;
  snapshot: Extract<CompareSnapshot, { ready: true }> | null;
  error: string | null;
  busy: boolean;

  refresh(): Promise<void>;
  /** Run a command, refresh, and return the engine's reason on refusal. */
  run(work: () => Promise<unknown>): Promise<string | null>;
}

export const useCompareStore = create<CompareStore>((set) => {
  const refresh = async () => {
    try {
      const snapshot = await bridge.compare();
      set({
        connection: 'live',
        snapshot: snapshot.ready ? snapshot : null,
        error: snapshot.ready ? null : (snapshot.error ?? 'no comparison available'),
      });
    } catch (e) {
      set({ connection: 'offline', error: e instanceof Error ? e.message : String(e) });
    }
  };

  return {
    connection: 'connecting',
    snapshot: null,
    error: null,
    busy: false,

    refresh,

    run: async (work) => {
      set({ busy: true });
      try {
        await work();
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      } finally {
        set({ busy: false });
        await refresh();
      }
    },
  };
});
