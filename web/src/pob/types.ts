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
