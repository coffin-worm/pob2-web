/**
 * Turning the engine's answers into something worth a model's context.
 *
 * The engine answers a UI. Its stat sheet carries a colour classification
 * and a row height per line, its tooltips carry centring and separator
 * flags, and its passive tree carries 4,500 nodes with pixel coordinates.
 * None of that means anything to a reader, and all of it costs tokens, so
 * everything here is the same information with the drawing taken out.
 *
 * The rule throughout: drop what only a renderer wanted, keep every number
 * and every word the engine computed, and never recompute anything.
 */

import type {
  BridgeSnapshot,
  CalcBreakdown,
  CalcSection,
  ConfigOption,
  GemInstance,
  ItemLine,
  ItemSlot,
  ItemSummary,
  SocketGroup,
  StatLine,
  TreeNode,
  WhatIf,
} from './bridge-types.js';

/**
 * PoB's inline colour codes.
 *
 * The bridge strips these from most places, but not from everywhere: text
 * that is passed through from PoB's own data files can still carry one, and
 * a stray `^7` in the middle of a sentence is noise either way.
 */
export function strip(text: string): string {
  return text.replace(/\^(?:[xX][0-9a-fA-F]{6}|[0-9])/g, '');
}

/** Blank lines collapsed, so a dropped section does not leave a hole. */
function tidy(lines: string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    const text = line.trimEnd();
    if (text === '' && (out.length === 0 || out.at(-1) === '')) continue;
    out.push(text);
  }
  while (out.at(-1) === '') out.pop();
  return out.join('\n');
}

/* ------------------------------------------------------------- the header */

export function header(state: BridgeSnapshot): string {
  if (!state.ready) {
    return state.engineError
      ? `No build is open. The engine reported: ${strip(state.engineError)}`
      : 'No build is open.';
  }

  const className = state.classes.find((entry) => entry.id === state.classId)?.name;
  const ascendancy = state.ascendancies.find(
    (entry) => entry.id === state.ascendClassId,
  )?.name;

  const budget = (label: string, used: number, max: number, over?: boolean) =>
    `${label}: ${used}/${max}${over ? ' (over budget)' : ''}`;

  return tidy([
    `Build: ${state.buildName}${state.unsaved ? ' (unsaved changes)' : ''}`,
    // PoB spells "no ascendancy chosen" as an ascendancy called None.
    `Level ${state.characterLevel} ${className ?? 'unknown class'}` +
      (ascendancy && ascendancy !== className && ascendancy !== 'None'
        ? ` / ${ascendancy}`
        : ''),
    state.dbFileName ? `File: ${state.dbFileName}` : 'Never saved.',
    '',
    budget(
      'Passive points',
      state.points.passives.used,
      state.points.passives.max,
      state.points.passives.over,
    ),
    budget(
      'Ascendancy points',
      state.points.ascendancy.used,
      state.points.ascendancy.max,
      state.points.ascendancy.over,
    ),
    budget(
      'Weapon set I points',
      state.points.weaponSet1.used,
      state.points.weaponSet1.max,
      state.points.weaponSet1.over,
    ),
    budget(
      'Weapon set II points',
      state.points.weaponSet2.used,
      state.points.weaponSet2.max,
      state.points.weaponSet2.over,
    ),
  ]);
}

/* ----------------------------------------------------------- the stat sheet */

/**
 * The sidebar, as text.
 *
 * `size: 'header'` is a section title and carries no value; `note` lines
 * elaborate on the line above them, so they are indented under it rather
 * than read as stats of their own.
 */
export function stats(lines: StatLine[], filter?: string): string {
  const wanted = filter?.trim().toLowerCase();
  const out: string[] = [];

  for (const line of lines) {
    const label = strip(line.label).trim();
    const value = line.value === undefined ? undefined : strip(line.value).trim();

    if (line.size === 'header') {
      if (!wanted) {
        out.push('', `### ${label}`);
      }
      continue;
    }
    if (wanted && !`${label} ${value ?? ''}`.toLowerCase().includes(wanted)) continue;
    if (line.note) {
      out.push(`    ${label}${value ? `: ${value}` : ''}`);
      continue;
    }
    out.push(value === undefined ? label : `${label}: ${value}`);
  }

  const text = tidy(out);
  if (text === '') {
    return wanted ? `No stat mentions "${filter}".` : 'The engine reported no stats.';
  }
  return text;
}

/* -------------------------------------------------------------- the tooltips */

