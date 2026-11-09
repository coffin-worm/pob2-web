/**
 * The shape of the state the header renders.
 *
 * These names are taken from the Lua side rather than invented, so that the
 * bridge is a transport and not a translation layer. `buildName`, `unsaved`,
 * `characterLevel`, `levelAutoMode`, `classId` and `ascendClassId` are all
 * fields on the `buildMode` table in src/Modules/Build.lua; the point budgets
 * are what its `pointDisplay` control computes each frame.
 *
 * Everything here is a plain serialisable value. Nothing in the UI should
 * ever hold a reference into the engine.
 */

/** A spent-against-available budget, as the top bar reports it. */
export interface PointBudget {
  used: number;
  max: number;
  /**
   * The engine's own verdict on being over budget. It agrees with
   * `used > max` today, but the budget rules live in Build.lua and the UI
   * should not be the place they are restated.
   */
  over?: boolean;
}

export interface BuildPoints {
  passives: PointBudget;
  /** Weapon set I and II each have their own passive budget in PoE 2. */
  weaponSet1: PointBudget;
  weaponSet2: PointBudget;
  ascendancy: PointBudget;
}

export interface NamedOption {
  id: number;
  name: string;
}

export interface HeaderState {
  buildName: string;
  /**
   * buildMode.outputRevision: bumped on every recalculation. The Calcs view
   * refetches when this moves instead of polling.
   */
  outputRevision?: number;
  /** Mirrors buildMode.unsaved: any modFlag across the tabs. */
  unsaved: boolean;
  /** Null until the build has been saved once; gates "Save" vs "Save As". */
  dbFileName: string | null;

  characterLevel: number;
  /** buildMode.characterLevelAutoMode: level derived from the tree, or typed. */
  levelAutoMode: boolean;

  classId: number;
  classes: NamedOption[];
  ascendClassId: number;
  /** Depends on the selected class, so it travels with it. */
  ascendancies: NamedOption[];

  loadoutId: number;
  loadouts: NamedOption[];

  points: BuildPoints;
}

/**
 * What the header can ask the engine to do.
 *
 * Deliberately commands rather than setters: the engine owns the state and
 * answers with a new one. A recalculation can change the level, the point
 * budgets and the ascendancy list all at once, and the UI must not assume
 * that setting a field is the same as the field having changed.
 */
export interface HeaderActions {
  save(): void;
  saveAs(): void;
  back(): void;
  setCharacterLevel(level: number): void;
  setLevelAutoMode(auto: boolean): void;
  setClass(classId: number): void;
  setAscendancy(ascendClassId: number): void;
  setLoadout(loadoutId: number): void;
  setBuildName(name: string): void;
}

export const LEVEL_MIN = 1;
export const LEVEL_MAX = 100;

/**
 * A modal the engine has opened and is waiting on.
 *
 * PoB answers some commands with a dialog rather than by doing the thing:
 * changing class with an allocated tree, Save As, Back with unsaved work.
 * Over a bridge that is invisible, so it travels with the state and the UI
 * can say what is being waited on instead of looking hung.
 */
/**
 * A dialog PoB is waiting on.
 *
 * Its controls are one mixed table: the array part is the message, one
 * label per line, and the named keys are the buttons. Buttons from the
 * array part have numeric keys, which arrive here as strings.
 */
export interface EnginePopup {
  title: string;
  lines: string[];
  buttons: { key: string; label: string; enabled: boolean }[];
  /** The button Enter would press, and the one Escape would. */
  defaultKey?: string;
  cancelKey?: string;
  /** Set when answering needs more than a button: a name, a folder. */
  needsInput?: boolean;
  /** PoB stacks dialogs; answering one can reveal another. */
  depth: number;
}

/** Whether the engine is reachable. */
export type Connection = 'connecting' | 'live' | 'offline';

/**
 * What GET /state answers with.
 *
 * `ready` is false when the engine is up but no build is open, and in that
 * case nothing else is present, hence the union rather than optional
 * fields, so a caller cannot read a level that is not there.
 */
export type BridgeSnapshot =
  | { ready: false; engineError?: string | null }
  | (HeaderState & {
      ready: true;
      popup?: EnginePopup | null;
      engineError?: string | null;
    });

/**
 * PoB's colours, classified.
 *
 * The engine marks stat lines with inline colour codes, and some of them
 * carry meaning: a damage type, a warning, an over-cap value. The bridge
 * turns those into names so this UI can give them its own palette instead of
 * inheriting PoB's.
 */
