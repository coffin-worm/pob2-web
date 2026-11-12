# The bridge

PoB's calculation engine, serving JSON over loopback HTTP.

`src/` is Path of Building, unmodified. This directory hosts it headless and
answers questions about whatever build it has open. The web UI in `web/` is
one client; the launcher in `launcher/` embeds another; `mcp/` is a third.
Anything that can make an HTTP request is a fourth.

The rule the whole thing is built on: read what PoB computed, and write by
calling PoB's own callbacks. No calculation is reimplemented here, and
nothing in `src/` is modified to make room for it.

## Starting it

The dev server does this for you (`npm run dev` in `web/`, which spawns the
engine and proxies it under its own origin). By hand:

```bash
cd src && "C:/Program Files/LOVE/lovec.exe" ../bridge
```

The working directory has to be `src/`, because `HeadlessWrapper.lua`
resolves its own `dofile`s against it. LOVE is here only because `lovec.exe`
is a LuaJIT 2.1 host that is already installed and already proven to load
PoB's native DLLs; nothing in `api.lua` or `server.lua` knows it exists.

Four environment variables override the defaults, which otherwise follow the
checkout: `POB_SRC`, `POB_RUNTIME`, `POB_BRIDGE_DIR` and `POB_BRIDGE_PORT`.

A fifth is not a default at all. `POB_BRIDGE_OWNER` names a process id,
and the engine exits when that process does.

## Finding it

Without `POB_BRIDGE_PORT` the engine takes the first free port of 49090,
49091 and 49092. A caller that names a port gets that one or nothing, since
quietly moving would strand whoever is waiting.

Either way it writes where it ended up to `%TEMP%/pob2-bridge.json`:

```json
{"port":62149,"root":"C:/personal/pob2-web/","started":1794270238}
```

Last writer wins. Two engines can run at once, and the one started most
recently is the one whose build somebody is looking at. Health-check the
port before trusting the file: a process killed outright never gets to clean
up after itself, so a stale file is normal.

The listener is bound to `127.0.0.1` explicitly. It serves a live engine
with filesystem access and has no authentication of any kind, which is why
it is loopback-only and why `Access-Control-Allow-Origin` can safely be
`*`.

## Dying with its host

A host that starts the engine owns it, and every host already ends it. The
dev server and the MCP server kill it from their exit handlers, and the
launcher puts it in a Windows job object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.

The interesting case is a host killed outright with `taskkill /f`, which
runs no handler at all. That turns out to be covered as well, and not by
anything in this repository: node puts every child it spawns into a job
object of its own that kills on close, so a force-killed dev server or MCP
server takes its engine with it about a second later. Measured three ways,
with the engine writing to a pipe, writing to a file, and with the watchdog
below switched off, it died every time. The orphan this was written to
prevent does not happen today.

It is kept because for two hosts out of three that guarantee is an
implementation detail of libuv rather than a promise libuv makes, and
because it is cheap. `POB_BRIDGE_OWNER` is a process id, and the frame loop
asks every two seconds whether that process has exited, through a handle
opened once at startup and kept. Keeping the handle is what makes watching
a pid safe: Windows holds a process object open while anyone has a handle
to it, so the handle goes on naming the process it was opened for even
after that process dies, and a recycled pid can never be mistaken for a
live owner.

When the watchdog is what ends the engine, the engine quits the way it
would on any quit and takes its announcement back, which was measured with
an owner that was no relation to the engine at all. When the kernel gets
there first, which is usually, the port file is left behind for the next
run to health-check, which is what already happened to any engine killed
outright.

Only a spawning host sets it. The launcher does not, because its job object
is kernel-enforced and needs no help, and nothing sets it for an engine
started by hand, which answers for as long as it is left alone.
## Conventions

**Every answer is a whole snapshot, not a diff.** One command can move
several things at once: changing class reloads the ascendancy list, and a
recalculation can move the character level and all four point budgets. A
client that patched fields individually would be guessing at which moved.

**`ready: false` means no build, not an error.** Most routes answer
`{ "ready": false }` when nothing is open. Errors are an HTTP status with
`{ "error": "..." }`, and the body is JSON on both paths.

**Tooltip routes answer in lines, with a block number.** `/item`,
`/item/staged`, `/gem` and `/skills/group` return PoB's own tooltip as
`{ text, tone, block, separator }`. Block 1 is the subject; block 2 is the
"Equipping this item will..." comparison underneath it. `tone` is PoB's
inline colour code classified into a name, so a client can apply its own
palette instead of inheriting PoB's.

