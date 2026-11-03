import { create } from 'zustand';
import { bridge } from './bridge';
import type { Connection, NamedOption, StatLine, StatsSnapshot } from './types';

/**
 * The stat sidebar.
 *
 * A separate store and a separate poll from the header's. The sidebar is an
 * order of magnitude more data and is the thing a recalculation actually
 * changes, so the two are free to move at different rates later without one
 * dragging the other.
 */
interface StatsStore {
  connection: Connection;
  ready: boolean;
  engineError: string | null;

  lines: StatLine[];
  warnings: string[];
  socketGroupId: number;
  socketGroups: NamedOption[];
  skillId: number;
  skills: NamedOption[];

  refresh(): Promise<void>;
  setSocketGroup(id: number): void;
  setMainSkill(id: number): void;
}

export const useStatsStore = create<StatsStore>((set) => {
  const apply = (snapshot: StatsSnapshot) => {
    if (!snapshot.ready) {
      set({
        connection: 'live',
        ready: false,
        engineError: snapshot.engineError ?? null,
        lines: [],
        warnings: [],
      });
      return;
    }
    set({
      connection: 'live',
      ready: true,
      engineError: snapshot.engineError ?? null,
      lines: snapshot.lines,
      warnings: snapshot.warnings,
      socketGroupId: snapshot.socketGroupId,
      socketGroups: snapshot.socketGroups,
      skillId: snapshot.skillId,
      skills: snapshot.skills,
    });
  };

  const run = async (call: () => Promise<unknown>) => {
    try {
      await call();
      apply(await bridge.stats());
    } catch {
      set({ connection: 'offline' });
    }
  };

  return {
    connection: 'connecting',
    ready: false,
    engineError: null,
    lines: [],
    warnings: [],
    socketGroupId: 1,
    socketGroups: [],
    skillId: 1,
    skills: [],

    refresh: async () => {
      try {
        apply(await bridge.stats());
      } catch {
        set({ connection: 'offline' });
      }
    },

    // These change what the engine calculates, so the answer is a fresh
    // sidebar rather than a patched one.
    setSocketGroup: (id) => {
      void run(() => bridge.act('setSocketGroup', id));
    },
    setMainSkill: (id) => {
      void run(() => bridge.act('setMainSkill', id));
    },
  };
});

export function startStatsPolling(intervalMs = 1000): () => void {
  const tick = () => {
    void useStatsStore.getState().refresh();
  };
  tick();
  const timer = window.setInterval(tick, intervalMs);
  return () => window.clearInterval(timer);
}