export type StatTone =
  | 'normal'
  | 'dim'
  | 'custom'
  | 'warning'
  | 'positive'
  | 'negative'
  | 'unsupported'
  | 'source'
  | 'offence'
  | 'defence'
  | 'fire'
  | 'cold'
  | 'lightning'
  | 'chaos';

/** PoB sets a row height per line; it is the engine's own emphasis. */
export type StatSize = 'header' | 'normal' | 'small';

export interface StatLine {
  label: string;
  /** Absent on section headers and on notes attached to the line above. */
  value?: string;
  tone: StatTone;
  size: StatSize;
  note?: boolean;
}

/** A passive, positioned where PoB computed it at tree load. */
export interface TreeNode {
  id: number;
  x: number;
  y: number;
  /** Normal | Notable | Keystone | Socket | ClassStart | AscendClassStart */
  type: string;
  name: string;
  /** Set on ascendancy nodes, which live in their own distant groups. */
  ascendancy?: string;
  /** 1-based index into TreeSnapshot.icons. Absent when the node has no art. */
  icon?: number;
  /** 1-based index into TreeSnapshot.frameSets. */
  frames?: number;
  /** Tree units. The icon sits inside the frame, so these differ by type. */
  iconSize: number;
  frameSize: number;
  /** PoB's own stat lines for this node, colour codes stripped. */
  stats: string[];
  /** Keystones carry one; nothing else does. */
  flavour?: string;
}

/** The three sprites a node wears, one per allocation state. */
export interface TreeFrameSet {
  alloc: string;
  path: string;
  unalloc: string;
}

/**
 * A connector between two nodes.
 *
 * `[a, b]` is a straight line. `[a, b, cx, cy]` is an arc of the orbit
 * centred at (cx, cy): both endpoints lie on that circle by construction,
 * which the bridge checks before sending it.
 */
export type TreeConnector = [number, number] | [number, number, number, number];

/** A painted backdrop: one image, centred on a point in tree space. */
export interface TreeBackdropImage {
  image: string;
  x: number;
  y: number;
  width: number;
  height: number;
  name?: string;
  current?: boolean;
}

export interface TreeBackdrop extends TreeBackdropImage {
  /** The tree's own centrepiece, drawn over the class artwork. */
  centre?: { image: string; width: number; height: number };
  /** The lit half of it, turned to face the class's start node. */
  active?: { image: string; width: number; height: number; angle: number };
  /** Every ascendancy's disc, each in its own distant corner. */
  ascendancies: TreeBackdropImage[];
}

export interface TreeBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type TreeSnapshot =
  | { ready: false }
  | {
      ready: true;
      nodes: TreeNode[];
      /** PoB's own connector list: the links it actually draws. */
      connectors: TreeConnector[];
      /** Art-name palettes the nodes index into, 1-based. */
      icons: string[];
      frameSets: TreeFrameSet[];
      bounds: TreeBounds;
      /**
       * Arcs whose endpoints did not land on one circle about the centre PoB
       * gave. Zero in a healthy tree; anything else fell back to a straight
       * line and the tree is drawing a lie.
       */
      arcErrors: number;
      buildMs: number;
    };

export type TreeAllocSnapshot =
  | { ready: false }
  | {
      ready: true;
      allocated: number[];
      /**
       * Nodes PoB can path to from the allocated tree, so clickable, each
       * with what clicking it would cost in new points. The cost is the
       * engine's `pathDist` from the same search that built the path.
       */
      reachable: [number, number][];
      classId: number;
      ascendClassId: number;
      /** Follows the class rather than the tree, so it rides with this. */
      backdrop: TreeBackdrop | null;
    };

/**
 * One row of a Calcs section.
 *
 * Unlike the sidebar's label/value pairs, these are matrix rows: a damage
 * section has a column per damage type, so `values` is 1..6 long and a row
 * whose label is empty is the column header for the rows beneath it.
 */
export interface CalcRow {
  label: string;
  /**
   * One entry per column slot, including empty ones. PoB's rows carry empty
   * placeholders so a row with no "All Types" figure still lines up under
   * the header, so these must be rendered by position, not compacted.
   */
  values: string[];
  /** Present only when at least one cell carries a meaningful colour. */
  tones?: StatTone[];
  /**
   * One entry per column slot, as `values` is. A non-empty entry is the
   * address of that cell's working inside PoB's own tables, and the only
   * thing that makes the cell worth clicking. Absent when no cell in the
   * row has any.
   */
  refs?: string[];
}

