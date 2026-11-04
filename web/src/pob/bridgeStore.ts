import { create } from 'zustand';
import { bridge } from './bridge';
import type {
  BridgeSnapshot,
  Connection,
  EnginePopup,
  HeaderActions,
  HeaderState,
} from './types';

/**
 * The header's state, backed by the real engine.
 *
 * This replaces mockStore. The shape above it is unchanged -- Header still
 * takes HeaderState and HeaderActions -- which is the whole point of having
 * written the contract from the Lua field names in the first place.
 *
 * Commands are deliberately not optimistic. The engine owns the state and
 * answers with a new snapshot, and some commands do not do what was asked:
 * changing class with an allocated passive tree opens a confirmation dialog
 * instead. Showing the change before the engine agreed to it would mean the
 * UI and the build disagreeing, which is worse than a frame of latency on
 * loopback.
 */

const BLANK: HeaderState = {
  buildName: '',
  unsaved: false,
  dbFileName: null,
  characterLevel: 1,
  levelAutoMode: false,
  classId: 0,
  classes: [],
  ascendClassId: 0,
  ascendancies: [],
  loadoutId: 0,
  loadouts: [],
  points: {
    passives: { used: 0, max: 0 },
    weaponSet1: { used: 0, max: 0 },
    weaponSet2: { used: 0, max: 0 },
    ascendancy: { used: 0, max: 0 },
  },
};

interface BridgeStore extends HeaderState, HeaderActions {
  connection: Connection;
  /** The engine is reachable but may have no build open. */
  ready: boolean;
  popup: EnginePopup | null;
  /** A transport failure: the engine could not be reached. */
  error: string | null;
  /**
   * An error PoB recorded inside its own frame handler. The process is alive
   * and answering; the build's calculations are not running.
   */
  engineError: string | null;

  refresh(): Promise<void>;
  newBuild(): Promise<void>;
  /** Close a modal the engine is blocked on, without answering it. */
  dismissPopup(): void;
  /** Press one of the open dialog's buttons. */
  answerPopup(key: string): void;
  /** Clear a recorded engine error. Does not repair the build. */
  dismissError(): Promise<void>;
}

export const useBridgeStore = create<BridgeStore>((set) => {
  const apply = (snapshot: BridgeSnapshot) => {
    if (!snapshot.ready) {
      set({
        connection: 'live',
        ready: false,
        error: null,
        engineError: snapshot.engineError ?? null,
      });
      return;
    }
    const { ready: _ready, popup, engineError, ...state } = snapshot;
    set({
      ...state,
      ready: true,
      popup: popup ?? null,
      engineError: engineError ?? null,
      connection: 'live',
      error: null,
    });
  };

  const run = async (call: () => Promise<BridgeSnapshot>) => {
    try {
      apply(await call());
    } catch (cause) {
      set({
        connection: 'offline',
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  /** HeaderActions are fire-and-forget; the snapshot arrives through the store. */
  const command = (action: string, value?: unknown) => () => {
    void run(() => bridge.act(action, value));
  };

  return {
    ...BLANK,
    connection: 'connecting',
    ready: false,
    popup: null,
    error: null,
    engineError: null,

    refresh: () => run(() => bridge.state()),
    newBuild: () => run(() => bridge.newBuild()),
    dismissPopup: command('dismissPopup'),
    answerPopup: (key: string) => {
      void run(() => bridge.act('answerPopup', { button: key }));
    },
    dismissError: () =>
      run(async () => {
        await bridge.dismissError();
        return bridge.state();
      }),

    save: command('save'),
    saveAs: command('saveAs'),
    back: command('back'),

    setCharacterLevel: (level) => command('setCharacterLevel', level)(),
    setLevelAutoMode: (auto) => command('setLevelAutoMode', auto)(),
    setClass: (classId) => command('setClass', classId)(),
    setAscendancy: (ascendClassId) => command('setAscendancy', ascendClassId)(),
    setLoadout: (loadoutId) => command('setLoadout', loadoutId)(),
    setBuildName: (name) => command('setBuildName', name)(),
  };
});

/**
 * Poll the engine.
 *
 * Needed even though commands return a snapshot: a recalculation settles over
 * frames, and the build can also change from outside this UI. One second is
 * slow enough to be free and fast enough that nothing looks stale.
 */
export function startPolling(intervalMs = 1000): () => void {
  const tick = () => {
    void useBridgeStore.getState().refresh();
  };
  tick();
  const timer = window.setInterval(tick, intervalMs);
  return () => window.clearInterval(timer);
}
