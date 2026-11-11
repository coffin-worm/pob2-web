# Web UI tests

Two layers, both against the real thing: no mocked engine.

    cd web
    npm test              # both, engine first
    npm run test:engine   # vitest: boots the engine, drives the bridge's HTTP routes
    npm run test:e2e      # Playwright (Chromium): drives the app in a browser

Needs LOVE installed (`C:/Program Files/LOVE/lovec.exe`, or `<repo>/love/lovec.exe`,
or set `POB_LOVE`), and once per machine `npx playwright install chromium`.

- **Engine** (`tests/engine/`): each file starts `lovec.exe` once on a free port from
  51930 up, polls `GET /health`, and kills the process tree afterwards. About 10 seconds.
- **Browser** (`tests/e2e/`): Playwright starts `npm run dev` on port 5199 with its own
  engine on 51990 (`vite.e2e.config.ts`), so it does not touch a dev server on
  5173-5177/49090. About 40 seconds.

Both layers set `POB_USER_PATH` to a throwaway folder, so builds they save never land in
your real `Documents/Path of Building (PoE2)/Builds`. The browser tests refuse to run if
something else is already answering on :51990. No test requests pobb.in, maxroll,
poe.ninja, poe2db, pastebin or rentry; those hosts are blocked and asserted unused.
The account import controls on the Import view only show when signed in, so those two
specs stub the dev server's `/poe` routes (pathofexile.com), not the engine.

## The character fixture

`engine/fixtures/character.json` is a character payload shaped like the one
pathofexile.com answers with. Nothing in it came from an account: the name is invented,
and the two rings and the 35-point passive route were built against this checkout's own
data. Both layers import it, which is the only automated cover for a character import
that succeeds; everything else about importing is a refusal.

It is a regression test for one bug in particular. PoB estimates which act a character
is in, then fails to read its own answer back, so an import lands on the Endgame
resistance penalty and takes 60% off fire, cold and lightning (`bridge/README.md` has
the detail). The fixture's route is deliberately a mid-campaign one, and the rings carry
25% of each resistance, so the bug reads as -35% where the fix reads as +5%. Remove the
correction in `bridge/api.lua` and both layers fail on exactly that number.

If a tree update retires those node ids, the engine test fails saying fewer points were
allocated than the fixture asked for. To regenerate them, start the engine, then on a
fresh build pick a node at the cost you want and take PoB's own route to it:

```bash
curl "http://127.0.0.1:49090/tree/alloc"        # reachable: [[nodeId, cost], ...]
curl "http://127.0.0.1:49090/tree/path?node=NN" # path: the hashes, in order
```