/**
 * One of PoB's tooltips.
 *
 * `block` 1 is the subject itself and anything above that is a comparison
 * the engine appended, which is a different question and gets rendered
 * separately. Separators become blank lines; centring is dropped.
 */
export function tooltip(lines: ItemLine[], block = 1): string {
  return tidy(
    lines
      .filter((line) => line.block === block)
      .map((line) => {
        if (line.separator) return '';
        return line.text === undefined ? '' : strip(line.text);
      }),
  );
}

/**
 * What a change would do, as the engine put it.
 *
 * The whole answer is the comparison here, so every block is rendered. The
 * blocks that matter on an item tooltip, where block 1 is the item and 2 is
 * what equipping it would do, do not apply: these routes have no subject to
 * describe, only a difference, and they put it in block 1.
 *
 * `unchanged` is the engine's own verdict and is worth saying plainly,
 * because an empty comparison and a comparison that moves nothing look
 * identical otherwise.
 */
export function comparison(answer: WhatIf, subject?: string): string {
  if (!answer.ready) {
    return `The engine could not price that: ${strip(answer.error ?? 'no reason given')}`;
  }
  const head = subject ? `${subject}` : '';
  if (answer.unchanged) {
    return head === '' ? 'Nothing changes.' : `${head}: nothing changes.`;
  }

  const blocks = [...new Set(answer.lines.map((line) => line.block))].sort((a, b) => a - b);
  const parts = blocks.map((block) => tooltip(answer.lines, block)).filter((text) => text !== '');

  if (parts.length === 0) {
    return head === ''
      ? 'The engine said nothing about that change.'
      : `${head}: the engine said nothing about that change.`;
  }
  return (head === '' ? '' : `${head}\n\n`) + parts.join('\n\n');
}

/* ------------------------------------------------------------ the passives */

export interface TreeSummary {
  allocated: number[];
  nodes: Map<number, TreeNode>;
}

/**
 * The allocated tree, by what is worth reading.
 *
 * A hundred allocated nodes are mostly small attribute passives, and
 * listing them individually would bury the four that decide how the build
 * works. Keystones and notables are named; the rest are counted.
 */
export function tree({ allocated, nodes }: TreeSummary): string {
  const byType = new Map<string, TreeNode[]>();
  let unknown = 0;

  for (const id of allocated) {
    const node = nodes.get(id);
    if (!node) {
      unknown += 1;
      continue;
    }
    const list = byType.get(node.type);
    if (list) list.push(node);
    else byType.set(node.type, [node]);
  }

  const named = (type: string) =>
    (byType.get(type) ?? [])
      .map((node) => {
        const where = node.ascendancy ? ` [${node.ascendancy}]` : '';
        return `- ${node.name}${where} (id ${node.id})`;
      })
      .sort();

  const out: string[] = [`${allocated.length} nodes allocated.`, ''];

  const keystones = named('Keystone');
  if (keystones.length > 0) out.push(`### Keystones (${keystones.length})`, ...keystones, '');

  const notables = named('Notable');
  if (notables.length > 0) out.push(`### Notables (${notables.length})`, ...notables, '');

  const counts: string[] = [];
  for (const [type, list] of [...byType].sort()) {
    if (type === 'Keystone' || type === 'Notable') continue;
    counts.push(`${type}: ${list.length}`);
  }
  if (unknown > 0) counts.push(`not in the tree data: ${unknown}`);
  if (counts.length > 0) out.push(`### The rest`, counts.join(', '));

  return tidy(out);
}

/** One node, with the stats the engine parsed off it. */
export function node(entry: TreeNode): string {
  return tidy([
    `${entry.name} (${entry.type}, id ${entry.id})`,
    entry.ascendancy ? `Ascendancy: ${entry.ascendancy}` : '',
    '',
    ...entry.stats.map((stat) => strip(stat)),
    entry.flavour ? `\n"${strip(entry.flavour)}"` : '',
  ]);
}

/* ------------------------------------------------------------ the equipment */

/**
 * What is worn, slot by slot.
 *
 * The engine sends slots and items as two lists joined on an id, and it
 * also sends every item PoB considers valid for each slot, which for a
 * build with a large item list is several hundred entries of nothing much.
 * Only what is actually equipped is named here; the rest is on request.
 */
