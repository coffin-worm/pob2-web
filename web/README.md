# PoB web UI — header prototype

A prototype of Path of Building's UI as a web app, intended to run in
WebView2 against the existing Lua calc engine. This is the top bar only.

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

## Known gaps

- **Only the header is wired.** The engine exposes exactly what the top bar
  needs. Every other screen is unbuilt, and the second one is the honest
  test of what the full UI costs.
- **Dialogs are not drawn.** The UI reports that the engine is waiting on
  one and can dismiss it, but cannot answer it — so a class change that
  would reset an allocated tree currently cannot be confirmed from here.
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
