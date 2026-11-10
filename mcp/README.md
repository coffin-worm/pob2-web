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

Eleven, over the bridge's forty-five routes. The grouping is the point: the
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

`pob_what_if` takes a `change` of `passive`, `config`, `slot`, `gem` or
`socket_group`, which covers five of the bridge's eight pricing routes. The
three crafting ones are not here yet; see the gaps below.

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

Measured on a level 73 build: the whole build summary with its stat sheet is
1.2 kB, the allocated tree 0.8 kB, the configuration 1.9 kB, and a what-if
two to five hundred bytes.

## Writing

One tool changes anything, `pob_open_build`, and it writes nothing to disk:
it replaces what the engine has open. On an engine this server started that
is harmless. On an engine it merely attached to, somebody may have a window
on that build, so it refuses until called again with `confirm: true`.

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

- **No crafting.** `/craft/*` is thirteen routes and the most interesting
  machinery in the bridge, including pricing all thirteen catalysts at once
  and a whole corruption draft together. It needs its own tool or two, with
  the bench item's state as part of the answer.
- **No comparison.** `/compare` holds the build against a saved comparison,
  stat by stat, which is exactly the shape a model wants and is not wired up.
- **No notes.** `/notes` is readable and is not exposed.
- **No item staging.** `/item/staged` prices a pasted item against every
  slot it fits, in one answer. Exposing it would mean also exposing the
  command that stages the item, which is a write.
- **Windows only**, in the same way the rest of the repository is: the
  engine host is `lovec.exe` and `bridge/fs.lua` is bound to the Win32
  filesystem calls.
- The stat-sort item search is resumable by design and this does not resume
  it. Asking again with the same arguments carries the scan on, but the
  server will not do that by itself, so a first answer is ranked among what
  had been measured when it was asked.
