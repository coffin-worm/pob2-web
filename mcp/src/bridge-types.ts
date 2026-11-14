/**
 * The slice of the engine's JSON this server reads.
 *
 * `web/src/pob/types.ts` is the authority on these shapes and describes all
 * of them. This is a narrowed copy rather than an import because that file
 * belongs to the web package and pulling it in would drag the whole UI's
 * module graph through tsc for the sake of types that are erased anyway.
 *
 * Narrowed, not simplified: the fields below are spelled exactly as the
 * engine sends them. Anything missing here is missing because this server
 * does not read it, not because it does not exist.
 */

/** Colour classifications the engine puts on its own lines. */
export type Tone = string;

export interface NamedOption {
  id: number;
  name: string;
}

export interface PointBudget {
  used: number;
  max: number;
  over?: boolean;
}

export interface BuildPoints {
  passives: PointBudget;
  weaponSet1: PointBudget;
  weaponSet2: PointBudget;
  ascendancy: PointBudget;
}

export type BridgeSnapshot =
  | { ready: false; engineError?: string | null }
  | {
      ready: true;
      buildName: string;
      outputRevision?: number;
      unsaved: boolean;
      dbFileName: string | null;
      characterLevel: number;
      levelAutoMode: boolean;
      classId: number;
      classes: NamedOption[];
      ascendClassId: number;
      ascendancies: NamedOption[];
      loadoutId: number;
      loadouts: NamedOption[];
      points: BuildPoints;
      /**
       * Which game data the engine is running on, and which the build was
       * made against. A calculation against last patch's data is not wrong
       * in a way the numbers show, so the version has to be said.
       */
      data?: {
        tree?: string;
        target?: string;
        buildTree?: string;
        buildTarget?: string;
      };
      engineError?: string | null;
    };

export interface StatLine {
  label: string;
  value?: string;
  tone: Tone;
  size: 'header' | 'normal' | 'small';
  note?: boolean;
}

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
      /**
       * The main skill's stat sets, and which one the sheet is about. A
       * granted effect can declare more than one (Essence Drain has
       * "Projectile" and "Damage over Time") and PoB calculates the
       * selected one alone, so a build whose damage is its debuff reads as
       * the projectile until this moves.
       */
      statSets?: NamedOption[];
      statSetId?: number;
      /** PoB's older multi-part mechanism, on the same footing. */
      parts?: NamedOption[];
      partId?: number;
    };

/** One line of a PoB tooltip. `block` 1 is the subject, 2 the comparison. */
export interface ItemLine {
  text?: string;
  tone?: Tone;
  block: number;
  centre?: boolean;
  separator?: boolean;
}

export interface TreeNode {
  id: number;
  type: string;
  name: string;
  ascendancy?: string;
  stats: string[];
  flavour?: string;
}

export type TreeSnapshot = { ready: false } | { ready: true; nodes: TreeNode[] };

export type TreeAllocSnapshot =
  | { ready: false }
  | {
      ready: true;
      allocated: number[];
      reachable: [number, number][];
      /**
       * The allocated nodes paid for out of one weapon set rather than
       * the shared pool, as `[id, 1]` or `[id, 2]`. They are in
       * `allocated` too: the set is a fact about how the point was paid
       * for, not a separate kind of allocation.
       */
      weaponSets?: [number, number][];
      classId: number;
      ascendClassId: number;
    };

export interface ItemSlot {
  name: string;
  label: string;
  itemId: number;
  flask?: boolean;
  active?: boolean;
  /** 1 or 2 on a slot that belongs to one weapon set, absent on the rest. */
  weaponSet?: number;
}

export interface ItemSummary {
  id: number;
  name: string;
  base: string;
  rarity: string;
  equipped?: string;
}

export type ItemsSnapshot =
  | { ready: false; engineError?: string | null }
  | {
      ready: true;
      slots: ItemSlot[];
      items: ItemSummary[];
      sets: NamedOption[];
      setId: number;
      weaponSet: number;
    };

export type ItemDetail =
  | { ready: false; error?: string }
  | {
      ready: true;
      id: number;
      name: string;
      rarity: string;
      slot?: string;
      lines: ItemLine[];
    };

/** One line of a skill's own stat sheet, or a section break. */
export interface SkillStatLine {
  gap?: boolean;
  label?: string;
  value?: string;
}

