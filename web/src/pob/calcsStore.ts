import { create } from 'zustand';
import { bridge } from './bridge';
import type {
  CalcBreakdown,
  CalcSection,
  CalcSelector,
  CalcsSnapshot,
  Connection,
} from './types';

/**
 * The Calcs tab.
 *
 * Not polled. Building it runs CheckFlag over a thousand rows and formats
 * every survivor, which is cheap (single-digit milliseconds) but pointless
 * to repeat when nothing has changed. `buildMode.outputRevision` moves on
 * every recalculation, so the app refetches on that instead of on a timer.
 */
interface CalcsStore {
  connection: Connection;
  ready: boolean;
  sections: CalcSection[];
  rowCount: number;
  buildMs: number;
  selector: CalcSelector | null;

  /**
   * The cell whose working is on screen, if any.
   *
   * `label` and `value` are kept beside the answer because the panel
   * names what it is explaining, and the row it came from scrolls away.
   */
  opened: { ref: string; label: string; value: string } | null;
  breakdown: CalcBreakdown | null;
  breakdownLoading: boolean;

  refresh(): Promise<void>;
  setSocketGroup(id: number): void;
  setSkill(id: number): void;
  openBreakdown(ref: string, label: string, value: string): Promise<void>;
  closeBreakdown(): void;
}

export const useCalcsStore = create<CalcsStore>((set, get) => {
  const apply = (snapshot: CalcsSnapshot) => {
    if (!snapshot.ready) {
      set({ connection: 'live', ready: false, sections: [], rowCount: 0 });
      return;
    }
    set({
      connection: 'live',
      ready: true,
      sections: snapshot.sections,
      rowCount: snapshot.rowCount,
      buildMs: snapshot.buildMs,
      selector: snapshot.selector,
    });
  };

  const loadBreakdown = async (ref: string) => {
    set({ breakdownLoading: true });
    try {
      const breakdown = await bridge.calcsBreakdown(ref);
      // The pointer may have moved to another cell, or closed the panel,
      // while this was in flight.
      if (get().opened?.ref === ref) set({ breakdown });
    } catch (error) {
      if (get().opened?.ref === ref) {
        set({
          breakdown: {
            ready: false,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    } finally {
      if (get().opened?.ref === ref) set({ breakdownLoading: false });
    }
  };

  const refresh = async () => {
    try {
      apply(await bridge.calcs());
      // PoB rebuilds a pinned breakdown after every recalculation, and so
      // does this: the working behind a number is about the build as it
      // is now, and a stale one is worse than none because it reads as
      // current. The cell reference survives because it addresses
      // positions in PoB's tables, which the recalculation does not move.
      const opened = get().opened;
      if (opened) await loadBreakdown(opened.ref);
    } catch {
      set({ connection: 'offline' });
    }
  };

  const run = (action: string, value: number) => {
    void (async () => {
      try {
        await bridge.act(action, value);
        await refresh();
      } catch {
        set({ connection: 'offline' });
      }
    })();
  };

  return {
    connection: 'connecting',
    ready: false,
    sections: [],
    rowCount: 0,
    buildMs: 0,
    selector: null,
    opened: null,
    breakdown: null,
    breakdownLoading: false,

    refresh,

    openBreakdown: async (ref, label, value) => {
      // Clicking the open cell again closes it, which is PoB's behaviour
      // and the gesture people try first.
      if (get().opened?.ref === ref) {
        set({ opened: null, breakdown: null });
        return;
      }
      set({ opened: { ref, label, value }, breakdown: null });
      await loadBreakdown(ref);
    },

    closeBreakdown: () => set({ opened: null, breakdown: null }),

    // The Calcs tab details whichever skill it is pointed at, which PoB keeps
    // separate from the sidebar's main skill on purpose.
    setSocketGroup: (id) => run('setCalcsSocketGroup', id),
    setSkill: (id) => run('setCalcsSkill', id),
  };
});
