import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTreeStore } from '../pob/treeStore';
import { Lines } from '../ui/TooltipLines';
import type { SpriteRect, TreeArt } from './art';
import type { TreeBackdropImage, TreeNode } from '../pob/types';
import styles from './TreeView.module.css';

/**
 * The passive tree.
 *
 * Canvas rather than SVG, and not as a preference: the tree is 4546 nodes
 * and 5149 connectors, so an SVG would be about ten thousand elements for
 * the browser to lay out and hit-test on every pan. Canvas draws the
 * connectors as two batched paths and the nodes as two sprites each, and
 * hit-testing is a distance check this file does itself.
 *
 * Everything meaningful is still the engine's. Node positions are PoB's,
 * resolved from group/orbit/orbitIndex at tree load; which connections curve
 * and about what centre is PoB's own connector list; the sprite each node
 * wears is the asset name PoB resolved for it; reachability is its
 * `node.path`; and a click sends `toggleNode` so AllocNode walks the route
 * to a distant node exactly as it does in the desktop app.
 */

/** Fallback radii, used only when the artwork has not been extracted. */
const RADIUS: Record<string, number> = {
  Normal: 36,
  Notable: 64,
  Keystone: 92,
  Socket: 52,
  ClassStart: 104,
  AscendClassStart: 68,
};

const CONNECTOR_WIDTH = 9;
const MIN_SCALE = 0.012;
const MAX_SCALE = 0.9;
const TIP_WIDTH = 320;
const TIP_GUTTER = 12;
/**
 * How long the pointer rests on a node before the engine is asked what it
 * is worth. Long enough that crossing the tree costs nothing, short
 * enough that stopping to read is answered by the time you have.
 */
const DWELL_MS = 180;

/**
 * Below this, nodes are drawn as circles instead of sprites.
 *
 * A normal node's frame is 54 tree units, so at 0.06 it covers about three
 * pixels: two scaled blits to paint something no bigger than the dot that
 * replaces them. The whole tree fits on screen at around 0.045, so the
 * zoomed-all-out view is the one that takes the cheap path, which is also
 * the view with the most nodes in it.
 */
const SPRITE_SCALE = 0.06;

/** Unallocated art, dimmed so the lit tree reads at a glance. */
const DIM_ALPHA = 0.5;

interface Camera {
  x: number;
  y: number;
  scale: number;
}

interface Hover {
  node: TreeNode;
  /** Where to put the tooltip, in the wrapper's own coordinates. */
  sx: number;
  sy: number;
  /** The panel's size when the pointer entered, so placing the tooltip is
   * not a layout read during render. */
  wrapW: number;
  wrapH: number;
}

/** What one node needs to draw itself, resolved once instead of per frame. */
interface Drawable {
  node: TreeNode;
  icon: SpriteRect | null;
  alloc: SpriteRect | null;
  path: SpriteRect | null;
  unalloc: SpriteRect | null;
  radius: number;
}

const fallbackRadius = (node: TreeNode) => RADIUS[node.type] ?? RADIUS.Normal;

/** The radius a pointer has to land inside to count as over this node. */
const hitRadius = (node: TreeNode) => Math.max(node.frameSize, node.iconSize, 24) * 0.6;

function blit(
  ctx: CanvasRenderingContext2D,
  art: TreeArt,
  rect: SpriteRect,
  x: number,
  y: number,
  size: number,
) {
  const page = art.page(rect.p);
  if (!page) return;
  // The sprite's own pixel size is irrelevant: PoB chose the box this goes
  // in (node.targetSize), which leaves the extractor free to store the art
  // at whatever resolution keeps it sharp.
  const half = size / 2;
  ctx.drawImage(page, rect.x, rect.y, rect.w, rect.h, x - half, y - half, size, size);
}

function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  art: TreeArt,
  entry: TreeBackdropImage,
  alpha: number,
) {
  const bitmap = art.backdrop(entry.image);
  if (!bitmap) return;
  ctx.globalAlpha = alpha;
  ctx.drawImage(
    bitmap,
    entry.x - entry.width / 2,
    entry.y - entry.height / 2,
    entry.width,
    entry.height,
  );
  ctx.globalAlpha = 1;
}

