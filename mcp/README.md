# The MCP server

Lets an AI client read a Path of Building 2 build, price changes to it and
make them, through the real calculation engine.

The interesting half is not the reading. It is that a model can ask "what
would this passive be worth" and get PoB's own answer: a full recalculation
with the change applied, reported as a difference, with the build left
exactly as it was. That is the same mechanism the desktop app uses when you
hover a node, and it is the difference between a model reasoning about
modifier text and a model reading a number the engine computed.

From there it can build rather than only judge: `pob_tree_edit` spends and
refunds points, `pob_skill_edit` changes the gems, and `pob_new_build` and
`pob_save_build` start a variant and hand it back as a file somebody can
open. The same mechanism is what makes that worth doing, because an edit
answers with what moved on the stat sheet rather than with "done".

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
announcement in the port file is taken back at the same time. That covers
every exit a handler can see: a client closing stdin, a signal, an uncaught
failure.

A client that kills the server outright runs no handler, and the engine
still goes about a second later, because node puts every child it spawns
into a job object that kills on close. The engine is handed this process id
as well and watches it, which is a belt to that kernel-enforced braces
rather than the thing doing the work. `bridge/README.md` has the
measurements, under "Dying with its host".

An engine the server merely attached to is left alone whichever way the
server goes, because it belongs to whoever started it.

An engine can also go while the server stays: somebody closes the app, the
dev server restarts, the engine follows the host that started it. The next
call then finds nothing listening on the port it had, and the server used
to keep that dead port for the rest of its life, which turned one restart
into every later call failing on an address that had stopped meaning
anything. A refused connection now makes it forget the engine, look again
the same way it looked the first time, and ask once more.

Everything cached goes at the same time, because all of it belonged to that
engine: the passive tree it was read from, and the claim on the crafting
bench, which is about an item in a process that no longer exists.

The answer from the new engine says so, once, naming the engine that went:

```
Note: the engine changed. http://127.0.0.1:50221 stopped answering, and
this is a different engine on http://127.0.0.1:50240. Anything staged on
the crafting bench, or equipped but not saved, belonged to the engine that
has gone. Check the build before relying on what an earlier answer said
about it.
```

Reconnecting quietly would be the worse half of a good idea. The answer
would look like the next in a series and is actually the first about a
different process, where the bench is empty and an earlier equip never
happened. It is said by wrapping the two helpers that build every answer,
rather than at the forty-odd places that call them, because a notice which
matters only after a reconnect is exactly the kind a new tool would forget
to carry, and the one time it is needed is the time nobody is looking for
it. Said once, too: it describes a transition, and repeating it on every
answer afterwards is how a warning stops being read.

One retry, and a `POST` is retried only when the connection was refused.
Refused means nothing was received, so sending it again cannot repeat
anything. A connection that dies mid-request may have been acted on
already, and this is the transport for `POST /action`, so a blind retry
there could equip an item twice; that case reports what it does not know
instead.

## Which build is answering

Every `pob_build` answer ends with a line saying when this server was built
and what the checkout has done since:

```
Server built 2026-11-12 05:58, after the checkout's latest commit 02c625065.
```

or, when the code on disk has moved on:

```
Server built 2026-11-10 05:58, but the checkout is at 02c625065 from
2026-11-12 05:47. This server cannot contain that work, so a tool missing
or refusing an argument is the likely reason: rebuild `mcp/` and restart
the client.
```

This exists because the failure it describes is invisible from the inside.
A client holds the tool list it was handed at `initialize`, and a server
built before the work being asked about behaves perfectly: it just behaves
like an older version, so a fix that landed an hour ago looks like a fix
that did not work. One chat session reported three bugs that had all been
fixed before it wrote the report, and had no way to tell.

A notification would not have helped. Nothing changes inside a process, so
there is nothing to notify about, and a rebuilt server is a different
process whose handshake a client may or may not apply to a conversation
already open. What was missing was never a message, it was a fact.

Both halves are read at runtime: the newest timestamp among the built files,
and `git log -1` in the checkout. That keeps the build a plain `tsc` with no
generated file to commit or ignore, at the price of comparing a file
timestamp against a commit date rather than a commit against a commit. So it
answers "probably stale" rather than "stale", with a minute of slack, which
is the honest shape of what can be known from inside the process. A rebuild
moves the first half past the second.

Without git, or outside a repository, the line says when the server was
built and draws no comparison.

## The tools

Twenty-nine, over the bridge's forty-seven routes. The grouping is the point:
the engine exposes a route per control, and a model handed forty tools spends
its context on the schema list and still picks the wrong one. So these are
grouped by the question somebody actually has, and the routes that differ
only in which control they drive are folded into one tool with a
discriminator.

