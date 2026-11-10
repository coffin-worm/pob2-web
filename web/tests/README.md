# Web UI tests

Two layers, both against the real thing: no mocked engine.

    cd web
    npm test              # both, engine first
    npm run test:engine   # vitest: boots the engine, drives the bridge's HTTP routes
    npm run test:e2e      # Playwright (Chromium): drives the app in a browser

Needs LOVE installed (`C:/Program Files/LOVE/lovec.exe`, or `<repo>/love/lovec.exe`,
or set `POB_LOVE`), and once per machine `npx playwright install chromium`.

- **Engine** (`tests/engine/`): each file starts `lovec.exe` once on a free port from
  51930 up, polls `GET /health`, and kills the process tree afterwards. About 4 seconds.
- **Browser** (`tests/e2e/`): Playwright starts `npm run dev` on port 5199 with its own
  engine on 51990 (`vite.e2e.config.ts`), so it does not touch a dev server on
  5173-5177/49090. About 40 seconds.

Both layers set `POB_USER_PATH` to a throwaway folder, so builds they save never land in
your real `Documents/Path of Building (PoE2)/Builds`. The browser tests refuse to run if
something else is already answering on :51990. No test requests pobb.in, maxroll,
poe.ninja, poe2db, pastebin or rentry; those hosts are blocked and asserted unused.
The account import controls on the Import view only show when signed in, so that one
spec stubs the dev server's `/poe/status` and `/poe/characters` (pathofexile.com), not
the engine.
