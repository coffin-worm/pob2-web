# The launcher

Path of Building as a window, rather than a terminal.

What this replaces is `npm run dev`: a Node toolchain, a Vite server on
whichever of ten ports was free, a browser tab, and a console window you
have to leave open. All of that exists to do two things that do not need
Node at all, which are serving a folder of built files and starting the
engine beside it. This does those two things and nothing else.

It is not a replacement for the dev server. While you are working on the
UI you want hot reload, and this has none. This is what you want when you
just want to use it.

```
dotnet build -c Release
bin\Release\net10.0-windows\PathOfBuilding2Web.exe
```

It expects the web UI to have been built already (`npm run build` in
`web/`), because it serves `web/dist` rather than compiling anything.

## There is no local web server

This is the one surprising thing about the design, so it goes first.

The UI is a web app and it fetches from `/bridge`, so the obvious shape is
a little HTTP server on localhost that serves the built files and proxies
that one path to the engine. That is what Vite does, and copying it would
have been three lines of `HttpListener`.

It is not what happens here. Every request on the window's origin is
answered in process, through WebView2's `WebResourceRequested`: files are
read off disk and anything under `/bridge` is forwarded to the engine.
Nothing listens on a socket except the engine itself.

That buys three things. No second port to collide with anything. No URL
reservation to negotiate with `http.sys`, which is the part of
`HttpListener` that needs an administrator the first time. And no window
in which everything else on the machine can talk to the UI's origin.

**The shape that did not work**, in case somebody tries it again:
`SetVirtualHostNameToFolderMapping` for the files plus a
`WebResourceRequested` filter for `/bridge`. A mapped host is served
entirely by the mapping and the event never fires for it, so `/bridge`
came back as a missing file and the UI reported the engine unreachable
while it was running perfectly. Serving both halves through the one
handler is also simply less to get wrong: there is no precedence question.

The origin is a fixed invented name, `https://pob.local`, which is never
resolved and never reaches DNS. Fixed matters: whatever the page keeps in
local storage is still there next time, rather than being scoped to
whichever port it happened to get.

## Two mounts, not one

`/bridge` goes to the engine. `/poe` is signing in to pathofexile.com and
listing characters, and it is answered by `PoeAccount.cs` in this process.

That second one was missing for a while, and account import was broken in
the window the whole time without being broken anywhere else. The UI is the
same build in the browser and here, and in the browser those routes are a
Vite plugin, `web/plugins/poe-account.ts`. Here there was nothing, so
`/poe/status` fell through to the static files and came back as
`404 Not found` in `text/plain`, and the import panel reported that the
route did not return JSON. A missing mount reads as a broken feature.

So `PoeAccount.cs` is a second implementation of that plugin's six
endpoints, under the same mount, answering the same bodies. Two
implementations of one contract is a real cost and it is the lesser one:
PoB's own OAuth lives in `PoEAPI.lua` and runs on `LaunchSubScript` and
`launch:DownloadPage`, both empty stubs in the headless host, so the
transport has to live wherever there is TLS and a socket library. In the
browser build that is node. In the window it is this process.

What does not move is the import itself. The character JSON goes to the
bridge's `POST /code/character` untouched, which hands it to PoB's own
`ImportItemsAndSkills` and `ImportPassiveTreeAndJewels`.

Two details are worth knowing. The sign-in **is** a link, an ordinary
anchor on `/poe/signin`, and this origin exists only inside this window, so
handing that URL to the system browser resolves to nothing. The sign-in is
therefore started in process when the link is clicked and the browser is
given GGG's own URL instead. And the redirect GGG comes back to is caught
on a raw socket rather than an `HttpListener`, for the same reason this
file has no web server: the exchange is one GET and one page, which is less
HTTP than negotiating with `http.sys` for the right to listen. The ports
are 49082, 49083 and 49084 with no path, because those are the origins
registered with the OAuth client.

The access token is held in memory and nowhere else: not on disk, not in
the page, not in the trace. The refresh token beside it is kept across
restarts by `TokenStore.cs`, encrypted to the Windows user, so closing
the window no longer signs you out. Why it is on disk at all is in
`web/README.md`, under "The sign-in that survives a restart": the short
version is that a sign-in you do constantly stops being read, and PoB
upstream already writes the same secret to Settings.xml in the clear.

`TokenStore.cs` is the other half of `web/plugins/token-store.ts`, down
to the file it reads. Both keep the same token in
`%LOCALAPPDATA%/pob2-web/poe-token.json`, so a sign-in in the dev server
is a sign-in in the window and the other way round: one account on one
machine should not have to prove itself twice. That is also why it is the
one piece of state not under `Paths.UserData()`, which is this program's
own folder and nobody else's. The format is PowerShell's, because the
dev server's half is PowerShell: `ConvertFrom-SecureString` with no key
argument is `CryptProtectData` at `CurrentUser` scope over the string's
UTF-16 bytes, printed as hex, which is exactly what `ProtectedData`
produces here. Neither half can tell the other's file from its own.

## The engine cannot outlive the window

