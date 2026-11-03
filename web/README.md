# PoB web UI — header prototype

A prototype of Path of Building's UI as a web app, intended to run in
WebView2 against the existing Lua calc engine. Three screens so far: the top
bar, the stat sidebar and the Calcs tab, all driven by the real engine.

```bash
npm install
npm run dev
```

## Why this might be worth doing

The Lua UI's ceiling is not its renderer — SimpleGraphic draws textured
quads with alpha, three blend modes and clipping, which is enough for most
flat UI. The ceiling is that every pixel is hand-placed immediate-mode draw
code with a bitmap font, so each improvement costs what it costs and none of
it compounds.

Three numbers argued for trying this:

| | |
|---|---|
| UI code that would be rebuilt | ~34,700 lines |
| Calc engine and model kept | ~24,800 lines |
| Game data kept | ~341,900 lines |

And the fork stays mergeable. Over six months of upstream commits, file
touches landed in `Data` (880), `TreeData` (448), `Export` (123), `Classes`
(79) and `Modules` (31) — roughly 94% in the game data you would keep taking
unchanged. The UI barely moves upstream, so owning it costs little.

`src/HeadlessWrapper.lua` already runs the whole application with the
renderer stubbed out; it is how the 912-test spec suite drives real builds.
The engine does not need a window.

## Stack

| Choice | Why |
|---|---|
| Vite + React + TypeScript | The Calcs tab is thousands of dense rows; TanStack Table/Virtual is the strongest answer to that anywhere |
| Radix primitives, unstyled | PoB is mostly dropdowns, popups and sliders. Radix brings type-ahead, roving focus, focus traps and ARIA — none of which the Lua UI has — and styles nothing |
| Plain CSS + custom properties | The design system is the point. Tailwind would scatter it across utility strings; `src/styles/tokens.css` keeps every decision in one file |
| Zustand | Recalculation output streams in. Selector subscriptions stop that re-rendering the world |
| Inter (OFL) | Designed for UI at 12–16px, which is the whole range this app lives in |