export type SkillStats =
  | { ready: false; error?: string }
  | {
      ready: true;
      group: number;
      groupLabel: string;
      /** Every active skill the group grants, in order. */
      skills: string[];
      /** Which of them these numbers are about, counting from 1. */
      skill: number;
      weaponSet?: number;
      /** Set when this is already the build's main skill. */
      main?: boolean;
      lines: SkillStatLine[];
    };

export interface SocketGroup {
  index: number;
  label: string;
  name: string;
  slot?: string;
  enabled: boolean;
  fullDPS?: boolean;
  main?: boolean;
  source?: string;
  gemCount: number;
  skills: string[];
  /**
   * PoB's own label for the weapon set: "Set 1", "Set 2", or "Both" when
   * the group is tied to neither and so follows whichever set is active.
   */
  weaponSet?: string;
}

export interface GemInstance {
  index: number;
  name: string;
  level: number;
  quality: number;
  enabled: boolean;
  count: number;
  support?: boolean;
  tags?: string;
  maxLevel?: number;
  error?: string;
}

export type SkillsSnapshot =
  | { ready: false; engineError?: string | null }
  | {
      ready: true;
      groups: SocketGroup[];
      sets: NamedOption[];
      setId: number;
      mainGroup: number;
      selected?: number;
      gems?: GemInstance[];
    };

export interface ConfigOption {
  var: string;
  type: string;
  label: string;
  value?: boolean | number | string;
  placeholder?: boolean | number | string;
  default?: boolean | number | string;
  changed?: boolean;
  list?: { value: boolean | number | string; label: string }[];
}

export interface ConfigSection {
  name: string;
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
      sets: NamedOption[];
      setId: number;
      customMods: CustomModBlock[];
      shown: number;
      total: number;
    };

/** The shape every "what would this do" route answers with. */
export type WhatIf =
  | { ready: false; error?: string }
  | {
      ready: true;
      lines: ItemLine[];
      unchanged?: boolean;
      /**
       * Lines on the item the engine did not read, when the comparison is
       * about an item and it has any. A change worth nothing is often a
       * change to something PoB does not model, and the lines it could
       * not place are where that shows.
       */
      unparsed?: string[];
    };

/** One row of the power report: a node, and what it is worth. */
export interface PowerNode {
  id: number;
  name: string;
  type?: string;
  allocated?: boolean;
  /** What the route to it costs in points. Absent on a cluster notable. */
  points?: number;
  cluster?: boolean;
  /** The node by itself, as a change in the chosen stat. */
  power: number;
  /** The whole route to it, divided by what the route costs. */
  pathPower: number;
  stats: string[];
}

/**
 * The tree ranked by what each node is worth.
 *
 * `scanning` means the engine is still measuring and `results` is empty:
 * there is no partial order to show, because the scan walks outward from
 * the allocated tree and a ranking of what it has reached so far would
 * read as an answer.
 */
export type TreePowerSnapshot =
  | { ready: false; error?: string }
  | {
      ready: true;
      stat: string;
      statLabel: string;
      scanning?: true;
      percent?: number;
      baseline?: number;
      lowerIsBetter?: true;
      order?: 'node' | 'route';
      include?: string;
      depth?: number;
      total?: number;
      results: PowerNode[];
    };

export type TreeWhatIf =
  | { ready: false; error?: string }
  | {
      ready: true;
      id: number;
      allocated?: boolean;
      granted?: boolean;
      node: WhatIf;
      path?: WhatIf;
      pathLength?: number;
    };

export interface ItemSearchResult {
  name: string;
  base: string;
  rarity: string;
  slot?: string;
  db: 'unique' | 'rare';
  league?: string;
  source?: string;
  level?: number;
  value?: number;
  delta?: number;
  fits?: boolean;
}

export interface ItemSearchSnapshot {
  ready: boolean;
  error?: string;
  results: ItemSearchResult[];
  total?: number;
  truncated?: boolean;
  sortLabel?: string;
  baseline?: number;
  scanning?: boolean;
  scanned?: number;
  loading?: boolean;
}

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

export interface BuildEntry {
  kind: 'build' | 'folder';
  name: string;
  subPath: string;
  modified?: number;
  fileName?: string;
  path?: string;
  level?: number;
  class?: string;
  ascendancy?: string;
  open?: boolean;
}

