/**
 * Named bundles of configuration options.
 *
 * Path of Building has no notion of a preset. The Configuration tab is a
 * flat list of independent options, and "fighting a pinnacle boss" is a
 * thing somebody knows to express by setting one of them. So the names
 * here are ours, and the only honest way to write them is thinly: each one
 * names the options it sets and nothing else happens behind it.
 *
 * They are thin for a second reason, which is that PoB has already done
 * the bundling. `enemyIsBoss` is not a flag; it is a list option whose
 * apply function sets the enemy's resistances, the effect of curses and
 * exposure on it, its poise, its damage and its level placeholders, all
 * four ways (ConfigOptions.lua:1982). Writing out "the boss's resists and
 * curse effect" as separate entries here would be a worse copy of a table
 * the engine maintains against the game.
 *
 * This file is meant to grow. A preset is a name, a sentence, and a list
 * of option-value pairs using the variable names pob_config prints; adding
 * one is adding an entry.
 */

import type { ConfigOption } from './bridge-types.js';

export interface PresetOption {
  option: string;
  value: string | number | boolean;
}

export interface ConfigPreset {
  name: string;
  about: string;
  options: PresetOption[];
}

export const presets: ConfigPreset[] = [
  {
    name: 'mapping',
    about:
      'Clearing a map: an ordinary monster, with none of a boss\'s ' +
      'resistances, damage or resistance to curses and slows.',
    options: [{ option: 'enemyIsBoss', value: 'None' }],
  },
  {
    name: 'boss',
    about:
      'A standard map boss: unique, 30% elemental resistance, half effect ' +
      'from curses and exposure, and far harder to knock back or slow.',
    options: [{ option: 'enemyIsBoss', value: 'Boss' }],
  },
  {
    name: 'pinnacle',
    about:
      'A guardian or pinnacle boss, which is what the engine assumes when ' +
      'nobody has said otherwise.',
    options: [{ option: 'enemyIsBoss', value: 'Pinnacle' }],
  },
  {
    name: 'uber',
    about: 'An uber pinnacle boss, the hardest set of enemy assumptions PoB offers.',
    options: [{ option: 'enemyIsBoss', value: 'Uber' }],
  },
];

export const presetNames = presets.map((preset) => preset.name);

export const presetByName = (name: string): ConfigPreset | undefined =>
  presets.find((preset) => preset.name === name.trim().toLowerCase());

/**
 * Which presets the configuration currently matches.
 *
 * An option nobody has touched still has a value, which is the engine's
 * default, and `enemyIsBoss` defaults to the pinnacle boss. So a build
 * that has never had its configuration opened is on the `pinnacle` preset,
 * and saying so is more use than saying nothing is set.
 *
 * Several names can match at once, in principle, and all of them are
 * returned rather than the first: a preset that is a subset of another is
 * a thing this list is allowed to contain.
 */
export function matching(current: Map<string, ConfigOption>): string[] {
  return presets
    .filter((preset) =>
      preset.options.every((entry) => effective(current.get(entry.option)) === entry.value),
    )
    .map((preset) => preset.name);
}

/** What an option is worth now, which is the default when nobody set it. */
export function effective(
  option: ConfigOption | undefined,
): string | number | boolean | undefined {
  return option?.value ?? option?.default;
}
