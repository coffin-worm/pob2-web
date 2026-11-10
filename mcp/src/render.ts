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
  CorruptPreview,
  CraftAffixes,
  CraftAffixRow,
  CraftAnoints,
  CraftBases,
  CraftCatalysts,
  CraftCompare,
  CraftCorruptions,
  CraftRunes,
  CraftState,
  GemInstance,
  ItemLine,
  ItemSlot,
  ItemSummary,
  SocketGroup,
  StagedItem,
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

/* --------------------------------------------------------------- the bench */

/**
 * A comparison that sits inside a larger answer, as the shape above wants.
 *
 * The engine spells a nested comparison with a plain boolean `ready` rather
 * than as a discriminated union, because it sits beside the thing it
 * describes instead of standing in for the whole answer. Same information,
 * so it is converted here rather than handled twice everywhere below.
 */
function nested(compare: CraftCompare | undefined): WhatIf {
  if (!compare) return { ready: false, error: 'the engine priced nothing' };
  if (!compare.ready) {
    return compare.error === undefined ? { ready: false } : { ready: false, error: compare.error };
  }
  return { ready: true, lines: compare.lines ?? [], unchanged: compare.unchanged ?? false };
}

/**
 * What a rune grants, minus the line its own name already is.
 *
 * A rune is named after what it does, so printing the name and then the
 * lines reads as the engine saying the same thing twice.
 */
function rest(lines: string[] | undefined, label: string): string {
  return (lines ?? [])
    .map((line) => strip(line))
    .filter((line) => line !== label)
    .join('; ');
}

/** One prefix or suffix slot, as what is in it. */
function affixRow(row: CraftAffixRow): string {
  if (row.modId === undefined) return `${row.index}. empty`;
  const marks = [
    row.affix ? `"${strip(row.affix)}"` : '',
    row.tier !== undefined && row.tierCount !== undefined
      ? `tier ${row.tier} of ${row.tierCount}`
      : '',
    row.level === undefined ? '' : `item level ${row.level}`,
    // Where in the tier's own range it landed, which is the difference
    // between a tier worth keeping and the same tier wasted.
    row.roll === undefined ? '' : `roll ${row.roll.toFixed(2)}`,
    row.unknown ? 'the item can no longer roll this' : '',
  ].filter(Boolean);
  const text = (row.lines ?? []).map((line) => strip(line)).join('; ');
  return (
    `${row.index}. ${text || strip(row.label ?? row.modId)}` +
    (marks.length > 0 ? ` (${marks.join(', ')})` : '')
  );
}

/**
 * The bench item, as something being crafted.
 *
 * `crafted` is the dividing line and is worth saying out loud: only a magic
 * or rare built in PoB's own craft dialog has affix rows. Anything copied
 * out of the game carries its modifiers as text, and the whole affix half
 * of this answer is empty for it.
 */