/** One part of the working behind a number. */
export type CalcBreakdownPart =
  | { type: 'text'; lines: { text: string; tone?: StatTone }[] }
  | {
      type: 'table';
      label?: string;
      footer?: string;
      cols: { key: string; label: string; right?: boolean }[];
      /** Row-major, already projected onto `cols`. */
      rows: { text: string; tone?: StatTone }[][];
    }
  /** PoB draws a circle to scale; the number is what survives reading. */
  | { type: 'radius'; radius: number };

/**
 * Where one number on the Calcs tab came from.
 *
 * The engine fills `actor.breakdown` on every pass, and PoB's own
 * `CalcBreakdownControl` turns one cell's worth of it into these sections.
 */
export type CalcBreakdown =
  | { ready: false; error?: string }
  | {
      ready: true;
      ref: string;
      label?: string;
      sections: CalcBreakdownPart[];
      /** The cell's descriptors all failed their flags for this skill,
       * which is not the same as an error. */
      empty?: boolean;
      /** The sizing pass threw; the content is whole, its pixel widths
       * are not, and nothing here wanted those. */
      partial?: boolean;
      buildMs: number;
    };

export interface CalcSubSection {
  label: string;
  /** A summary shown beside the sub-section's title, e.g. "241.4 DPS". */
  extra?: string | null;
  rows: CalcRow[];
}

export interface CalcSection {
  id: string;
  /** PoB's own column grouping: 1 offence and wide, 2 and 3 defensive. */
  group: number;
  /** How many of PoB's columns it asks for. Damage matrices want three. */
  width: number;
  tone: StatTone;
  subSections: CalcSubSection[];
}

/** The Calcs tab's own skill selection, separate from the sidebar's. */
export interface CalcSelector {
  socketGroupId: number;
  socketGroups: NamedOption[];
  skillId: number;
  skills: NamedOption[];
}

export type CalcsSnapshot =
  | { ready: false; engineError?: string | null }
  | {
      ready: true;
      sections: CalcSection[];
      rowCount: number;
      /** Milliseconds the engine spent building this payload. */
      buildMs: number;
      selector: CalcSelector | null;
      engineError?: string | null;
    };

export type StatsSnapshot =
  | { ready: false; engineError?: string | null }
  | {
      ready: true;
      lines: StatLine[];
      warnings: string[];
      socketGroupId: number;
      socketGroups: NamedOption[];
      skillId: number;
      skills: NamedOption[];
      engineError?: string | null;
    };

/* ------------------------------------------------------------- the items */

/** One of PoB's equipment slots, as it currently stands. */
export interface ItemSlot {
  /** The engine's own name, and the key every command uses. */
  name: string;
  /** What PoB labels it: the two weapon sets share labels, not names. */
  label: string;
  /** 0 when empty. */
  itemId: number;
  /** "None" plus every item PoB considers valid for this slot. */
  options: { id: number; name: string; rarity?: StatTone }[];
  /** Flasks are the only slots that can be equipped but switched off. */
  flask?: boolean;
  active?: boolean;
  /** A jewel socket on the passive tree rather than a piece of equipment. */
  socket?: boolean;
  /** For a socket hanging off a piece of gear, the gear's slot name. */
  jewel?: string;
  /** 1 or 2 on the weapon slots, absent elsewhere. */
  weaponSet?: number;
}

export interface ItemSummary {
  id: number;
  name: string;
  base: string;
  /** NORMAL | MAGIC | RARE | UNIQUE | RELIC */
  rarity: string;
  /** The slot it is equipped in, if any. */
  equipped?: string;
}

export type ItemsSnapshot =
  | { ready: false; engineError?: string | null }
  | {
      ready: true;
      slots: ItemSlot[];
      /** In PoB's own order: by the slot an item belongs in, then by where
       * it is equipped. */
      items: ItemSummary[];
      sets: { id: number; name: string }[];
      setId: number;
      weaponSet: number;
      buildMs: number;
      engineError?: string | null;
    };

/**
 * One line of PoB's own item tooltip.
 *
 * `block` separates the item from the "Equipping this item will..."
 * comparison beneath it; everything in block 1 is the item itself.
 */
export interface ItemLine {
  text?: string;
  tone?: StatTone;
  size?: number;
  block: number;
  centre?: boolean;
  separator?: boolean;
}

