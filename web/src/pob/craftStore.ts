import { create } from 'zustand';
import { bridge } from './bridge';
import { useItemsStore } from './itemsStore';
import type { CraftBases, CraftState } from './types';

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
  };
});