The engine is started exactly as the dev server's plugin starts it: LOVE,
handed the `bridge` directory, with the working directory set to `src/`
because `HeadlessWrapper` resolves its own `dofile`s against it. The
environment it reads is the plugin's too, so the two stay in step.

Two things are deliberately different.

**The port is ephemeral.** The plugin uses 49090, which is fine until a
dev server is already on it. Here the OS picks one, so two copies and a
dev server can all be running and none of them is anybody else's problem.

**The process is in a job object** with `KILL_ON_JOB_CLOSE`, so Windows
ends it when the launcher's handle closes. That is the only way to be
certain, and it is worth the twenty lines of P/Invoke: the plugin's own
comment admits that killing the child leaves LOVE running often enough to
matter, and the orphan is then reused by the next start, so a change to
`api.lua` does nothing and you spend a while wondering why. The engine
also survives under a different process name than you expect, `lovec`
rather than `love`, which is its own afternoon.

Verified both ways. A graceful close leaves no engine, and so does
`Stop-Process -Force` on the launcher.

If the engine dies on its own, the next request starts another one rather
than leaving the app dead until it is restarted.

## Where it looks for things

Every one of these takes an environment override first, because the one
thing worse than a wrong guess is a wrong guess you cannot argue with.

| What | Override | Otherwise |
|---|---|---|
| The checkout | `POB_ROOT` | Walks up from the executable looking for `bridge/main.lua` and `src/` |
| LOVE | `POB_LOVE` | `love/lovec.exe` beside the executable, then the two install paths |
| The built UI | | `web/dist` under the checkout |
| Profile and window position | | `%LOCALAPPDATA%\PathOfBuilding2Web` |

Walking up is what lets the same executable run from `launcher/bin/...`
in a checkout and from the root of a shipped folder, without either
layout being the special case.

Set `POB_TRACE=1` to log every request to `trace.log` in that profile
folder. Failures are logged whether or not it is set.

## When it cannot start

All four ways this fails are things the person reading can fix, so each
one says which it is and what to do:

- LOVE is not installed, or `POB_LOVE` points at nothing.
- The web UI has not been built.
- The checkout is not where the launcher thought.
- The engine crashed on boot, in which case its own last words are in the
  message, in a box you can select and paste rather than a dialog you can
  only dismiss.

## Shipping it

```
.\publish.ps1 -IncludeLove -Zip
```

That builds the UI, publishes the launcher with .NET carried inside it,
and assembles a folder holding `bridge/`, `src/`, `runtime/`, `web/dist/`
and a copy of LOVE. The result needs nothing installed except the WebView2
runtime, which ships with Edge and is therefore already on any current
Windows machine.

A real run comes out at 0.55 GB: `src/` is 410 MB of it, the engine's
runtime 28, the built UI 12 and LOVE 11. Nothing here makes the game data
smaller.

The executable itself is 103 MB of that, because .NET is inside it.
`-FrameworkDependent` takes .NET back out and leaves a 297 KB executable
that needs the .NET 10 Desktop Runtime on the target. Worth it when the
target is your own machine and nothing else.

`-Zip` also writes `dist-app.zip`, and a `README.txt` goes into the folder
so whoever opens it knows to double-click the executable and knows that
the directories beside it are the application rather than clutter.

### One file is deliberately left out

`runtime/libcurl.dll` is not copied. It is PoB's network layer, and the
headless engine does not have one: `HeadlessWrapper` stubs
`require("lcurl.safe")` outright, with a comment saying it does not really
need it. The published build was run without the file to check, and it
works.

The reason it is skipped rather than merely unnecessary is that Windows
Defender flags a fresh copy of it as `Trojan:Win32/Posilod.CA!cl` and
quarantines it part-way through the archive, which fails the zip. The same
bytes sitting in the checkout are left alone, so this is a heuristic about
new files at unfamiliar paths rather than a judgement about the file.
Either way, carrying a DLL the engine never loads only to trip somebody's
scanner is the wrong trade. Drop it from `$skip` in `publish.ps1` to ship
it, and expect to need an exclusion.

## The icon, and how it was made

`icon.ico` is the web UI's own `favicon.svg` at seven sizes, 16 through
256. Getting there was less direct than it sounds, and the method is
written down because the next person will hit the same wall.

A stock Windows box has no SVG rasteriser: no ImageMagick, no Inkscape, no
Pillow in the system Python. The artwork is also not a shape you can
hand-port, because it is a masked silhouette filled by a dozen blurred
ellipses, and the gradient everybody recognises it by only exists once
those blurs are composited.

So a real browser did the rasterising. A throwaway local server handed it
the SVG, the page drew it into a canvas at each size, and posted the raw
RGBA straight back; a short script assembled the icon from those buffers.
The 256 goes in as PNG and the rest as plain DIBs, which every Windows
shell path has read since long before PNG entries existed. An icon is the
one asset where a format question is not worth any cleverness at all.

WinForms does not adopt the application icon for the window by itself, so
the form reads it back out of its own executable. Otherwise the file on
disk has the bolt and the title bar has the default.

## Known gaps

- **No file association and no installer.** It is a folder you unzip.
- **No hot reload**, by design. Use the dev server for that.
