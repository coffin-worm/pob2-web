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

Fourteen, over the bridge's forty-five routes. The grouping is the point: the
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
| `pob_stage_item` | Put an item on the bench |

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

Two things are only reachable through the bench. PoB gives affix rows to a
magic or rare built in its own craft dialog and to nothing else, so
`pob_stage_item` can make a blank item from a base; anything copied out of
the game carries its modifiers as text instead. Catalysts are the same: the
control PoB hides for a pasted item is the one the pricing reads, so the
thirteen can only be priced on something built on the bench.

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
- The affix list leaves out the tier ids. They are what PoB's own dropdown
  is keyed by, and nothing here can put one in a slot, so eight of them per
  modifier would cost context and buy nothing. The corruption list does
  print its ids, because those are what prices a draft.

Measured on a level 73 build: the whole build summary with its stat sheet is
1.2 kB, the allocated tree 0.8 kB, the configuration 1.9 kB, and a what-if
two to five hundred bytes. All thirteen catalysts, priced together, are
0.4 kB; the bench item is 0.2 to 0.5 kB and the same item priced against
every slot it fits about 0.6 kB.

## Writing

Two tools change anything, and neither writes to disk.

`pob_open_build` replaces what the engine has open. `pob_stage_item`
replaces what is on the bench, and the bench is not part of the build: no
slot changes and no item is equipped.

On an engine this server started, both are harmless. On an engine it merely
attached to, somebody may have a window on that build or an item part way
through a craft, so each refuses until called again with `confirm: true`.

The bridge's roughly sixty write commands are otherwise not exposed, which
includes everything that touches the user's files.

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

- **Nothing applies a craft.** Everything about the bench can be read and
  priced; the twelve commands that change the item on it are not exposed, so
  an affix cannot be put in a row, a rune in a socket, or a corruption on
  the item. That is the read-and-price posture holding, and it is also the
  obvious next thing: pricing a craft nobody can then make is half an
  answer.
- **No comparison.** `/compare` holds the build against a saved comparison,
  stat by stat, which is exactly the shape a model wants and is not wired up.
- **No notes.** `/notes` is readable and is not exposed.
- **Windows only**, in the same way the rest of the repository is: the
  engine host is `lovec.exe` and `bridge/fs.lua` is bound to the Win32
  filesystem calls.
- The stat-sort item search is resumable by design and this does not resume
  it. Asking again with the same arguments carries the scan on, but the
  server will not do that by itself, so a first answer is ranked among what
  had been measured when it was asked.
