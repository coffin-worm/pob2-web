# The MCP server

Lets an AI client read a Path of Building 2 build, and price changes to it,
through the real calculation engine.

The interesting half is not the reading. It is that a model can ask "what
would this passive be worth" and get PoB's own answer: a full recalculation
with the change applied, reported as a difference, with the build left
exactly as it was. That is the same mechanism the desktop app uses when you
hover a node, and it is the difference between a model reasoning about
modifier text and a model reading a number the engine computed.

## Running it

```bash
cd mcp && npm install && npm run build
```

Then in a client's server configuration:

```json
{
  "mcpServers": {
    "pob2": {
      "command": "node",
      "args": ["C:/personal/pob2-web/mcp/dist/index.js"]
    }
  }
}
```

Nothing else is needed. The checkout is found by walking up from the
server's own directory, and the engine is started on the first question
rather than at startup, so the client's `initialize` comes back promptly
instead of waiting several seconds for PoB to read the game data.

`.mcp.json` at the root of the checkout says the same thing for Claude
Code, which reads it when a session starts in this folder and asks before
running a server it has not seen. The path in it is absolute, because a
relative one would depend on the directory the client launches from. Note
that `mcp/dist/` is not in the repository, so on a fresh checkout that file
points at a build that has not happened yet.

## Which engine it talks to

By default it attaches to an engine that is already running, and starts one
only if nothing answers. That order is deliberate: an engine already up has
a build loaded, and often a window showing it, so a server that always
started its own would answer questions about an empty character while the
real one sat on the next port along.

It looks, in order, at `POB_BRIDGE_PORT` if set, then the port written to
`%TEMP%/pob2-bridge.json`, then 49090, 49091 and 49092, health-checking each
one. Failing all of that it starts its own on a port it asks the OS for, so
it can never collide with the dev server's.

`--own` (or `POB_MCP_OWN=1`) skips straight to starting a private engine,
which is what you want when somebody is working in the app and should not
have the build changed under them.

| Variable | What it does |
| --- | --- |
| `POB_ROOT` | The checkout, if walking up from `dist/` finds the wrong one |
| `POB_LOVE` | Path to `lovec.exe`, if LOVE is not where it usually is |
| `POB_BRIDGE_PORT` | Attach to exactly this port, and fail if nothing answers |
| `POB_MCP_OWN` | `1` to always start a private engine |

An engine this server started is killed when the server exits, and its
announcement in the port file is taken back at the same time. A client that
kills the server outright can orphan one; the next run attaches to it rather
than piling up another, which is the reason nothing worse than one orphan
can accumulate.

## The tools

Nineteen, over the bridge's forty-five routes. The grouping is the point: the
engine exposes a route per control, and a model handed forty tools spends
its context on the schema list and still picks the wrong one. So these are
grouped by the question somebody actually has, and the routes that differ
only in which control they drive are folded into one tool with a
discriminator.

| Tool | Answers |
| --- | --- |
| `pob_build` | The open build and its whole stat sheet. The place to start. |
| `pob_tree` | What is allocated on the passive tree, or one node in full |
| `pob_items` | What is equipped, or one item's modifiers and what it is worth |
| `pob_skills` | The socket groups, or the gems in one of them |
| `pob_config` | The assumptions the numbers rest on |
| `pob_calcs` | The Calculations tab, section summaries or matching rows |
| `pob_breakdown` | The engine's working behind one number |
| `pob_what_if` | What a change would be worth, without making it |
| `pob_search` | Passives, items or gems in PoB's own data |
| `pob_builds` | The saved builds folder |
| `pob_open_build` | Open a saved build, or import a share code |
| `pob_craft` | The bench item, and what could go on it |
| `pob_craft_price` | What an anoint, a corruption or a catalyst would be worth |
| `pob_craft_apply` | Make that change to the bench item |
| `pob_stage_item` | Put an item on the bench |
| `pob_equip_staged` | Take the bench item and wear it |
| `pob_compare` | This build against another one, stat by stat |
| `pob_compare_load` | Load, choose or drop a build to compare against |
| `pob_notes` | What the build's author wrote about it |