**The what-if routes answer in the same shape, all in block 1.** There is no
subject to describe, only a difference. `unchanged: true` is the engine's own
verdict that the change moves nothing, which is worth saying out loud since
it is otherwise indistinguishable from an empty answer.

**`outputRevision` only ever goes up, and it is this bridge's count, not
PoB's.** It is the number a client refetches on: when it moves, what the
engine would answer has changed. PoB's own `outputRevision` counts
recalculations within one build and `buildMode:Init` sets it back to 1
(`Build.lua:641`), so opening a build lowers it, and opening one in an
engine that has not recalculated since it booted leaves 1 at 1. A client
watching for a change would see none and go on showing the build before it.
So the build's name and file are part of what is counted here.

**`buildMs` is the engine's own cost** for the routes that recalculate, so a
client can tell an expensive question from a slow one.

**Everything the build reports is about its main skill.** The stat sheet,
every what-if, and the Calcs tab all answer for one skill, so a passive that
helps a different one moves nothing and says nothing about why.
`/skills/stats` is the way round that: `mainSocketGroup` is an argument to
the misc calculator, the same way `repItem` is, so the engine answers for
another skill without the build being moved to it and back. The index within
a group has no such argument, so that one field is set and restored around
the call.

## Reading

| Route | Takes | Answers |
| --- | --- | --- |
| `GET /health` | | Whether PoB booted, the frame count, and the command list |
| `GET /state` | | The build: name, class, ascendancy, level, point budgets |
| `GET /stats` | | The stat sidebar, about an order of magnitude more data |
| `GET /calcs` | | The Calculations tab, a few hundred rows with cell references |
| `GET /calcs/breakdown` | `ref` | The engine's working behind one cell |
| `GET /tree` | | The tree's geometry, ~420 kB. Fetch once; it does not change |
| `GET /tree/alloc` | | What is allocated, which weapon set paid for it, and what is reachable with path costs |
| `GET /tree/path` | `node` | The route a click on one node would allocate |
| `GET /items` | | Slots, the item list and the item sets |
| `GET /item` | `id`, `slot?` | One item's tooltip, with a slot comparison if asked |
| `GET /item/edit` | `id` | What is editable: text, modifier rolls, variant |
| `GET /item/staged` | | The bench item, against every slot it fits |
| `GET /items/search` | `q`, `mode`, `db`, `slot`, `type`, `league`, `req`, `source`, `sort`, `limit?` | The unique and rare databases on PoB's eight filter axes |
| `GET /items/filters` | | What each of those axes offers |
| `GET /skills` | `group?` | Socket groups, and the gems in one of them |
| `GET /skills/group` | `index` | What a socket group does |
| `GET /skills/stats` | `group`, `skill?` | One skill's own stat sheet, without making it the main one |
| `GET /gem` | `group`, `gem` | One gem at its current level and quality |
| `GET /gems/search` | `q` | Every gem in the game, by name |
| `GET /config` | | The Configuration tab: only the options this build uses |
| `GET /notes` | | The build's notes, with the palette to colour them |
| `GET /compare` | | The build against the active comparison, stat by stat |
| `GET /builds` | `sort?` | The builds folder, as PoB's own scanner sees it |
| `GET /code` | | The build as a code, exactly as the desktop app exports it |
| `GET /code/inspect` | `code` | What a code contains, without importing it |
| `GET /paths` | | Where PoB is keeping builds and settings |

## Pricing a change, without making it

These are the reason the bridge is more than a view. Each one runs a full
recalculation with the change applied and reports the difference, leaving the
build exactly as it was. It is the same mechanism the desktop app uses when
you hover something.

| Route | Takes | Prices |
| --- | --- | --- |
| `GET /tree/whatif` | `node` | A passive: the node alone, and the whole route to it with a per-point column |
| `GET /items/whatif` | `slot` | A flask or charm being switched on, or off |
| `GET /gem/whatif` | `group`, `gem`, `subject`, `level?` | A gem disabled, taken to 20 quality, or taken to another level |
| `GET /skills/whatif` | `group` | A whole socket group switched |
| `GET /config/whatif` | `var`, `value?` | One configuration option changed |
| `GET /craft/anoint/whatif` | `slot`, `node?` | One anoint on the bench item |
| `GET /craft/corrupt/preview` | `mode`, `source?`, `implicits?`, `ranges?` | A whole corruption draft, priced together |
| `GET /craft/catalysts` | `quality?` | All thirteen catalysts at once, at one quality |

The last two take a draft rather than a single choice, because two implicits
chosen together have to be priced together. PoB itself can only price one at
a time against the uncorrupted item.

## Crafting

