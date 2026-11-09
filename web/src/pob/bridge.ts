import type {
  BridgeSnapshot,
  BuildCode,
  BuildsSnapshot,
  BuildSort,
  CodeInspection,
  CompareSnapshot,
  CalcBreakdown,
  CalcsSnapshot,
  ConfigSnapshot,
  ItemDetail,
  ItemEdit,
  ItemFilterOptions,
  ItemFilters,
  ItemSearchSnapshot,
  CraftAffixes,
  AnointWhatIf,
  CraftAnoints,
  CorruptDraft,
  CorruptPreview,
  CraftCorruptions,
  CraftBases,
  CraftRunes,
  CraftState,
  NotesSnapshot,
  ItemsSnapshot,
  GemSearchSnapshot,
  SkillDetail,
  SkillsSnapshot,
  StagedItem,
  TreeWhatIf,
  StatsSnapshot,
  TreeAllocSnapshot,
  TreePathPreview,
  TreeSnapshot,
  WhatIf,
} from './types';

/**
 * The transport to the Lua engine.
 *
 * The engine runs as a separate process serving JSON over loopback HTTP
 * (bridge/ in the repo root). Every call answers with a whole snapshot
 * rather than a diff, because one command can move several things at once:
 * changing class reloads the ascendancy list, and a recalculation can move
 * the level and all four budgets. A UI that patched fields individually
 * would be guessing at which ones moved.
 *
 * No WebSocket yet. The handshake is available (SHA-1 and base64 both ship
 * in runtime/lua) but request/response is enough for state this small, and
 * it keeps the failure modes obvious.
 *
 * The default is a path, not a host: the dev server starts the engine and
 * proxies it under its own origin (see plugins/pob-bridge.ts), so these are
 * same-origin requests and which port the engine took is not the UI's
 * business. Set VITE_POB_BRIDGE to a full URL to talk to one directly.
 */
const BASE = (import.meta.env.VITE_POB_BRIDGE as string | undefined) ?? '/bridge';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });

  // The bridge answers JSON on both success and failure, but a dead socket
  // or an HTML error page should not surface as a parse error.
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const detail =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `${response.status} ${response.statusText}`;
    throw new Error(detail);
  }

  return body as T;
}

/**
 * A corruption draft, flattened for a query string.
 *
 * "1:ModId,2:ModId" and "3:0.95": keyed rather than positional, because a
 * draft with only the second slot filled has to survive the trip.
 */
function corruptParams(draft: CorruptDraft): string {
  const pairs = (table: Record<number, string | number>) =>
    Object.entries(table)
      .filter(([, value]) => value !== '' && value !== undefined)
      .map(([index, value]) => `${index}:${value}`)
      .join(',');

  const params = new URLSearchParams({ mode: draft.mode });
  if (draft.source) params.set('source', draft.source);
  const implicits = pairs(draft.implicits);
  const ranges = pairs(draft.ranges);
  if (implicits) params.set('implicits', implicits);
  if (ranges) params.set('ranges', ranges);
  return String(params);
}