export function equipment(
  snapshot: {
    slots: ItemSlot[];
    items: ItemSummary[];
    sets: { id: number; name: string }[];
    setId: number;
    weaponSet: number;
  },
  options: { unequipped?: boolean | undefined } = {},
): string {
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  const out: string[] = [];

  const set = snapshot.sets.find((entry) => entry.id === snapshot.setId);
  if (snapshot.sets.length > 1 && set) {
    out.push(`Item set: ${strip(set.name)} (of ${snapshot.sets.length}).`);
  }
  out.push(`Weapon set ${snapshot.weaponSet === 2 ? 'II' : 'I'} is active.`, '');

  out.push('### Equipped');
  for (const slot of snapshot.slots) {
    const item = slot.itemId === 0 ? undefined : byId.get(slot.itemId);
    if (!item) {
      out.push(`- ${strip(slot.label)}: empty`);
      continue;
    }
    const marks = [
      item.rarity.toLowerCase(),
      slot.flask && slot.active === false ? 'switched off' : '',
    ].filter(Boolean);
    // PoB spells a rare's name as "Name, Base", so repeating the base
    // would read as "Pain Grasp, Lazuli Ring (rare, Lazuli Ring)".
    const base =
      item.base && !item.name.includes(item.base) ? `, ${strip(item.base)}` : '';
    out.push(
      `- ${strip(slot.label)}: ${strip(item.name)} (${marks.join(', ')}${base})` +
        ` [id ${item.id}]`,
    );
  }

  if (options.unequipped) {
    const spare = snapshot.items.filter((item) => item.equipped === undefined);
    out.push('', `### Not equipped (${spare.length})`);
    for (const item of spare) {
      out.push(
        `- ${strip(item.name)} (${item.rarity.toLowerCase()}, ${strip(item.base)})` +
          ` [id ${item.id}]`,
      );
    }
  }

  return tidy(out);
}

/* --------------------------------------------------------------- the skills */

export function groups(list: SocketGroup[], mainGroup: number): string {
  if (list.length === 0) return 'This build has no socket groups.';
  return tidy(
    list.map((group) => {
      const marks = [
        group.index === mainGroup ? 'main' : '',
        group.enabled ? '' : 'disabled',
        group.fullDPS ? 'in full DPS' : '',
        group.source ? `granted by ${strip(group.source)}` : '',
      ].filter(Boolean);
      const where = group.slot ? ` in ${group.slot}` : '';
      const skills = group.skills.length > 0 ? ` grants ${group.skills.join(', ')}` : '';
      const count = `${group.gemCount} gem${group.gemCount === 1 ? '' : 's'}`;
      return (
        `${group.index}. ${strip(group.label)}${where}` +
        ` (${count}${marks.length > 0 ? `, ${marks.join(', ')}` : ''})` +
        skills
      );
    }),
  );
}

export function gems(list: GemInstance[]): string {
  if (list.length === 0) return 'That group has no gems in it.';
  return tidy(
    list.map((gem) => {
      const marks = [
        gem.support ? 'support' : '',
        gem.enabled ? '' : 'disabled',
        gem.count > 1 ? `x${gem.count}` : '',
        gem.error ? `cannot be used: ${strip(gem.error)}` : '',
      ].filter(Boolean);
      return (
        `${gem.index}. ${gem.name} level ${gem.level}, quality ${gem.quality}%` +
        (marks.length > 0 ? ` (${marks.join(', ')})` : '')
      );
    }),
  );
}

/* --------------------------------------------------------------- the config */

/**
 * Configuration, by what somebody chose.
 *
 * PoB offers hundreds of these and this build uses a few dozen of them, so
 * the default is the ones whose value differs from the default. That is
 * also the honest answer to "how is this build configured": the rest is the
 * engine's own assumptions, which are the same for everyone.
 */
export function config(
  sections: { name: string; options: ConfigOption[] }[],
  options: { all?: boolean | undefined; filter?: string | undefined } = {},
): string {
  const wanted = options.filter?.trim().toLowerCase();
  const out: string[] = [];

  for (const section of sections) {
    const rows: string[] = [];
    for (const option of section.options) {
      const set = option.changed === true || option.value !== undefined;
      if (!options.all && !set) continue;
      const label = strip(option.label).trim().replace(/:$/, '');
      if (wanted && !`${label} ${option.var}`.toLowerCase().includes(wanted)) continue;

      const shown =
        option.value === undefined
          ? option.placeholder === undefined
            ? '(not set)'
            : `(not set, the engine assumes ${String(option.placeholder)})`
          : String(option.value);
      rows.push(`- ${label} [${option.var}]: ${shown}`);
    }
    if (rows.length > 0) out.push(`### ${strip(section.name)}`, ...rows, '');
  }

  const text = tidy(out);
  if (text !== '') return text;
  if (wanted) return `No configuration option mentions "${options.filter}".`;
  return options.all
    ? 'The engine offers no configuration for this build.'
    : 'Nothing is configured: every option is at its default.';
}

