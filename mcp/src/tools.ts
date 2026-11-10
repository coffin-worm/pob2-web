/**
 * What a client can ask.
 *
 * Eleven tools over forty-odd routes, which is deliberate. The engine
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
  BridgeSnapshot,
  BuildsSnapshot,
  CalcBreakdown,
  CalcsSnapshot,
  CodeInspection,
  ConfigSnapshot,
  GemSearchSnapshot,
  ItemDetail,
  ItemSearchSnapshot,
  ItemsSnapshot,
  SkillsSnapshot,
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
        '- "socket_group": a whole socket group being turned off, by `group`.',
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
        'by, which runs the engine against every candidate and is slow; the ' +
        'answer says how far it got, and asking again carries the scan on.\n' +
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

      const found = await bridge.get<ItemSearchSnapshot>('/items/search', {
        q: query,
        slot,
        db,
        sort,
        limit,
      });
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
      if (found.scanning) {
        notes.push(
          `The ranking is still running: ${found.scanned ?? 0} measured so far, so ` +
            'this order is provisional. Asking again with the same arguments carries it on.',
        );
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
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
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
}
