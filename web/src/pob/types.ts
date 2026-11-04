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
   * buildMode.outputRevision — bumped on every recalculation. The Calcs view
   * refetches when this moves instead of polling.
   */
  outputRevision?: number;
  /** Mirrors buildMode.unsaved: any modFlag across the tabs. */
  unsaved: boolean;
  /** Null until the build has been saved once; gates "Save" vs "Save As". */
  dbFileName: string | null;

  characterLevel: number;
  /** buildMode.characterLevelAutoMode -- level derived from the tree, or typed. */
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
export interface EnginePopup {
  title: string;
}

/** Whether the engine is reachable. */
export type Connection = 'connecting' | 'live' | 'offline';

/**
 * What GET /state answers with.
 *
 * `ready` is false when the engine is up but no build is open, and in that
 * case nothing else is present -- hence the union rather than optional
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
 * carry meaning — a damage type, a warning, an over-cap value. The bridge
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
 * centred at (cx, cy) — both endpoints lie on that circle by construction,
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
      /** Nodes PoB can path to from the allocated tree, so clickable. */
      reachable: number[];
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
}

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
  /** What PoB labels it — the two weapon sets share labels, not names. */
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

export interface ItemSearchResult {
  name: string;
  base: string;
  rarity: string;
  /** Where PoB would equip it. */
  slot?: string;
}

export interface ItemSearchSnapshot {
  ready: boolean;
  results: ItemSearchResult[];
  total?: number;
  truncated?: boolean;
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
   * read-only — PoB rebuilds it on every pass. */
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
