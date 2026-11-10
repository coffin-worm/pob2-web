/**
 * What a client can ask.
 *
 * Nineteen tools over forty-odd routes, which is deliberate. The engine
 * answers a UI and exposes a route per control; a model handed forty tools
 * spends its context on the schema list and still picks the wrong one. So
 * these are grouped by the question somebody actually has, and the routes
 * that differ only in which control they drive are folded into one tool
 * with a discriminator.
 *
 * Everything answers in text. The engine's JSON is shaped for a renderer
 * and carries colours, row heights and pixel coordinates; see render.ts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Bridge } from './client.js';
import * as show from './render.js';
import type {
  AnointWhatIf,
  BridgeSnapshot,
  BuildsSnapshot,
  CalcBreakdown,
  CalcsSnapshot,
  CodeInspection,
  CompareSnapshot,
  ConfigSnapshot,
  CorruptPreview,
  CraftAffixes,
  CraftAnoints,
  CraftBases,
  CraftCatalysts,
  CraftCorruptions,
  CraftRunes,
  CraftState,
  GemSearchSnapshot,
  ItemDetail,
  ItemEdit,
  ItemSearchSnapshot,
  ItemsSnapshot,
  NotesSnapshot,
  SkillsSnapshot,
  StagedItem,
  StatsSnapshot,
  TreeAllocSnapshot,
  TreeWhatIf,
  WhatIf,
} from './bridge-types.js';

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (text: string): Result => ({ content: [{ type: 'text', text }] });
const no = (text: string): Result => ({ content: [{ type: 'text', text }], isError: true });

/** Read-only, and safe to call again with the same arguments. */
const reads = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

/** Changes something, though never anything on disk. */
const writes = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

/**
 * How long a stat-sorted item search may keep asking.
 *
 * The engine runs the calculator against every candidate in every slot it
 * fits and spreads that over as many requests as it takes, so one request
 * is a slice rather than an answer. Measured against the whole database on
 * a level 73 build: 551 candidates, eight requests, three seconds, and the
 * same for the cheapest stat and the most expensive one alike.
 *
 * So this is fifteen times what a full scan needed and still a fraction of
 * the request timeout in client.ts. It is a stop, not a plan: a database
 * that grows or a machine that is slower should still answer something
 * rather than hang.
 */
const SCAN_BUDGET_MS = 45_000;

/**
 * A corruption draft, flattened for a query string.
 *
 * "1:ModId,2:ModId": keyed rather than positional, because a draft with
 * only the second slot filled has to survive the trip.
 */
const keyed = (table: Record<string, string | number>) =>
  Object.entries(table)
    .map(([slot, value]) => `${slot}:${value}`)
    .join(',');

