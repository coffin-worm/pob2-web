import { create } from 'zustand';
import { bridge } from './bridge';
import { TreeArt } from '../tree/art';
import type {
  Connection,
  TreeBackdrop,
  TreeBounds,
  TreeConnector,
  TreeFrameSet,
  TreeNode,
  TreeWhatIf,
} from './types';

/**
 * The passive tree.
 *
 * Three loads with very different lifetimes. The geometry (4546 nodes, 5149
 * connectors, every node's stat lines and the names of its art, about 1 MB)
 * does not change while a build is open, so it is fetched once. The artwork
 * is a static build product, also fetched once. The allocation on top of
 * both changes on every click and is small enough to refetch freely.
 */
interface TreeStore {
  connection: Connection;

  /** Geometry, loaded once. */
  loaded: boolean;
  nodes: TreeNode[];
  connectors: TreeConnector[];
  icons: string[];
  frameSets: TreeFrameSet[];
  bounds: TreeBounds | null;
  /** Node lookup, built once so hit-testing and drawing do not rebuild it. */
  byId: Map<number, TreeNode>;
  /**
   * Arcs the bridge could not verify against PoB's own centres. Should be
   * zero; surfaced rather than swallowed because the failure mode is a tree
   * that looks almost right.
   */
  arcErrors: number;

  /** Artwork, or null when it has not been extracted. */
  art: TreeArt | null;

  /** Allocation, refreshed on change. */
  allocated: Set<number>;
  /** Reachable node id to what clicking it would cost in new points. */
  reachable: Map<number, number>;
  backdrop: TreeBackdrop | null;

  /**
   * The route a hovered node would allocate.
   *
   * Cached per node for as long as the allocation holds: the answer only
   * changes when the tree does, and hovering back and forth across a
   * cluster should not re-ask the engine for something it already said.
   */
  preview: { id: number; path: number[]; cost: number } | null;
  previewPath(id: number | null): Promise<void>;

  /**
   * What the hovered node would be worth, once asked.
   *
   * Two full recalculations, so this is not asked on every node the
   * pointer crosses: the view waits for a dwell. PoB answers the same
   * question instantly because it is in-process, and gates it behind
   * Ctrl+D anyway for the same reason it costs something.
   */
  delta: { id: number; whatIf: TreeWhatIf } | null;
  previewDelta(id: number | null): Promise<void>;

  /** PoB's Ctrl+D, which is a real switch there and so is one here. */
  showDeltas: boolean;
  setShowDeltas(on: boolean): void;

  load(): Promise<void>;
  refreshAlloc(): Promise<void>;
  toggle(id: number): Promise<void>;
}

export const useTreeStore = create<TreeStore>((set, get) => {
  const pathCache = new Map<number, { path: number[]; cost: number }>();
  // Keyed by node, emptied whenever the allocation moves, which is the
  // only thing that can change what a node is worth without the build
  // itself changing. refreshAlloc runs on every outputRevision, so this
  // follows the build rather than a clock.
  const deltaCache = new Map<number, TreeWhatIf>();

  // Remembered per viewer, the way PoB remembers its own switch. A failure
  // to read it is not worth an error: the default is simply used.
  const readShowDeltas = () => {
    try {
      return window.localStorage.getItem('pob.tree.deltas') !== 'off';
    } catch {
      return true;
    }
  };

  const refreshAlloc = async () => {
    try {
      const snapshot = await bridge.treeAlloc();
      if (!snapshot.ready) return;
      set({
        connection: 'live',
        allocated: new Set(snapshot.allocated),
        reachable: new Map(snapshot.reachable),
        backdrop: snapshot.backdrop ?? null,
        preview: null,
      });
      // Every cached route is about the tree as it was.
      pathCache.clear();
      deltaCache.clear();
    } catch {
      set({ connection: 'offline' });
    }
  };

  return {
    connection: 'connecting',
    loaded: false,
    nodes: [],
    connectors: [],
    icons: [],
    frameSets: [],
    bounds: null,
    byId: new Map(),
    arcErrors: 0,
    art: null,
    allocated: new Set(),
    reachable: new Map(),
    backdrop: null,
    preview: null,
    delta: null,
    showDeltas: readShowDeltas(),

    setShowDeltas: (on) => {
      try {
        window.localStorage.setItem('pob.tree.deltas', on ? 'on' : 'off');
      } catch {
        // A refused write costs the preference, not the feature.
      }
      set({ showDeltas: on, delta: on ? get().delta : null });
    },

    previewDelta: async (id) => {
      if (id === null || !get().showDeltas) {
        if (get().delta) set({ delta: null });
        return;
      }
      if (get().delta?.id === id) return;

      const cached = deltaCache.get(id);
      if (cached) {
        set({ delta: { id, whatIf: cached } });
        return;
      }
      try {
        const whatIf = await bridge.treeWhatIf(id);
        deltaCache.set(id, whatIf);
        // The pointer may have moved on, or the switch been thrown,
        // while two recalculations were in flight.
        if (get().showDeltas) set({ delta: { id, whatIf } });
      } catch {
        // A node the engine will not price is not an error worth
        // showing; the tooltip simply carries no comparison.
      }
    },

    previewPath: async (id) => {
      if (id === null) {
        if (get().preview) set({ preview: null });
        return;
      }
      if (get().preview?.id === id) return;

      const cached = pathCache.get(id);
      if (cached) {
        set({ preview: { id, ...cached } });
        return;
      }
      try {
        const result = await bridge.treePath(id);
        if (!result.ready) return;
        pathCache.set(id, { path: result.path, cost: result.cost });
        // The pointer may have moved on while this was in flight.
        if (get().reachable.has(id) || get().allocated.has(id)) {
          set({ preview: { id, path: result.path, cost: result.cost } });
        }
      } catch {
        // A route the engine will not give is not an error worth showing;
        // the node simply gets no preview.
      }
    },

    load: async () => {
      if (get().loaded) return;

      // The art is static and the geometry comes from the engine, so neither
      // waits on the other.
      const art = TreeArt.load().then((loaded) => set({ art: loaded }));

      try {
        const snapshot = await bridge.tree();
        if (!snapshot.ready) return;
        set({
          connection: 'live',
          loaded: true,
          nodes: snapshot.nodes,
          connectors: snapshot.connectors,
          icons: snapshot.icons,
          frameSets: snapshot.frameSets,
          bounds: snapshot.bounds,
          arcErrors: snapshot.arcErrors,
          byId: new Map(snapshot.nodes.map((node) => [node.id, node])),
        });
        await refreshAlloc();
      } catch {
        set({ connection: 'offline' });
      }
      await art;
    },

    refreshAlloc,

    // Allocation is the engine's: clicking a node three steps away allocates
    // the route to it, because AllocNode walks the node's own path.
    toggle: async (id) => {
      try {
        await bridge.act('toggleNode', id);
        await refreshAlloc();
      } catch {
        // A node with no path is refused by the engine. That is a legitimate
        // answer: it is not reachable, and not worth an error state.
        await refreshAlloc();
      }
    },
  };
});
