# PoB on LÖVE — host swap prototype

Runs Path of Building 2's application code inside [LÖVE 11.5](https://love2d.org)
by reimplementing SimpleGraphic's host API on `love.graphics`. No tab, no
control class and no calc code is touched — see the one caveat below.

The bet: PoB's UI ceiling isn't its own code, it's the renderer underneath.
SimpleGraphic is a textured-quad blitter with bitmap font atlases — no
shaders, no TrueType, no canvases. Swap the host and that ceiling moves,
without editing a single one of PoB's tabs.

```bash
"C:\Program Files\LOVE\love.exe" C:\dev\pob-love
```

`shim.log` records boot status, frame errors and any host call that's still
a stub. Set `POBLOVE_AUTOBUILD=0` to stop it opening a build on launch.

## Why this is feasible at all

The host boundary is small and already proven swappable — the community
macOS port replaced the Windows runtime and left the Lua and calc engine
untouched. `_SimpleGraphic.def.lua` documents 68 functions, and only about
fifteen of them are graphics:

| Area | Functions |
|---|---|
| Geometry | `DrawImage` ×4 overloads, `DrawImageQuad` ×4 |
| Text | `DrawString`, `DrawStringWidth`, `DrawStringCursorIndex` |
| State | `SetDrawColor`, `GetDrawColor`, `SetDrawLayer`, `SetViewport`, `SetBlendMode`, `SetClearColor` |
| Resources | `NewImageHandle` + its `:Load/:IsValid/:ImageSize` methods |

The rest is files, clipboard, time, console and subscripts.

## The caveat: PoB's LuaJIT is patched

The one thing that genuinely blocked the swap wasn't graphics at all.
SimpleGraphic bundles a **LuaJIT with syntax extensions**, and PoB's source
uses two of them:

| Extension | Example | Lua 5.1 equivalent |
|---|---|---|
| Compound assignment | `count += 1`, `url ..= "/x"` | `count = count + (1)` |
| Safe navigation | `gem.gemData?.gameId` | `(gem.gemData and gem.gemData.gameId)` |
| Bare `continue` | `if not gem then continue end` | `goto continue` + `::continue::` |
| Lambda shorthand | `\|_, key\| -> t[key]` | `function(_, key) return t[key] end` |

None are valid Lua 5.1, so stock LuaJIT refuses to parse the file at all.
Each surfaced only once the previous was fixed, one parse error at a time:
`Modules/Main.lua:340` (`'=' expected near '+'`), then `ModParser.lua:6164`
(`unexpected symbol near '?'`), then `Tooltip.lua:237`, then
`BuildExportPoE2.lua:147` (`'=' expected near 'end'`), then
`CalcOffence.lua:5191` (`unexpected symbol near '|'`) — all before any
rendering question could be asked.

That serial discovery is the honest shape of this work: you cannot
enumerate the dialect up front, because the parser stops at the first
offence. Budget for more.

29 sites across 15 files. `restyle-tooling/apply_lua51_compat.py` rewrites
each to the explicit form, which the patched runtime accepts just as
happily — so the native build is unaffected and the fork now parses under
any Lua 5.1 host. It's idempotent; re-run it after an upstream pull.

The `continue` pass locates its sites by scanning rather than by line
number, because inserting a `::continue::` label shifts every line below
it. A hardcoded list drifts on the second run — which is exactly how an
earlier version of the script produced `goto goto continue`.

The rewrite parenthesises every right-hand side, because
`y += cond and 24 or 0` naively becomes `y = y + cond and 24 or 0`, which
parses as `(y + cond) and 24 or 0`. Two real sites in `ItemsTab.lua` hit
exactly that trap.

Worth knowing independently of this prototype: it means PoB's source cannot
be run by a stock Lua, which quietly constrains tooling, embedding and any
future host.

## The three things that needed real work

**Layer sorting.** SimpleGraphic sorts draws by layer; LÖVE is immediate
mode. Every draw call is recorded into a command buffer tagged with
`(layer, subLayer, emission order)` and replayed sorted at end of frame.
Without this, dropdowns and tooltips render underneath the content they
float over.

**Working directory.** SimpleGraphic's `SetWorkDir` changes the real process
CWD, and PoB leans on that with bare relative `io.open("UpdateCheck.lua")`
calls. LÖVE can't chdir, so `io.open`, `io.lines`, `os.remove` and
`os.rename` are wrapped to resolve through a tracked `workDir`.

