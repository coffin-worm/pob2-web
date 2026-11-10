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
      classId: number;
      ascendClassId: number;
    };

export interface ItemSlot {
  name: string;
  label: string;
  itemId: number;
  flask?: boolean;
  active?: boolean;
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
  | { ready: true; lines: ItemLine[]; unchanged?: boolean };

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
