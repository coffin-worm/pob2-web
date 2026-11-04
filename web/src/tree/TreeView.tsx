import { useEffect, useMemo, useRef, useState } from 'react';
import { useTreeStore } from '../pob/treeStore';
import type { TreeNode } from '../pob/types';
import styles from './TreeView.module.css';

/**
 * The passive tree.
 *
 * Canvas rather than SVG, and not as a preference: the tree is 4546 nodes
 * and 5187 edges, so an SVG would be about ten thousand elements for the
 * browser to lay out and hit-test on every pan. Canvas draws it as five
 * batched paths, and hit-testing is a distance check this file does itself.
 *
 * Everything meaningful is still the engine's. Node positions are PoB's,
 * resolved from group/orbit/orbitIndex at tree load; reachability is its
 * `node.path`; and a click sends `toggleNode` so AllocNode walks the route
 * to a distant node exactly as it does in the desktop app.
 */

/** Tree-space radii, tuned against PoB's own node spacing. */
const RADIUS: Record<string, number> = {
  Normal: 36,
  Notable: 64,
  Keystone: 92,
  Socket: 52,
  ClassStart: 104,
  AscendClassStart: 68,
};

const EDGE_WIDTH = 9;
const MIN_SCALE = 0.012;
const MAX_SCALE = 0.9;
const LABEL_WIDTH = 290;

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface Hover {
  node: TreeNode;
  /** Where to put the label, in the wrapper's own coordinates. */
  sx: number;
  sy: number;
}

const radiusOf = (node: TreeNode) => RADIUS[node.type] ?? RADIUS.Normal;