export function bench(state: CraftState): string {
  if (!state.ready) return 'Nothing is on the bench.';

  const name = strip(state.name ?? 'unnamed');
  const what = [
    state.rarity ? state.rarity.toLowerCase() : '',
    // PoB spells a rare's name as "Name, Base", so the base is usually in it.
    state.baseName && !name.includes(strip(state.baseName)) ? strip(state.baseName) : '',
    // And the type is "Ring" for something already called a Lazuli Ring.
    state.itemType && !`${name} ${state.baseName ?? ''}`.includes(strip(state.itemType))
      ? strip(state.itemType)
      : '',
  ].filter(Boolean);

  const out: string[] = [
    `On the bench: ${name}${what.length > 0 ? ` (${what.join(', ')})` : ''}`,
    [
      // Quality 0 is the absence of quality, and saying so is noise.
      state.quality === undefined || state.quality === 0 ? '' : `Quality ${state.quality}.`,
      state.corrupted ? 'Corrupted.' : '',
    ]
      .filter(Boolean)
      .join(' '),
  ];

  if (state.crafted) {
    // affixLimit is the item's whole budget, prefixes and suffixes
    // together, so each half counts its own rows instead.
    const rows = (kind: string, list: CraftAffixRow[] | undefined) => {
      if (!list || list.length === 0) return;
      const filled = list.filter((row) => row.modId !== undefined).length;
      out.push('', `### ${kind} (${filled} of ${list.length})`, ...list.map(affixRow));
    };
    rows('Prefixes', state.prefixes);
    rows('Suffixes', state.suffixes);
    if (state.affixLimit !== undefined) {
      out.push('', `It can carry ${state.affixLimit} affixes in all.`);
    }
  } else {
    out.push(
      '',
      'It has no affix rows: only a magic or rare built in the craft dialog ' +
        'does. Its modifiers are text, which pob_items shows in full.',
    );
  }

  if (state.sockets) {
    const { rune, jewel, max, natural } = state.sockets;
    out.push(
      '',
      '### Rune sockets',
      `${rune} rune and ${jewel} jewel, of at most ${max}` +
        (natural === undefined ? '' : `, ${natural} of them on the base itself`),
      ...(state.runes ?? []).map((row) => {
        if (row.name === undefined) return `${row.index}. empty`;
        const label = strip(row.label ?? row.name);
        const lines = rest(row.lines, label);
        return `${row.index}. ${label}${lines ? `: ${lines}` : ''}`;
      }),
    );
  }

  if (state.anoint) {
    out.push(
      '',
      '### Anoint',
      ...state.anoint.slots.map((slot) => {
        if (slot.node) return `Line ${slot.index}: ${strip(slot.node)}`;
        if (slot.other) {
          return (
            `Line ${slot.index}: ${strip(slot.other)} ` +
            '(not an anoint, and anointing would replace it)'
          );
        }
        return `Line ${slot.index}: empty`;
      }),
    );
  }

  if (state.corrupt) {
    out.push(
      '',
      '### Corruption',
      state.corrupt.corrupted
        ? 'Already corrupted, so nothing more can be.'
        : state.corrupt.corruptible
          ? 'Can be corrupted.'
          : 'This base cannot be corrupted.',
    );
  }

  if (state.catalyst) {
    const on = state.catalyst.options.find((entry) => entry.id === state.catalyst?.catalyst);
    out.push(
      '',
      '### Catalysts',
      state.catalyst.catalyst === 0 || !on
        ? 'None on it.'
        : strip(on.name) +
          (state.catalyst.quality === undefined ? '' : ` at ${state.catalyst.quality} quality`) +
          '.',
    );
  }

  return tidy(out);
}

/**
 * The bench item against every slot it fits.
 *
 * The whole point of staging rather than equipping: one answer that prices
 * the same item in each slot that will take it, so a ring does not have to
 * be tried in one hand and then in the other.
 */
export function staged(answer: StagedItem): string {
  if (!answer.ready) {
    return answer.error === undefined
      ? 'Nothing is on the bench.'
      : `The engine could not price the bench item: ${strip(answer.error)}`;
  }

  const base =
    answer.base && !answer.name.includes(answer.base) ? `, ${strip(answer.base)}` : '';
  const out: string[] = [
    `On the bench: ${strip(answer.name)} (${answer.rarity.toLowerCase()}${base})`,
    '',
    tooltip(answer.lines, 1),
  ];

  if (answer.fitsNothing) {
    out.push('', 'No slot on this character will take it.');
    return tidy(out);
  }
  if (answer.limited && answer.limit !== undefined) {
    out.push(
      '',
      `This unique is limited to ${answer.limit}, and that many are already worn, ` +
        'so only the slots holding one are offered.',
    );
  }

  for (const slot of answer.slots) {
    const marks = [
      slot.primary ? 'where PoB would put it' : '',
      slot.empty ? 'empty now' : '',
      slot.similar ? 'holds something similar' : '',
      slot.removing ? 'it is already here, so this is what removing it does' : '',
      slot.weaponSet === 2 ? 'weapon set II' : '',
    ].filter(Boolean);
    out.push(
      '',
      `## ${strip(slot.label)}${marks.length > 0 ? ` (${marks.join(', ')})` : ''}`,
      comparison(nested(slot.compare)),
    );
  }

  return tidy(out);
}

/* -------------------------------------------------------- the option lists */

/**
 * What one affix row could hold.
 *
 * The tier ids are deliberately not printed. They are what PoB's own
 * dropdown is keyed by, and nothing this server exposes can put one in a
 * slot, so eight of them per modifier would cost a reader context and buy
 * nothing. What is worth reading is the series, how many tiers it has, the
 * levels they start at, and what the top one rolls.
 */
