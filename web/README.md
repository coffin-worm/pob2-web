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

## What is and isn't real

The controls are real and the state transitions are real — changing class
invalidates the ascendancy and reloads its list, the level drives the
passive budget, edits raise the unsaved flag. **The data behind them is a
mock.** `src/pob/mockStore.ts` is the only file that should need deleting
when the bridge lands.

The contract is `src/pob/types.ts`. Field names are taken from the Lua side
rather than invented — `buildName`, `unsaved`, `characterLevel`,
`levelAutoMode`, `classId`, `ascendClassId` are all fields on the
`buildMode` table in `src/Modules/Build.lua`, and the budgets are what its
`pointDisplay` control computes each frame. The intent is that the bridge is
a transport, not a translation layer.

So this proves the UI and the design system. It does not yet prove the
stack end to end.

## The bridge, unsolved

The engine has to run somewhere and talk to the page. The complication found
while setting this up: **there is no standalone LuaJIT on a normal PoB
install.** It is embedded in `SimpleGraphic.dll`, and `runtime/` ships only
`Path{space}of{space}Building-PoE2.exe` and `Update.exe`. Three ways out,
none tried yet:

1. **Ship a LuaJIT binary.** ~1 MB, and PoB's native modules (`lua-utf8`,
   `socket`, `lzip`, `zstd`) are built against the Lua 5.1 ABI that LuaJIT
   provides, so they should load. Simplest, and the one I would try first.
2. **Use the Docker image the specs already use.** Proven to run the full
   app headless, but a container in the dev loop is heavy and the compose
   mount is read-only.
3. **Serve from inside the existing exe.** `socket.dll` (LuaSocket) and
   `dkjson.lua` both ship in `runtime/`, so the running app could host the
   API itself. Avoids a second runtime entirely, but couples the UI's
   lifetime to the old app's.

Whichever wins, the wire format is JSON over a WebSocket, and `dkjson` is
already in `runtime/lua/`.

## Known gaps

- The header needs about 1350px. Past that the loadout picker is dropped;
  below roughly 1150px it will scroll rather than hide anything that
  reports build state.
- No light theme. This is a dark application beside a dark game, and a real
  light theme is work, not a media query.
- Keyboard shortcuts, drag and drop, and the tooltip system are untouched.