**Colour escapes.** PoB embeds `^7` and `^xRRGGBB` inside strings, so
`DrawString` splits text into coloured runs and advances the pen per
segment, rather than printing it as one string.

**Allocation.** The first working version allocated a closure, a colour
table and a fresh `Quad` or `Mesh` on every draw call. That is fine for a
menu and fatal for the passive tree, which issues thousands per frame: the
process climbed to 1.4 GB and went *Not Responding* while still rendering
correctly. Commands are now pooled plain tables dispatched by a type tag,
`Quad`s are cached by their texture-coordinate tuple, `Mesh`es come from a
pool, blend state only changes when it actually differs, and `DrawString`
takes a fast path when a string contains no escape at all.

Worth internalising: the correctness work was the easy half. An
immediate-mode shim over a retained-mode API invites exactly this, and it
doesn't show up until you render something dense.

## The payoff, wired up

`fontFiles` maps PoB's font names onto real system TrueType, rasterised at
whatever pixel height the call site asks for. SimpleGraphic could only serve
16 pre-baked sizes per face.

Two things this exercise taught, both visible only once you screenshot it:

**Size is not the number PoB passes.** PoB's `height` is the pixel height of
the bitmap atlas it used to get; LOVE sizes a font by em, so `newFont(16)`
yields a line height well over 16. Everything comes out oversized, and
right-aligned labels — which anchor at a fixed x — slide off the left edge of
the side panel. `getFont` now measures and re-asks at a corrected size.

**Metrics are load-bearing.** The default is Arial, because PoB's `VAR` is
Liberation Sans and Arial is metric-compatible with it, so PoB's own layout
lands where it was designed to. A face with different metrics (Segoe UI, say)
looks more modern and reflows *most* things correctly — PoB measures with
`DrawStringWidth` — but fixed-anchor right-aligned text still overruns. Point
`fontFiles` wherever you like; just look at the result before believing it.

Still available and unexploited: shaders (real blur, glow, gradients),
canvases (render-to-texture, cheap full-screen effects), and `love.math`
tweening for animation. None of those exist in SimpleGraphic at all.

## Stubbed, not implemented

- **`LaunchSubScript` / `AbortSubScript` / `IsSubScriptRunning`.** These run
  update checks, trade queries and build imports off-thread. `love.thread`
  is the natural mapping and nothing here blocks it — it's just not done.
  Anything that fetches from the network is therefore inert.
- **`NewArtHandle`, `LoadArtRectangle`, `LoadArtArcBand`, `Texture.*`.**
  Sprite-sheet slicing. Checked: the only callers are under
  `Export/Scripts/ScriptResources/`, i.e. the GGPK data exporter, not the
  UI — so these stubs cost the application nothing. Same for the `"ASYNC"`
  image-load flag, which appears in the API definition and nowhere else.

- **DDS texture arrays — this is what keeps the passive tree from drawing.**
  Tree art ships as `.dds.zst` under `src/TreeData/`. The zstd layer is
  solved: `zstd.dll` from PoB's own runtime, reached through LuaJIT's FFI,
  since `love.data.decompress` does zlib/gzip/deflate/lz4 and not zstd.
  What remains is the container. Each file is a **DX10-header DDS texture
  array** — `skills_64_64_BC1` carries `arraySize=175`,
  `group-background_216_216_BC7` carries 6, `oils_108_108_RGBA` carries 13 —
  and LOVE's `newCompressedData` parses single 2D textures only, so it
  rejects all of them with "Unsupported format".

  The formats themselves are fine: this GPU reports `BC7`, `DXT1`, `BC4/5/6h`
  and `rgba8` as supported, so nothing is missing at the hardware level.
  Closing it means parsing the DDS header in Lua, walking the per-slice mip
  chain, and synthesising a single-slice DDS in memory for each one — plus
  honouring the `stackIdx` argument on `DrawImage`/`DrawImageQuad`, which
  exists precisely to select an array slice and which this shim currently
  ignores. That is the next substantial piece of work, and it is the
  difference between a running shell and a usable Path of Building.
- **DPI scale override.** `GetVirtualScreenSize` honours the percentage but
  the draw transform doesn't scale with it yet, so changing the setting
  will mis-size the layout.
- **`TakeScreenshot`, `Restart`, `SpawnProcess`.**

## What this is not

A prototype answering "is the boundary clean enough to cross?" — not a
daily driver. The long tail is the subscript threading, the art-handle
paths, and whatever surfaces once someone actually clicks around for an
hour. The calc engine is untouched either way; it never knew it was being
drawn.