| Tool | Answers |
| --- | --- |
| `pob_build` | The open build and its whole stat sheet. The place to start. |
| `pob_tree` | What is allocated on the passive tree, or one node in full |
| `pob_items` | What is equipped, or one item's modifiers and what it is worth |
| `pob_skills` | The socket groups, the gems in one, or one skill's own stats |
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
| `pob_notes_write` | Write or add to those notes |
| `pob_import_character` | Import a live character's tree, items and skills |
| `pob_set_main_skill` | Point the build at a different skill |
| `pob_best_points` | Rank the tree by what a point buys |
| `pob_tree_edit` | Allocate and refund passive points |
| `pob_skill_edit` | Add, remove and change gems and socket groups |
| `pob_config_set` | Change what the numbers assume, by option or by preset |
| `pob_weapon_set` | Hold weapon set I or weapon set II |
| `pob_new_build` | Start an empty build on a class and ascendancy |
| `pob_save_build` | Write the open build to a file, under a new name |

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

A staged item says what the engine could not read in it. PoB marks such a
line "Not supported in PoB yet" inside the tooltip, among twenty others;
what it does not say is the consequence, so `pob_stage_item` gathers them
above the slot comparisons and says it: nothing below counts them. Above,
because every number underneath is computed from an item missing those
lines, and read in the other order they are read wrong.

Text that prints rune modifiers without naming the rune gets a line of its
own. PoB usually works the rune out from the modifiers it recognises, so
this is for the case where it cannot. The mechanism is in
`bridge/README.md`, under the crafting routes.

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

## One skill at a time

Everything a build reports is about its main skill. The stat sheet, every
what-if and the whole Calcs tab answer for that one skill, which is easy to
forget and expensive to forget: a passive that helps a different skill
prices as worth nothing, and the answer looks like a verdict on the passive.

So `pob_skills` with `stats=true` gives one skill's own sheet without
touching the build, and a what-if that moves nothing says which skill it was
about rather than only "nothing changes". Some groups grant more than one
skill, so `skill` picks which: on a group granting Ice-Tipped Arrows and Ice
Fragments, the first has a mana cost and no damage and the second has the
damage.

`pob_set_main_skill` is the other half, for when the main skill really is
wrong rather than when something needs looking up. It is a write, and
guarded like the others.

Which weapon set each group is on is now on every line of `pob_skills`,
because it is invisible everywhere else and wrong often enough to matter. A
group tied to neither set follows whichever set is active, which is what a
mark wants and rarely what anything else does, so the ones that are not
marks are listed again at the end.

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
- A stat filter hides stats, never warnings. Asking about "mana" should not
  also hide the engine saying a skill cannot be used, so warning-toned
  lines come through under a heading that says they are not matches.
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

Twelve tools change something, and one of them writes to disk.

`pob_open_build` replaces what the engine has open, and `pob_new_build`
replaces it with an empty one. `pob_stage_item` replaces what is on the
bench and `pob_craft_apply` changes it, and the bench is not part of the
build: no slot changes, no item is equipped, and the character's numbers do
not move. `pob_equip_staged`, `pob_tree_edit`, `pob_skill_edit`,
`pob_config_set`, `pob_weapon_set` and `pob_set_main_skill` change the
build itself, so every number moves, and `pob_compare_load` changes what
the build is being compared against.

`pob_save_build` is the one that writes a file. It saves under a name you
give it, refuses a name already taken rather than overwriting, and replaces
an existing build only when `overwrite` says to. The bridge's `saveBuild`
and `deleteBuild` are still not exposed, so there is no way from here to
save over the file a build was opened from without naming it, and no way to
delete a build at all.

On an engine this server started, all of them are harmless. On an engine it
merely attached to, somebody may have a window on that build, so every one
of them refuses until called again with `confirm: true`.

### Opening something else does not save what you were on

It used to. PoB saves the open build on its way out whenever it is running
in dev mode, which the bridge engine always is: to its own file if it has
one, and to `~~temp~~.xml` if it does not (`Build.lua:1152`). So opening a
second build wrote the first one back to disk, and reopening a build to undo
an experiment was the way to keep it. The three routes that replace a build
are now asked to discard it, with PoB's own `abortSave` flag, so the undo
these tools promise is real. Measured: a build edited, reopened, edited
again and then replaced by a new one leaves its file byte for byte as it
was, and writes no `~~temp~~.xml`.

### Where the next points go

`pob_best_points` ranks the whole tree by what each node is worth, which
is the app's own Power Report rather than anything reasoned about here.
Two numbers per node: what it is worth on its own, and what the whole
route to it is worth per point. The second is the default order, because
it is the one that answers the question actually being asked. Together
with `pob_tree_edit` that closes a loop in two calls, rank and take, and
the ranking is measured again against the build it just changed.

Asked for the points already spent instead, it measures each by taking
it back, which answers the opposite question: a row near zero is a point
doing nothing. Ascendancy nodes are in neither, because they are not
bought with passive points.

The first call measures the tree and takes a few seconds; later calls
read the report it built, until the build moves and makes it a report
about a build that no longer exists.

### Which weapon set is held

`pob_weapon_set` is the Items tab's weapon swap, and it is worth knowing
what that actually decides before reading its answer. The set a build is
calculated in is the main socket group's own, not the swap button
(`CalcSetup.lua:1074`), and the button only gets a say when the main
group is tied to neither set. So a main skill restricted to set I stays
calculated in set I whatever is held, and swapping then moves what the
other set reserves and nothing else. The tool says which of the two
cases it was, because a swap where the weapons changed and the damage
did not is otherwise a mystery.

