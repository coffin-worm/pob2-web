import { create } from 'zustand';
import { bridge } from './bridge';
import type { CalcSection, CalcSelector, CalcsSnapshot, Connection } from './types';

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

  refresh(): Promise<void>;
  setSocketGroup(id: number): void;
  setSkill(id: number): void;
}

export const useCalcsStore = create<CalcsStore>((set) => {
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

  const refresh = async () => {
    try {
      apply(await bridge.calcs());
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

    refresh,
    // The Calcs tab details whichever skill it is pointed at, which PoB keeps
    // separate from the sidebar's main skill on purpose.
    setSocketGroup: (id) => run('setCalcsSocketGroup', id),
    setSkill: (id) => run('setCalcsSkill', id),
  };
});
