import { create } from 'zustand';
import {
  LEVEL_MAX,
  LEVEL_MIN,
  type HeaderActions,
  type HeaderState,
  type NamedOption,
} from './types';

/**
 * A stand-in for the engine.
 *
 * This exists so the header can be built and judged before the Lua bridge
 * is solved, and it is the only file that should need deleting when the
 * bridge lands -- everything above it talks to HeaderState and HeaderActions.
 *
 * The class and ascendancy lists are hand-written and the point arithmetic
 * is a plausible approximation, not the real rules. None of it is a claim
 * about game mechanics; it is here to make the controls behave like controls.
 */

const ASCENDANCIES: Record<number, NamedOption[]> = {
  0: [
    { id: 0, name: 'None' },
    { id: 1, name: 'Warbringer' },
    { id: 2, name: 'Titan' },
    { id: 3, name: 'Smith of Kitava' },
  ],
  1: [
    { id: 0, name: 'None' },
    { id: 1, name: 'Deadeye' },
    { id: 2, name: 'Pathfinder' },
  ],
  2: [
    { id: 0, name: 'None' },
    { id: 1, name: 'Infernalist' },
    { id: 2, name: 'Blood Mage' },
    { id: 3, name: 'Lich' },
  ],
  3: [
    { id: 0, name: 'None' },
    { id: 1, name: 'Invoker' },
    { id: 2, name: 'Acolyte of Chayula' },
  ],
  4: [
    { id: 0, name: 'None' },
    { id: 1, name: 'Witchhunter' },
    { id: 2, name: 'Gemling Legionnaire' },
    { id: 3, name: 'Tactician' },
  ],
  5: [
    { id: 0, name: 'None' },
    { id: 1, name: 'Stormweaver' },
    { id: 2, name: 'Chronomancer' },
  ],
};

const CLASSES: NamedOption[] = [
  { id: 0, name: 'Warrior' },
  { id: 1, name: 'Ranger' },
  { id: 2, name: 'Witch' },
  { id: 3, name: 'Monk' },
  { id: 4, name: 'Mercenary' },
  { id: 5, name: 'Sorceress' },
];

/** Quest-granted passives, flat in this mock. */
const QUEST_POINTS = 24;

const clampLevel = (n: number) =>
  Math.max(LEVEL_MIN, Math.min(LEVEL_MAX, Math.floor(n) || LEVEL_MIN));

interface MockStore extends HeaderState, HeaderActions {
  /** Set by save(); lets the prototype show the unsaved dot appearing and clearing. */
  lastAction: string | null;
}

const pointsForLevel = (level: number, ascendClassId: number) => ({
  passives: { used: 0, max: level - 1 + QUEST_POINTS },
  weaponSet1: { used: 0, max: 24 },
  weaponSet2: { used: 0, max: 24 },
  ascendancy: { used: 0, max: ascendClassId === 0 ? 0 : 8 },
});

export const useMockStore = create<MockStore>((set, get) => ({
  buildName: 'Unnamed build',
  unsaved: false,
  dbFileName: null,

  characterLevel: 1,
  levelAutoMode: false,

  classId: 1,
  classes: CLASSES,
  ascendClassId: 0,
  ascendancies: ASCENDANCIES[1],

  loadoutId: 0,
  loadouts: [{ id: 0, name: 'Default' }],

  points: pointsForLevel(1, 0),

  lastAction: null,

  save: () =>
    set((s) => ({
      unsaved: false,
      dbFileName: s.dbFileName ?? `${s.buildName}.xml`,
      lastAction: 'save',
    })),

  saveAs: () => set({ lastAction: 'saveAs' }),
  back: () => set({ lastAction: 'back' }),

  setCharacterLevel: (level) => {
    const next = clampLevel(level);
    set({
      characterLevel: next,
      unsaved: true,
      points: pointsForLevel(next, get().ascendClassId),
    });
  },

  setLevelAutoMode: (auto) => set({ levelAutoMode: auto, unsaved: true }),

  setClass: (classId) =>
    set((s) => ({
      classId,
      // Changing class invalidates the ascendancy, exactly as the engine does.
      ascendClassId: 0,
      ascendancies: ASCENDANCIES[classId] ?? [{ id: 0, name: 'None' }],
      unsaved: true,
      points: pointsForLevel(s.characterLevel, 0),
    })),

  setAscendancy: (ascendClassId) =>
    set((s) => ({
      ascendClassId,
      unsaved: true,
      points: pointsForLevel(s.characterLevel, ascendClassId),
    })),

  setLoadout: (loadoutId) => set({ loadoutId, unsaved: true }),
  setBuildName: (buildName) => set({ buildName, unsaved: true }),
}));