export function register(server: McpServer, bridge: Bridge) {
  /* ------------------------------------------------------------- the build */

  server.registerTool(
    'pob_build',
    {
      title: 'Read the open build',
      description:
        'The build Path of Building has open: its name, class, ascendancy, ' +
        'level, passive point budgets, and the whole stat sheet the app shows ' +
        'down its side (life, energy shield, resistances, DPS, and the rest). ' +
        'Start here. Pass `filter` to keep only the stats whose name or value ' +
        'mentions a word, which is the cheap way to ask about one number.',
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe('Keep only stats mentioning this, e.g. "resist" or "crit".'),
        stats: z
          .boolean()
          .optional()
          .describe('Include the stat sheet. Defaults to true.'),
      },
      annotations: reads,
    },
    async ({ filter, stats = true }) => {
      const state = await bridge.get<BridgeSnapshot>('/state');
      if (!state.ready) return ok(show.header(state));
      if (!stats) return ok(show.header(state));

      const sheet = await bridge.get<StatsSnapshot>('/stats');
      const parts = [show.header(state)];
      if (sheet.ready) {
        parts.push('', '## Stats', show.stats(sheet.lines, filter));
        if (sheet.warnings.length > 0) {
          parts.push(
            '',
            '## Warnings the engine raised',
            ...sheet.warnings.map((warning) => `- ${show.strip(warning)}`),
          );
        }
      } else {
        parts.push('', 'The engine has no stats for this build.');
      }
      return ok(parts.join('\n'));
    },
  );

  /* ---------------------------------------------------------- the passives */

  server.registerTool(
    'pob_tree',
    {
      title: 'Read the passive tree',
      description:
        'What the build has allocated on the passive tree. Keystones and ' +
        'notables are named with their node ids; the small attribute passives ' +
        'are counted rather than listed, because listing a hundred of them ' +
        'buries the four that decide how the build works. Pass `node` for one ' +
        "node's own stats. Use pob_search with what=\"passive\" to turn a name " +
        'into an id.',
      inputSchema: {
        node: z
          .number()
          .int()
          .optional()
          .describe('A node id, for that one node in full rather than the summary.'),
      },
      annotations: reads,
    },
    async ({ node }) => {
      const nodes = await bridge.treeNodes();
      if (node !== undefined) {
        const found = nodes.get(node);
        return found ? ok(show.node(found)) : no(`There is no node with id ${node}.`);
      }
      const alloc = await bridge.get<TreeAllocSnapshot>('/tree/alloc');
      if (!alloc.ready) return no('The engine has no tree allocated.');
      return ok(show.tree({ allocated: alloc.allocated, nodes }));
    },
  );

  /* ---------------------------------------------------------- the equipment */

  server.registerTool(
    'pob_items',
    {
      title: 'Read the equipment',
      description:
        'What the build is wearing, slot by slot, with each item id. Pass ' +
        "`item` with an id for that item's full modifier list exactly as the " +
        'app shows it. Pass `slot` alongside it to also get what equipping it ' +
        'there would do to the build.',
      inputSchema: {
        item: z.number().int().optional().describe('An item id, for its full text.'),
        slot: z
          .string()
          .optional()
          .describe(
            'An engine slot name to compare the item against, e.g. "Weapon 1" ' +
              'or "Body Armour". Only meaningful with `item`.',
          ),
        unequipped: z
          .boolean()
          .optional()
          .describe("Also list the items in the build's list that are not worn."),
      },
      annotations: reads,
    },
    async ({ item, slot, unequipped }) => {
      if (item !== undefined) {
        const detail = await bridge.get<ItemDetail>('/item', { id: item, slot });
        if (!detail.ready) {
          return no(detail.error ?? `The engine has no item with id ${item}.`);
        }
        const parts = [show.tooltip(detail.lines, 1)];
        const against = show.tooltip(detail.lines, 2);
        if (against !== '') {
          parts.push('', `## Equipping it in ${detail.slot ?? slot ?? 'that slot'}`, against);
        }
        return ok(parts.join('\n'));
      }

      const items = await bridge.get<ItemsSnapshot>('/items');
      if (!items.ready) return no('The engine has no items for this build.');
      return ok(show.equipment(items, { unequipped }));
    },
  );

  /* ------------------------------------------------------------- the skills */

  server.registerTool(
    'pob_skills',
    {
      title: 'Read the skills',
      description:
        'The socket groups: which skills the build uses, where they are ' +
        'socketed, which one is the main one, and which are disabled. Pass ' +
        '`group` with a group number for the gems in it at their levels and ' +
        'qualities.',
      inputSchema: {
        group: z.number().int().optional().describe('A socket group number, for its gems.'),
      },
      annotations: reads,
    },
    async ({ group }) => {
      const skills = await bridge.get<SkillsSnapshot>('/skills', { group });
      if (!skills.ready) return no('The engine has no skills for this build.');

      if (group === undefined) {
        return ok(show.groups(skills.groups, skills.mainGroup));
      }
      // Asked about one group, so the other ten are not the answer.
      const one = skills.groups.filter((entry) => entry.index === group);
      if (one.length === 0) return no(`This build has no socket group ${group}.`);
      return ok(
        [
          show.groups(one, skills.mainGroup),
          '',
          '## Its gems',
          show.gems(skills.gems ?? []),
        ].join('\n'),
      );
    },
  );

  /* ------------------------------------------------------------- the config */

  server.registerTool(
    'pob_config',
    {
      title: 'Read the configuration',
      description:
        "The Configuration tab: the assumptions the numbers rest on, such as " +
        'whether the character is assumed to be on full life, how many power ' +
        'charges are up, or which boss is being fought. By default only the ' +
        'options somebody has actually set, because the rest are the engine\'s ' +
        'defaults and the same for every build.',
      inputSchema: {
        all: z.boolean().optional().describe('Include options left at their default.'),
        filter: z.string().optional().describe('Keep only options mentioning this.'),
      },
      annotations: reads,
    },
    async ({ all, filter }) => {
      const config = await bridge.get<ConfigSnapshot>('/config');
      if (!config.ready) return no('The engine has no configuration for this build.');

      const parts = [
        `${config.shown} of the engine's ${config.total} options apply to this build.`,
        '',
        show.config(config.sections, { all, filter }),
      ];
      const mods = config.customMods.filter((block) => block.text.trim() !== '');
      if (mods.length > 0 && filter === undefined) {
        parts.push('', '## Custom modifiers');
        for (const block of mods) {
          parts.push(
            `### ${show.strip(block.title)}${block.enabled ? '' : ' (disabled)'}`,
            show.strip(block.text),
          );
        }
      }
      return ok(parts.join('\n'));
    },
  );

  /* -------------------------------------------------------------- the calcs */

  server.registerTool(
    'pob_calcs',
    {
      title: 'Read the calculations',
      description:
        'The Calculations tab, which is where every intermediate number ' +
        'lives: hit damage before and after each multiplier, attack rate, ' +
        'accuracy, mitigation, recovery. Called with nothing it lists the ' +
        'sections and their headline figures, because the whole tab is several ' +
        'hundred rows. Pass `filter` to get the matching rows, each with a cell ' +
        'reference you can hand to pob_breakdown.',
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe('Keep only rows whose label mentions this, e.g. "accuracy".'),
        section: z.string().optional().describe('One section id, for all of its rows.'),
      },
      annotations: reads,
    },
    async ({ filter, section }) => {
      const calcs = await bridge.get<CalcsSnapshot>('/calcs');
      if (!calcs.ready) return no('The engine has no calculations for this build.');
      return ok(
        `${calcs.rowCount} rows in all.\n\n${show.calcs(calcs.sections, { filter, section })}`,
      );
    },
  );

  server.registerTool(
    'pob_breakdown',
    {
      title: 'Explain one number',
      description:
        "The engine's own working behind one cell of the Calculations tab: " +
        'every modifier that fed it, where each came from, and how they ' +
        'combined. `ref` is a cell reference of the form "3.1.4.2", which ' +
        'pob_calcs prints beside the cells that have one.',
      inputSchema: {
        ref: z.string().describe('A cell reference from pob_calcs, e.g. "3.1.4.2".'),
      },
      annotations: reads,
    },
    async ({ ref }) => {
      const answer = await bridge.get<CalcBreakdown>('/calcs/breakdown', { ref });
      return ok(show.breakdown(answer));
    },
  );

  /* ------------------------------------------------------------- the what-if */

  server.registerTool(
    'pob_what_if',
    {
      title: 'Price a change',
      description:
        'What a change would be worth, without making it. The engine runs a ' +
        'full recalculation with the change applied and reports the difference ' +
        'stat by stat, exactly as the app does when you hover something. The ' +
        'build is not touched.\n\n' +
        'This is the tool worth reaching for: it answers "is this better" with ' +
        "the engine's real numbers instead of a guess. `change` picks what to " +
        'price:\n' +
        '- "passive": a tree node, by `node` id. Answers both what the node ' +
        'alone does and what the whole route to it does.\n' +
        '- "config": a Configuration option, by `option` (its variable name ' +
        'from pob_config) and `value`.\n' +
        '- "slot": turning a flask or charm on or off, by `slot`.\n' +
        '- "gem": a gem being disabled or taken to 20 quality, by `group`, ' +
        '`gem` and `subject`.\n' +
        '- "socket_group": a whole socket group being turned off, by `group`.\n\n' +
        'Crafting a change into an item is priced by pob_craft_price instead, ' +
        'because that happens on the bench rather than on the build.',
      inputSchema: {
        change: z
          .enum(['passive', 'config', 'slot', 'gem', 'socket_group'])
          .describe('What kind of change to price.'),
        node: z.number().int().optional().describe('For "passive": the node id.'),
        option: z
          .string()
          .optional()
          .describe('For "config": the option\'s variable name, e.g. "enemyIsBoss".'),
        value: z
          .union([z.string(), z.number(), z.boolean()])
          .optional()
          .describe('For "config": the value to try. Omit for a checkbox to flip it.'),
        slot: z.string().optional().describe('For "slot": the engine slot name.'),
        group: z
          .number()
          .int()
          .optional()
          .describe('For "gem" and "socket_group": the socket group number.'),
        gem: z.number().int().optional().describe('For "gem": the gem number in the group.'),
        subject: z
          .enum(['enabled', 'quality'])
          .optional()
          .describe('For "gem": whether to price turning it off, or taking it to 20 quality.'),
      },
      annotations: reads,
    },
    async (args) => {
      const { change } = args;

      if (change === 'passive') {
        if (args.node === undefined) return no('change="passive" needs a `node` id.');
        const answer = await bridge.get<TreeWhatIf>('/tree/whatif', { node: args.node });
        if (!answer.ready) {
          return no(answer.error ?? `The engine could not price node ${args.node}.`);
        }
        const nodes = await bridge.treeNodes();
        const name = nodes.get(args.node)?.name ?? `node ${args.node}`;
        const parts: string[] = [];
        if (answer.allocated) parts.push(`${name} is already allocated.`, '');
        if (answer.granted) parts.push(`${name} is granted by an item, not by a point.`, '');
        parts.push(show.comparison(answer.node, `## ${name} itself`));
        if (answer.path) {
          parts.push(
            '',
            show.comparison(
              answer.path,
              `## The whole route to it (${answer.pathLength ?? '?'} nodes)`,
            ),
          );
        }
        return ok(parts.join('\n'));
      }

      if (change === 'config') {
        if (args.option === undefined) return no('change="config" needs an `option`.');
        const answer = await bridge.get<WhatIf>('/config/whatif', {
          var: args.option,
          value: args.value === undefined ? undefined : String(args.value),
        });
        const label =
          args.value === undefined
            ? `## Flipping ${args.option}`
            : `## Setting ${args.option} to ${String(args.value)}`;
        return ok(show.comparison(answer, label));
      }

      if (change === 'slot') {
        if (args.slot === undefined) return no('change="slot" needs a `slot` name.');
        const answer = await bridge.get<WhatIf>('/items/whatif', { slot: args.slot });
        return ok(show.comparison(answer, `## Switching ${args.slot}`));
      }

      if (change === 'gem') {
        if (args.group === undefined || args.gem === undefined) {
          return no('change="gem" needs both `group` and `gem`.');
        }
        const subject = args.subject ?? 'enabled';
        const answer = await bridge.get<WhatIf>('/gem/whatif', {
          group: args.group,
          gem: args.gem,
          subject,
        });
        const label =
          subject === 'quality'
            ? `## Gem ${args.gem} in group ${args.group} at 20 quality`
            : `## Gem ${args.gem} in group ${args.group} turned off`;
        return ok(show.comparison(answer, label));
      }

      if (args.group === undefined) return no('change="socket_group" needs a `group`.');
      const answer = await bridge.get<WhatIf>('/skills/whatif', { group: args.group });
      return ok(show.comparison(answer, `## Socket group ${args.group} switched`));
    },
  );

  /* ------------------------------------------------------------- the search */

  server.registerTool(
    'pob_search',
    {
      title: 'Search the game data',
      description:
        "Look something up in Path of Building's own data. `what` picks " +
        'where:\n' +
        '- "passive": tree nodes by name or by the text of their stats, ' +
        'returning ids for pob_tree and pob_what_if.\n' +
        '- "item": the unique and rare databases. `sort` names a stat to rank ' +
        'by, which runs the engine against every candidate in every slot it ' +
        'fits, so it takes a few seconds rather than being instant. The ' +
        'ranking is carried to the end before answering; if it runs out of ' +
        'budget the answer says how far it got.\n' +
        '- "gem": every skill and support gem in the game.',
      inputSchema: {
        what: z.enum(['passive', 'item', 'gem']).describe('Which database to search.'),
        query: z.string().describe('What to look for. An empty string matches everything.'),
        slot: z
          .string()
          .optional()
          .describe('For "item": restrict to items for one slot, e.g. "Helmet".'),
        db: z
          .enum(['unique', 'rare'])
          .optional()
          .describe('For "item": which database. Both are searched by default.'),
        sort: z
          .string()
          .optional()
          .describe('For "item": a stat to rank by, e.g. "FullDPS" or "Life".'),
        limit: z.number().int().min(1).max(100).optional().describe('At most this many. Default 20.'),
      },
      annotations: reads,
    },
    async ({ what, query, slot, db, sort, limit = 20 }) => {
      if (what === 'passive') {
        const nodes = await bridge.treeNodes();
        const wanted = query.trim().toLowerCase();
        const hits = [...nodes.values()].filter((entry) => {
          if (entry.type === 'Socket' || entry.type === 'ClassStart') return false;
          if (wanted === '') return entry.type === 'Keystone';
          if (entry.name.toLowerCase().includes(wanted)) return true;
          return entry.stats.some((stat) => stat.toLowerCase().includes(wanted));
        });
        if (hits.length === 0) return ok(`No passive mentions "${query}".`);
        const shown = hits.slice(0, limit);
        const lines = shown.map(
          (entry) =>
            `- ${entry.name} (${entry.type}, id ${entry.id})` +
            (entry.ascendancy ? ` [${entry.ascendancy}]` : '') +
            (entry.stats.length > 0 ? `: ${show.strip(entry.stats.join('; '))}` : ''),
        );
        const more = hits.length > shown.length ? ` Showing ${shown.length}.` : '';
        return ok(`${hits.length} passives match.${more}\n\n${lines.join('\n')}`);
      }

      if (what === 'gem') {
        const found = await bridge.get<GemSearchSnapshot>('/gems/search', { q: query });
        if (found.results.length === 0) return ok(`No gem mentions "${query}".`);
        const shown = found.results.slice(0, limit);
        const lines = shown.map(
          (gem) =>
            `- ${gem.name}${gem.support ? ' (support)' : ''}` +
            (gem.maxLevel ? `, max level ${gem.maxLevel}` : '') +
            (gem.tags ? `, ${gem.tags}` : ''),
        );
        const total = found.total ?? found.results.length;
        const more = total > shown.length ? ` Showing ${shown.length}.` : '';
        return ok(`${total} gems match.${more}\n\n${lines.join('\n')}`);
      }

      const ask = () =>
        bridge.get<ItemSearchSnapshot>('/items/search', { q: query, slot, db, sort, limit });

      let found = await ask();

      // A stat sort comes back part way through, with the engine's own
      // count of how far it got, and asking again with the same arguments
      // carries it on. So it is carried on here rather than handing back a
      // provisional ranking and a note about how to fix it: a ranking that
      // is wrong at the top is worse than one that took three seconds.
      const started = Date.now();
      let passes = 1;
      let stalled = 0;
      while (found.scanning === true && Date.now() - started < SCAN_BUDGET_MS) {
        const before = found.scanned ?? 0;
        found = await ask();
        passes += 1;
        // The engine's own progress is the only thing that says the scan is
        // still a scan. Two passes that move it nowhere mean it is not
        // going to finish, and spinning until the budget runs out would
        // turn that into a slow answer instead of a quick one.
        stalled = (found.scanned ?? 0) > before ? 0 : stalled + 1;
        if (stalled >= 2) break;
      }

      if (found.loading) {
        return ok('The engine is still parsing the item databases. Ask again shortly.');
      }
      if (found.error !== undefined) return no(show.strip(found.error));
      if (found.results.length === 0) return ok(`No item mentions "${query}".`);

      const lines = found.results.map((item) => {
        // PoB spells a name as "Name, Base", so the base is usually in it.
        const base =
          item.base && !item.name.includes(item.base) ? `, ${show.strip(item.base)}` : '';
        const where = item.slot ? `, ${item.slot}` : '';
        const worth =
          item.delta === undefined
            ? ''
            : ` [${item.value ?? '?'}, ${item.delta >= 0 ? '+' : ''}${item.delta}]`;
        const how = item.source ? ` (${show.strip(item.source)})` : '';
        return `- ${show.strip(item.name)} (${item.rarity.toLowerCase()}${base}${where})${worth}${how}`;
      });

      // A note about a ranking column, with no ranking column in it, is noise.
      const ranked = found.results.some((item) => item.delta !== undefined);
      const notes: string[] = [`${found.total ?? found.results.length} items match.`];
      if (found.sortLabel && ranked) {
        notes.push(
          `Ranked by ${show.strip(found.sortLabel)}` +
            (found.baseline === undefined ? '' : `, which is ${found.baseline} now`) +
            '. The bracket is the item\'s value and its change against this build.',
        );
      }
      if (found.scanning === true) {
        notes.push(
          `The ranking did not finish: ${found.scanned ?? 0} of ` +
            `${found.total ?? '?'} measured over ${passes} passes before the ` +
            'budget ran out, so this order is provisional. Asking again with ' +
            'the same arguments carries it on.',
        );
      } else if (passes > 1) {
        notes.push(`Ranked the whole set, ${found.scanned ?? 0} of them.`);
      }
      return ok(`${notes.join(' ')}\n\n${lines.join('\n')}`);
    },
  );

  /* ------------------------------------------------------------- the builds */

  server.registerTool(
    'pob_builds',
    {
      title: 'List the saved builds',
      description:
        "The builds folder, as Path of Building's own build list sees it: " +
        'name, class, level and the path pob_open_build wants. Also says which ' +
        'one is open and whether it has unsaved changes.',
      inputSchema: {},
      annotations: reads,
    },
    async () => {
      const builds = await bridge.get<BuildsSnapshot>('/builds', { sort: 'EDITED' });
      if (!builds.ready) return no(builds.error ?? 'The engine could not read the builds folder.');

      const lines = builds.entries
        .filter((entry) => entry.kind === 'build')
        .map((entry) => {
          const who = [entry.class, entry.ascendancy].filter(Boolean).join(' / ');
          const level = entry.level ? `level ${entry.level}` : 'no level';
          const folder = entry.subPath ? `${entry.subPath}/` : '';
          return (
            `- ${folder}${entry.name}: ${level}${who ? `, ${who}` : ''}` +
            (entry.open ? ' (open now)' : '') +
            (entry.path ? `\n  path: ${entry.path}` : '')
          );
        });

      const head = [
        `${lines.length} builds in ${builds.buildPath}.`,
        builds.unsaved ? 'The open build has unsaved changes.' : '',
      ].filter(Boolean);
      return ok(`${head.join(' ')}\n\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'pob_open_build',
    {
      title: 'Open a build',
      description:
        'Replace what the engine has open, either with a saved build by ' +
        '`path` (from pob_builds) or with a `code` pasted from a share link. ' +
        'Nothing is written to disk and no saved build is altered, but this ' +
        'does discard unsaved changes to whatever is currently open.\n\n' +
        'When the engine was already running before this server attached to ' +
        'it, somebody may have a window open on that build, and this will ' +
        'change what they are looking at. In that case it asks for `confirm`.',
      inputSchema: {
        path: z.string().optional().describe('A build file path from pob_builds.'),
        code: z
          .string()
          .optional()
          .describe('A Path of Building share code or link. Decoded locally; nothing is fetched.'),
        confirm: z
          .boolean()
          .optional()
          .describe('Required when the engine is one this server did not start.'),
      },
      annotations: writes,
    },
    async ({ path, code, confirm }) => {
      if ((path === undefined) === (code === undefined)) {
        return no('Give exactly one of `path` or `code`.');
      }

      if (!(await bridge.ours()) && confirm !== true) {
        return no(
          'That engine was already running when this server attached to it, so ' +
            'something else may have a window open on the build. Opening another ' +
            'one would change what is on their screen and discard any unsaved ' +
            'changes. Call again with confirm=true if that is wanted.',
        );
      }

      if (code !== undefined) {
        // Read it first: a code that does not decode should say so rather
        // than replacing a working build with an empty one.
        const look = await bridge.get<CodeInspection>('/code/inspect', { code });
        if (!look.valid) return no(`That code does not decode: ${show.strip(look.error)}`);
        const state = await bridge.post<BridgeSnapshot>('/code/import', { code });
        return ok(`Imported.\n\n${show.header(state)}`);
      }

      const state = await bridge.post<BridgeSnapshot>('/build/open', { path });
      return ok(`Opened.\n\n${show.header(state)}`);
    },
  );

  /* -------------------------------------------------------------- the bench */

  server.registerTool(
    'pob_craft',
    {
      title: 'Read the crafting bench',
      description:
        'The crafting bench, and what could go on the item that is on it. ' +
        'Crafting in Path of Building always happens on the bench and never ' +
        'on an item in a slot, so put something there with pob_stage_item ' +
        'first. `what` picks the question:\n' +
        '- "bench": the item being crafted, its affix rows, its rune sockets, ' +
        'its anoint lines, and whether it can be corrupted. The default.\n' +
        '- "worth": the bench item priced against every slot it fits, in one ' +
        'answer, so a ring does not have to be tried in each hand.\n' +
        '- "affixes": everything one affix row could hold, by `kind` and ' +
        '`index`. Only a magic or rare built on the bench has affix rows.\n' +
        '- "bases": the item types, or the bases under one `type`.\n' +
        '- "runes": the runes and soul cores its sockets would accept.\n' +
        '- "anoints": the notables it could be anointed with, of 875, ' +
        'searched by `query`. Their node ids are what pob_craft_price wants.\n' +
        '- "corruptions": the implicits it could take, what it already ' +
        'carries, and the rolls a corruption would scale. The modifier ids ' +
        'here are what pob_craft_price wants.',
      inputSchema: {
        what: z
          .enum(['bench', 'worth', 'affixes', 'bases', 'runes', 'anoints', 'corruptions'])
          .optional()
          .describe('Which part of the bench to read. Defaults to "bench".'),
        kind: z
          .enum(['prefix', 'suffix'])
          .optional()
          .describe('For "affixes": which half of the affix rows.'),
        index: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('For "affixes": which row, counting from 1.'),
        type: z
          .string()
          .optional()
          .describe('For "bases": an item type, e.g. "Ring". Omit for the list of types.'),
        query: z.string().optional().describe('For "runes", "anoints" and "corruptions".'),
        mode: z
          .enum(['anywhere', 'names', 'modifiers'])
          .optional()
          .describe('For "anoints": what `query` is matched against. Defaults to "anywhere".'),
        source: z
          .enum(['Corrupted', 'SpecialCorrupted'])
          .optional()
          .describe(
            'For "corruptions": which table. "SpecialCorrupted" is Glimpse ' +
              'of Chaos, offered on a helmet only.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(400)
          .optional()
          .describe('For "anoints": at most this many. Defaults to 20.'),
      },
      annotations: reads,
    },
    async ({ what = 'bench', kind, index, type, query, mode, source, limit }) => {
      if (what === 'worth') {
        return ok(show.staged(await bridge.get<StagedItem>('/item/staged')));
      }

      if (what === 'affixes') {
        if (kind === undefined || index === undefined) {
          return no('what="affixes" needs both `kind` and `index`.');
        }
        const answer = await bridge.get<CraftAffixes>('/craft/affixes', { kind, index, q: query });
        return ok(show.affixOptions(answer));
      }

      if (what === 'bases') {
        return ok(show.bases(await bridge.get<CraftBases>('/craft/bases', { type })));
      }

      if (what === 'runes') {
        return ok(show.runes(await bridge.get<CraftRunes>('/craft/runes', { q: query })));
      }

      if (what === 'anoints') {
        // Twenty, not the engine's own 150: a notable's answer carries
        // every line it grants and its oil recipe, so sixty of them is
        // ten kilobytes of context for a question that wanted a page.
        const answer = await bridge.get<CraftAnoints>('/craft/anoints', {
          q: query,
          mode: mode ?? 'anywhere',
          limit: limit ?? 20,
        });
        return ok(show.anoints(answer));
      }

      if (what === 'corruptions') {
        const answer = await bridge.get<CraftCorruptions>('/craft/corruptions', {
          source: source ?? 'Corrupted',
          q: query,
        });
        return ok(show.corruptions(answer));
      }

      return ok(show.bench(await bridge.get<CraftState>('/item/craft')));
    },
  );

  server.registerTool(
    'pob_craft_price',
    {
      title: 'Price a craft',
      description:
        'What a craft would be worth, without doing it. Same mechanism as ' +
        'pob_what_if, and on the bench item rather than on the build: the ' +
        'engine applies the craft, recalculates, reports the difference, and ' +
        'puts the item back as it was. `change` picks what to price:\n' +
        '- "anoint": one notable, by `node` id from pob_craft what="anoints". ' +
        'Both sides put the item in its own slot, so the answer is the ' +
        "anoint's worth and not the whole item's.\n" +
        '- "corruption": a whole corruption draft at once, as `implicits` ' +
        '(modifier ids keyed by implicit slot, from pob_craft ' +
        'what="corruptions") or as `ranges` (a roll between 0.78 and 1.22 ' +
        "keyed by the explicit's index). Never both: PoB's own dialog writes " +
        'one half or the other. A draft rather than a single choice because ' +
        'two implicits chosen together have to be priced together.\n' +
        '- "catalysts": all thirteen at once, at one `quality`, so they read ' +
        'against each other. Most of them scale nothing on a given item, ' +
        'which is the useful part of the answer.',
      inputSchema: {
        change: z.enum(['anoint', 'corruption', 'catalysts']).describe('What to price.'),
        node: z
          .number()
          .int()
          .optional()
          .describe('For "anoint": the notable\'s node id. Omit to price taking one off.'),
        line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'For "anoint": which enchant line to put it on, counting from 1. ' +
              'Defaults to 1.',
          ),
        implicits: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            'For "corruption": modifier ids keyed by implicit slot, e.g. ' +
              '{"1": "LocalIncreasedPhysicalDamagePercentImplicit3"}.',
          ),
        ranges: z
          .record(z.string(), z.number())
          .optional()
          .describe(
            'For "corruption": a roll between 0.78 and 1.22 keyed by the ' +
              "explicit modifier's index, e.g. {\"2\": 1.22}. Uniques only.",
          ),
        source: z
          .enum(['Corrupted', 'SpecialCorrupted'])
          .optional()
          .describe('For "corruption": which table the implicits come from.'),
        quality: z
          .number()
          .int()
          .min(0)
          .max(99)
          .optional()
          .describe(
            'For "catalysts": the quality to price all thirteen at. Defaults ' +
              'to what the item carries.',
          ),
      },
      annotations: reads,
    },
    async (args) => {
      const { change } = args;

      if (change === 'anoint') {
        const line = args.line ?? 1;
        const answer = await bridge.get<AnointWhatIf>('/craft/anoint/whatif', {
          slot: line,
          node: args.node,
        });
        if (!answer.ready) {
          return no(answer.error ?? 'The engine could not price that anoint.');
        }
        const label =
          args.node === undefined
            ? `## Taking the anoint off line ${line}`
            : `## Anointing node ${args.node} on line ${line}`;
        // PoB's own two early answers, and both read as nothing happening
        // unless the reason is given.
        const why = answer.reason === undefined ? '' : `${show.strip(answer.reason)}\n\n`;
        return ok(why + show.comparison(answer, label));
      }

      if (change === 'corruption') {
        if (args.implicits !== undefined && args.ranges !== undefined) {
          return no(
            'Give `implicits` or `ranges`, not both: PoB\'s corruption dialog ' +
              'writes whichever half is showing, so a draft is one or the other.',
          );
        }
        if (args.implicits === undefined && args.ranges === undefined) {
          return no('change="corruption" needs either `implicits` or `ranges`.');
        }
        const ranges = args.ranges !== undefined;
        const answer = await bridge.get<CorruptPreview>('/craft/corrupt/preview', {
          mode: ranges ? 'ranges' : 'implicits',
          source: args.source,
          implicits: args.implicits === undefined ? undefined : keyed(args.implicits),
          ranges: args.ranges === undefined ? undefined : keyed(args.ranges),
        });
        return ok(show.corruptPreview(answer));
      }

      const answer = await bridge.get<CraftCatalysts>('/craft/catalysts', {
        quality: args.quality,
      });
      return ok(show.catalysts(answer));
    },
  );

  server.registerTool(
    'pob_stage_item',
    {
      title: 'Put an item on the bench',
      description:
        'Put an item on the crafting bench, which is where everything in ' +
        'pob_craft and pob_craft_price reads from. The bench is separate from ' +
        'the slots: nothing is equipped, nothing is written to disk, and the ' +
        'build is not changed. It answers with the item priced against every ' +
        'slot it would fit.\n\n' +
        'Give exactly one of:\n' +
        '- `item`: an item id from pob_items. A copy of it goes on the bench, ' +
        'so crafting on it leaves the worn one alone.\n' +
        '- `text`: an item as the game copies it to the clipboard.\n' +
        '- `name`: a unique or rare from the database, named exactly as ' +
        'pob_search what="item" prints it, base and all.\n' +
        '- `base`, with its `type` and optionally a `rarity`: a blank item ' +
        'made on the bench, which is the only kind that has affix rows.\n' +
        '- `clear`: true, to take the bench item off again.\n\n' +
        'Whatever was on the bench is replaced, so when the engine was ' +
        'already running before this server attached to it, and somebody may ' +
        'be part way through a craft, it asks for `confirm`.',
      inputSchema: {
        item: z.number().int().optional().describe('An item id from pob_items.'),
        text: z.string().optional().describe("An item's in-game text."),
        name: z
          .string()
          .optional()
          .describe('A database item, named exactly as pob_search prints it.'),
        base: z
          .string()
          .optional()
          .describe('A base to make a blank item on, e.g. "Lazuli Ring", with `type`.'),
        type: z
          .string()
          .optional()
          .describe('The item type `base` belongs to, from pob_craft what="bases".'),
        rarity: z
          .enum(['NORMAL', 'MAGIC', 'RARE', 'UNIQUE'])
          .optional()
          .describe(
            'For `base`: defaults to RARE. Only MAGIC and RARE get affix ' +
              'rows; the other two carry their modifiers as text.',
          ),
        clear: z.boolean().optional().describe('Take the bench item off instead.'),
        confirm: z
          .boolean()
          .optional()
          .describe('Required when the engine is one this server did not start.'),
      },
      annotations: writes,
    },
    async ({ item, text, name, base, type, rarity, clear, confirm }) => {
      const given = [item, text, name, base, clear === true ? clear : undefined].filter(
        (value) => value !== undefined,
      );
      if (given.length !== 1) {
        return no('Give exactly one of `item`, `text`, `name`, `base` or `clear`.');
      }
      if (base !== undefined && type === undefined) {
        return no('`base` needs the `type` it belongs to, which pob_craft what="bases" lists.');
      }

      if (!(await bridge.ours()) && confirm !== true) {
        return no(
          'That engine was already running when this server attached to it, so ' +
            'something else may have an item part way through a craft on the ' +
            'bench. This would replace it. Call again with confirm=true if that ' +
            'is wanted.',
        );
      }

      if (clear === true) {
        await bridge.post<BridgeSnapshot>('/action', { action: 'clearStagedItem' });
        bridge.releaseBench();
        return ok('The bench is empty.');
      }

      if (item !== undefined) {
        // An equipped item cannot be put on the bench directly: PoB has no
        // gesture for it, and the bench is for things not yet committed to.
        // What it does have is the item as text, which stages a copy.
        const edit = await bridge.get<ItemEdit>('/item/edit', { id: item });
        if (!edit.ready || edit.raw === undefined) {
          return no(`The engine has no item with id ${item}, or no text for it.`);
        }
        await bridge.post<BridgeSnapshot>('/action', {
          action: 'stageItemText',
          value: { text: edit.raw },
        });
      } else if (text !== undefined) {
        await bridge.post<BridgeSnapshot>('/action', {
          action: 'stageItemText',
          value: { text },
        });
      } else if (base !== undefined) {
        await bridge.post<BridgeSnapshot>('/action', {
          action: 'craftItem',
          value: { type, base, rarity: rarity ?? 'RARE' },
        });
        bridge.claimBench();
        // A blank item has no modifiers, so pricing it against every slot
        // would be a page of nothing. What it has is affix rows.
        return ok(show.bench(await bridge.get<CraftState>('/item/craft')));
      } else {
        await bridge.post<BridgeSnapshot>('/action', {
          action: 'stageDbItem',
          value: { name },
        });
      }

      bridge.claimBench();
      return ok(show.staged(await bridge.get<StagedItem>('/item/staged')));
    },
  );

  server.registerTool(
    'pob_craft_apply',
    {
      title: 'Apply a craft',
      description:
        'Make the change to the item on the bench, rather than only pricing ' +
        'it. Nothing is written to disk and nothing is equipped: the bench is ' +
        'not part of the build, so the character is unchanged until the item ' +
        'goes into a slot. Answers with the bench item as it now stands.\n\n' +
        'Price it first with pob_craft_price where there is a route for it. ' +
        '`change` picks what to do:\n' +
        '- "affix": put a modifier in a prefix or suffix row, by `kind`, ' +
        '`index`, the `affix` series from pob_craft what="affixes", and a ' +
        '`tier`. `roll` says where in that tier\'s range it lands.\n' +
        '- "rune": socket a rune or soul core, by `index` and `rune` name ' +
        'from pob_craft what="runes".\n' +
        '- "sockets": change how many sockets the item has, by `socket` and ' +
        '`count`. PoB lets an item exceed what its base comes with.\n' +
        '- "anoint": anoint a notable, by `node` id and `line`.\n' +
        '- "corrupt": corrupt it, with the same `implicits` or `ranges` ' +
        'draft pob_craft_price takes. This cannot be undone to the item: a ' +
        'corrupted item can only be replaced by staging another.\n' +
        '- "quality": set the item\'s quality.\n' +
        '- "catalyst": apply one of the thirteen by number, with its own ' +
        '`quality`.\n\n' +
        '`clear` empties an affix row, a socket or an anoint line instead.',
      inputSchema: {
        change: z
          .enum(['affix', 'rune', 'sockets', 'anoint', 'corrupt', 'quality', 'catalyst'])
          .describe('What to change.'),
        kind: z
          .enum(['prefix', 'suffix'])
          .optional()
          .describe('For "affix": which half of the affix rows.'),
        index: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('For "affix" and "rune": which row or socket, counting from 1.'),
        affix: z
          .string()
          .optional()
          .describe(
            'For "affix": the series, which pob_craft what="affixes" prints ' +
              'in front of each one, e.g. "IncreasedLife1".',
          ),
        tier: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('For "affix": which tier, 1 being the lowest. Defaults to the top one.'),
        roll: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            'For "affix": where in the tier\'s range it rolls, 0 the bottom ' +
              'and 1 the top. Defaults to what the row already had, else the middle.',
          ),
        rune: z
          .string()
          .optional()
          .describe('For "rune": the rune or soul core, named as pob_craft prints it.'),
        socket: z
          .enum(['rune', 'jewel'])
          .optional()
          .describe('For "sockets": which kind to change the count of.'),
        count: z
          .number()
          .int()
          .min(0)
          .max(6)
          .optional()
          .describe('For "sockets": how many.'),
        node: z.number().int().optional().describe('For "anoint": the notable\'s node id.'),
        line: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('For "anoint": which enchant line. Defaults to 1.'),
        implicits: z
          .record(z.string(), z.string())
          .optional()
          .describe('For "corrupt": modifier ids keyed by implicit slot.'),
        ranges: z
          .record(z.string(), z.number())
          .optional()
          .describe('For "corrupt": a roll between 0.78 and 1.22 keyed by explicit index.'),
        source: z
          .enum(['Corrupted', 'SpecialCorrupted'])
          .optional()
          .describe('For "corrupt": which table the implicits come from.'),
        quality: z
          .number()
          .int()
          .min(0)
          .max(99)
          .optional()
          .describe('For "quality" and "catalyst".'),
        catalyst: z
          .number()
          .int()
          .min(0)
          .max(13)
          .optional()
          .describe('For "catalyst": which one, by the number pob_craft prints. 0 takes it off.'),
        clear: z
          .boolean()
          .optional()
          .describe('Empty the affix row, socket or anoint line named instead.'),
        confirm: z
          .boolean()
          .optional()
          .describe('Required when the bench item is not one this server staged.'),
      },
      annotations: writes,
    },
    async (args) => {
      const { change, clear } = args;

      // Only when there is work to lose. An engine this server started has
      // nobody looking at it, an item we staged ourselves is ours to
      // change, and an empty bench holds nobody's craft.
      if (!(await bridge.benchIsOurs())) {
        const bench = await bridge.get<CraftState>('/item/craft');
        if (bench.ready && args.confirm !== true) {
          return no(
            'The item on the bench is not one this server put there, and that ' +
              'engine was already running when the server attached to it, so ' +
              'somebody may be part way through this craft. Call again with ' +
              'confirm=true, or stage your own item with pob_stage_item first.',
          );
        }
      }

      const after = async (): Promise<Result> =>
        ok(show.bench(await bridge.get<CraftState>('/item/craft')));

      if (change === 'affix') {
        const { kind, index } = args;
        if (kind === undefined || index === undefined) {
          return no('change="affix" needs `kind` and `index`.');
        }
        if (clear === true) {
          await bridge.post<BridgeSnapshot>('/action', {
            action: 'setCraftAffix',
            value: { kind, index, modId: 'None' },
          });
          return after();
        }
        if (args.affix === undefined) {
          return no('change="affix" needs an `affix` series, or clear=true to empty the row.');
        }
        // The tiers are looked up rather than taken as an id, so that the
        // list a reader saw does not have to carry nine ids per modifier.
        // Asking the row itself also checks that the modifier can go in it.
        const list = await bridge.get<CraftAffixes>('/craft/affixes', { kind, index });
        if (!list.ready) {
          return no(list.error ?? `The engine would not open ${kind} slot ${index}.`);
        }
        const option = (list.options ?? []).find((entry) => entry.key === args.affix);
        if (!option) {
          return no(
            `Nothing called ${args.affix} can go in ${kind} slot ${index}. ` +
              'pob_craft what="affixes" lists what can, for that row: a ' +
              'modifier already in another row is excluded from the rest, so ' +
              'the same series cannot be put in two of them.',
          );
        }
        const tier = args.tier ?? option.tierCount;
        const modId = option.modIds[tier - 1];
        if (modId === undefined) {
          return no(
            `${show.strip(option.label)} has ${option.tierCount} tiers, so there is no tier ${tier}.`,
          );
        }
        await bridge.post<BridgeSnapshot>('/action', {
          action: 'setCraftAffix',
          value: { kind, index, modId, roll: args.roll },
        });
        return after();
      }

      if (change === 'rune') {
        if (args.index === undefined) return no('change="rune" needs an `index`.');
        if (clear !== true && args.rune === undefined) {
          return no('change="rune" needs a `rune` name, or clear=true to empty the socket.');
        }
        await bridge.post<BridgeSnapshot>('/action', {
          action: 'setRune',
          value: { index: args.index, name: clear === true ? 'None' : args.rune },
        });
        return after();
      }

      if (change === 'sockets') {
        if (args.count === undefined) return no('change="sockets" needs a `count`.');
        await bridge.post<BridgeSnapshot>('/action', {
          action: 'setSocketCount',
          value: { kind: args.socket ?? 'rune', count: args.count },
        });
        return after();
      }

      if (change === 'anoint') {
        const line = args.line ?? 1;
        if (clear !== true && args.node === undefined) {
          return no('change="anoint" needs a `node` id, or clear=true to take the anoint off.');
        }
        await bridge.post<BridgeSnapshot>('/action', {
          action: 'setAnoint',
          value: { slot: line, node: clear === true ? null : args.node },
        });
        return after();
      }

      if (change === 'corrupt') {
        if (args.implicits !== undefined && args.ranges !== undefined) {
          return no(
            'Give `implicits` or `ranges`, not both: PoB\'s corruption dialog ' +
              'writes whichever half is showing, so a draft is one or the other.',
          );
        }
        if (args.implicits === undefined && args.ranges === undefined) {
          return no('change="corrupt" needs either `implicits` or `ranges`.');
        }
        await bridge.post<BridgeSnapshot>('/action', {
          action: 'corruptItem',
          value: {
            mode: args.ranges !== undefined ? 'ranges' : 'implicits',
            source: args.source,
            implicits: args.implicits === undefined ? undefined : keyed(args.implicits),
            ranges: args.ranges === undefined ? undefined : keyed(args.ranges),
          },
        });
        return after();
      }

      if (change === 'quality') {
        if (args.quality === undefined) return no('change="quality" needs a `quality`.');
        await bridge.post<BridgeSnapshot>('/action', {
          action: 'setCraftQuality',
          value: { quality: args.quality },
        });
        return after();
      }

      if (args.catalyst === undefined) {
        return no('change="catalyst" needs a `catalyst` number, 0 to take it off.');
      }
      await bridge.post<BridgeSnapshot>('/action', {
        action: 'setCatalyst',
        value: { catalyst: args.catalyst, quality: args.quality },
      });
      return after();
    },
  );

  server.registerTool(
    'pob_equip_staged',
    {
      title: 'Wear the bench item',
      description:
        'Take the item off the bench and put it on the character. This is ' +
        'the one crafting tool that changes the build rather than the bench: ' +
        'the item joins the build\'s item list and goes into a slot, so every ' +
        'number the build reports moves.\n\n' +
        'Nothing is written to disk. The saved build file is untouched and ' +
        'saving is not exposed, so this is undone by closing without saving, ' +
        'or by opening the build again with pob_open_build.\n\n' +
        'Give a `slot` to choose where it goes, or leave it out for the ' +
        "engine's own choice, which is the first empty slot that will take " +
        'it. Price it first with pob_craft what="worth", which reports the ' +
        'item against every slot it fits.',
      inputSchema: {
        slot: z
          .string()
          .optional()
          .describe(
            'An engine slot name, e.g. "Ring 2" or "Body Armour". Omit for ' +
              "the engine's own choice.",
          ),
        confirm: z
          .boolean()
          .optional()
          .describe('Required when the engine is one this server did not start.'),
      },
      annotations: writes,
    },
    async ({ slot, confirm }) => {
      // Guarded on the engine and not on the bench, unlike pob_craft_apply:
      // what this changes is the build, so who staged the item does not
      // come into it.
      if (!(await bridge.ours()) && confirm !== true) {
        return no(
          'That engine was already running when this server attached to it, ' +
            'so somebody may have a window open on the build. Equipping this ' +
            'would change the character they are looking at. Call again with ' +
            'confirm=true if that is wanted.',
        );
      }

      await bridge.post<BridgeSnapshot>('/action', {
        action: 'equipStagedItem',
        value: slot === undefined ? {} : { slot },
      });
      // The engine clears the bench on its way through AddDisplayItem, so
      // the claim on it is no longer ours to hold.
      bridge.releaseBench();

      const items = await bridge.get<ItemsSnapshot>('/items');
      if (!items.ready) return ok('Equipped. The engine has no item list to show.');
      return ok(
        `Equipped${slot === undefined ? '' : ` in ${slot}`}, and the bench is ` +
          `empty again.\n\n${show.equipment(items)}`,
      );
    },
  );

  /* ---------------------------------------------------------- the comparison */

  server.registerTool(
    'pob_compare',
    {
      title: 'Read the comparison',
      description:
        'The open build against another one, stat by stat. This is PoB\'s ' +
        'own Compare tab, and it is the direct way to answer "which of these ' +
        'two is better", because every stat is lined up rather than read off ' +
        'two separate sheets.\n\n' +
        'Something has to be loaded to compare against first, which is what ' +
        'pob_compare_load does. Stats the two builds agree on are left out ' +
        'unless `all` is set, since on two variants of one build the handful ' +
        'that differ are the whole answer.',
      inputSchema: {
        all: z
          .boolean()
          .optional()
          .describe('Include the stats the two builds agree on.'),
      },
      annotations: reads,
    },
    async ({ all }) => {
      const snapshot = await bridge.get<CompareSnapshot>('/compare');
      return ok(show.versus(snapshot, { all }));
    },
  );

  server.registerTool(
    'pob_compare_load',
    {
      title: 'Load a build to compare against',
      description:
        'Put another build in the comparison list, choose which one is ' +
        'compared against, or take one out. Nothing is written to disk and ' +
        'the open build is not changed: a comparison is held beside it.\n\n' +
        '`action` picks which:\n' +
        '- "load": add a build, by `path` from pob_builds or by `code` from a ' +
        'share link. It becomes the one compared against.\n' +
        '- "select": compare against one already loaded, by `index` from ' +
        'pob_compare.\n' +
        '- "remove": take one out of the list, by `index`.',
      inputSchema: {
        action: z
          .enum(['load', 'select', 'remove'])
          .optional()
          .describe('What to do. Defaults to "load".'),
        path: z.string().optional().describe('For "load": a build file path from pob_builds.'),
        code: z
          .string()
          .optional()
          .describe(
            'For "load": a share code or link. Decoded locally; nothing is fetched.',
          ),
        index: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('For "select" and "remove": which loaded build, from pob_compare.'),
        confirm: z
          .boolean()
          .optional()
          .describe('Required when the engine is one this server did not start.'),
      },
      annotations: writes,
    },
    async ({ action = 'load', path, code, index, confirm }) => {
      if (!(await bridge.ours()) && confirm !== true) {
        return no(
          'That engine was already running when this server attached to it, ' +
            'so somebody may have the Compare tab open on it. Changing what is ' +
            'loaded would change what they are looking at. Call again with ' +
            'confirm=true if that is wanted.',
        );
      }

      if (action === 'load') {
        if ((path === undefined) === (code === undefined)) {
          return no('Give exactly one of `path` or `code`.');
        }
        if (code !== undefined) {
          // Read it first: a code that does not decode should say so rather
          // than landing in the list as an empty build.
          const look = await bridge.get<CodeInspection>('/code/inspect', { code });
          if (!look.valid) return no(`That code does not decode: ${show.strip(look.error)}`);
        }
        await bridge.post<BridgeSnapshot>('/action', {
          action: 'addCompare',
          value: code === undefined ? { path } : { code },
        });
      } else if (index === undefined) {
        return no(`action="${action}" needs an \`index\` from pob_compare.`);
      } else {
        await bridge.post<BridgeSnapshot>('/action', {
          action: action === 'select' ? 'setCompare' : 'removeCompare',
          value: index,
        });
      }

      return ok(show.versus(await bridge.get<CompareSnapshot>('/compare')));
    },
  );

  /* --------------------------------------------------------------- the notes */

  server.registerTool(
    'pob_notes',
    {
      title: 'Read the build notes',
      description:
        "The build's own notes: whatever the person who made it wrote down, " +
        'which on a shared build is usually how it is meant to be played, ' +
        'what to buy first, and which parts are flexible. Worth reading ' +
        'before judging a build, because it is the only part of the file that ' +
        'says what the author intended.',
      inputSchema: {},
      annotations: reads,
    },
    async () => ok(show.notes(await bridge.get<NotesSnapshot>('/notes'))),
  );
}