export type ItemDetail =
  | { ready: false; error?: string }
  | {
      ready: true;
      id: number;
      name: string;
      rarity: string;
      /** The slot the comparison was run against, if one was asked for. */
      slot?: string;
      lines: ItemLine[];
      /** Desktop keyboard hints the bridge dropped. */
      droppedTips: number;
      buildMs: number;
    };

/**
 * One slot a staged item could go in, and what it would do there.
 *
 * The order these arrive in is PoB's own and is load-bearing: an empty
 * slot first, then the slot holding something this item is an alternative
 * to, then by what the build would actually do. The first row is the one
 * worth reading.
 */
export interface StagedSlot {
  name: string;
  label: string;
  /** Where PoB's own auto-equip would have put it, which is not the same
   * thing as the best slot for it. */
  primary?: boolean;
  /** Nothing is in it, which is what sorts it to the top. */
  empty?: boolean;
  /** It holds the same unique, or the same base and subtype. */
  similar?: boolean;
  /** The staged item is already here, so the comparison below is what
   * taking it out would do. */
  removing?: boolean;
  weaponSet?: number;
  socket?: boolean;
  /** What equipping it here would displace. */
  replaces?: { id: number; name: string; rarity: string };
  /** The three numbers the ordering turns on. Absent where the build does
   * not produce them: FullDPS only exists with a full-DPS group. */
  fullDPS?: number;
  combinedDPS?: number;
  totalEHP?: number;
  compare?: Comparison;
}

/**
 * PoB's comparison lines for one change.
 *
 * `WhatIf` without a cost of its own, because these arrive several at a
 * time inside a bigger answer that reports the cost once.
 */
export type Comparison =
  | { ready: false; error?: string }
  | {
      ready: true;
      lines: ItemLine[];
      droppedTips: number;
      /** Set when equipping it there moves nothing at all. */
      unchanged?: boolean;
    };

/**
 * What one passive node would be worth.
 *
 * Two answers where the node is not adjacent. `node` is what the node
 * alone does; `path` is what the whole route to it does, and carries the
 * per-point column, which is the only way to weigh a route of six nodes
 * against one of two. PoB shows both for the same reason.
 */
export type TreeWhatIf =
  | { ready: false; error?: string }
  | {
      ready: true;
      id: number;
      allocated?: boolean;
      /** Granted by an item, so the only question is what losing it costs. */
      granted?: boolean;
      node: Comparison;
      path?: Comparison;
      /** How many nodes the route covers. */
      pathLength?: number;
      buildMs: number;
    };

/**
 * The item on the bench.
 *
 * PoB keeps a pasted item as `displayItem` and does not equip it until
 * told to, which is what makes the question "what would this do?"
 * answerable before committing to an answer.
 */
export type StagedItem =
  | { ready: false; error?: string }
  | {
      ready: true;
      name: string;
      base: string;
      rarity: string;
      /** Where AddItem would put it unaided. */
      primarySlot?: string;
      lines: ItemLine[];
      droppedTips: number;
      slots: StagedSlot[];
      /** How many of this unique may be worn at once. */
      limit?: number;
      /** That many already are, so only the slots holding one are offered. */
      limited?: boolean;
      /** No slot will take it at all. */
      fitsNothing?: boolean;
      buildMs: number;
    };

export interface ItemSearchResult {
  name: string;
  base: string;
  rarity: string;
  /** Where PoB would equip it. */
  slot?: string;
  /** Which database it came out of. */
  db: 'unique' | 'rare';
  league?: string;
  /** How PoB says this is obtained, with its colour markup taken off. */
  source?: string;
  /** The level it requires, if it requires one. */
  level?: number;
  /**
   * Only on a stat sort: the stat as a reader should see it, and the
   * change against the build as it stands. Absent together for an item
   * that fits no slot this build has.
   */
  value?: number;
  delta?: number;
  fits?: boolean;
}

/** The eight axes PoB filters its database on. */
export interface ItemFilters {
  q: string;
  mode: string;
  db: string;
  slot: string;
  type: string;
  league: string;
  req: string;
  source: string;
  sort: string;
}

/** What each of those axes offers, learned from the database itself. */
export interface ItemFilterOptions {
  ready: boolean;
  loading?: boolean;
  slots: string[];
  typeGroups: { key: string; label: string }[];
  types: string[];
  leagues: string[];
  sorts: { key: string; label: string }[];
  sources: { key: string; label: string }[];
  requirements: { key: string; label: string }[];
  modes: { key: string; label: string }[];
}

