# PoB on LÖVE — host swap prototype

Runs Path of Building 2's **unmodified Lua** inside [LÖVE 11.5](https://love2d.org)
by reimplementing SimpleGraphic's host API on `love.graphics`.

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

## The payoff, wired up

`fontFiles` maps PoB's font names onto real system TrueType — Segoe UI for
`VAR`, Segoe UI Bold for `VAR BOLD`, Consolas for `FIXED` — rasterised at
whatever pixel height the call site asks for. SimpleGraphic could only
serve 16 pre-baked sizes per face.

This works *because* PoB measures its own layout with `DrawStringWidth`:
change the metrics and the UI reflows around them instead of overlapping.
Point `fontFiles` at any TTF to change the whole application's typography.

Still available and unexploited: shaders (real blur, glow, gradients),
canvases (render-to-texture, cheap full-screen effects), and `love.math`
tweening for animation. None of those exist in SimpleGraphic at all.

## Stubbed, not implemented

- **`LaunchSubScript` / `AbortSubScript` / `IsSubScriptRunning`.** These run
  update checks, trade queries and build imports off-thread. `love.thread`
  is the natural mapping and nothing here blocks it — it's just not done.
  Anything that fetches from the network is therefore inert.
- **`NewArtHandle`, `LoadArtRectangle`, `LoadArtArcBand`, `Texture.*`.**
  Used for sprite-sheet slicing; falls back to whole-image draws.
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