export function affixOptions(answer: CraftAffixes): string {
  if (!answer.ready) {
    return answer.error === undefined
      ? 'Nothing is on the bench, or it has no affix rows.'
      : `The engine would not list that row: ${strip(answer.error)}`;
  }
  const options = answer.options ?? [];
  const where = `${answer.kind ?? 'that'} slot ${answer.index ?? '?'}`;
  if (options.length === 0) return `Nothing can go in ${where}.`;

  const total = answer.total ?? options.length;
  const head =
    `${total} modifiers could go in ${where}` +
    (total > options.length ? `, of which ${options.length} are here` : '') +
    '.' +
    // PoB spells an empty slot as a modifier called None.
    (answer.selected === undefined || answer.selected === 'None'
      ? ''
      : ` In it now: ${strip(answer.selected)}.`);

  const lines = options.map((option) => {
    const levels = option.levels.filter((level) => level > 0);
    const span =
      levels.length === 0
        ? ''
        : `, item level ${Math.min(...levels)} to ${Math.max(...levels)}`;
    const top = option.preview.map((line) => strip(line)).join('; ');
    return (
      `- ${strip(option.label)}` +
      (option.affix ? ` (${strip(option.affix)})` : '') +
      `: ${option.tierCount} tier${option.tierCount === 1 ? '' : 's'}${span}` +
      (top ? `\n    top tier: ${top}` : '')
    );
  });

  return `${head}\n\n${lines.join('\n')}`;
}

/** The item types, or the bases under one of them. */
export function bases(answer: CraftBases): string {
  if (!answer.ready) return 'The engine has no base list.';
  const list = answer.bases ?? [];
  if (answer.type === undefined || list.length === 0) {
    const types = answer.types ?? [];
    if (types.length === 0) return 'The engine has no item types.';
    const lines = types.map((type) => `- ${type}`).join('\n');
    return `${types.length} item types. Pass one as "type" for its bases.\n\n${lines}`;
  }
  const lines = list
    .map((entry) => {
      const label = strip(entry.label || entry.name);
      const marks = [
        // The engine keys a base by its name, and a label that reads
        // differently would be a name pob_stage_item refuses.
        label === entry.name ? '' : `named ${entry.name}`,
        entry.level === undefined || entry.level === 0 ? '' : `level ${entry.level}`,
      ].filter(Boolean);
      return `- ${label}${marks.length > 0 ? ` (${marks.join(', ')})` : ''}`;
    })
    .join('\n');
  return (
    `${list.length} ${answer.type} bases` +
    (answer.rarities === undefined ? '' : `, craftable as ${answer.rarities.join(', ')}`) +
    `.\n\n${lines}`
  );
}

export function runes(answer: CraftRunes): string {
  if (!answer.ready) {
    return answer.error === undefined
      ? 'Nothing is on the bench, or it has no sockets.'
      : `The engine would not list the runes: ${strip(answer.error)}`;
  }
  const options = answer.options ?? [];
  if (options.length === 0) return 'No rune or soul core fits this item.';
  const lines = options.map((rune) => {
    const marks = [
      rune.type ? rune.type.toLowerCase() : '',
      rune.req === undefined ? '' : `needs level ${rune.req}`,
      rune.limit === undefined ? '' : `at most ${rune.limit} per item`,
      rune.socketBound ? 'cannot be taken out again' : '',
    ].filter(Boolean);
    const label = strip(rune.label || rune.name);
    const lines = rest(rune.lines, label);
    return (
      `- ${label}` +
      (marks.length > 0 ? ` (${marks.join(', ')})` : '') +
      (lines ? `: ${lines}` : '')
    );
  });
  return `${answer.total ?? options.length} fit these sockets.\n\n${lines.join('\n')}`;
}

/**
 * The notables the bench item could be anointed with.
 *
 * A search and not a list: there are 875 of them on the tree. Each carries
 * its node id, because that is what prices it.
 */
export function anoints(answer: CraftAnoints): string {
  if (!answer.ready) {
    return answer.error === undefined
      ? 'Nothing is on the bench, or it cannot be anointed.'
      : `The engine would not list the anoints: ${strip(answer.error)}`;
  }
  const options = answer.options ?? [];
  if (options.length === 0) return 'No notable matches.';

  const lines = options.map((option) => {
    const recipe = option.recipe.length > 0 ? ` [${option.recipe.join(', ')}]` : '';
    const already = option.allocated ? ' (already on the tree, so it would add nothing)' : '';
    const grants = option.lines.map((line) => strip(line)).join('; ');
    return `- ${strip(option.name)} (id ${option.id})${already}: ${grants}${recipe}`;
  });

  const total = answer.total ?? options.length;
  const more = total > options.length ? ` Showing ${options.length}.` : '';
  return `${total} notables match.${more}\n\n${lines.join('\n')}`;
}