export interface ItemSearchSnapshot {
  ready: boolean;
  error?: string;
  results: ItemSearchResult[];
  total?: number;
  truncated?: boolean;
  /** How many matched everything except the obtainability default. */
  hiddenBySource?: number;
  sort?: string;
  sortLabel?: string;
  /** What the sorted stat is worth right now, for the delta column. */
  baseline?: number;
  /**
   * Set while a stat sort is still running. The list is then ranked among
   * what has been measured rather than among everything that matched, so
   * asking again with the same filters carries the scan on.
   */
  scanning?: boolean;
  scanned?: number;
  /** True while PoB is still parsing the databases at startup. */
  loading?: boolean;
  buildMs?: number;
}

/* ---------------------------------------------------------- the crafting */

/** One prefix or suffix slot on the bench item. */
export interface CraftAffixRow {
  index: number;
  /** The tier in the slot. Absent when the slot is empty. */
  modId?: string;
  /** The modifier's own name, as the game gives it ("of the Brute"). */
  affix?: string;
  /** What it is mutually exclusive with. */
  group?: string;
  /** The item level this tier starts at. */
  level?: number;
  /** The series label, with `#` where the tiers differ. */
  label?: string;
  /** What it reads at its current roll. */
  lines?: string[];
  /** Which tier this is, out of how many, 1 being the lowest. */
  tier?: number;
  tierCount?: number;
  /** Every tier of this modifier, lowest first. */
  modIds?: string[];
  /** Where in this tier's range it sits: 0 the bottom, 1 the top. */
  roll?: number;
  /** Set when the item can no longer roll what is in the slot. */
  unknown?: boolean;
}

/** One rune or soul core a socket will take. */
export interface CraftRune {
  name: string;
  label: string;
  lines: string[];
  /** Rune or SoulCore: different objects in the game. */
  type?: string;
  /** The level the rune itself needs, which is not the item's. */
  req?: number;
  /** How many of it one item may carry, where the game caps that. */
  limit?: number;
  /** A rune that cannot be taken out once it is in. */
  socketBound?: boolean;
}

/** One socket on the bench item, and what is in it. */
export interface CraftRuneRow {
  index: number;
  name?: string;
  label?: string;
  lines?: string[];
  type?: string;
  socketBound?: boolean;
  /** Set when the item can no longer take what is in the socket. */
  unknown?: boolean;
}

export interface CraftSockets {
  rune: number;
  jewel: number;
  /** PoB's own cap on both. */
  max: number;
  /** What the base itself comes with, which PoB lets you exceed. */
  natural?: number;
}

export interface CraftRunes {
  ready: boolean;
  error?: string;
  options?: CraftRune[];
  total?: number;
}

export interface CraftState {
  ready: boolean;
  name?: string;
  baseName?: string;
  itemType?: string;
  rarity?: string;
  /**
   * Whether this item has affix slots at all. True only for a magic or
   * rare item made in the craft dialog: a unique, or a rare copied out of
   * the game, carries its modifiers as text instead.
   */
  crafted?: boolean;
  affixLimit?: number;
  corrupted?: boolean;
  quality?: number;
  qualityEditable?: boolean;
  prefixes?: CraftAffixRow[];
  suffixes?: CraftAffixRow[];
  /** Absent when the base has no rune sockets and cannot be given any. */
  sockets?: CraftSockets;
  runes?: CraftRuneRow[];
  /** Absent when the item cannot be anointed at all. */
  anoint?: { slots: CraftAnointSlot[] };
  /**
   * Whether the base can be corrupted, and whether it already is.
   * The lists behind the panel are their own call: reading them
   * means opening PoB's dialog, which is not free.
   */
  corrupt?: { corruptible: boolean; corrupted?: boolean };
  /**
   * Catalysts: jewellery quality, thirteen of them, each scaling the
   * modifiers that carry its own tag. Absent for a base no catalyst
   * touches. The prices behind the panel are their own call, because
   * reading them means thirteen runs of the calculator.
   */
  catalyst?: { catalyst: number; quality?: number; options: CraftCatalystOption[] };
}

/** One modifier a slot could hold, with all of its tiers. */
export interface CraftAffixOption {
  key: string;
  label: string;
  affix: string;
  /** Lowest tier first. */
  modIds: string[];
  tierCount: number;
  /** The item level each tier starts at, in the same order. */
  levels: number[];
  haveRange?: boolean;
  /** What the top tier reads at a middling roll. */
  preview: string[];
}