`pob_what_if` takes a `change` of `passive`, `config`, `slot`, `gem` or
`socket_group`; `pob_craft_price` takes `anoint`, `corruption` or
`catalysts`. Between them that is all eight of the bridge's pricing routes.
They are two tools rather than one because their parameters barely overlap,
and because they price different things: one a change to the build, the
other a change to an item on the bench.

## The bench

Crafting in Path of Building happens on the bench and never on an item in a
slot, which is the whole reason `pob_stage_item` exists. Nothing in the
engine loads an equipped item onto the bench, so `pob_stage_item` with an
item id reads the item back out as text and stages a copy of it. Crafting on
that copy leaves the worn one alone, and nothing is equipped unless somebody
does it in the app.

Affix rows are only reachable that way. PoB gives them to a magic or rare
built in its own craft dialog and to nothing else, so `pob_stage_item` can
make a blank item from a base; anything copied out of the game carries its
modifiers as text instead.

Catalysts are narrower for a different reason. PoB offers them for a ring,
an amulet or a jewel, and only when the item's modifiers carry catalyst tags
or the item was built on the bench. So a pasted rare whose modifiers happen
to carry none is refused, and the engine says why.

`pob_craft_apply` makes the change rather than pricing it, and it is the
other half of the loop: read what a row could hold, price it, apply it, read
what the item is now worth, and `pob_equip_staged` to wear it. It covers the
seven things PoB can change about a bench item: an affix row, a rune socket,
the socket count, an anoint, a corruption, the quality, and a catalyst.

An affix row is addressed by series and tier rather than by the id of each
tier, so `affix: "IncreasedLife1", tier: 8, roll: 1` is the top tier of that
series rolled at the top of its range. The series handle is the lowest
tier's id, which is what the list prints in front of each modifier, and the
tier is resolved against the row being filled, so a modifier that cannot go
in that row is refused by name. PoB excludes a series already in one row
from the others, which is why the same one cannot be put in two.

## The comparison

`pob_compare` is PoB's own Compare tab: the open build and another one,
every stat lined up. It is the direct way to answer "which of these two is
better", which is otherwise two stat sheets and arithmetic.

Something has to be loaded first, which `pob_compare_load` does from a
saved build or a share code, and which is why there is a second tool: a
read-only one would answer "nothing is loaded" on almost every build, the
same trap the crafting bench had. Loading holds a build beside the open one
and changes neither, and nothing is written to disk.

One thing the answer has to say out loud, because a reader cannot check it:
the engine's difference is the comparison minus the open build. It is what
the other build has, not what this one would gain. Reading it the other way
round inverts every conclusion drawn from it, so the direction is stated
above the rows rather than left to be inferred from them.

## The ranking takes a moment

`pob_search what="item"` with a `sort` runs the engine against every
candidate in every slot it fits. The engine spreads that over as many
requests as it takes and reports how far it got, so one request is a slice
and not an answer. The tool carries the scan to the end before replying:
measured on the whole database, 551 candidates take eight requests and
about three seconds, for the cheapest stat and the most expensive one
alike. A ranking that is wrong at the top is worth more than three seconds.

There is a budget, and if it runs out the answer says how far it got and
that asking again carries it on.

## Everything is text, and that is the work

The engine answers a UI. Its stat sheet carries a colour classification and
a row height per line, its tooltips carry centring and separator flags, and
its passive tree is 4,500 nodes with pixel coordinates in about 420 kB.
Handed to a model raw, two calls would fill a context window with things no
reader can use.

So `render.ts` turns each answer into text, and the rule throughout is: drop
what only a renderer wanted, keep every number and every word the engine
computed, and recompute nothing. Some examples of what that means in
practice:

- The tree is fetched once and never shown. It is there to turn allocated
  node ids into names, and names back into the ids the what-if routes want.