export const bridge = {
  /** The current build, or `{ ready: false }` when none is open. */
  state: () => request<BridgeSnapshot>('/state'),

  /** The stat sidebar: an order of magnitude more data, so its own route. */
  stats: () => request<StatsSnapshot>('/stats'),

  /** The Calcs tab. Fetched when outputRevision moves, not on a timer. */
  calcs: () => request<CalcsSnapshot>('/calcs'),

  /** The tree's geometry. ~420 kB, fetched once; it does not change. */
  tree: () => request<TreeSnapshot>('/tree'),

  /** The route a click on one node would allocate, and what it costs. */
  treePath: (node: number) => request<TreePathPreview>(`/tree/path?node=${node}`),

  /** What is allocated on it. Small, and changes on every click. */
  treeAlloc: () => request<TreeAllocSnapshot>('/tree/alloc'),

  /** Slots, the item list and the item sets. */
  items: () => request<ItemsSnapshot>('/items'),

  /**
   * One item as PoB would draw it. With a slot it also carries the
   * "Equipping this item will..." comparison, which is a full recalculation
   * against that slot, hence a route of its own, fetched on demand.
   */
  item: (id: number, slot?: string) =>
    request<ItemDetail>(
      `/item?id=${id}` + (slot ? `&slot=${encodeURIComponent(slot)}` : ''),
    ),

  /**
   * What one passive node is worth, before the point is spent.
   *
   * Two full recalculations where the node is not adjacent, so it is
   * asked on a dwell rather than on every pixel of pointer movement.
   */
  treeWhatIf: (node: number) => request<TreeWhatIf>(`/tree/whatif?node=${node}`),

  /** What switching a flask or charm on, or off, would do. */
  slotWhatIf: (slot: string) =>
    request<WhatIf>(`/items/whatif?slot=${encodeURIComponent(slot)}`),

  /** What a gem being off, or at 20 quality, would do. */
  gemWhatIf: (group: number, gem: number, subject: 'enabled' | 'quality') =>
    request<WhatIf>(`/gem/whatif?group=${group}&gem=${gem}&subject=${subject}`),

  /**
   * Where one number on the Calcs tab came from. `ref` is the cell
   * reference that /calcs carries, which addresses PoB's own tables.
   */
  calcsBreakdown: (ref: string) =>
    request<CalcBreakdown>(`/calcs/breakdown?ref=${encodeURIComponent(ref)}`),

  /** What is editable about one item: text, modifier rolls, variant. */
  itemEdit: (id: number) => request<ItemEdit>(`/item/edit?id=${id}`),

  /**
   * The item on the bench, against every slot it fits.
   *
   * One full recalculation per candidate slot, so this is the most
   * expensive read here. It is still cheaper than what it replaces, which
   * was equipping the item to find out and unequipping it again.
   */
  stagedItem: () => request<StagedItem>('/item/staged'),

  /**
   * PoB's unique and rare databases, on PoB's own eight filter axes.
   *
   * Naming a stat in `sort` makes this expensive: the engine is run
   * against every candidate in every slot it fits. The bridge answers with
   * how far it got, and asking again with the same filters carries the
   * scan on, so this is called in a loop until `scanning` clears.
   */
  itemSearch: (filters: ItemFilters, limit?: number) => {
    const params = new URLSearchParams(
      Object.entries(filters).filter(([, value]) => value !== ''),
    );
    if (limit) params.set('limit', String(limit));
    return request<ItemSearchSnapshot>(`/items/search?${params}`);
  },

  /** What each of those filters offers, learned from the database itself. */
  itemFilters: () => request<ItemFilterOptions>('/items/filters'),

  /**
   * Socket groups, and the gems in one of them. `group` is what expands a
   * group into its gem list; without it only the group list comes back.
   */
  skills: (group?: number) =>
    request<SkillsSnapshot>('/skills' + (group ? `?group=${group}` : '')),

  /** What a socket group does, as PoB describes it. */
  socketGroup: (index: number) => request<SkillDetail>(`/skills/group?index=${index}`),

  /** One gem as PoB would draw it, at its current level and quality. */
  gem: (group: number, gem: number) =>
    request<SkillDetail>(`/gem?group=${group}&gem=${gem}`),

  /** Every gem the game has, by name. */
  gemSearch: (query: string) =>
    request<GemSearchSnapshot>(`/gems/search?q=${encodeURIComponent(query)}`),

  /** The configuration tab: only the options this build actually uses. */
  config: () => request<ConfigSnapshot>('/config'),

  /** The build's notes, with the palette needed to colour them. */
  notes: () => request<NotesSnapshot>('/notes'),

  /** The bench item, as something being crafted. */
  craftState: () => request<CraftState>('/item/craft'),

  /**
   * Everything one affix slot could hold.
   *
   * Its own call because the list depends on what the other slots hold,
   * so it has to be asked for again after every change.
   */
  craftAffixes: (kind: string, index: number, query?: string) =>
    request<CraftAffixes>(
      `/craft/affixes?kind=${kind}&index=${index}` +
        (query ? `&q=${encodeURIComponent(query)}` : ''),
    ),

  /** The bases an item can be crafted on, by type. */
  craftBases: (type?: string) =>
    request<CraftBases>('/craft/bases' + (type ? `?type=${encodeURIComponent(type)}` : '')),

  /** The runes and soul cores the bench item's sockets will accept. */
  craftRunes: (query?: string) =>
    request<CraftRunes>('/craft/runes' + (query ? `?q=${encodeURIComponent(query)}` : '')),

  /**
   * The notables the bench item could be anointed with.
   *
   * A search rather than a list: there are 875 of them on the tree. The
   * three modes are the desktop control's own, and "anywhere" matches the
   * distilled emotions as well as the name and the modifiers.
   */
  craftAnoints: (query?: string, mode?: string) =>
    request<CraftAnoints>(
      `/craft/anoints?mode=${mode ?? 'anywhere'}` +
        (query ? `&q=${encodeURIComponent(query)}` : ''),
    ),

  /**
   * What one anoint would do, before it is applied.
   *
   * Both sides of the comparison put the bench item in its own slot, so
   * the answer is the anoint's worth rather than the whole item's. No node
   * asks what taking the current anoint off would cost.
   */
  anointWhatIf: (slot: number, node?: number) =>
    request<AnointWhatIf>(
      `/craft/anoint/whatif?slot=${slot}` + (node ? `&node=${node}` : ''),
    ),

  /**
   * What the bench item could be corrupted with, and what it already has.
   *
   * One call for the whole panel: the implicit list, the roll ranges and
   * the sources all come off PoB's own dialog, and opening that dialog is
   * the expensive part.
   */
  craftCorruptions: (source?: string, query?: string) =>
    request<CraftCorruptions>(
      '/craft/corruptions?source=' +
        encodeURIComponent(source ?? 'Corrupted') +
        (query ? `&q=${encodeURIComponent(query)}` : ''),
    ),

  /**
   * What corrupting would do, before it is done.
   *
   * The whole draft goes in one call, so two implicits chosen together are
   * priced together. PoB can only price one at a time, against the
   * uncorrupted item.
   */
  corruptPreview: (draft: CorruptDraft) =>
    request<CorruptPreview>(`/craft/corrupt/preview?${corruptParams(draft)}`),

  /**
   * What a build code contains, without importing it.
   *
   * Decode only. A link pasted here has its code read out of it; nothing
   * is ever fetched, so this works with no network and sends nothing.
   */
  inspectCode: (code: string) =>
    request<CodeInspection>(`/code/inspect?code=${encodeURIComponent(code)}`),

  /** The current build as a code, exactly as the desktop app exports it. */
  buildCode: () => request<BuildCode>('/code'),

  /** Replace the open build with one decoded from a code. */
  importCode: (code: string) =>
    request<BridgeSnapshot>('/code/import', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  /** Import a character from a pasted game API response. */
  importCharacter: (json: string) =>
    request<BridgeSnapshot>('/code/character', {
      method: 'POST',
      body: JSON.stringify({ json }),
    }),

  /** The builds folder, as PoB's own scanner sees it. */
  builds: (sort?: BuildSort) =>
    request<BuildsSnapshot>('/builds' + (sort ? `?sort=${sort}` : '')),

  /** The current build against the active comparison, stat by stat. */
  compare: () => request<CompareSnapshot>('/compare'),

  /**
   * What flipping one configuration option would do, without doing it.
   * A value is needed for anything that is not a checkbox.
   */
  configWhatIf: (name: string, value?: string | number | boolean) =>
    request<WhatIf>(
      `/config/whatif?var=${encodeURIComponent(name)}` +
        (value === undefined ? '' : `&value=${encodeURIComponent(String(value))}`),
    ),

  /** The same for turning a socket group off, or on. */
  socketGroupWhatIf: (group: number) => request<WhatIf>(`/skills/whatif?group=${group}`),

  /** Ask the engine to run one of api.lua's commands. */
  act: (action: string, value?: unknown) =>
    request<BridgeSnapshot>('/action', {
      method: 'POST',
      body: JSON.stringify({ action, value }),
    }),

  /** Clear a recorded engine error. Does not repair the build. */
  dismissError: () =>
    request<{ ok: boolean }>('/engine/dismiss', { method: 'POST', body: '{}' }),

  newBuild: () => request<BridgeSnapshot>('/build/new', { method: 'POST', body: '{}' }),

  openBuild: (path: string) =>
    request<BridgeSnapshot>('/build/open', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
};