Which makes "measure this build on the other weapon set"
`pob_set_main_skill`, to a group on that set. Ranking the tree for the
other set is the same thing, since `pob_best_points` measures the build
as it stands.

Weapon set *points* are a different thing again, and the counters read
oddly until you know the rule. Allocate fourteen nodes with
`pob_tree_edit weaponSet=1` and the passive count goes up by fourteen as
well, which looks like the nodes were charged twice. They were not. PoB's
main count is `PointsUsed - min(setI, setII)` (`Build.lua:1092`): the
discount is the *smaller* of the two sets, because a weapon set point buys
one slot allocated differently in each set, and one spent alone has nothing
to pair with. Fill the other set and the main points come back, one for
one. An imported character with 24 and 24 is discounted the full 24, which
is why its set nodes look free and freshly allocated ones do not. The
header says this whenever the two sets are uneven, so the pair of numbers
explains itself.

### Importing a live character

`pob_import_character` takes the character payload pathofexile.com answers
with, inline or as a file, and imports it into the build that is already
open, which is what the desktop's two buttons do. The tree half and the
items half can be asked for separately, PoB's four checkboxes are there, and
the payload is validated before anything is touched, because PoB deletes the
equipment and the skill groups and only then reads it.

**It does not sign in, and it will not.** The account sign-in is OAuth in a
browser, and this server has neither a browser nor anywhere safe to keep a
token: it is a stdio process a client starts and stops. The two places that
do hold a session are the app and the dev server, each keeping the token in
memory only, and either will hand you the JSON. The app's Import tab fetches
it, and a dev server answers `/poe/character?name=NAME` on its own port.
That split is deliberate rather than unfinished: a credential belongs where
somebody can see it being used.

The resistance penalty is corrected on the way in, the same as every other
import path here; `RULINGS.md` says why that is necessary.

### Which half of a skill is being measured

A skill can declare more than one stat set, and PoB calculates the selected
one and no other. Essence Drain is the plain case: `Projectile` is a chaos
spell hit, `Damage over Time` is the debuff that is most of what the skill
does. On a real level 67 Lich the first reads 1,233 DPS and the second
3,386, and before this the second was not reachable, or visible, from here
at all.

So `pob_build` now says which set the sheet is about whenever there is more
than one, names the others, and says how to move; `pob_set_main_skill` takes
`statSet` (and `part`, for PoB's older multi-part skills); and
`pob_best_points` repeats the caution with its ranking, because that is
where it bites hardest. Ranking a chaos damage over time build on its
projectile scores duration, Wither and the damage over time passives at
zero, which reads as a verdict on those nodes rather than as the wrong
question.

The selection lives on the gem instance, as PoB stores it, so it survives a
save and follows the gem rather than the build.

### Which game data the numbers came from

Every answer that carries the header carries the game data version with it:
`Game data: tree 0_5, target 0_1`, from PoB's own `GameVersions.lua`, and
the build's own versions when they differ from the engine's. A calculation
made against last patch's tree is wrong in a way no stat line shows, so the
version travels with the numbers rather than being something to go and ask
for. The server's own staleness line sits beside it, which between them
answer "is any of this current" without a round trip.

### What the numbers assume

`pob_config_set` is the other half of `pob_config`: the tab could be
read and one option could be priced, and now it can be set. A preset
sets several at once under a name, and there are four of them, all about
which enemy is being fought.

They are thin on purpose. Path of Building has no notion of a preset, so
every name here is ours, and it has already done the bundling that
matters: `enemyIsBoss` is a list option whose own code sets the enemy's
resistances, the effect of curses and exposure on it, its poise, its
damage and its level. Writing those out again under a friendlier name
would be a worse copy of a table the engine keeps against the game. So a
preset names the options it writes, the answer says which it wrote, and
pob_config says which preset a build is on, defaults included.

### What an edit answers with

`pob_tree_edit` and `pob_skill_edit` read the stat sheet before the change
and again after it, and report the lines that differ. Not a what-if: the
change has been made, both sheets are the engine's own, and the difference
between them is simply what moved. It is what makes iterating possible in
one call each way, and it reads like this:

```
Gem 5 in group 4 is now Fork.

## What moved
- Average Damage: 5,291.0 -> 4,514.4
- Hit DPS: 3,449.8 -> 2,943.5
- Ignite DPS: 2.7, which the sheet did not report before
- Mana Cost per second: 121.00 -> 133.00
```

Lines are matched by label and by how many of that label have been seen,
because a sheet can carry two rows under one name and matching on the name
alone would report the second as a change to the first. A line that appears
or disappears is said in words, since a stat the sheet stops reporting at
all is a different thing from one that went to zero.

`pob_tree_edit` adds what the allocation itself did, read from the tree
before and after rather than from what was asked for: allocating one node
allocates the route to it, so the answer to what that cost is a list nobody
typed.

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