export type BuildsSnapshot =
  | { ready: false; error?: string }
  | {
      ready: true;
      entries: BuildEntry[];
      buildPath: string;
      openPath?: string;
      unsaved: boolean;
    };

export type CodeInspection =
  | { valid: false; error: string }
  | {
      valid: true;
      level?: number;
      class?: string;
      ascendancy?: string;
      codeBytes: number;
      xmlBytes: number;
    };

export interface CalcCell {
  text: string;
  tone?: Tone;
}

export type CalcBreakdownPart =
  | { type: 'text'; lines: CalcCell[] }
  | {
      type: 'table';
      label?: string;
      footer?: string;
      cols: { key: string; label: string }[];
      rows: CalcCell[][];
    }
  | { type: 'radius'; radius: number };

export type CalcBreakdown =
  | { ready: false; error?: string }
  | {
      ready: true;
      ref: string;
      label?: string;
      sections: CalcBreakdownPart[];
      empty?: boolean;
      partial?: boolean;
    };

export interface CalcRow {
  label: string;
  values: string[];
  /**
   * One per column slot. A non-empty entry addresses that cell's working
   * inside PoB's own tables, which is what /calcs/breakdown wants.
   */
  refs?: string[];
}

export interface CalcSubSection {
  label: string;
  extra?: string | null;
  rows: CalcRow[];
}

export interface CalcSection {
  id: string;
  subSections: CalcSubSection[];
}

export type CalcsSnapshot =
  | { ready: false; engineError?: string | null }
  | { ready: true; sections: CalcSection[]; rowCount: number };

/* --------------------------------------------------------------- the bench */

/**
 * Crafting happens on PoB's bench, never on an item in a slot.
 *
 * `displayItem` is where the desktop Items tab keeps the item being worked
 * on, and every route below reads it. Nothing here is a view of the
 * equipped item: a copy goes onto the bench, is changed there, and is
 * equipped only when somebody says so.
 */

/** One slot the bench item would fit, and what putting it there would do. */
export interface StagedSlot {
  name: string;
  label: string;
  primary?: boolean;
  empty?: boolean;
  similar?: boolean;
  /** The item is already here, so the comparison is what removing it does. */
  removing?: boolean;
  weaponSet?: number;
  compare?: WhatIf;
}

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
      slots: StagedSlot[];
      /** How many of this unique may be worn at once. */
      limit?: number;
      /** That many already are, so only the slots holding one are offered. */
      limited?: boolean;
      fitsNothing?: boolean;
      /**
       * Lines the parser could not place, which no number here counts.
       *
       * Absent rather than empty when every line parsed.
       */
      unparsed?: string[];
      /** The text shows rune modifiers without naming the rune. */
      runesMissing?: boolean;
    };

/** One prefix or suffix slot on the bench item. */
export interface CraftAffixRow {
  index: number;
  modId?: string;
  affix?: string;
  level?: number;
  label?: string;
  lines?: string[];
  tier?: number;
  tierCount?: number;
  /** Every tier of this modifier, lowest first, so [0] is the series. */
  modIds?: string[];
  /** Where in this tier's range it sits: 0 the bottom, 1 the top. */
  roll?: number;
  unknown?: boolean;
}

export interface CraftRuneRow {
  index: number;
  name?: string;
  label?: string;
  lines?: string[];
  type?: string;
  unknown?: boolean;
}

export interface CraftAnointSlot {
  /** Which enchant line this is, not which anoint. */
  index: number;
  node?: string;
  /** What the line holds when it is not an anoint. */
  other?: string;
}

export interface CraftState {
  ready: boolean;
  name?: string;
  baseName?: string;
  itemType?: string;
  rarity?: string;
  /**
   * Whether the item has affix slots at all. True only for a magic or rare
   * made in the craft dialog: a unique, or a rare copied out of the game,
   * carries its modifiers as text instead.
   */
  crafted?: boolean;
  affixLimit?: number;
  corrupted?: boolean;
  quality?: number;
  prefixes?: CraftAffixRow[];
  suffixes?: CraftAffixRow[];
  sockets?: { rune: number; jewel: number; max: number; natural?: number };
  runes?: CraftRuneRow[];
  anoint?: { slots: CraftAnointSlot[] };
  corrupt?: { corruptible: boolean; corrupted?: boolean };
  catalyst?: { catalyst: number; quality?: number; options: { id: number; name: string }[] };
}