export interface CraftAffixes {
  ready: boolean;
  error?: string;
  kind?: string;
  index?: number;
  options?: CraftAffixOption[];
  total?: number;
  /** What is in the slot now, so the list can mark it. */
  selected?: string;
}

export interface CraftBase {
  name: string;
  label: string;
  level?: number;
}

export interface CraftBases {
  ready: boolean;
  types?: string[];
  type?: string;
  bases?: CraftBase[];
  rarities?: string[];
}

/** One notable the bench item could be anointed with. */
export interface CraftAnoint {
  id: number;
  name: string;
  /** What the notable grants, as the tree words it. */
  lines: string[];
  /** The distilled emotions the anoint costs. Three, mostly. */
  recipe: string[];
  /** Already on the tree, so anointing it would change nothing. */
  allocated?: boolean;
}

export interface CraftAnoints {
  ready: boolean;
  error?: string;
  options?: CraftAnoint[];
  /** How many matched, which can be more than were sent. */
  total?: number;
  truncated?: boolean;
}

/** One anoint slot on the bench item, and what is in it. */
export interface CraftAnointSlot {
  /**
   * Which enchant line this is, not which anoint: slot 2 is the second
   * enchant line, and only the second anoint if the first line is one.
   */
  index: number;
  /** The notable in it, by name. Absent when the slot is empty. */
  node?: string;
  /**
   * What the line holds when it is not an anoint. Anointing replaces the
   * line whatever is in it, so this is a warning rather than a label.
   */
  other?: string;
}

/** What one anoint would do, asked before it is applied. */
export type AnointWhatIf =
  | { ready: false; error?: string }
  | {
      ready: true;
      lines: ItemLine[];
      droppedTips?: number;
      unchanged?: boolean;
      /**
       * Why nothing would move. PoB's two early answers: the node is
       * already allocated on the tree, or already anointed.
       */
      reason?: string;
      buildMs?: number;
    };

/* --------------------------------------------------------- catalysts */

/** One of PoB's thirteen catalysts, as its own dropdown names it. */
export interface CraftCatalystOption {
  /** 1 to 13, or 0 for taking the catalyst off again. */
  id: number;
  name: string;
}

/** One catalyst, priced against the item as it stands. */
export interface CraftCatalystRow extends CraftCatalystOption {
  /** The one already on the item. */
  current?: boolean;
  /**
   * The item's own modifiers this catalyst would scale, read off PoB's
   * parse and written out at the scaled value. Empty for most of the
   * thirteen on most items, which is the useful part.
   */
  scales?: string[];
  compare?: { ready: boolean; error?: string; lines?: ItemLine[]; unchanged?: boolean };
  error?: string;
}

export interface CraftCatalysts {
  ready: boolean;
  error?: string;
  /** The slot both sides of every comparison put the item in. */
  slot?: string;
  /** The quality all thirteen were priced at, so they can be read together. */
  quality?: number;
  /** What is on the item now, 0 for none. */
  catalyst?: number;
  options?: CraftCatalystRow[];
  buildMs?: number;
}

/* --------------------------------------------------------- corrupting */

/** One corruption implicit the bench item could take. */
export interface CraftCorruption {
  modId: string;
  /** What it reads, with its range still in it. */
  lines: string[];
  /**
   * An item carries one modifier per group, which is why picking the same
   * group in a second slot is not offered.
   */
  group?: string;
}

/** One of the bench item's explicits that a corruption would scale. */
export interface CraftCorruptRange {
  /** Its place in the item's explicit lines, which is how PoB keys it. */
  index: number;
  /** The line as the item stores it, range and all. */
  line?: string;
  /** Where the roll sits now, between 0.78 and 1.22. */
  value: number;
  /** The same line read out at that roll. */
  scaled: string;
}

/** A corruption implicit the item already has. */
export interface CraftCorruptCurrent {
  line: string;
  /** Absent where the line did not match any modifier PoB knows. */
  modId?: string;
  group?: string;
}

export interface CraftCorruptions {
  ready: boolean;
  error?: string;
  /** "Corrupted", plus "Glimpse of Chaos" on a helmet. */
  sources?: { id: string; name: string }[];
  /** How many implicit slots the chosen source offers. */
  slots?: number;
  options?: CraftCorruption[];
  total?: number;
  /** Uniques only: the rolls a corruption would scale. */
  ranges?: CraftCorruptRange[];
  /** What the item already carries, so the draft can start from it. */
  current?: CraftCorruptCurrent[];
  corrupted?: boolean;
}