/**
 * What the bench item could be corrupted with.
 *
 * The modifier ids are printed here, unlike the affix list: a corruption
 * draft is priced by id, so these are the one set of ids a reader can
 * actually use.
 */
export function corruptions(answer: CraftCorruptions): string {
  if (!answer.ready) {
    return answer.error === undefined
      ? 'Nothing is on the bench.'
      : `The engine would not open the corruption list: ${strip(answer.error)}`;
  }

  const sources = answer.sources ?? [];
  const out: string[] = [
    [
      answer.corrupted ? 'This item is already corrupted.' : '',
      answer.slots === undefined ? '' : `${answer.slots} implicit slots.`,
      sources.length > 1
        ? `Sources: ${sources.map((source) => `${source.name} (${source.id})`).join(', ')}.`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
  ];

  const current = answer.current ?? [];
  if (current.length > 0) {
    out.push(
      '',
      '### Implicits it already carries',
      ...current.map(
        (entry) =>
          `- ${strip(entry.line)}` +
          (entry.modId === undefined ? '' : ` (${entry.modId})`) +
          (entry.group === undefined ? '' : ` [group ${entry.group}]`),
      ),
    );
  }

  const ranges = answer.ranges ?? [];
  if (ranges.length > 0) {
    out.push(
      '',
      '### Rolls a corruption would scale',
      'Between 0.78 and 1.22, and priced as ranges rather than as implicits.',
      ...ranges.map(
        (range) => `- ${range.index}: ${strip(range.scaled)} (at ${range.value.toFixed(2)})`,
      ),
    );
  }

  const options = answer.options ?? [];
  if (options.length > 0) {
    const total = answer.total ?? options.length;
    const shown = total > options.length ? `, showing ${options.length}` : '';
    out.push(
      '',
      `### Implicits it could take (${total}${shown})`,
      ...options.map(
        (option) =>
          `- ${option.modId}: ${option.lines.map((line) => strip(line)).join('; ')}` +
          (option.group === undefined ? '' : ` [group ${option.group}]`),
      ),
    );
  }

  return tidy(out);
}

/**
 * All thirteen catalysts, priced together.
 *
 * The useful part is how few of them do anything: a catalyst only scales
 * the modifiers carrying its own tag, and most items carry two or three
 * tags. So the ones that move nothing are named in a single line rather
 * than given a comparison each, and what is left is the real choice.
 */
export function catalysts(answer: CraftCatalysts): string {
  if (!answer.ready) {
    return answer.error === undefined
      ? 'Nothing is on the bench.'
      : `The engine would not price the catalysts: ${strip(answer.error)}`;
  }
  const options = answer.options ?? [];
  if (options.length === 0) return 'No catalyst applies to this item.';

  const out: string[] = [
    `Priced at ${answer.quality ?? '?'} quality` +
      (answer.slot === undefined ? '' : `, compared in ${answer.slot}`) +
      '.',
  ];

  const idle: string[] = [];
  for (const row of options) {
    // Taking the catalyst off is offered as one of the thirteen, and on an
    // item that has none it is a choice that cannot be made.
    if (row.id === 0 && (answer.catalyst ?? 0) === 0) continue;

    const compare = nested(row.compare);
    const scales = (row.scales ?? []).map((line) => strip(line));
    if (row.error === undefined && scales.length === 0 && compare.ready && compare.unchanged) {
      idle.push(strip(row.name));
      continue;
    }

    out.push('', `### ${strip(row.name)}${row.current ? ' (on it now)' : ''}`);
    if (row.error !== undefined) {
      out.push(`The engine could not price it: ${strip(row.error)}`);
      continue;
    }
    if (scales.length > 0) out.push(`Scales: ${scales.join('; ')}`);
    out.push(comparison(compare));
  }

  if (idle.length > 0) {
    out.push(
      '',
      `### Nothing to scale (${idle.length})`,
      `${idle.join(', ')}: this item carries no modifier they touch.`,
    );
  }

  return tidy(out);
}

/** What corrupting would do: the item it would become, and the difference. */
export function corruptPreview(answer: CorruptPreview): string {
  if (!answer.ready) {
    return `The engine could not corrupt that: ${strip(answer.error ?? 'no reason given')}`;
  }
  return tidy([
    '## The item, corrupted',
    tooltip(answer.item, 1),
    '',
    `## What it would do${answer.slot === undefined ? '' : ` in ${answer.slot}`}`,
    comparison(nested(answer.compare)),
  ]);
}
