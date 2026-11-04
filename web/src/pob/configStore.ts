import { create } from 'zustand';
import { bridge } from './bridge';
import type { ConfigSnapshot, ConfigValue, Connection } from './types';

/**
 * The configuration screen.
 *
 * One fetch, refreshed whenever the engine recalculates — which is also
 * whenever an option changes, since every option feeds the mod list. The
 * payload is 22 kB for the options a build actually uses and 98 kB with
 * "show all" on, which is why that is a toggle rather than the default.
 */
interface ConfigStore {
  connection: Connection;
  snapshot: Extract<ConfigSnapshot, { ready: true }> | null;

  refresh(): Promise<void>;
  set(name: string, value: ConfigValue | null): Promise<string | null>;
  act(action: string, value?: unknown): Promise<string | null>;
}

export const useConfigStore = create<ConfigStore>((set) => {
  const refresh = async () => {
    try {
      const snapshot = await bridge.config();
      set({ connection: 'live', snapshot: snapshot.ready ? snapshot : null });
    } catch {
      set({ connection: 'offline' });
    }
  };

  const act = async (action: string, value?: unknown) => {
    try {
      await bridge.act(action, value);
      await refresh();
      return null;
    } catch (error) {
      // A refusal is an answer — "-999 is not an option for
      // resistancePenalty" — and worth showing rather than swallowing.
      await refresh();
      return error instanceof Error ? error.message : String(error);
    }
  };

  return {
    connection: 'connecting',
    snapshot: null,
    refresh,
    act,

    // null clears the option back to its default, which is what emptying
    // the field does in PoB.
    set: (name, value) => act('setConfig', { var: name, value }),
  };
});