Later: TanStack Table/Virtual for Calcs, Tauri for the WebView2 shell (a few
MB using the system WebView2, against Electron's ~150).

## Running it

Two processes. The engine first, from `src/` — `HeadlessWrapper.lua`
resolves its own `dofile`s relative to the working directory:

```bash
cd C:/dev/pob2/src
"C:/Program Files/LOVE/lovec.exe" C:/dev/pob2/bridge
```

Then the UI:

```bash
cd C:/dev/pob2/web
npm install && npm run dev
```

The page says whether the engine is reachable, and `VITE_POB_BRIDGE`
overrides the default `http://127.0.0.1:49090`.

## What is and isn't real

All of it. The header runs against PoB's own Lua: the class list is the
eight classes in the tree data, the ascendancies are reloaded by the engine
when the class changes, the budgets are what `pointDisplay` computed on its
last frame, and the unsaved dot is `buildMode.unsaved`.

`mockStore.ts` is gone. Keeping it would have been worse than useless,
because comparing it against the engine showed it had been wrong in ways
nobody would have noticed by looking:

| The mock said | The engine says |
|---|---|
| 6 classes, ids 0–5 | 8 classes, ids 1–11 — no Druid or Huntress in the mock |
| Witch has 3 ascendancies | 4, plus None — the mock never had Abyssal Lich |
| Passive max is `level - 1 + 24` | `99 + quest points` — **it does not depend on level** |

That last one is the one worth remembering. The prototype demonstrated the
passive budget moving as you typed a level, and that was an invention of the
mock; in PoE 2 the maximum is the full endgame budget and only the *used*
side moves. A plausible lie is the failure mode of building against a mock,
and it survived a careful read of my own code.

The contract is `src/pob/types.ts`. Field names were taken from the Lua side
rather than invented — `buildName`, `unsaved`, `characterLevel`,
`levelAutoMode`, `classId`, `ascendClassId` are all fields on the
`buildMode` table in `src/Modules/Build.lua` — and that paid off: wiring the
bridge needed no renaming on either side.

## The sidebar, and what a second screen cost

The stat sidebar was the second screen, chosen because it is dense
structured output rather than another row of controls. It came to about 250
lines: one store, one component, one stylesheet, and `api.stats` in Lua.

It cost that little because of one decision. `RefreshStatList` has already
done the filtering — which stats apply to *this* skill, via per-stat `flag`
and `condFunc` entries in `BuildDisplayStats.lua` — and the number
formatting. Both are game rules. So `api.stats` reads
`controls.statBox.list` and only classifies what it finds: two columns is a
stat, one centred column is a note on the line above, and the row height is
PoB's own emphasis.

The payoff is visible when you switch skills. Going from Entangle to
Bonestorm on the same build, Hit DPS moves 189.5 → 241.4, and the *set of
stats changes*: Channel Time and Hit Rate appear, AoE Radius disappears.
Nothing in the web code knows what a channelled skill is. Had the filtering
been reimplemented here, that would have been a feature to build and then a
rule to keep in step with the game forever.

What the UI does own is the part PoB's bitmap renderer could not: tabular
figures that do not shuffle while a number recalculates, a label column
quiet enough to scan, and a palette of its own. PoB's colour codes are
classified into names (`fire`, `warning`, `positive`, `source`) by the
bridge, so the meaning survives while the 2010-era hex does not.

## The Calcs tab, and a prediction that was wrong

This file used to say the Calcs tab "was the original argument for this
stack" and would need virtualisation. It measured out otherwise, and the
measurement is the only reason to know:

| | |
|---|---|
| Rows defined in `CalcSections.lua` | 1081 |
| Rows the selected skill actually shows | **210** |
| Payload | 13 kB |
| Engine time to build it | **2–3 ms** |

210 rows is not a virtualisation problem, and neither is the 1081-row
ceiling. TanStack Virtual would have been a dependency bought on a guess.
It is still the right answer if a screen ever needs it; this one does not,
and saying so is worth more than having been right.

What the Calcs tab *does* have that the sidebar did not is **shape**. Most
sections are label/value pairs, but the damage sections are matrices —
damage types across, modifiers down — and PoB asks for three of its columns
for those and one for everything else. That is carried through: wide
sections get a grid of their own above the board, narrow ones flow in a
multi-column layout.

One bug of mine, and a good illustration of why reading PoB's structures
beats interpreting them. Its rows carry empty column placeholders:

```lua
{ label = "Added Min",
    { },                        -- no "All Types" figure for this row
    { format = "{0:mod:1,2}",   -- Physical
```

`UpdateSize` gives every slot an x offset whether or not it has a format,
so the empties hold the column open. I was skipping them, which shifted
every value one column left and silently misaligned the matrix against its
own header — five values under six headings, each one plausible. Empty
slots are now kept as empty strings.

The Calcs tab also has **its own skill selector**, which is not the
sidebar's. PoB keeps `input.skill_number` separate from
`build.mainSocketGroup` deliberately: the sidebar always reports Effective
DPS for the main skill, while this tab details whichever skill you point it
at. With Entangle as the main skill and Bonestorm selected here, the
sidebar reads 189.5 DPS and the Calcs tab reads 241.4, and both are right.

Because it is the expensive route, it is not polled. `buildMode.outputRevision`
moves on every recalculation, and the app refetches on that.

## The bridge

I had this wrong. The earlier note here said there is no standalone LuaJIT
because it is embedded in `SimpleGraphic.dll`. In fact `runtime/lua51.dll`
**is** LuaJIT 2.1, x64, shipped as its own file, and every native module —
`socket`, `lua-utf8`, `lzip`, `lcurl`, and `SimpleGraphic.dll` itself —
imports it by name. The VM was never locked inside the renderer. What is
missing from a PoB install is only an interpreter *executable*, which is the
small part.

So no binary had to be shipped and no container was needed. `lovec.exe`, the
console build of LÖVE, is already installed, is LuaJIT 2.1, and was already
proven by `love-host/` to load PoB's DLLs. It runs windowless with its own
`love.run`, and PoB never touches a GPU because
`src/_SimpleGraphic.def.lua` stubs every draw call.

`bridge/` is four files, and the split matters:

| | |
|---|---|
| `api.lua` | The build as plain values, and the commands. **Host-agnostic** |
| `server.lua` | Non-blocking HTTP over LuaSocket. **Host-agnostic** |
| `main.lua` | Paths, boot, tick. The throwaway part |
| `conf.lua` | Headless LÖVE config. Also throwaway |

Only the bottom two know LÖVE exists, so the shipping host — the existing
exe, or Tauri with mlua — replaces them and keeps the rest.

The rule in `api.lua` is that it reads what PoB computed and writes by
calling the control callbacks PoB already has: `classDrop.selFunc`,
`characterLevel.changeFunc`, `treeTab:SetActiveSpec`. Setting the fields
directly would skip the tree rebuild and the recalculation flags, and would
make this a second source of truth.

JSON over HTTP with a 1s poll, not a WebSocket. The handshake is available
(`sha1/` and `base64.lua` both ship in `runtime/lua/`) but the state is
small and request/response has obvious failure modes. Every call answers
with a whole snapshot rather than a diff, because one command moves several
things at once.

### Two things the engine does that a bridge has to respect

**PoB answers some commands with a dialog.** Changing class with an
allocated tree, Save As, Back with unsaved work — all open a modal instead
of doing the thing. Over a bridge that is invisible, so the open popup
travels with the state and the UI says what is being waited on rather than
looking hung.

**LÖVE's game-directory argument is read as a build URL.**
`Modules/Main.lua:64` treats `arg[1]` as something to download, so PoB tried
to fetch `C:/dev/pob2/bridge` from a build site, named the build after the
failure message, and skipped creating its own initial build. `main.lua`
blanks `arg` before boot.

**PoB records errors instead of crashing**, and that is the one that cost
real time. Loading a test build produced a sidebar with zero stats and no
other symptom: the process was alive, `/state` answered, the build reported
as open, and every number was zero. PoB had caught an error inside its own
frame handler and set `promptMsg`, where nothing was looking.

The error itself was a latent bug in PoB, not in the bridge:

```
Modules/Build.lua:345: bad argument #1 to 'remove' (string expected, got boolean)
```

A build named `~~temp~~` has its file deleted on load, but on the headless
path `dbFileName` is `false`, so `os.remove` gets a boolean. My test file
happened to be the one filename that triggers it. `/build/open` now renames
that case, but the fix that matters is that `promptMsg` travels with the
state, so a build whose calculations have died says so instead of looking
merely empty.

## Known gaps

- **Two screens of perhaps a dozen.** The passive tree, items, skills and
  the calculation breakdown are all unbuilt, and the tree is the one that
  will not resemble either of these — a canvas with 1500 nodes, not a list.
- **Nothing is virtualised, and on this evidence nothing needs to be.** See
  below — this was the opposite of what this file predicted.
- **Dialogs are not drawn.** The UI reports that the engine is waiting on
  one and can dismiss it, but cannot answer it — so a class change that
  would reset an allocated tree currently cannot be confirmed from here.
- **No build list.** Builds are opened by absolute path through
  `POST /build/open`; `GetUserPath` is stubbed headless, so `/paths` reports
  nothing useful and there is no directory listing.
- **Rename is in-memory.** `setBuildName` marks the build dirty; it does not
  rename the file, because in PoB the name *is* the file name and renaming
  happens inside Save As.
- **Loadouts are tree specs.** `buildMode.loadoutsList` — the sets linked
  with `{name}` markers — is a richer thing that only exists after
  `SyncLoadouts`, and is not surfaced yet.
- **Two processes, started by hand**, and the dev host is a game engine.
  Fine for a dev loop, not a product.
- The header needs about 1350px. Past that the loadout picker is dropped;
  below roughly 1150px it will scroll rather than hide anything that
  reports build state.
- No light theme. This is a dark application beside a dark game, and a real
  light theme is work, not a media query.
- Keyboard shortcuts, drag and drop, and the tooltip system are untouched.