/* ----------------------------------------------------------- the calcs tab */

/**
 * The Calcs tab, which is a few hundred rows.
 *
 * Handed over whole it would be most of a context window, so with nothing
 * to narrow it this gives the sections and the headline figure PoB puts
 * beside each one. A filter then matches row labels and brings back the
 * rows themselves, with the cell references that make them explainable:
 * `pob_breakdown` turns one of those into the engine's own working.
 */
export function calcs(
  sections: CalcSection[],
  options: { filter?: string | undefined; section?: string | undefined } = {},
): string {
  const wanted = options.filter?.trim().toLowerCase();
  const only = options.section?.trim().toLowerCase();
  const out: string[] = [];
  let matched = 0;

  for (const section of sections) {
    if (only && section.id.toLowerCase() !== only) continue;
    const body: string[] = [];

    for (const sub of section.subSections) {
      if (!wanted && !only) {
        const extra = sub.extra ? ` ${strip(sub.extra)}` : '';
        body.push(`- ${strip(sub.label)}${extra} (${sub.rows.length} row${sub.rows.length === 1 ? '' : 's'})`);
        continue;
      }

      // A filter naming a section or a sub-section takes the whole of it.
      // "life" is the Life section, whose own rows are called things like
      // "Total Base" and would otherwise match nothing at all.
      const whole =
        wanted !== undefined &&
        (section.id.toLowerCase().includes(wanted) ||
          strip(sub.label).toLowerCase().includes(wanted));

      const rows: string[] = [];
      for (const row of sub.rows) {
        const label = strip(row.label).trim();
        if (wanted && !whole && !label.toLowerCase().includes(wanted)) continue;
        const cells = row.values
          .map((value, index) => {
            const text = strip(value).trim();
            if (text === '') return '';
            const ref = row.refs?.[index];
            return ref ? `${text} [ref ${ref}]` : text;
          })
          .filter((cell) => cell !== '');
        if (label === '' && cells.length === 0) continue;
        matched += 1;
        rows.push(`- ${label || '(column header)'}: ${cells.join(' | ') || '(empty)'}`);
      }
      if (rows.length > 0) {
        const extra = sub.extra ? ` ${strip(sub.extra)}` : '';
        body.push(`${strip(sub.label)}${extra}`, ...rows, '');
      }
    }

    if (body.length > 0) out.push(`### ${section.id}`, ...body, '');
  }

  const text = tidy(out);
  if (text === '') {
    return wanted
      ? `No row on the Calcs tab mentions "${options.filter}".`
      : 'The engine reported no calculations.';
  }
  if (wanted) {
    return `${matched} rows mention "${options.filter}".\n\n${text}`;
  }
  return text;
}

/* ------------------------------------------------------------ the breakdown */

/** Where one number came from, as the Calcs tab would show it. */
export function breakdown(answer: CalcBreakdown): string {
  if (!answer.ready) {
    return `No breakdown: ${strip(answer.error ?? 'the engine gave no reason')}`;
  }
  if (answer.empty) {
    return `${answer.label ?? answer.ref} has no breakdown for the active skill.`;
  }

  const out: string[] = [`### ${strip(answer.label ?? answer.ref)}`, ''];
  for (const section of answer.sections) {
    if (section.type === 'text') {
      out.push(...section.lines.map((line) => strip(line.text)));
      out.push('');
      continue;
    }
    if (section.type === 'radius') {
      out.push(`Radius: ${section.radius}`, '');
      continue;
    }
    if (section.label) out.push(strip(section.label));
    out.push(section.cols.map((col) => strip(col.label)).join(' | '));
    out.push(section.cols.map(() => '---').join(' | '));
    for (const row of section.rows) {
      out.push(row.map((cell) => strip(cell.text)).join(' | '));
    }
    if (section.footer) out.push(strip(section.footer));
    out.push('');
  }

  if (answer.partial) {
    out.push(
      '(The engine could not size this for drawing. The content is whole; ' +
        'only its layout was lost.)',
    );
  }
  return tidy(out);
}