/** One modifier a slot could hold, with all of its tiers. */
export interface CraftAffixOption {
  /** The lowest tier's id, which is how the series is addressed. */
  key: string;
  label: string;
  affix: string;
  /** Lowest tier first. */
  modIds: string[];
  tierCount: number;
  /** The item level each tier starts at, in the same order. */
  levels: number[];
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

export interface CraftBases {
  ready: boolean;
  types?: string[];
  type?: string;
  bases?: { name: string; label: string; level?: number }[];
  rarities?: string[];
}

export interface CraftRune {
  name: string;
  label: string;
  lines: string[];
  type?: string;
  req?: number;
  limit?: number;
  socketBound?: boolean;
}

export interface CraftRunes {
  ready: boolean;
  error?: string;
  options?: CraftRune[];
  total?: number;
}

/** One notable the bench item could be anointed with. */
export interface CraftAnoint {
  id: number;
  name: string;
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

export type AnointWhatIf =
  | { ready: false; error?: string }
  | {
      ready: true;
      lines: ItemLine[];
      unchanged?: boolean;
      /** Why nothing would move: already allocated, or already anointed. */
      reason?: string;
    };

/**
 * A comparison nested inside a larger answer.
 *
 * Says the same thing as WhatIf and is spelled differently: `ready` is a
 * plain boolean here, because it sits beside the thing it describes rather
 * than standing in for the whole answer.
 */
export interface CraftCompare {
  ready: boolean;
  error?: string;
  lines?: ItemLine[];
  unchanged?: boolean;
}

/** One catalyst, priced against the item as it stands. */
export interface CraftCatalystRow {
  id: number;
  name: string;
  /** The one already on the item. */
  current?: boolean;
  /**
   * The item's own modifiers this catalyst would scale, read off PoB's
   * parse and written out at the scaled value. Empty for most of the
   * thirteen on most items, which is the useful part.
   */
  scales?: string[];
  compare?: CraftCompare;
  error?: string;
}

export interface CraftCatalysts {
  ready: boolean;
  error?: string;
  /** The slot both sides of every comparison put the item in. */
  slot?: string;
  /** The quality all thirteen were priced at, so they read against each other. */
  quality?: number;
  /** What is on the item now, 0 for none. */
  catalyst?: number;
  options?: CraftCatalystRow[];
}

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
  /** Where the roll sits now, between 0.78 and 1.22. */
  value: number;
  /** The same line read out at that roll. */
  scaled: string;
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
  /** What the item already carries, so a draft can start from it. */
  current?: { line: string; modId?: string; group?: string }[];
  corrupted?: boolean;
}

export type CorruptPreview =
  | { ready: false; error?: string }
  | {
      ready: true;
      /** The corrupted item, as PoB would draw it. */
      item: ItemLine[];
      slot?: string;
      compare: CraftCompare;
    };

/** What /item/edit exposes, of which only the raw text is read here. */
export type ItemEdit =
  | { ready: false }
  | { ready: true; id: number; name: string; rarity: string; raw?: string };

/* ---------------------------------------------------------- the comparison */

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

/**
 * One stat on both builds, or a section break.
 *
 * `diff` is the comparison minus the open build, so it is what the other
 * build has and not what this one would gain. `better` is the stat's own
 * verdict on that direction: more resistance is an improvement, more mana
 * cost is not.
 */
export interface CompareRow {
  /** PoB's own section spacer, the same as in the stat sidebar. */
  gap?: boolean;
  label?: string;
  /** Formatted with the stat's own fmt, so these are strings. */
  primary?: string;
  compare?: string;
  /** Absent when the two agree. */
  diff?: string;
  percent?: number;
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
    };

/* --------------------------------------------------------------- the notes */

/**
 * The build's notes.
 *
 * The engine also sends `palette` and `digits`, which say what PoB's colour
 * escapes resolve to. They are here for a renderer that wants to draw the
 * notes in colour; this server strips the escapes instead, so neither is
 * read and neither is below.
 */
export interface NotesSnapshot {
  ready: boolean;
  text?: string;
  /** PoB's own comparison of the buffer against what the file holds. */
  modified?: boolean;
}
