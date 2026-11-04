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
} from './types';

/**
 * The passive tree.
 *
 * Three loads with very different lifetimes. The geometry — 4546 nodes, 5149
 * connectors, every node's stat lines and the names of its art, about 1 MB —
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
  reachable: Set<number>;
  backdrop: TreeBackdrop | null;

  load(): Promise<void>;
  refreshAlloc(): Promise<void>;
  toggle(id: number): Promise<void>;
}

export const useTreeStore = create<TreeStore>((set, get) => {
  const refreshAlloc = async () => {
    try {
      const snapshot = await bridge.treeAlloc();
      if (!snapshot.ready) return;
      set({
        connection: 'live',
        allocated: new Set(snapshot.allocated),
        reachable: new Set(snapshot.reachable),
        backdrop: snapshot.backdrop ?? null,
      });
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
    reachable: new Set(),
    backdrop: null,

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
        // answer -- it is not reachable -- and not worth an error state.
        await refreshAlloc();
      }
    },
  };
});