/** A corruption as it is asked for: implicits, or roll ranges, never both. */
export interface CorruptDraft {
  source?: string;
  mode: 'implicits' | 'ranges';
  /** Keyed by slot, because filling only the second one is a thing people do. */
  implicits: Record<number, string>;
  /** Keyed by the explicit's index on the item. */
  ranges: Record<number, number>;
}

/** What corrupting would do, asked before it is done. */
export type CorruptPreview =
  | { ready: false; error?: string }
  | {
      ready: true;
      /** The corrupted item, as PoB would draw it. */
      item: ItemLine[];
      droppedTips?: number;
      /** The slot both sides of the comparison put it in. */
      slot?: string;
      compare: {
        ready: boolean;
        error?: string;
        lines?: ItemLine[];
        unchanged?: boolean;
      };
      buildMs?: number;
    };

/* ------------------------------------------------------------- the notes */

/** One colour the desktop Notes tab offers, as PoB names it. */
export interface NoteColour {
  name: string;
  /** The caret escape that selects it, such as "^xFFFF77". */
  code: string;
  /** The same colour, as CSS. */
  hex: string;
}

export interface NotesSnapshot {
  ready: boolean;
  text?: string;
  /** PoB's own comparison of the buffer against what the file holds. */
  modified?: boolean;
  palette?: NoteColour[];
  /** What `^0` to `^9` resolve to. */
  digits?: Record<string, string>;
}

/* ------------------------------------------------------------ the skills */

/** One socket group in the list. */
export interface SocketGroup {
  index: number;
  /** PoB's own label: the group's name, or the skills in it. */
  label: string;
  /** The group's own name, which is the editable one. */
  name: string;
  slot?: string;
  enabled: boolean;
  fullDPS?: boolean;
  main?: boolean;
  /** Set when an item or passive granted the group, which makes it
   * read-only: PoB rebuilds it on every pass. */
  source?: string;
  gemCount: number;
  /** The active skills the group currently grants. */
  skills: string[];
}

export interface GemInstance {
  index: number;
  name: string;
  level: number;
  quality: number;
  enabled: boolean;
  count: number;
  /** strength | dexterity | intelligence, from the granted effect. */
  tone?: StatTone;
  support?: boolean;
  tags?: string;
  maxLevel?: number;
  /** Set when the build cannot use this gem, with PoB's reason. */
  error?: string;
}

export type SkillsSnapshot =
  | { ready: false; engineError?: string | null }
  | {
      ready: true;
      groups: SocketGroup[];
      sets: { id: number; name: string }[];
      setId: number;
      mainGroup: number;
      /** The expanded group, when one was asked for. */
      selected?: number;
      gems?: GemInstance[];
      buildMs: number;
      engineError?: string | null;
    };

/** PoB's own gem or socket-group tooltip. Same line model as the items. */
export type SkillDetail =
  | { ready: false; error?: string }
  | {
      ready: true;
      name?: string;
      lines: ItemLine[];
      droppedTips: number;
      buildMs: number;
    };

export interface GemSearchResult {
  id: string;
  name: string;
  support?: boolean;
  tags?: string;
  maxLevel?: number;
}

export interface GemSearchSnapshot {
  ready: boolean;
  results: GemSearchResult[];
  total?: number;
  truncated?: boolean;
}

/* ------------------------------------------------------- the config tab */

/** check | count | integer | countAllowZero | float | list | text */
export type ConfigType =
  | 'check'
  | 'count'
  | 'integer'
  | 'countAllowZero'
  | 'float'
  | 'list'
  | 'text';

export type ConfigValue = boolean | number | string;

export interface ConfigOption {
  var: string;
  type: ConfigType;
  label: string;
  /** Absent when the option has never been set: JSON drops a nil. */
  value?: ConfigValue;
  /** What the field shows while empty; PoB computes some of these. */
  placeholder?: ConfigValue;
  default?: ConfigValue;
  /** Set when the value differs from the default. PoB draws a border. */
  changed?: boolean;
  list?: { value: ConfigValue; label: string; tone?: StatTone }[];
  /** PoB's own explanation, some of it computed from the live build. */
  tooltip?: string[];
}

export interface ConfigSection {
  name: string;
  /** PoB lays its sections out in three columns. */
  col: number;
  options: ConfigOption[];
}

export interface CustomModBlock {
  index: number;
  title: string;
  enabled: boolean;
  text: string;
}