export function TreeView() {
  const loaded = useTreeStore((s) => s.loaded);
  const nodes = useTreeStore((s) => s.nodes);
  const edges = useTreeStore((s) => s.edges);
  const bounds = useTreeStore((s) => s.bounds);
  const allocated = useTreeStore((s) => s.allocated);
  const reachable = useTreeStore((s) => s.reachable);
  const load = useTreeStore((s) => s.load);
  const toggle = useTreeStore((s) => s.toggle);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 0.05 });
  const fittedRef = useRef(false);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const hoverRef = useRef<TreeNode | null>(null);

  const [hover, setHover] = useState<Hover | null>(null);
  const [dragging, setDragging] = useState(false);
  const [frameMs, setFrameMs] = useState(0);

  // Ascendancy nodes sit in their own groups thousands of units from the
  // main tree, which is why PoB draws them as a separate overlay. They are
  // left out here rather than dragged into a view they do not belong in.
  const { drawNodes, drawEdges } = useMemo(() => {
    const kept = nodes.filter((node) => !node.ascendancy);
    const index = new Map(kept.map((node) => [node.id, node]));
    const pairs: [TreeNode, TreeNode][] = [];
    for (const [a, b] of edges) {
      const from = index.get(a);
      const to = index.get(b);
      if (from && to) pairs.push([from, to]);
    }
    return { drawNodes: kept, drawEdges: pairs };
  }, [nodes, edges]);

  useEffect(() => {
    void load();
  }, [load]);

  // Fit the whole tree on first sight, once there is something to fit.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!bounds || !wrap || fittedRef.current) return;
    const { clientWidth: w, clientHeight: h } = wrap;
    if (w === 0 || h === 0) return;
    cameraRef.current = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
      scale:
        Math.min(w / (bounds.maxX - bounds.minX), h / (bounds.maxY - bounds.minY)) * 0.92,
    };
    fittedRef.current = true;
  }, [bounds]);

  // One render loop, driven by refs. Panning through React state would mean
  // a reconcile per mouse move for a canvas React does not draw anyway.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    let raf = 0;
    // A rolling average reported on a clock rather than a frame count. An
    // average over N frames reads zero until N have happened, which is
    // exactly wrong when frames are scarce -- a backgrounded tab would claim
    // it was drawing instantly.
    let ema = 0;
    let lastReport = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);

      const started = performance.now();
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w === 0 || h === 0) return;

      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const cam = cameraRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      ctx.save();
      ctx.translate(w / 2, h / 2);
      ctx.scale(cam.scale, cam.scale);
      ctx.translate(-cam.x, -cam.y);

      // Everything below is in tree units. Culling to the viewport is what
      // keeps a zoomed-in frame cheap rather than always paying for 4115.
      const halfW = w / 2 / cam.scale;
      const halfH = h / 2 / cam.scale;
      const pad = 200;
      const left = cam.x - halfW - pad;
      const right = cam.x + halfW + pad;
      const top = cam.y - halfH - pad;
      const bottom = cam.y + halfH + pad;
      const visible = (n: TreeNode) =>
        n.x >= left && n.x <= right && n.y >= top && n.y <= bottom;

      // Two stroke calls for the edges rather than 5187.
      const dimEdges = new Path2D();
      const litEdges = new Path2D();
      for (const [a, b] of drawEdges) {
        if (!visible(a) && !visible(b)) continue;
        const path = allocated.has(a.id) && allocated.has(b.id) ? litEdges : dimEdges;
        path.moveTo(a.x, a.y);
        path.lineTo(b.x, b.y);
      }
      ctx.lineWidth = EDGE_WIDTH;
      ctx.strokeStyle = '#2b2f38';
      ctx.stroke(dimEdges);
      ctx.lineWidth = EDGE_WIDTH * 2;
      ctx.strokeStyle = '#6e8fff';
      ctx.stroke(litEdges);

      // Three fill calls for the nodes, by state.
      const dim = new Path2D();
      const open = new Path2D();
      const lit = new Path2D();
      for (const node of drawNodes) {
        if (!visible(node)) continue;
        const r = radiusOf(node);
        const path = allocated.has(node.id) ? lit : reachable.has(node.id) ? open : dim;
        path.moveTo(node.x + r, node.y);
        path.arc(node.x, node.y, r, 0, Math.PI * 2);
      }
      ctx.fillStyle = '#23262e';
      ctx.fill(dim);
      ctx.fillStyle = '#3c4250';
      ctx.fill(open);
      ctx.fillStyle = '#6e8fff';
      ctx.fill(lit);

      const hovered = hoverRef.current;
      if (hovered) {
        ctx.lineWidth = 3 / cam.scale;
        ctx.strokeStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(hovered.x, hovered.y, radiusOf(hovered) + 14 / cam.scale, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();

      const cost = performance.now() - started;
      ema = ema === 0 ? cost : ema * 0.9 + cost * 0.1;
      if (started - lastReport > 500) {
        lastReport = started;
        setFrameMs(Number(ema.toFixed(2)));
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [drawNodes, drawEdges, allocated, reachable]);

  const toTree = (clientX: number, clientY: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const cam = cameraRef.current;
    return {
      x: (clientX - rect.left - rect.width / 2) / cam.scale + cam.x,
      y: (clientY - rect.top - rect.height / 2) / cam.scale + cam.y,
      localX: clientX - rect.left,
      localY: clientY - rect.top,
    };
  };

  /**
   * Nearest node whose radius contains the point. A linear scan over 4115
   * nodes costs well under a millisecond, so there is no spatial index here
   * to be kept in step with anything.
   */
  const nodeAt = (treeX: number, treeY: number) => {
    let best: TreeNode | null = null;
    let bestDistance = Infinity;
    for (const node of drawNodes) {
      const dx = node.x - treeX;
      const dy = node.y - treeY;
      const distance = dx * dx + dy * dy;
      const r = radiusOf(node) * 1.4;
      if (distance < r * r && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  };

  const clearHover = () => {
    if (hoverRef.current) {
      hoverRef.current = null;
      setHover(null);
    }
  };

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        data-dragging={dragging}
        data-over={hover !== null}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          if (drag) {
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
              drag.moved = true;
              // A label pinned to where the cursor was is wrong the moment
              // the tree moves under it.
              clearHover();
            }
            const cam = cameraRef.current;
            cam.x -= dx / cam.scale;
            cam.y -= dy / cam.scale;
            drag.x = e.clientX;
            drag.y = e.clientY;
            return;
          }

          const { x, y, localX, localY } = toTree(e.clientX, e.clientY);
          const found = nodeAt(x, y);
          // Only a change of node is worth a re-render; within one node the
          // label should stay put rather than chase the cursor.
          if (found?.id !== hoverRef.current?.id) {
            hoverRef.current = found;
            setHover(found ? { node: found, sx: localX, sy: localY } : null);
          }
        }}
        onPointerUp={(e) => {
          const drag = dragRef.current;
          dragRef.current = null;
          setDragging(false);
          if (!drag || drag.moved) return;
          const { x, y } = toTree(e.clientX, e.clientY);
          const found = nodeAt(x, y);
          if (found) void toggle(found.id);
        }}
        onPointerLeave={clearHover}
        onWheel={(e) => {
          // Zoom about the cursor: the point under the pointer stays put,
          // which is what makes a canvas this size navigable at all.
          const cam = cameraRef.current;
          const before = toTree(e.clientX, e.clientY);
          cam.scale = Math.min(
            MAX_SCALE,
            Math.max(MIN_SCALE, cam.scale * Math.exp(-e.deltaY * 0.0015)),
          );
          const after = toTree(e.clientX, e.clientY);
          cam.x += before.x - after.x;
          cam.y += before.y - after.y;
        }}
      />

      {hover && (
        <div
          className={styles.label}
          style={{
            left: Math.min(hover.sx + 16, (wrapRef.current?.clientWidth ?? 0) - LABEL_WIDTH),
            top: hover.sy + 16,
          }}
        >
          {hover.node.name || `Node ${hover.node.id}`}
          <div className={styles.labelType}>
            {hover.node.type}
            {allocated.has(hover.node.id)
              ? ' · allocated'
              : reachable.has(hover.node.id)
                ? ' · click to allocate'
                : ' · not reachable'}
          </div>
        </div>
      )}

      <div className={styles.hud}>
        <span>
          <span className={styles.hudValue}>{allocated.size}</span> allocated
        </span>
        <span>
          <span className={styles.hudValue}>{drawNodes.length}</span> nodes
        </span>
        <span>
          <span className={styles.hudValue}>{frameMs}</span> ms/frame
        </span>
        {!loaded && <span>loading…</span>}
      </div>
    </div>
  );
}
