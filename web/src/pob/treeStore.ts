import { create } from 'zustand';
import { bridge } from './bridge';
import type { Connection, TreeBounds, TreeNode } from './types';

/**
 * The passive tree.
 *
 * Two fetches with very different lifetimes. The geometry — 4546 nodes and
 * 5187 edges, about 420 kB — does not change while a build is open, so it is
 * fetched once. The allocation on top of it changes on every click, and is
 * small enough to refetch freely.
 */
interface TreeStore {
  connection: Connection;

  /** Geometry, loaded once. */
  loaded: boolean;
  nodes: TreeNode[];
  edges: [number, number][];
  bounds: TreeBounds | null;
  /** Node lookup, built once so hit-testing and drawing do not rebuild it. */
  byId: Map<number, TreeNode>;

  /** Allocation, refreshed on change. */
  allocated: Set<number>;
  reachable: Set<number>;

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
      });
    } catch {
      set({ connection: 'offline' });
    }
  };

  return {
    connection: 'connecting',
    loaded: false,
    nodes: [],
    edges: [],
    bounds: null,
    byId: new Map(),
    allocated: new Set(),
    reachable: new Set(),

    load: async () => {
      if (get().loaded) return;
      try {
        const snapshot = await bridge.tree();
        if (!snapshot.ready) return;
        set({
          connection: 'live',
          loaded: true,
          nodes: snapshot.nodes,
          edges: snapshot.edges,
          bounds: snapshot.bounds,
          byId: new Map(snapshot.nodes.map((node) => [node.id, node])),
        });
        await refreshAlloc();
      } catch {
        set({ connection: 'offline' });
      }
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