export type ConfigSnapshot =
  | { ready: false; engineError?: string | null }
  | {
      ready: true;
      sections: ConfigSection[];
      sets: { id: number; name: string }[];
      setId: number;
      showAll: boolean;
      customMods: CustomModBlock[];
      /** How many options apply to this build, and how many exist. */
      shown: number;
      total: number;
      /** Options PoB declares more than once; the first won. */
      duplicates: string[];
      buildMs: number;
      engineError?: string | null;
    };

/* ---------------------------------------------------- import and export */

/** What a build code contains, read without importing it. */
export type CodeInspection =
  | { valid: false; error: string }
  | {
      valid: true;
      level?: number;
      class?: string;
      ascendancy?: string;
      /** The code itself, after any URL wrapper is stripped. */
      codeBytes: number;
      xmlBytes: number;
    };

export type BuildCode =
  | { ready: false; error?: string }
  | { ready: true; code: string; codeBytes: number; xmlBytes: number };

/* ------------------------------------------------------- the build list */

export type BuildSort = 'NAME' | 'CLASS' | 'EDITED' | 'LEVEL';

export interface BuildEntry {
  kind: 'build' | 'folder';
  name: string;
  /** The folder it sits in, "" for the root. Folders carry their parent. */
  subPath: string;
  /** Unix seconds. */
  modified?: number;
  /** Builds only. */
  fileName?: string;
  path?: string;
  level?: number;
  class?: string;
  ascendancy?: string;
  /** Set on the build currently loaded. */
  open?: boolean;
}

export type BuildsSnapshot =
  | { ready: false; error?: string }
  | {
      ready: true;
      entries: BuildEntry[];
      /** Where PoB is keeping them, which is worth showing once. */
      buildPath: string;
      sort: BuildSort;
      /** Absent when the open build has never been saved. */
      openPath?: string;
      unsaved: boolean;
      buildMs: number;
    };

/* ------------------------------------------------------- the comparison */

export interface CompareBuild {
  name: string;
  class?: string;
  ascendancy?: string;
  level?: number;
}

export interface CompareEntry extends CompareBuild {
  index: number;
  label: string;
  active?: boolean;
}

/** One stat on both builds, or a section break. */
export interface CompareRow {
  /** PoB's own section spacer, same as in the sidebar. */
  gap?: boolean;
  label?: string;
  tone?: StatTone;
  /** Formatted with the stat's own fmt, so these are strings. */
  primary?: string;
  compare?: string;
  /** Absent when the two agree. */
  diff?: string;
  percent?: number;
  /** Whether the difference is an improvement: more resistance is, more
   * mana cost is not. The stat decides. */
  better?: boolean;
}

export type CompareSnapshot =
  | { ready: false; error?: string }
  | {
      ready: true;
      entries: CompareEntry[];
      /** 0 when nothing is loaded to compare against. */
      active: number;
      primary?: CompareBuild;
      compare?: CompareBuild;
      rows?: CompareRow[];
      buildMs: number;
    };

/* ----------------------------------------------------- editing an item */

export interface ItemRange {
  index: number;
  /** The modifier as written, with its bounds: "+(30-50) to Evasion". */
  line: string;
  /** 0 is the bottom of the roll, 1 the top. PoB's own slider value. */
  range: number;
}

export type ItemEdit =
  | { ready: false }
  | {
      ready: true;
      id: number;
      name: string;
      rarity: string;
      /** The item as text. Editing this covers everything else. */
      raw?: string;
      ranges: ItemRange[];
      variants: { index: number; name: string }[];
      variant?: number;
      /** Items whose variants are several independent choices; the simple
       * variant control does not apply to them. */
      variantGroups?: boolean;
    };

/** The route a click would take, as the engine would take it. */
export type TreePathPreview =
  | { ready: false; error?: string }
  | {
      ready: true;
      id: number;
      /** Node ids, target first. Empty when already allocated. */
      path: number[];
      cost: number;
      allocated?: boolean;
      reachable?: boolean;
    };

/* --------------------------------------------------------------- what if */

/**
 * What the build would look like with one thing changed.
 *
 * PoB's own comparison lines, from the same mechanism behind its checkbox
 * tooltips: flip the setting, rerun the calculator, compare, flip back.
 */
export type WhatIf =
  | { ready: false; error?: string }
  | {
      ready: true;
      lines: ItemLine[];
      droppedTips: number;
      /** Set when the change moves nothing at all. */
      unchanged?: boolean;
      buildMs: number;
    };
