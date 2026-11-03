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