- `pob_tree` names keystones and notables and counts the rest. A hundred
  allocated nodes are mostly small attribute passives, and listing them
  buries the four that decide how the build works.
- `pob_config` shows what somebody chose, not all several hundred options.
  The rest are the engine's defaults and the same for every build.
- `pob_calcs` with no filter lists sections and their headline figures,
  because the whole tab is a few hundred rows.
- `pob_craft_price change="catalysts"` names in one line the ten or twelve
  catalysts that scale nothing on the item, and gives a comparison only to
  the ones that do. That is the answer, not a saving: a catalyst only
  touches modifiers carrying its own tag, and most items carry two or three.
- The affix list prints one handle per series rather than one id per tier.
  PoB keys its own dropdown by the id of each tier, and nine ids for each of
  twenty modifiers would be most of the answer by weight, so a craft is
  applied by the series plus a tier number and the server resolves it.
- The thirteen catalyst numbers are printed by `pob_craft_price`, which is
  the answer a reader applies one from, and not by every read of the bench.
  They are a fixed table and it never changes.
- `pob_compare` drops the stats the two builds agree on. Two builds worth
  comparing are usually variants of each other, so most of the sheet is
  identical and the handful that moved is the whole question. `all` brings
  the rest back.
- It also drops the engine's percentage on a stat that was negative to
  begin with, and only there. The percentage is a ratio of the two values,
  so going from -25% resistance to -18% is +7 and an improvement, and
  -28% as a ratio. Side by side those read as a contradiction, and the
  absolute difference beside it says the same thing without the trap.

Measured on a level 73 build: the whole build summary with its stat sheet is
1.2 kB, the allocated tree 0.8 kB, the configuration 1.9 kB, and a what-if
two to five hundred bytes. All thirteen catalysts, priced together, are
0.4 kB; the bench item is 0.2 to 0.5 kB and the same item priced against
every slot it fits about 0.6 kB.

## Writing

Four tools change anything, and none of them writes to disk.

`pob_open_build` replaces what the engine has open. `pob_stage_item`
replaces what is on the bench and `pob_craft_apply` changes it, and the
bench is not part of the build: no slot changes, no item is equipped, and
the character's numbers do not move. `pob_equip_staged` is the one that
moves them, and it is the only tool here that changes the build itself: the
bench item joins the build's item list and goes into a slot.

On an engine this server started, all four are harmless. On an engine it
merely attached to, somebody may have a window on that build, so
`pob_open_build`, `pob_stage_item` and `pob_equip_staged` refuse until
called again with `confirm: true`.

`pob_craft_apply` asks only when there is work to lose: an item this server
staged is its own to change, and an empty bench holds nobody's craft, so the
guard fires for an item that was already on the bench of an engine the
server attached to. That is a heuristic rather than a fact, and it says so:
the app could have put something else on the bench between two calls and
nothing here would know.

Nothing saves. The bridge's `saveBuild`, `saveBuildAs` and `deleteBuild`
are not exposed and neither is anything else that touches the user's files,
so every change here lives in the engine's memory: closing without saving
undoes it, and so does opening the build again.

## Checking it

`probe.mjs` drives the server the way a real client does, over stdio with
the actual protocol, and prints each answer's size and a capped excerpt so a
large one does not have to be read in full:

```bash
node probe.mjs dist/index.js '[{"name":"pob_build","args":{"filter":"resist"}}]'
```

`CAP=2000` raises the excerpt limit. The server's own diagnostics, and
PoB's boot output, go to stderr; stdout belongs to the protocol and a single
stray line on it corrupts the session.

## Known gaps

- **Windows only**, in the same way the rest of the repository is: the
  engine host is `lovec.exe` and `bridge/fs.lua` is bound to the Win32
  filesystem calls.
- `probe.mjs` prints a libuv assertion from `async.c` as it exits. The
  server is not what aborts: run it on its own and close its stdin and it
  leaves cleanly. It is the SDK transport's `client.close()` in the harness,
  and it comes after every answer has been printed, so it costs nothing but
  a moment's alarm.