export function TreeView() {
  const loaded = useTreeStore((s) => s.loaded);
  const nodes = useTreeStore((s) => s.nodes);
  const connectors = useTreeStore((s) => s.connectors);
  const icons = useTreeStore((s) => s.icons);
  const frameSets = useTreeStore((s) => s.frameSets);
  const bounds = useTreeStore((s) => s.bounds);
  const arcErrors = useTreeStore((s) => s.arcErrors);
  const art = useTreeStore((s) => s.art);
  const allocated = useTreeStore((s) => s.allocated);
  const reachable = useTreeStore((s) => s.reachable);
  const backdrop = useTreeStore((s) => s.backdrop);
  const preview = useTreeStore((s) => s.preview);
  const previewPath = useTreeStore((s) => s.previewPath);
  const delta = useTreeStore((s) => s.delta);
  const previewDelta = useTreeStore((s) => s.previewDelta);
  const showDeltas = useTreeStore((s) => s.showDeltas);
  const setShowDeltas = useTreeStore((s) => s.setShowDeltas);
  const load = useTreeStore((s) => s.load);
  const toggle = useTreeStore((s) => s.toggle);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 0.05 });
  const fittedRef = useRef(false);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const hoverRef = useRef<TreeNode | null>(null);
  const matchRef = useRef<Set<number>>(new Set());
  const previewRef = useRef<Set<number>>(new Set());
  const dwellRef = useRef<number | undefined>(undefined);
  const tipRef = useRef<HTMLDivElement>(null);

  const [hover, setHover] = useState<Hover | null>(null);
  const [dragging, setDragging] = useState(false);
  const [frameMs, setFrameMs] = useState(0);
  const [query, setQuery] = useState('');
  const [spriteMode, setSpriteMode] = useState(false);

  /**
   * Nodes with their art resolved, and connectors resolved to node pairs.
   *
   * Both are rebuilt only when the geometry or the artwork changes, which is
   * once. Doing the palette lookups in the draw loop would be 4546 string
   * hashes a frame for an answer that never changes.
   */
  const { drawNodes, drawLines, drawArcs } = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));

    const drawables: Drawable[] = nodes.map((node) => {
      const frames = node.frames ? frameSets[node.frames - 1] : undefined;
      return {
        node,
        icon: art?.sprite(node.icon ? icons[node.icon - 1] : undefined) ?? null,
        alloc: art?.sprite(frames?.alloc) ?? null,
        path: art?.sprite(frames?.path) ?? null,
        unalloc: art?.sprite(frames?.unalloc) ?? null,
        radius: fallbackRadius(node),
      };
    });

    const lines: [TreeNode, TreeNode][] = [];
    const arcs: { a: TreeNode; b: TreeNode; cx: number; cy: number; r: number }[] = [];
    for (const connector of connectors) {
      const a = byId.get(connector[0]);
      const b = byId.get(connector[1]);
      if (!a || !b) continue;
      if (connector.length === 4) {
        const cx = connector[2];
        const cy = connector[3];
        arcs.push({ a, b, cx, cy, r: Math.hypot(a.x - cx, a.y - cy) });
      } else {
        lines.push([a, b]);
      }
    }
    return { drawNodes: drawables, drawLines: lines, drawArcs: arcs };
  }, [nodes, connectors, icons, frameSets, art]);

  /**
   * Search matches, by name and by stat text.
   *
   * Stats are searched too because that is how the question is usually
   * asked: not "where is Heavy Armour" but "where is anything that gives
   * spirit". A linear scan of 4546 nodes per keystroke is under a
   * millisecond, so there is no index here to keep in step with the tree.
   */
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return new Set<number>();
    const found = new Set<number>();
    for (const node of nodes) {
      if (node.name.toLowerCase().includes(needle)) {
        found.add(node.id);
        continue;
      }
      for (const stat of node.stats) {
        if (stat.toLowerCase().includes(needle)) {
          found.add(node.id);
          break;
        }
      }
    }
    return found;
  }, [query, nodes]);

  // Handed to the render loop through a ref rather than a dependency: the
  // loop reads it every frame and should not be torn down and rebuilt on
  // every keystroke. Written in an effect, because assigning a ref during
  // render is not safe under concurrent rendering.
  useEffect(() => {
    matchRef.current = matches;
  }, [matches]);

  // The previewed route, as a set the draw loop can test per node without
  // scanning a list. Memoised first so the effect below depends on one
  // stable value rather than on a field reached through an optional chain.
  const routeSet = useMemo(() => new Set(preview ? preview.path : []), [preview]);

  useEffect(() => {
    previewRef.current = routeSet;
  }, [routeSet]);

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
    // exactly wrong when frames are scarce: a backgrounded tab would claim
    // it was drawing instantly.
    let ema = 0;
    let lastReport = 0;
    let lastMode: boolean | null = null;

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
      // keeps a zoomed-in frame cheap rather than always paying for 4546.
      const halfW = w / 2 / cam.scale;
      const halfH = h / 2 / cam.scale;
      const pad = 200;
      const left = cam.x - halfW - pad;
      const right = cam.x + halfW + pad;
      const top = cam.y - halfH - pad;
      const bottom = cam.y + halfH + pad;
      const visible = (x: number, y: number) =>
        x >= left && x <= right && y >= top && y <= bottom;
      const boxVisible = (x: number, y: number, bw: number, bh: number) =>
        x + bw / 2 >= left && x - bw / 2 <= right && y + bh / 2 >= top && y - bh / 2 <= bottom;

      // ---------------------------------------------------------- backdrops
      //
      // Only what is on screen is even asked for: there are 37 of these at
      // up to 2048px, and asking is what starts the download, so panning to
      // an ascendancy is what pays for its disc.
      if (art && backdrop) {
        for (const entry of backdrop.ascendancies) {
          if (boxVisible(entry.x, entry.y, entry.width, entry.height)) {
            drawBackdrop(ctx, art, entry, entry.current ? 1 : 0.55);
          }
        }
        if (boxVisible(backdrop.x, backdrop.y, backdrop.width, backdrop.height)) {
          drawBackdrop(ctx, art, backdrop, 1);

          // The lit half of the centrepiece points at the class's start
          // node. PoB works that angle out at draw time; the bridge reports
          // it so this does not have to know which node that is.
          const active = backdrop.active && art.backdrop(backdrop.active.image);
          if (backdrop.active && active) {
            ctx.save();
            ctx.translate(backdrop.x, backdrop.y);
            ctx.rotate(backdrop.active.angle);
            ctx.drawImage(
              active,
              -backdrop.active.width / 2,
              -backdrop.active.height / 2,
              backdrop.active.width,
              backdrop.active.height,
            );
            ctx.restore();
          }

          const centre = backdrop.centre && art.backdrop(backdrop.centre.image);
          if (backdrop.centre && centre) {
            ctx.drawImage(
              centre,
              backdrop.x - backdrop.centre.width / 2,
              backdrop.y - backdrop.centre.height / 2,
              backdrop.centre.width,
              backdrop.centre.height,
            );
          }
        }
      }

      // --------------------------------------------------------- connectors
      //
      // Two paths rather than 5149 strokes. An arc is drawn as an arc: both
      // its endpoints sit on the circle the bridge sends, so there is no
      // curve to approximate and nothing to go subtly out of true.
      const dimPath = new Path2D();
      const litPath = new Path2D();

      for (const [a, b] of drawLines) {
        if (!visible(a.x, a.y) && !visible(b.x, b.y)) continue;
        const path = allocated.has(a.id) && allocated.has(b.id) ? litPath : dimPath;
        path.moveTo(a.x, a.y);
        path.lineTo(b.x, b.y);
      }

      for (const { a, b, cx, cy, r } of drawArcs) {
        if (!visible(a.x, a.y) && !visible(b.x, b.y)) continue;
        const path = allocated.has(a.id) && allocated.has(b.id) ? litPath : dimPath;
        const from = Math.atan2(a.y - cy, a.x - cx);
        const to = Math.atan2(b.y - cy, b.x - cx);
        // The short way round: the long way would cut across the tree.
        let delta = to - from;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        path.moveTo(a.x, a.y);
        path.arc(cx, cy, r, from, to, delta < 0);
      }

      ctx.lineWidth = CONNECTOR_WIDTH;
      ctx.strokeStyle = '#3a3226';
      ctx.stroke(dimPath);
      ctx.lineWidth = CONNECTOR_WIDTH * 1.8;
      ctx.strokeStyle = '#c9a227';
      ctx.stroke(litPath);

      // The route a click would take, over the connectors and under the
      // nodes. Drawn from the same two shapes as everything else: a
      // connector is on the route when both its ends are.
      const route = previewRef.current;
      if (route.size > 0) {
        const routePath = new Path2D();
        const onRoute = (a: TreeNode, b: TreeNode) =>
          (route.has(a.id) || allocated.has(a.id)) &&
          (route.has(b.id) || allocated.has(b.id)) &&
          (route.has(a.id) || route.has(b.id));

        for (const [a, b] of drawLines) {
          if (!onRoute(a, b)) continue;
          routePath.moveTo(a.x, a.y);
          routePath.lineTo(b.x, b.y);
        }
        for (const { a, b, cx, cy, r } of drawArcs) {
          if (!onRoute(a, b)) continue;
          const from = Math.atan2(a.y - cy, a.x - cx);
          const to = Math.atan2(b.y - cy, b.x - cx);
          let delta = to - from;
          while (delta > Math.PI) delta -= Math.PI * 2;
          while (delta < -Math.PI) delta += Math.PI * 2;
          routePath.moveTo(a.x, a.y);
          routePath.arc(cx, cy, r, from, to, delta < 0);
        }
        ctx.lineWidth = CONNECTOR_WIDTH * 1.8;
        ctx.strokeStyle = '#6ee7b7';
        ctx.stroke(routePath);
      }

      // -------------------------------------------------------------- nodes
      const sprites = art !== null && cam.scale >= SPRITE_SCALE;
      if (sprites !== lastMode) {
        lastMode = sprites;
        setSpriteMode(sprites);
      }

      if (sprites && art) {
        // Unallocated first and dimmed, then the lit tree over it, so a
        // crowded cluster reads as a path rather than as a field of rings.
        for (const pass of [false, true]) {
          ctx.globalAlpha = pass ? 1 : DIM_ALPHA;
          for (const item of drawNodes) {
            const { node } = item;
            const isAlloc = allocated.has(node.id);
            if (isAlloc !== pass) continue;
            if (!visible(node.x, node.y)) continue;
            if (item.icon && node.iconSize > 0) {
              blit(ctx, art, item.icon, node.x, node.y, node.iconSize);
            }
            const frame = isAlloc
              ? item.alloc
              : reachable.has(node.id)
                ? item.path
                : item.unalloc;
            if (frame && node.frameSize > 1) {
              blit(ctx, art, frame, node.x, node.y, node.frameSize);
            }
          }
        }
        ctx.globalAlpha = 1;
      } else {
        // Three fills for the lot. This is the zoomed-out view, where the
        // art would be sub-pixel anyway.
        const dim = new Path2D();
        const open = new Path2D();
        const lit = new Path2D();
        for (const { node, radius } of drawNodes) {
          if (!visible(node.x, node.y)) continue;
          const path = allocated.has(node.id) ? lit : reachable.has(node.id) ? open : dim;
          path.moveTo(node.x + radius, node.y);
          path.arc(node.x, node.y, radius, 0, Math.PI * 2);
        }
        ctx.fillStyle = '#2a251d';
        ctx.fill(dim);
        ctx.fillStyle = '#4a4134';
        ctx.fill(open);
        ctx.fillStyle = '#c9a227';
        ctx.fill(lit);
      }

      // ----------------------------------------------------- search + hover
      const found = matchRef.current;
      if (found.size > 0) {
        ctx.lineWidth = 4 / cam.scale;
        ctx.strokeStyle = '#5cf0bb';
        const ring = new Path2D();
        for (const { node } of drawNodes) {
          if (!found.has(node.id) || !visible(node.x, node.y)) continue;
          const r = hitRadius(node) + 10 / cam.scale;
          ring.moveTo(node.x + r, node.y);
          ring.arc(node.x, node.y, r, 0, Math.PI * 2);
        }
        ctx.stroke(ring);
      }

      if (route.size > 0) {
        ctx.lineWidth = 5 / cam.scale;
        ctx.strokeStyle = '#6ee7b7';
        const ring = new Path2D();
        for (const { node } of drawNodes) {
          if (!route.has(node.id) || !visible(node.x, node.y)) continue;
          const r = hitRadius(node) + 6 / cam.scale;
          ring.moveTo(node.x + r, node.y);
          ring.arc(node.x, node.y, r, 0, Math.PI * 2);
        }
        ctx.stroke(ring);
      }

      const hovered = hoverRef.current;
      if (hovered) {
        ctx.lineWidth = 3 / cam.scale;
        ctx.strokeStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(hovered.x, hovered.y, hitRadius(hovered) + 8 / cam.scale, 0, Math.PI * 2);
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
  }, [drawNodes, drawLines, drawArcs, allocated, reachable, art, backdrop]);

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
   * Nearest node whose radius contains the point. A linear scan over 4546
   * nodes costs well under a millisecond, so there is no spatial index here
   * to be kept in step with anything.
   */
  const nodeAt = (treeX: number, treeY: number) => {
    let best: TreeNode | null = null;
    let bestDistance = Infinity;
    for (const { node } of drawNodes) {
      const dx = node.x - treeX;
      const dy = node.y - treeY;
      const distance = dx * dx + dy * dy;
      const r = hitRadius(node);
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
      // The route goes with it. Leaving it drawn after the pointer has
      // gone is a highlight with nothing explaining it.
      void previewPath(null);
      window.clearTimeout(dwellRef.current);
      void previewDelta(null);
    }
  };

  // The tooltip used to sit above the cursor in the lower half of the
  // panel and below it in the upper half, which needs no measurement and
  // was right while a tooltip was a name and three stat lines. A node's
  // worth can be thirty, and a box that tall runs off the top of the
  // panel whichever side of the cursor it starts on. So it is measured
  // once it exists and pulled back inside, which is the one thing the
  // original heuristic was written to avoid and the change that made it
  // necessary.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !hover) return;
    const limit = hover.wrapH - el.offsetHeight - TIP_GUTTER;
    el.style.top = `${Math.max(TIP_GUTTER, Math.min(hover.sy + 16, limit))}px`;
  });

  /** Put the first search match in the middle of the view. */
  const goToFirstMatch = () => {
    const first = nodes.find((node) => matches.has(node.id));
    if (!first) return;
    const cam = cameraRef.current;
    cam.x = first.x;
    cam.y = first.y;
    cam.scale = Math.max(cam.scale, 0.18);
  };

  const stateOf = (node: TreeNode) => {
    if (allocated.has(node.id)) return 'allocated';
    const cost = reachable.get(node.id);
    if (cost === undefined) return 'not reachable';
    // The number people actually want from a tree: not "you can take
    // this" but "this costs you four points".
    return cost === 1 ? 'costs 1 point' : `costs ${cost} points`;
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
              // A tooltip pinned to where the cursor was is wrong the moment
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
          // tooltip should stay put rather than chase the cursor.
          if (found?.id !== hoverRef.current?.id) {
            hoverRef.current = found;
            const wrap = wrapRef.current;
            // What this click would actually allocate. Asked of the
            // engine, cached per node, and only when the node under the
            // pointer changes, not per mouse-move.
            void previewPath(found && reachable.has(found.id) ? found.id : null);

            // What the node is worth waits for the pointer to settle.
            // The route above is one cheap call the engine answers from
            // what it already knows; this is two full recalculations, and
            // firing them across every node between here and there would
            // queue work for answers nobody asked for.
            window.clearTimeout(dwellRef.current);
            void previewDelta(null);
            if (found) {
              dwellRef.current = window.setTimeout(() => {
                void previewDelta(found.id);
              }, DWELL_MS);
            }

            setHover(
              found
                ? {
                    node: found,
                    sx: localX,
                    sy: localY,
                    wrapW: wrap?.clientWidth ?? 0,
                    wrapH: wrap?.clientHeight ?? 0,
                  }
                : null,
            );
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

      <form
        className={styles.search}
        onSubmit={(e) => {
          e.preventDefault();
          goToFirstMatch();
        }}
      >
        <input
          className={styles.searchInput}
          type="search"
          placeholder="Search nodes and stats"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search the passive tree"
        />
        {query.trim().length >= 2 && (
          <span className={styles.searchCount}>
            {matches.size} {matches.size === 1 ? 'match' : 'matches'}
          </span>
        )}
      </form>

      {hover && (
        <div
          className={styles.tip}
          // Kept inside the panel on both axes. Below the cursor in the top
          // half and above it in the bottom half, which needs no measurement
          // of a box that has not been laid out yet.
          ref={tipRef}
          style={{
            left: Math.max(
              TIP_GUTTER,
              Math.min(hover.sx + 16, hover.wrapW - TIP_WIDTH - TIP_GUTTER),
            ),
            top: hover.sy + 16,
          }}
        >
          <div className={styles.tipName}>{hover.node.name || `Node ${hover.node.id}`}</div>
          <div className={styles.tipMeta}>
            {hover.node.ascendancy ? `${hover.node.ascendancy} · ` : ''}
            {hover.node.type} · {stateOf(hover.node)}
          </div>
          {hover.node.stats.length > 0 && (
            <ul className={styles.tipStats}>
              {hover.node.stats.map((stat, i) => (
                <li key={i}>{stat}</li>
              ))}
            </ul>
          )}
          {hover.node.flavour && <div className={styles.tipFlavour}>{hover.node.flavour}</div>}

          {/* What the point is worth. The question the desktop tree
              answers on hover and the reason its tooltip is the tool
              people actually plan with. */}
          {showDeltas && delta?.id === hover.node.id && delta.whatIf.ready && (
            <div className={styles.tipDelta}>
              <Lines lines={delta.whatIf.node.ready ? delta.whatIf.node.lines : []} />
              {delta.whatIf.node.ready && delta.whatIf.node.unchanged && (
                <div className={styles.tipQuiet}>
                  {delta.whatIf.allocated ? 'Unallocating' : 'Allocating'} this changes nothing.
                </div>
              )}
              {delta.whatIf.path?.ready && (
                <>
                  <hr className={styles.tipRule} />
                  <Lines lines={delta.whatIf.path.lines} />
                </>
              )}
            </div>
          )}
          {showDeltas && delta?.id === hover.node.id && !delta.whatIf.ready && (
            <div className={styles.tipQuiet}>{delta.whatIf.error}</div>
          )}
          {showDeltas && delta?.id !== hover.node.id && (
            <div className={styles.tipQuiet}>working out what it is worth…</div>
          )}
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
        <span>{spriteMode ? 'art' : 'dots'}</span>
        <button
          className={styles.hudToggle}
          data-on={showDeltas ? 'true' : undefined}
          onClick={() => setShowDeltas(!showDeltas)}
          title={
            showDeltas
              ? 'Stop pricing each node on hover'
              : 'Show what each node would be worth, on hover'
          }
        >
          stat differences {showDeltas ? 'on' : 'off'}
        </button>
        {!loaded && <span>loading…</span>}
        {loaded && !art && <span title="run npm run tree-art">no artwork</span>}
        {arcErrors > 0 && (
          <span className={styles.hudWarn} title="arcs that failed the bridge's own check">
            {arcErrors} bad arcs
          </span>
        )}
      </div>
    </div>
  );
}