| Route | Takes | Answers |
| --- | --- | --- |
| `GET /item/craft` | | The bench item's affix rows and what is in them |
| `GET /craft/affixes` | `kind`, `index`, `q?` | Everything one affix row could hold |
| `GET /craft/bases` | `type?` | The bases an item can be crafted on |
| `GET /craft/runes` | `q?` | The runes and soul cores its sockets accept |
| `GET /craft/anoints` | `mode`, `q?` | The notables it could be anointed with, of 875 |
| `GET /craft/corruptions` | `source?`, `q?` | The implicits it could take, and its roll ranges |

Crafting in PoB always happens on the bench, never on an item already in a
slot. Nothing puts an equipped item there: the bench is `displayItem`, and
the commands that fill it are `stageItemText`, `stageDbItem` and
`craftItem`. To work on something already worn, read it back as text with
`GET /item/edit` and stage a copy.

Two of these routes answer about a narrower item than the name suggests.
`/craft/affixes` needs an item PoB itself built, because only a magic or
rare made in the craft dialog has affix rows; anything copied out of the
game carries its modifiers as text. `/craft/catalysts` reads the control
PoB shows for a ring, an amulet or a jewel whose modifiers carry catalyst
tags, or one built on the bench, and answers that a catalyst does not apply
otherwise.

Seven commands change the item on the bench, through `POST /action` like
any other: `setCraftAffix`, `setRune`, `setSocketCount`, `setAnoint`,
`corruptItem`, `setCraftQuality` and `setCatalyst`. None of them touches
the build, because the bench is not part of it. `equipStagedItem` is the
one that does.

## Writing

```
POST /action        {"action": "setCharacterLevel", "value": 90}
POST /build/new     {}
POST /build/open    {"path": "...xml"}
POST /code/import   {"code": "eNrtPWt3..."}
POST /code/character {"json": "..."}
POST /engine/dismiss {}
```

`GET /health` lists every action `POST /action` will accept, which is the
authoritative list; there are around sixty. They are commands rather than
setters, deliberately: the engine owns the state and answers with a new
snapshot. Setting a field is not the same as the field having changed.

Writes that touch the user's files are in that list too (`saveBuild`,
`saveBuildAs`, `deleteBuild`), so a client meant to be read-only should pick
what it exposes rather than passing actions through.

## Importing a character

`importCharacter` takes `{ json, tree, items }` plus PoB's four import
checkboxes (`deleteJewels`, `deleteSkills`, `deleteEquipment`,
`ignoreWeaponSwap`) and imports into the build that is already open, which
is what the desktop's two buttons do. `POST /code/character` is the older
route and goes through HeadlessWrapper's `loadBuildFromJSON`, which opens a
new build first; use that for a pasted blob and the command for the import
panel.

It validates the payload before touching anything, which PoB does not.
`ImportItemsAndSkills` deletes the equipment and the skill groups and only
then reads `charData.equipment`, so a payload missing that key leaves a
gutted build behind a Lua error.

**Both paths then correct PoB's resistance penalty, which is a bug
upstream.** `EstimatePlayerProgress` records its answer as a string in
`build.Act`, either `"Endgame"` or `"Act 5"` (`Build.lua:1124`, the only
assignment). The import reads it back expecting a *number* for the act case
(`ImportTab.lua:992-1000`): one branch handles the string `"Endgame"`, the
other handles `type(Act) == "number"`, and `"Act 5"` is neither, so the
index never moves off the 7 it was initialised with. Every character import
therefore lands on Endgame, taking 60% off every elemental resistance. On a
character partway through the campaign that reads as the whole calculation
being wrong rather than as one dropdown being wrong.

`estimateResistancePenalty` applies the same correction on its own, for a
build imported before this existed. `GET /state` carries `act`, so a client
can show the estimate and notice when the two disagree.

A fixture character is imported through this command in `web/tests/`, at both
layers, and asserts the penalty matches the act. Taking the correction back
out fails those tests on the number the bug produces.

## The files

| File | What it is |
| --- | --- |
| `main.lua` | The host: boots PoB headless, runs its frame loop, routes requests. The throwaway one, specific to LOVE. |
| `api.lua` | Every answer and every command. Knows nothing about HTTP or LOVE. |
| `server.lua` | A non-blocking HTTP/1.1 server, enough of one for this. |
| `fs.lua` | The filesystem the headless engine does not have, so the build list can be scanned. |
| `zlib.lua` | Real Deflate and Inflate over the headless stubs, so build codes work. |
| `conf.lua` | LOVE's own configuration: no window, no modules it does not need. |

`api.lua` and `server.lua` have no idea LOVE exists, so a different host
replaces `main.lua` and keeps the rest.
