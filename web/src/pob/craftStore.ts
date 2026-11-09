import { create } from 'zustand';
import { bridge } from './bridge';
import { useItemsStore } from './itemsStore';
import type { CorruptDraft, CraftBases, CraftState } from './types';

/**
 * Crafting the bench item.
 *
 * PoB crafts on `displayItem` and nowhere else, which is the same bench
 * this app already stages pasted and database items on. So this is a
 * second view of one thing, not a second place to put items, and every
 * change here has to move both: the affix rows below and the item's own
 * tooltip above.
 */
interface CraftStore {
  state: CraftState | null;
  /** The base lists for the create dialog. Asked for once. */
  bases: CraftBases | null;
  busy: boolean;

  refresh(): Promise<void>;
  loadBases(type?: string): Promise<void>;

  /** Make a new item and put it on the bench. */
  create(spec: {
    rarity: string;
    type: string;
    base: string;
    name?: string;
  }): Promise<string | null>;

  /** Put a tier in a slot, or, with a null modId, empty it. */
  setAffix(
    kind: 'prefix' | 'suffix',
    index: number,
    modId: string | null,
    roll?: number,
  ): Promise<string | null>;

  setQuality(quality: number): Promise<string | null>;

  /** Put a rune in a socket, or, with a null name, empty it. */
  setRune(index: number, name: string | null): Promise<string | null>;

  /** How many sockets of one kind the item has. */
  setSocketCount(kind: 'rune' | 'jewel', count: number): Promise<string | null>;

  /** Anoint a slot, or, with a null node, take its anoint off. */
  setAnoint(slot: number, node: number | null): Promise<string | null>;

  /**
   * Corrupt the item, which is the one crafting step with no way back.
   *
   * So this is the only command here that takes a whole draft rather than
   * one change: the implicits and the roll ranges are assembled in the
   * panel and committed once, the way PoB's dialog has a Cancel next to
   * its Corrupted button.
   */
  corrupt(draft: CorruptDraft): Promise<string | null>;
}

export const useCraftStore = create<CraftStore>((set) => {
  const refresh = async () => {
    try {
      set({ state: await bridge.craftState() });
    } catch {
      set({ state: null });
    }
  };

  /**
   * Run a command, then refresh both views.
   *
   * The bench tooltip is the item as PoB draws it, and crafting changes
   * exactly that, so refreshing the affix rows alone would leave the
   * picture above them describing the item as it used to be.
   */
  const run = async (action: string, value: unknown): Promise<string | null> => {
    set({ busy: true });
    try {
      await bridge.act(action, value);
      await Promise.all([refresh(), useItemsStore.getState().refreshStaged()]);
      return null;
    } catch (error) {
      // The engine's refusal is the answer, "this item cannot roll that",
      // and is worth showing rather than swallowing.
      await refresh();
      return error instanceof Error ? error.message : String(error);
    } finally {
      set({ busy: false });
    }
  };

  return {
    state: null,
    bases: null,
    busy: false,

    refresh,

    loadBases: async (type) => {
      try {
        set({ bases: await bridge.craftBases(type) });
      } catch {
        /* Left as it was; the dialog keeps whatever it already had. */
      }
    },

    create: (spec) => run('craftItem', spec),

    setAffix: (kind, index, modId, roll) =>
      run('setCraftAffix', { kind, index, modId, roll }),

    setQuality: (quality) => run('setCraftQuality', { quality }),

    setRune: (index, name) => run('setRune', { index, name }),

    setSocketCount: (kind, count) => run('setSocketCount', { kind, count }),

    // The key is left out rather than sent as null, because the engine's
    // "no node" is the gesture for removing the anoint and a JSON null
    // does not arrive on the other side as a missing field.
    setAnoint: (slot, node) =>
      run('setAnoint', node === null ? { slot } : { slot, node }),

    corrupt: (draft) => run('corruptItem', draft),
  };
});
