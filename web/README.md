# PoB web UI: header prototype

A prototype of Path of Building's UI as a web app, intended to run in
WebView2 against the existing Lua calc engine. Ten screens so far: the top
bar, the stat sidebar, the passive tree, the Items tab, the Skills tab, the
Configuration tab, the Calcs tab, import/export, the build list and the
compare view, all driven by the real engine.

```bash
npm install
npm run dev
```

## Why this might be worth doing

The Lua UI's ceiling is not its renderer: SimpleGraphic draws textured
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
(79) and `Modules` (31): roughly 94% in the game data you would keep taking
unchanged. The UI barely moves upstream, so owning it costs little.

`src/HeadlessWrapper.lua` already runs the whole application with the
renderer stubbed out; it is how PoB's spec suite drives real builds. The
engine does not need a window.

## What this branch touches

Every commit on it has said "`src/` is untouched". That is checkable, so
here is the check:

```bash
git diff <base>..HEAD --name-only | awk -F/ '{print $1}' | sort | uniq -c
```

At the time of writing: 41 files under `web/`, 4 under `bridge/`, and
`.gitignore`. Nothing in `src/`, nothing in `spec/`.

That proves the *inputs* to PoB's test suite are unchanged: `.busted`
reads `src/`, `spec/` and `runtime/lua/`, and none of them differ from the
base. But "the suite is unaffected" and "the suite passes" are different
claims, and only the first one follows from a diff. So the suite was also
run, in the container CI uses:

```bash
docker compose up
```

```
912 successes / 0 failures / 0 errors / 0 pending : 178.2 seconds
```

All 53 files under `spec/System` ran: `.busted` sets
`exclude-tags = "builds"`, but nothing in the suite carries that tag, so
it excludes nothing. Two bits of output look alarming and are not:
`missing node <id>` comes from `HeadlessWrapper.lua` processing the tree,
and `Failed to get token from server: SSL connect error` is
`src/Classes/PoEAPI.lua:127` reaching for the live API from a container
with no network. Both appear on a clean checkout.

Everything the bridge adds lives beside the engine rather than inside it,
which is what makes the first claim worth anything: the capabilities the
headless host was missing (zlib, a filesystem) are installed over its
stubs from `bridge/`, at runtime, by code the suite never loads.

## Stack

| Choice | Why |
|---|---|
| Vite + React + TypeScript | The Calcs tab is thousands of dense rows; TanStack Table/Virtual is the strongest answer to that anywhere |
| Radix primitives, unstyled | PoB is mostly dropdowns, popups and sliders. Radix brings type-ahead, roving focus, focus traps and ARIA, none of which the Lua UI has, and styles nothing |
| Plain CSS + custom properties | The design system is the point. Tailwind would scatter it across utility strings; `src/styles/tokens.css` keeps every decision in one file |
| Zustand | Recalculation output streams in. Selector subscriptions stop that re-rendering the world |
| Inter (OFL) | Designed for UI at 12-16px, which is the whole range this app lives in |

Later: TanStack Table/Virtual for Calcs, Tauri for the WebView2 shell (a few
MB using the system WebView2, against Electron's ~150).

## Running it

```bash
cd web
npm install && npm run dev
```

…or `npm run build && npm run preview` to run what would actually ship.
Both start the engine and proxy it; see below.

That is the whole thing. `plugins/pob-bridge.ts` starts PoB's engine with
the dev server, waits for it to report ready, and serves it under the dev
server's own origin at `/bridge`, so the app makes same-origin requests and
which port the engine took stops being the UI's problem.

It was two hand-started processes before, in the right order from the right
directory, and the page said "engine not reachable" whenever you forgot one.

A few behaviours worth knowing, all of which cost something to get wrong:

- **It reuses an engine that is already listening** rather than starting a
  second one, which makes an engine you started by hand for debugging the
  one the UI talks to.
- **It only kills what it started.** Stop the dev server and an engine it
  spawned goes with it; one you started by hand survives.
- **It really kills it.** On Windows `child.kill()` leaves LÖVE running often
  enough to matter, and a surviving engine is then *reused* by the next
  start, so you edit `api.lua`, restart, and nothing changes. It shells out
  to `taskkill /f /t`.
- **No LÖVE, no engine.** The dev server still comes up and says so in the
  terminal and on the page. `POB_LOVE` points at `lovec.exe` if it is
  somewhere unusual.
- **The tree's artwork is built on first run.** `plugins/tree-art.ts`
  unpacks it from the game's own textures, which takes about twenty seconds
  and is not waited on: the server comes up at once, the tree draws circles
  until it lands, and a reload picks it up. It needs Python 3.14+ and
  Pillow; without them the circles are what you get, the HUD says
  `no artwork`, and `npm run tree-art` shows the real error.

`VITE_POB_BRIDGE` set to a full URL talks to an engine directly instead,
bypassing the proxy; the engine sends CORS headers for exactly that case.
`POB_SRC`, `POB_RUNTIME`, `POB_BRIDGE_DIR` and `POB_BRIDGE_PORT` override
the engine's own defaults.

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
| 6 classes, ids 0-5 | 8 classes, ids 1-11: no Druid or Huntress in the mock |
| Witch has 3 ascendancies | 4, plus None: the mock never had Abyssal Lich |
| Passive max is `level - 1 + 24` | `99 + quest points`: **it does not depend on level** |

That last one is the one worth remembering. The prototype demonstrated the
passive budget moving as you typed a level, and that was an invention of the
mock; in PoE 2 the maximum is the full endgame budget and only the *used*
side moves. A plausible lie is the failure mode of building against a mock,
and it survived a careful read of my own code.

The contract is `src/pob/types.ts`. Field names were taken from the Lua side
rather than invented (`buildName`, `unsaved`, `characterLevel`,
`levelAutoMode`, `classId`, `ascendClassId` are all fields on the
`buildMode` table in `src/Modules/Build.lua`) and that paid off: wiring the
bridge needed no renaming on either side.

## The sidebar, and what a second screen cost

The stat sidebar was the second screen, chosen because it is dense
structured output rather than another row of controls. It came to about 250
lines: one store, one component, one stylesheet, and `api.stats` in Lua.

It cost that little because of one decision. `RefreshStatList` has already
done the filtering (which stats apply to *this* skill, via per-stat `flag`
and `condFunc` entries in `BuildDisplayStats.lua`) and the number
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

## The passive tree

This was the screen that could have sunk the approach: a canvas with
thousands of nodes, pan, zoom and hit-testing, resembling none of the other
three. It did not.

| | |
|---|---|
| Nodes / connectors | 4546 / 5149 (2773 arcs, 2376 lines) |
| Geometry payload, fetched once | 1.03 MB, 2.5 ms to parse |
| Engine time to build it | 14 ms |
| Artwork, fetched once | 2.8 MB atlas, 145 ms to decode |
| **Draw time per frame** | **0.4-0.9 ms** zoomed in, **1.9-2.2 ms** with the whole tree on screen |
| **Hit-test, every mouse move** | **0.059 ms** over all 4546 |

**Canvas, not SVG**, and not as a taste: ten thousand SVG elements is ten
thousand things for the browser to lay out and hit-test on every pan. Canvas
draws every connector as two batched `Path2D` strokes, and hit-testing is a
linear scan this code does itself: at 0.059 ms there is no case for a
spatial index that could fall out of step with the data.

### The art is the game's, decoded once

The thing that looked expensive here was node art, and the reason is that
PoB does not ship sprite sheets in any form a browser can read. It ships
zstd-compressed DDS **texture arrays**: one file per cell size, each
holding up to 354 array slices of BC1 or BC7 block-compressed pixels, with
`tree.json`'s `ddsCoords` naming the slices. That is exactly right for a
renderer that uploads them to the GPU and exactly useless to a canvas.

`web/tools/tree_art.py` unpacks them once. It needs no third-party packages
beyond Pillow: zstd is in Python 3.14's standard library as
`compression.zstd`, and Pillow already decodes both BC1 and BC7. The only
hand-written part is splitting the array: Pillow opens slice 0 and offers
no API for the rest, so each slice's mip chain is cut out of the body and
wrapped in a one-slice DDS header, which keeps the actual block decoding in
Pillow where it belongs.

| | |
|---|---|
| Source textures | 92 MB in `src/TreeData/0_5` |
| Sprites extracted | 685, into one 4085×1774 atlas |
| Atlas | 2.8 MB WebP |
| Painted backdrops | 37 files, 8.4 MB, fetched only when on screen |
| Extraction | ~20 s, once |

Three choices in there are worth stating. The atlas holds only the 685
sprites the tree actually references, because the files also carry PoE1
leftovers (legion jewel art, anointment oils) and those are the physically
largest sprites in the set. It is stored at ¾ scale, because every sprite is
drawn into a box PoB chose and those boxes are all well under the source art
(a 128px icon lands in a 37-54px node), which turns 11.6M pixels of atlas
into 6.5M with nothing visibly lost at the deepest zoom this view allows.
And it is WebP rather than PNG, 2.8 MB against 9.8 MB, which is safe here
because WebP keeps alpha lossless even in lossy mode, and these sprites are
cut-outs.

The output is gitignored. The dev server builds it on first run, and if
Python is missing the tree falls back to circles and says so in the HUD.

### Curved connectors, and a check that they are not lies

Most of the tree's connections are arcs of an orbit, not straight lines, and
an arc drawn almost right is the kind of error that is invisible until the
tree looks faintly bent. So none of it is re-derived.

PoB builds a connector list of its own, and it is not the same as the links:
it drops the ones it does not draw (between an ascendancy and the tree
proper, and out of a class start) and it knows which connections curve.
For an arc it puts the orbit's centre in the first vertex of the quad it
builds. Both endpoints lie on the circle through that centre by
construction, so centre plus the two node positions is the whole arc: no
radius, no sweep, nothing to get subtly wrong.

That claim is checked rather than assumed. The bridge measures both radii
for every arc before sending it, counts the ones that disagree by more than
a unit, and reports the count as `arcErrors`; a connector that fails falls
back to a straight line, and the HUD says so. **It is 0 across all 2773
arcs.**

PoB emits connectors wider than 90° as two, because its arc *texture* only
covers 90°. That is a fact about the texture and not about the tree, so the
pair collapses back into the one arc it describes.

### The rest of it

Positions are PoB's, resolved from group/orbit/orbitIndex at tree load.
Which sprite a node wears is the asset name PoB resolved for it
(`node.icon`, `node.overlay[state]`), forwarded untouched, so neither the
bridge nor the extractor has an opinion about which picture a notable gets.
The sizes it is drawn at are `node.targetSize`. Tooltips are `node.sd` and
the keystone flavour text. The backdrops are `class.background` and the
ascendancy discs, and the rotation of the lit centrepiece is the angle to
the class's start node, which the bridge reports so the UI does not have to
know which node that is.

Allocation is PoB's too. A click sends `toggleNode`, and `AllocNode` walks
the node's own path, so clicking something several nodes away allocates the
route to it exactly as the desktop app does. Reachability is `node.path`: a
node PoB cannot path to is refused with a reason rather than quietly doing
nothing. Verified by clicking in the browser: 28 → 30 allocated for one
click two nodes out, the header moving 26/123 to 28/123, and the sidebar's
Mana Regen going 23.5 to 29.4 off the engine's own recalculation.

Two things are local decisions rather than the engine's, and both are
presentation. Below a scale of 0.06 the nodes are drawn as circles instead
of sprites, because a 54-unit frame is about three pixels there: two
scaled blits to paint something no bigger than the dot that replaces them.
And unallocated art is drawn at half alpha, so a crowded cluster reads as a
path rather than as a field of rings; PoB tints instead.

Search covers stat text as well as names, because that is how the question
is usually asked, not "where is Heavy Armour" but "where is anything that
gives spirit". It is a linear scan per keystroke, under a millisecond.

### What a click would cost

Hovering a reachable node now says **costs 13 points** and draws the route
the click would take.

Two pieces, because they have different shapes. The cost is `pathDist`,
the engine's own figure from the same search that built the path:
allocated nodes weigh nothing, so it is the number of *new* points, not the
length of the route. It rides with the allocation, one number per reachable
node: that took `/tree/alloc` from 25 kB to 44 kB for 3,900 nodes, which
buys an answer with no round trip on every mouse-move.

The route itself is fetched per node, 150 bytes for an eighteen-node path,
cached until the allocation changes. Every reachable node's route at once
would be the whole tree several times over.

**It asks for `GetEffectiveAllocationPath`, not `node.path`.** `AllocNode`
calls the former, and the two differ exactly where it matters: a path
running through a weapon-set branch, or one shortened by an Intuitive Leap
style jewel. A preview built on the raw path would be right almost always
and wrong on the builds that care.

Checked rather than assumed: preview a node, allocate it, and compare.
Predicted 4 points, cost 4, and every node in the previewed route came back
allocated.

### What the point is worth

A route preview says what a click would cost. It does not say whether the
cost is worth paying, and that is the question the desktop tree exists to
answer: hover a node there and the tooltip prices it in the stats you
actually care about.

`GET /tree/whatif` gives PoB's two answers rather than one. The node alone
is the obvious one. The whole route to it is the one that decides
anything, and it carries its own length, which is what turns the
comparison into a per-point one. Six nodes for 8% life is a worse deal
than two for 5%, and the second answer is the only place that shows.
A node an item granted is priced the only way that makes sense for it:
what losing it would cost.

Neither mutates the build. `addNodes` and `removeNodes` are arguments to
the misc calculator, the same way `repSlotName`/`repItem` are for the item
bench, so the whole feature is the engine answering a hypothetical rather
than this UI changing something and changing it back.

It is asked once the pointer rests, not on every node it crosses, and sits
behind a switch in the HUD. That switch is PoB's `Ctrl+D` made visible,
and it exists for the same reason PoB has one: two full recalculations is
not a thing to fire while a pointer travels across 4546 nodes.

Verified in the browser on Eldritch Will, 30 points away: the node alone
gave `+2 Total Life (+3.1%)`, and the route gave `+15.0 Average Hit
(+10.0%) [+0.5 (+0.3%) per point]`.

The tooltip had to learn to measure itself for this. It used to sit below
the cursor in the top half of the panel and above it in the bottom half,
which needs no measurement and was right while a tooltip was a name and
three stat lines. Thirty lines run off the panel whichever side of the
cursor they start on.

### What the tree still lacks

- **The glow behind allocated notables** (`activeEffectImage`). It is 60
  slices of 784×776, 146 MB of pixels for pure decoration, so the
  extractor skips that atlas outright.
- **Path preview.** Done: see below.
- **Attribute and multiple-choice nodes.** 371 nodes carry `options`; the
  variant for the current class is what the engine reports, and switching
  between them needs a modifier-key gesture that has no equivalent here yet.
- **Jewel sockets** draw their frame but not a socketed jewel or its radius.
- Compare mode, the node power heat map, and the ascendancies that replace
  one another.
- At full zoom-out every ascendancy disc is on screen, so all 23 download:
  8 MB. Over loopback that is nothing; over a network it would want a
  smaller tier.

## The Items tab

The cheapest screen so far, and for one reason: PoB already knows how to
draw an item.

`ItemsTab:AddItemTooltip` lays one out in full (the rarity header, the
base, quality and requirements, implicits above explicits, every mod in its
own colour, the unsupported ones called out, the flavour text) and given a
slot it also runs the comparison that produces "Equipping this item will
give you: +182 Effective Hit Pool (+19.2%)". That is hundreds of lines of
game knowledge about mod formatting and about what a stat delta means.

It builds all of it into a `Tooltip`, whose `lines` are
`{size, text, block, separatorImage}`: the same shape as the `statBox.list`
the sidebar already reads. So the bridge builds a tooltip, reads the lines,
classifies the colour codes into names, and sends them. There is no item
formatter on the web side at all.

| | |
|---|---|
| Slots, the item list and the sets | 3.8 kB, **0 ms** in the engine |
| One item, with its slot comparison | 2.0 kB, **3 ms** |
| Searching every unique and rare by name | 60 of them, **42 ms** |

(The wall-clock figures from the browser are 13-44 ms. Most of that is the
bridge's own 1/30 s poll tick, not work.)

### One line is dropped, and only one

`colorCodes.TIP` is used in exactly one way across the whole codebase:
advice about the desktop UI's keyboard shortcuts. "Tip: Press Ctrl+D in the
Items tab to disable the display of stat differences." None of those keys do
anything here, so forwarding them would be telling the user something untrue
about the application in front of them. Lines in that colour are dropped and
the count is reported as `droppedTips`, so it is visible rather than silent
if PoB ever starts using it for something that matters.

### What the slots know that a list of slot names could not

PoB has nineteen equipment slots and up to six jewel sockets hanging off
each piece that can carry them, and which of them exist at any moment is
build state:

- the third ring appears only behind an `AdditionalRingSlot` flag on the
  mod database;
- the weapon slots swap for their `Swap` twins with the active weapon set;
- a jewel socket on the tree exists only while its passive is allocated;
- the sockets on a piece of gear exist only up to that item's
  `jewelSocketCount`: equipping Tabula Rasa adds six.

So the slot list is asked for, not declared. Two of PoB's own passes have to
be run first, for the same reason the Calcs selector needed one:
`PopulateSlots` rebuilds the per-slot item lists, and `UpdateSockets`
decides which sockets are live. Neither runs headless on its own, and
without the second every socket is reported as available regardless of the
tree.

Which items may go in a slot is `IsItemValidForSlot`, a real rule about
two-handers, jewel rarities and sinister sockets, so the dropdowns are the
lists PoB built. Equipping checks it again on the way in, and a refusal
comes back as a sentence: *that item does not fit Boots*.

### Getting items in

Three ways, all of them PoB's:

- **Its own databases.** `main.uniqueDB.list` and `main.rareDB.list` are
  every unique and rare the game has, parsed at startup. Searching by name
  and adding one follows `ItemDBControl:OnSelClick` exactly, including the
  weapon-set redirection: with the second set showing, an item whose
  primary slot is "Weapon 1" has to go to "Weapon 1 Swap", and skipping that
  would quietly equip into the set you are not looking at.
- **Pasted item text**, through `CreateDisplayItemFromRaw`, which is what
  pasting into the real tab does. It leaves `displayItem` nil when the base
  is not one PoB knows, and that is the only failure worth reporting:
  everything else it parses leniently and marks unsupported on the item.
  Pasting does not equip: see the bench, below.
- **Auto-equip**, which is `AddItem`'s own behaviour, still reachable
  through `addItemText` for the case where you simply want the item in.

### The bench, and a question asked before it is answered

Pasting used to equip on arrival. That is one step fewer than the desktop
app and it costs you the only question worth asking: finding out whether
an item was an upgrade meant equipping it, reading the sidebar, and
unequipping it again. Three steps, the middle one against a build that had
already changed, and an interruption anywhere in that sequence leaving the
build wrong.

PoB does not work that way. A pasted item becomes `displayItem` and
nothing is equipped until told to. Its tooltip then answers "what would
this do here?" one slot at a time, on hover, because a tooltip is all the
desktop has. A web UI has room for a list, so `/item/staged` answers it
for every candidate slot at once.

Nothing is mutated to do it. `GetMiscCalculator` takes a
`repSlotName`/`repItem` pair, which means *recalculate as if this item
were in that slot*, and that is the same call PoB's own anoint and rune
tooltips make. So there is no equip-and-revert to get interrupted, and no
way to leave a half-equipped build behind.

The order of the slots is PoB's, key for key, from `ItemsTab:4495`: an
empty slot first, then the slot holding whatever this item is a direct
alternative to (the same unique, or the same base and subtype), then by
`FullDPS`, `CombinedDPS` and `TotalEHP`, then by name so it is stable.
That ordering is most of the feature. A ring that fits two slots sorts the
empty one above the one holding a working ring, which is the answer you
wanted and not the one the engine's slot order would have given. The
limited-unique rule came along with it: wear as many copies as the item
allows and only the slots holding one are offered, because the others are
not places a further copy could legally go.

One thing had to be turned off to make room. `AddItemTooltip` given no
slot does not mean *no comparison*; it means *every slot*, appended to the
item in one column, which is right when the tooltip is the whole UI. Asked
for both, the screen printed each comparison twice. `showStatDifferences`
is the engine's own switch for exactly this, the one `Ctrl+D` throws in
the real Items tab, and it gates the last section of the tooltip, so
turning it off leaves the item untouched.

| | |
|---|---|
| A ring against two slots | 8 ms |
| What it replaced | equip, read, unequip |

Verified in the browser: pasting Cracklecreep with Death Rush in Ring 1
offered Ring 2 first as *filling an empty slot*, all gains, and Ring 1
second as *replacing Death Rush*, trading 59% of hit DPS for fire
resistance and life regeneration. Equipping it from the second row put it
in the row's slot rather than PoB's default, and the bench cleared itself.

### What this screen decides for itself

Three things, all presentation. The slots are grouped (weapons, armour,
jewellery, charms and flasks, jewels) where PoB draws nineteen dropdowns in
one column; the order inside each group is still the engine's. Rarity
colours are tuned for this background rather than copied, for the same
reason as the damage types: PoB's unique brown is close to unreadable at
12px on anything lighter than black. And the layout switches between one
column and two on the width of the *panel*, not the window: a media query
would be wrong here, because this screen sits beside a 290px sidebar and the
viewport is wide long before the panel is.

### Editing an item, rather than replacing it

Three things, which between them are what the desktop tab's editor panel
is for:

- **The modifier rolls.** A unique's `+(30-50) to Evasion Rating` is a
  range, and PoB keeps one `rangeLineList` entry per such line holding its
  position between the bounds. Moving it is the control people actually
  use. The engine recalculates the whole build from it and rewrites the
  item's own text to match.
- **The variant**, for uniques with more than one version. Items whose
  variants come from several independent groups are refused with that as
  the reason, rather than having the wrong one set quietly.
- **The raw text**, which is the escape hatch. A PoB item *is* its text:
  it is parsed back from it, so this covers crafting, custom modifiers,
  quality and corruption without a control for each.

| | |
|---|---|
| The editable payload | 668 B |
| Goldrim as text | 422 characters, 2 adjustable rolls |

Editing is in place: the table in `itemsTab.items` is the one the build
holds, so mutating it *is* the save and the item keeps the slot it was
equipped in. If the new text is a different base, `PopulateSlots` takes it
out of that slot: the engine's call, and the right one.

New text is parsed into a throwaway item first. `ParseRaw` on the live one
would leave it half-rewritten if the text turns out not to be an item, and
the build is holding that table. Verified: pasting `hello` comes back with
*that is not an item PoB recognises* and Goldrim is untouched.

Verified in the browser: dragging the evasion roll to its maximum took the
sidebar's Evasion rating from 113 to 137 and rewrote the item's own
`Evasion:` line from 106 to 130; adding `+200 to maximum Life` to the text
took Total Life from 91 to 301.

### What it does not do

- **No crafting interface.** The real tab has affix pickers, a mod
  browser, enchantment and corruption menus, catalysts, rune sockets and
  a corrupt popup. All of it is reachable through the text box, none of it
  is reachable by pointing. This is the largest single gap left on this
  screen, and the one the desktop app spends the most surface on.
- **The bench takes pasted text only.** In the real tab the editor also
  opens by double-clicking any item in any list, and `Ctrl+Click` on a
  database row equips without going through it at all.
- **No item sets beyond switching between them**, and no shared item list.
- **No drag and drop**, which is how the real tab moves items between slots.
- **No variant or league filters** on the database search. The real one
  filters by league, slot, type, obtainability and requirements; this
  matches on name.
- **No socketed-jewel radius preview**, the same gap the tree has.

## The Skills tab

Socket groups and the gems in them, and the third screen in a row where the
engine does the describing.

A group's label is `displayLabel`, which PoB builds during the calculation
pass out of the group's own name or the skills it actually grants. What a
group does is `AddSocketGroupTooltip`. What a gem does is
`GemTooltip.AddGemTooltip`, which resolves a granted effect's levels and
stat sets at this gem's current level and quality: the tags, the tier, the
mana cost, the cast time, the requirements, and the damage per effect.
Reproducing any of that would mean reproducing how gem levels work.

All three are Tooltips, so all three come back through the same reader the
Items tab uses. That reader is now shared: one function turns
`tooltip.lines` into the UI's line model, and three screens call it.

| | |
|---|---|
| The group list | 199 B, **0 ms** |
| A group expanded with its gems | 660 B, **0 ms** |
| What a group does | 340 B, **0 ms** |
| One gem, at its level and quality | 2.0 kB, **1 ms** |
| Searching every gem by name | 38 hits, **43 ms** |

The first gem tooltip of a session cost **293 ms** and every one after it
1 ms, because that first call is what forces the gem's level data to
resolve. Worth knowing before concluding the route is slow from one
measurement.

### Flags instead of a decorated string

PoB's list control builds each row by appending `(Disabled)`, `(Active)`
and `(FullDPS)` to the label in three different colours. That is a string
the UI would have to take apart again, so the bridge sends the four facts:
`enabled`, `main`, `fullDPS`, `source`, and they become badges.

`source` is the one that matters for behaviour, not just display: a group
granted by an item or a passive is rebuilt on every calculation pass, so
deleting it only makes it come back. The command refuses it with the reason,
*that group comes from Tabula Rasa and cannot be deleted*, rather than
letting the UI offer something that cannot work.

### Leading spaces, and why they are trimmed

The gem tooltip indents its first lines by twelve or eighteen spaces. Those
are `iconNameIndent` and `iconTagIndent`: a hole PoB leaves in the text for
the gem icon it draws on top. Nothing draws an icon there here, and HTML
collapses leading whitespace anyway, so keeping them would have produced a
ragged left edge for no reason. They are trimmed, and the separators still
carry the grouping.

### What it does not do

- **No gem-level defaults.** The real tab has "default gem level" and
  "default quality" settings and a DPS-sorted gem picker; a new gem here
  arrives at its natural maximum level and zero quality.
- **No alternate quality, corruption or legacy gems.**
- **No weapon-set gating per group.** PoE2 lets a socket group apply to one
  weapon set or both (`set1`/`set2`); those are read but not yet editable.
- **No group count, no explode sources, no minion skill selection.**
- **No copy and paste of socket groups**, which the real tab does with
  Ctrl+C and Ctrl+V.

## The Configuration tab

The interesting thing about this screen is how much of it is usually not on
it.

| | |
|---|---|
| Options PoB declares | **663** |
| Options this build is asked | **77**, in five sections |
| Payload | 22.6 kB, **1-3 ms** |
| With "show all" | 533 options, 97.6 kB, 3 ms |

An option appears when the build could answer it: `ifCond` against the
conditions the calculation actually used, `ifFlag` against the mod list,
`ifSkillData` against the active skill, `ifNode` against the allocated
tree. That gating is a function of the whole calculation: allocate a
keystone and new questions appear, so every option's visibility is asked
of its own control rather than worked out again here.

Two rules inside that closure are worth knowing, because neither is obvious
and both would be wrong if reimplemented:

- **An option that no longer applies is still shown when its value differs
  from the default.** Otherwise a setting could go on affecting the build
  from somewhere you cannot see it.
- **"Show all" reveals the build-gated options but deliberately not the
  ones gated on another option being set** (`ifOption`), because those
  would have nothing to attach to.

PoB draws a blue border round an option that is not at its default. That
comparison is `GetDefaultState`, which is not simply the declared default:
it prefers the placeholder when the build computed one. It travels as a
`changed` flag and becomes a rule down the side of the row; on a list this
long, knowing what you have changed is most of what you want from it.

The tooltips are the engine's too, and some of them are functions of the
live mod list rather than fixed strings: *"You will automatically be
considered to be on Low Life if you have at least 43% Life reserved"* is
computed from the build in front of you.

### A bug this turned up in PoB itself

`conditionEnemyExitedPresenceRecently` is declared twice in
`Modules/ConfigOptions.lua`: once as "Enemy exited Presence Recently?"
gated on `ExitedPresenceRecently` (line 1669), and again as "Enemy entered
Presence Recently?" gated on `EnteredPresenceRecently` (line 1672). The
second was meant to have its own variable. As it stands both checkboxes
read and write one input, so ticking either ticks both and the entered
condition can never be set on its own.

That is upstream, not here, and `src/` is untouched, but sending both
would have given this UI two controls bound to one value. The first wins,
the rest come back in a `duplicates` list, and the screen says so rather
than quietly dropping one. Should be exactly one entry; anything else is
news.

### What would this change?

Seventy options and no way to tell which matter. Clicking the **±** on any
checkbox answers it:

```
Enabling this will give you:
  +0.17 Cast Rate (+20.0%)
  +25.0 Hit DPS (+20.0%)
  +17.33 Mana Cost per second (+20.0%)   ← in red
  +10.0% Movement Speed Modifier
```

That red line is the point. More mana cost is not an improvement, and
knowing which direction is better is `lowerIsBetter` on the stat: PoB's
judgement, not a sign test.

The mechanism is PoB's own, from behind the tooltips on its checkboxes:
flip the setting, rebuild the mod list, run the misc calculator, flip back,
compare. 5-11 ms. The same helper answers "what would turning this socket
group off cost?" on the Skills tab, because it is the same question.

Two things it was worth being careful about. **The build must come back
exactly as it was**: the change and its undo both run inside one pcall, so
a failure halfway still restores, and `buildFlag` is put back by hand
because the rebuilds set it. Checked by running twenty-five what-ifs in a
row and diffing the whole stat sidebar before and after: nothing moved,
same `outputRevision`, same unsaved flag.

And **"nothing moves" has to be distinguishable from "it broke"**. The
first version swallowed a failed comparison into an empty list, which
looks identical. It reports the failure now, which is how I found out
that disabling a socket group genuinely moves nothing on a build with no
gear, rather than the comparison being broken. I had assumed the latter;
disabling the group for real and watching the numbers not move is what
settled it.

### Custom modifiers

Free text, parsed exactly as an item's mods are, which is how a build
describes something the 663 options have no question for. The blocks are
editable here with their titles and enable flags; what the real tab also
has, and this does not, is the mod browser that helps you write one.

### What it does not do

- **Only the checkboxes answer "what would this change?"** For a list or a
  count there is no "the other way round", so the question needs a value
  the UI does not ask for yet.
- **No config sets beyond switching between them.**
- **No mod browser** for the custom modifier blocks.
- **The filter is local**, over the options already fetched. PoB's own
  search feeds the same visibility closure, so searching there means a
  round trip and a recalculation per keystroke.

## The Calcs tab, and a prediction that was wrong

This file used to say the Calcs tab "was the original argument for this
stack" and would need virtualisation. It measured out otherwise, and the
measurement is the only reason to know:

| | |
|---|---|
| Rows defined in `CalcSections.lua` | 1081 |
| Rows the selected skill actually shows | **210** |
| Payload | 13 kB |
| Engine time to build it | **2-3 ms** |

210 rows is not a virtualisation problem, and neither is the 1081-row
ceiling. TanStack Virtual would have been a dependency bought on a guess.
It is still the right answer if a screen ever needs it; this one does not,
and saying so is worth more than having been right.

What the Calcs tab *does* have that the sidebar did not is **shape**. Most
sections are label/value pairs, but the damage sections are matrices:
damage types across, modifiers down, and PoB asks for three of its columns
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
own header: five values under six headings, each one plausible. Empty
slots are now kept as empty strings.

The Calcs tab also has **its own skill selector**, which is not the
sidebar's. PoB keeps `input.skill_number` separate from
`build.mainSocketGroup` deliberately: the sidebar always reports Effective
DPS for the main skill, while this tab details whichever skill you point it
at. With Entangle as the main skill and Bonestorm selected here, the
sidebar reads 189.5 DPS and the Calcs tab reads 241.4, and both are right.

Because it is the expensive route, it is not polled. `buildMode.outputRevision`
moves on every recalculation, and the app refetches on that.

### Where a number came from

The Calcs tab was a wall of results and nothing else, which is half a
tab. You could read that your hit damage was 112 to 168 and had no way to
find out which of forty modifiers made it so. The desktop one answers that
on a click, and the answer is most of what the tab is for.

None of it needed computing. Every calculation pass already fills
`actor.breakdown` with the working behind each output, and
`CalcBreakdownControl` already turns one cell's worth of that into
sections. So `/calcs/breakdown` drives that control rather than reading
`breakdown` itself: what a cell produces depends on the flags each
descriptor carries, on resolving dotted `ns.name` keys, on sorting and
labelling the tables, and on listing contributing modifiers through four
format functions. `SetBreakdownData` builds its `sectionList` and only
then measures it for drawing, so all of that is readable without drawing
anything.

Cells are addressed by position, because they have no names: the Calcs
tab is literally a nested list of format strings. The reference uses
PoB's own indices rather than the ones this response ends up with, since
rows that format to nothing are dropped on the way out and the two
numberings part company at the first one. 262 of the thousand-odd cells on
a simple build can be explained; the rest are not clickable, because a
screen of dotted underlines would claim otherwise.

| | |
|---|---|
| Cells that can be explained | 262 |
| Reading one | 0 to 1 ms |

The panel is docked beside the board rather than floating over the cell.
PoB's pane can be dragged out of the way; a docked one never needs to be.
It is sticky so it follows a board thousands of pixels long, and it stacks
underneath when there is no room for two columns, scrolling itself into
view so that clicking a cell does not answer somewhere you cannot see.

It rebuilds after every recalculation while open, which is what PoB does
with a pinned pane. Working that describes a build you have since changed
is worse than no working at all, because it reads as current.

Verified in the browser: *Effective DPS Mod* `x 0.5` explains itself as
enemy resistance 50% with the two modifiers that set it, and the base
damage line follows the build from `= 15.0 to 22.0` at gem level 3 to
`= 224.0 to 336.0` at level 20 without the panel closing.

### What it does not do

- **No radius diagram.** PoB draws the area of effect to scale, with the
  range guide behind it; this reports the number.
- **No pop-out.** The real tab can tear a section off into a floating,
  draggable pane, and keep several of them.
- **No collapsing sections**, and no search across the board.
- **The sidebar does not open these.** PoB maps a sidebar stat onto the
  matching Calcs cell and shows the same pane; the mapping exists
  (`BuildBreakdownIndex`) and is not wired up here.

## Import and export, and the zlib that was missing

A build code is base64 of the deflated build XML. Two transforms, both
PoB's, so a code from here opens in the desktop app and a code from the
desktop app or a build site opens here.

Except that neither transform existed. `src/_SimpleGraphic.def.lua` stubs
`Deflate` and `Inflate` to return `""`, with a TODO asking for FFI bindings
to the zlib PoB already ships: the renderer normally provides them, and
nothing headless had needed them. That is a nasty failure to inherit: an
empty string is not an error, so importing a code would have produced a
build that silently did not load.

`bridge/zlib.lua` binds `runtime/zlib1.dll` through LuaJIT's FFI and
installs the result over the stubs at boot, and only over the stubs: a
host that provides real ones keeps them. It is about sixty lines:
`compressBound`/`compress2` one way, `uncompress` the other, with the
output buffer grown on `Z_BUF_ERROR` because zlib never says how big the
answer will be. `src/` stays untouched, which is the point: the bridge
fills in a capability the headless wrapper lacks rather than editing the
engine to suit itself.

```
[bridge] zlib 1.3.1 bound over the headless stubs
```

| | |
|---|---|
| This build as XML | 14,012 bytes |
| As a code | 3,824 chars |
| Round trip | class, ascendancy, level, tree and items all back |

### Reading a code is not fetching one

The paste box accepts a build-site link as well as a bare code, because the
code is the last path segment and trimming it by hand is a silly thing to
ask. **The link is read, never opened.** Fetching it would be sending the
user's build off the machine as a side effect of pasting, and that is a
decision to make explicitly rather than one to infer. The same goes for
character import: PoB can pull a character from the game's API, and this
screen takes the JSON you paste instead, because that request needs your
session and it is yours to make.

So this whole screen works with no network at all.

### What it tells you before it acts

PoB's import box validates as you type and says "Code is valid". Valid is
not the question anyone has. This decodes and reads the `Build` element out
of the XML, so before you commit you see **Infernalist · level 70** and
what the code weighs against what it unpacks to. Importing replaces the
open build outright, which PoB guards with a modal; here the sentence is
next to the button that does it.

The export is tagged with the `outputRevision` it was generated from, so
when the build moves underneath it the code goes away and the screen says
"the build changed: generate it again" rather than offering a stale code
that looks fine.

### What it does not do

- **No fetching from build sites**, per above, and no uploading to them:
  PoB's Share button posts the build to pobb.in and hands back a short
  link.
- **No import as a comparison build**, which PoB offers as a third mode.
- **No local build list.** Builds still open by absolute path through
  `POST /build/open`, and `GetUserPath` is stubbed headless, so there is
  nothing to list. This screen is how a build gets in for now.
- **Gzip is not handled** on the way in. `uncompress` reads the zlib
  wrapper only, and build codes are always zlib, but saying so beats
  appearing to support a format that would come back as a length error.

### Signing in, and the network that was missing

The third of these. zlib was stubbed, the filesystem was stubbed, and so
is the whole network layer: `LaunchSubScript` and `OpenURL` are empty
functions in `src/_SimpleGraphic.def.lua`, and `launch:DownloadPage` is a
Lua *source string* containing `require("lcurl.safe")` that it hands to
the first of them. So `PoEAPI.lua` is intact and inert: `FetchAuthToken`
builds a correct authorize URL and then never gets past its `if id then`.

The first two gaps were filled from `bridge/`, over FFI, because the
thing underneath (zlib1.dll, Win32 `FindFirstFileA`) was already on the
machine and the engine was the only one who needed it. This one is
different. The engine is not the only one who can make an HTTPS request:
the dev server can, natively, with a TLS stack and a socket library it
already has. Rebuilding curl and a subscript host in LuaJIT to avoid
that would be work in service of symmetry rather than anything else.

So the transport lives in `web/plugins/poe-account.ts`, and the import
does not. The character JSON goes to `POST /code/character` exactly as
GGG sent it, and `ImportItemsAndSkills` and `ImportPassiveTreeAndJewels`
read it: the same rule as everywhere else here.

Three constants are copied from PoB rather than chosen, because each one
fails as something else when it is wrong:

- **`client_id=pob`.** PoB's registered public client. A fork cannot mint
  its own without GGG registering it, so this identifies itself as what
  it is: a build of PoB.
- **Redirect ports 49082, 49083, 49084**, with `redirect_uri` of
  `http://localhost:<port>` and *no path* (`src/LaunchServer.lua:11`).
  Those exact origins are what GGG has registered. An ephemeral port, or
  a tidier `/callback`, earns `redirect_uri_mismatch`, which reads like
  a broken client rather than a wrong URL.
- **`Path of Building/<version>`** as the User-Agent, from `manifest.xml`,
  as `Launch.lua:273` sends it.

Signing in is an ordinary link to `/poe/signin`, which sets up PKCE and
redirects. Not a scripted `window.open`: the navigation is then the
user's own click, there is no popup-blocker gap, and the credentials are
typed on GGG's page. The token lives in the dev server's memory (not on
disk, not in the browser, not in a log) so a restart means signing in
again. That is the right trade for a refresh token that can read someone's
account, and it is why the browser is only ever told `authenticated: true`.

### An envelope, and who opens it

`/character/<name>` returns `{"character": {…}}`. PoB's own path unwraps
that (`ImportTab.lua:811`) before importing, but `HeadlessWrapper.lua`'s
`loadBuildFromJSON` hands the top level straight to the importers, which
want `.equipment` and `.passives` on it. Fed the envelope, the import
dies on a nil index and reports only that the JSON was not understood.

So `POST /code/character` opens the envelope if it is there, and passes
an already-unwrapped object through untouched rather than re-encoding it,
which leaves the path that already worked byte-for-byte what it was.
One place knows the shape, and it is the one next to the engine; the
browser forwards bytes.

Worth testing properly, since "both fail identically" is easy to mistake
for a working unwrap. A stub character grown one field at a time fails at
`ImportTab.lua` 1136, then 1245, then 948, then 961, each deeper than the
last, and the enveloped payload tracks the bare one at every step. Only
the unwrap gets the enveloped one past the first.

### What this part does not do

- **No league or realm picker.** `poe2` is hardcoded, as `PoEAPI.lua`'s
  own docstring says it always is.
- **No rate-limit queue.** PoB has a real `TradeQueryRateLimiter`; this
  passes a 429 back with GGG's `retry-after` and says how long to wait.
  Fine for two endpoints a human drives, not fine for anything automated.
- **Dev and preview only.** Like the bridge itself, it is a server-side
  plugin under `apply: 'serve'`; a built app has no Node behind it.
- **Not exercised end to end here.** Everything up to GGG's login is
  verified (the redirect, the PKCE parameters, the port binding, a
  forged `state` being refused, a stray probe not consuming the
  sign-in) but completing a sign-in needs a real account, so the first
  real character import is the first time that half runs.

## The build list, and the filesystem that was missing

The same shape as the zlib problem, one layer further down.

PoB's `Modules/BuildListHelpers` is already UI-free: it is shared by the
startup list and the Compare tab's folder import, and it does the whole
job: scan the folder, read each build's class, ascendancy and level out of
the first 2 kB of the file rather than loading it, sort with folders first
and a natural ordering. Exactly the kind of thing worth calling rather than
rewriting.

It is built entirely on `NewFileSearch`, which the headless wrapper stubs
to return nothing. So it did not fail: it reported an empty folder.

`bridge/fs.lua` supplies `NewFileSearch`, `GetUserPath`, `MakeDir`,
`RemoveDir` and the working-directory pair through LuaJIT's FFI onto the
Win32 calls, and installs them over the stubs. Unlike zlib this is read
*during* startup: `main:Init` asks `GetUserPath()` where the builds live
and gets `""`, so after installing them the bridge asks PoB to redo that
decision through its own `main:ChangeUserPath`, which creates the folders
and reloads settings from them.

```
[bridge] zlib 1.3.1 bound over the headless stubs
[bridge] builds at C:/Users/…/Documents/Path of Building (PoE2)/Builds/
```

That is the folder the desktop app uses, so builds saved here show up
there and the other way round. `POB_USER_PATH` overrides it.

The file search is enumerated eagerly rather than lazily, which is a
deliberate difference from the real host: PoB's scanner recurses into
subfolders *while iterating*, and an OS search handle held open across that
is a good way to end up locking a directory someone is trying to rename.

### A gap this exposed

`POST /build/open` has been loading builds since the bridge existed, and it
was doing it through HeadlessWrapper's `loadBuildFromXML`, which passes
`false` for the file name. A build loaded that way has all its contents and
no file behind it, so Save had nothing to write to, and the list could not
tell which of its entries was the open one. Nothing had noticed, because
until there was a build list there was nothing to notice it with. It calls
`SetMode("BUILD", path, name, xml)` now.

### What it refuses, and why

- **Deleting the open build.** PoB closes it first; deleting the file out
  from under a loaded build leaves the UI pointing at nothing.
- **Deleting anything outside the builds folder**, checked by prefix. That
  check was written as `not a == b` first, which parses as `(not a) == b`
  and would have let every path through: the second Lua precedence trap of
  the day, after `and`/`or`.
- **Saving over an existing name.** PoB's Save As box greys out its own
  button; refusing with the reason is the same answer.

Deleting a build file cannot be undone, so the × only arms the row; the
second click is a button that says what it does.

### What it does not do

- **No renaming or moving.** PoB has `MoveFolder` and `CopyFolder`, both
  built on the same file search, so they would work: they are just not
  wired up.
- **No nested folder creation** beyond the top level, and no folder
  deletion.
- **Windows only.** The FFI calls are Win32, which the dev host already
  was: it is started through a Windows path to `lovec.exe` and stopped with
  `taskkill`. A different host implements this against `dirent` and `stat`,
  or simply keeps the real SimpleGraphic implementations.

## The compare view, and the one place I copied rather than called

A second build, side by side, stat by stat.

The comparison build is a `CompareEntry`: PoB's own "lightweight Build
wrapper for comparison: loads XML, creates tabs, and runs calculations
without setting up the full UI chrome". So the right-hand column is a
second live calculation rather than a stored snapshot of numbers, and
`CompareTab:ImportBuild` builds it and refuses the result if it produced
no output.

| | |
|---|---|
| Payload | 3.3 kB, **0-2 ms** |
| Rows | 27 stats across 47 entries, counting PoB's section breaks |
| Differing | 13 of 27, for a build 22 levels apart from itself |

### The exception

Every other panel in this UI reads something the engine already built: a
`Tooltip`, a `statBox.list`, a control's `shown()`, PoB's own
`ScanFolder`. That has been the rule all the way through, and it is why
these screens are small.

This one breaks it. The side-by-side comparison exists exactly once in the
codebase, inside `CompareTab:DrawStatList` (line 3308), interleaved with
the `DrawString` calls that put it on the screen. There is no data-only
version to call and no sensible way to fake a canvas.

So the bridge transcribes that function: its order, and its skips: the
`SkillDPS` row that does not fit a two-column layout, hidden stats, stats
neither build's active skill uses, table-valued stats, stats that are zero
on both sides, and `condFunc`. Everything *inside* the loop is still the
engine's: `statData.fmt`, the percent/modifier multiplier, `formatNumSep`,
`condFunc`, `lowerIsBetter`. What is duplicated is the sequence, not the
rules. `matchFlags` is copied outright, because it is file-local to
CompareTab.lua and sixteen mechanical lines.

The cost is real and worth stating: **if `DrawStatList` changes, this has
to follow, and nothing will notice on its own.** Every other screen in
this UI gets upstream's changes for free. This one does not.

### Reading the numbers

The delta is `compare − primary`, and green means the comparison build is
better *at that stat*, which is `lowerIsBetter`'s call, not a sign test,
because more resistance is an improvement and more mana cost is not. So a
green row is something you would gain by switching to the build on the
right.

### What it does not do

- **Only the stat summary.** PoB's compare tab also diffs the passive
  tree, the items slot by slot, the skills and the Calcs breakdown, each
  with its own view. This is the summary panel.
- **No "copy this to my build"**, which PoB offers for a spec, an item and
  a jewel.
- **No power report**, PoB's ranked list of which nodes contribute what.
- **The comparison build cannot be edited here.** `CompareEntry` exposes
  `SetActiveSpec`, `SetActiveItemSet` and `SetActiveSkillSet`, so changing
  which of its sets is active would work; none of it is wired up.

## Dialogs, and a key that was the wrong type

PoB answers some commands with a modal rather than by doing the thing:
changing class with an allocated tree, Back with unsaved work, a build that
failed to load. The UI used to report that the engine was waiting and
nothing more, which left **changing class, a basic operation, with no way
through**.

A popup's controls are one mixed table. The array part is the message, one
`LabelControl` per line; the named keys are its buttons. Read that way it
is general: any dialog PoB opens comes through, not only the ones
anticipated here. `enterControl` and `escapeControl` say which button is
the default and which is the way out, so Enter and Escape do what they do
in the desktop app.

Pressing one calls that control's own `Click`, which checks `IsShown` and
`IsEnabled` first, so a button the dialog has greyed out stays greyed out,
and the handler behind it is PoB's.

### The bug worth keeping

The first version worked for `Continue` and silently did nothing for
`Cancel`.

`OpenConfirmPopup`'s three-button layout `t_insert`s two of its buttons, so
their keys are **integers** while `confirm` is a string. They all come out
of JSON as strings, and in Lua `t[4]` and `t["4"]` are different keys. The
lookup found nothing, and "no button called 4" is not a sentence anyone
reads as a type error.

It cost a detour through the wrong hypothesis: I assumed two dialogs were
stacking, because a *second* `setClass` while the first dialog was still
open really does open a second one, which is what the evidence looked like.
Measuring depth per step is what separated the two.

### What it does not do

- **No fields.** A dialog with a text box or a list (Save As, New Folder)
  is reported as needing input, and answering it uses whatever the engine
  already had. The screens that need those have their own commands
  (`saveBuildAs`, `newBuildFolder`) that skip the dialog entirely.
- **Dismiss without answering** closes the dialog without running any of
  its handlers, which is `ClosePopup` and is sometimes the only sensible
  answer. It is deliberately the least prominent button.

## What ships

Everything above was built and checked against `npm run dev`. That is not
the same as checking it works, so:

| | |
|---|---|
| JavaScript | 382 kB, **120 kB gzipped** |
| CSS | 56 kB, **8.5 kB gzipped** |
| Tree artwork | 11 MB, served as static files |
| Build | 1.2 s, or 20 s the first time |

Two things were wrong, and neither would have shown up in development.

**The engine was only wired to the dev server.** `plugins/pob-bridge.ts`
had a `configureServer` hook and nothing else, so `vite preview`, the only
way to run the built app, served the UI with nothing behind it. Every
request a 404, which reads as "the engine is broken" rather than "nobody
wired this up". It has a `configurePreviewServer` now, the same function.

**A build would have shipped a tree of circles.** The artwork extractor ran
on first dev start and never on build, so a fresh checkout's `npm run
build` produced a `dist/` with no `tree-art/` in it. It runs in
`buildStart` now, and that one *does* block: a dev server coming up
instantly while the art lands in the background is right, and a build
quietly omitting part of what it is building is not.

Checked by moving the artwork aside and building: 18.4 s in `buildStart`,
11 MB of `dist/tree-art` afterwards. Then the built app in a browser:
engine live, tree drawn, a config option toggled and the engine
recalculating, and **no console errors at all**, which the dev server
cannot say for itself with its proxy restarting under it.

## The bridge

I had this wrong. The earlier note here said there is no standalone LuaJIT
because it is embedded in `SimpleGraphic.dll`. In fact `runtime/lua51.dll`
**is** LuaJIT 2.1, x64, shipped as its own file, and every native module,
`socket`, `lua-utf8`, `lzip`, `lcurl`, and `SimpleGraphic.dll` itself,
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

Only the bottom two know LÖVE exists, so the shipping host (the existing
exe, or Tauri with mlua) replaces them and keeps the rest.

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
allocated tree, Save As, Back with unsaved work: all open a modal instead
of doing the thing. Over a bridge that is invisible, so the open popup
travels with the state and the UI says what is being waited on rather than
looking hung.

**LÖVE's game-directory argument is read as a build URL.**
`Modules/Main.lua:64` treats `arg[1]` as something to download, so PoB tried
to fetch the bridge directory's own path from a build site, named the build after the
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

- **Ten screens of perhaps a dozen.** Notes and the party/minion views are
  unbuilt. None of them looks harder than what is here.
- **Each screen's own gaps** are listed with that screen above: the tree's
  notable glow, the Items tab's missing crafting interface, the Skills
  tab's gem defaults, the Config tab's per-option comparison, and the
  compare view's tree/items/skills diffs.
- **Six of PoB's eighteen stat-difference tooltips.** The passive tree,
  socket groups, gems, gem quality, flasks and charms, and config
  checkboxes are answered. Still unanswered: the gem picker's per-row
  "selecting this gem will give you", the tree-set switch, the custom
  modifier group, the crafting affix and rune dropdowns, and config
  options that are lists rather than checkboxes. The bridge helper they
  all need is already there, so each is an endpoint and a button.
- **One screen copies rather than calls.** The compare view transcribes
  `CompareTab:DrawStatList`, because that logic exists only inside a draw
  function. It is the only place in this UI that will not track upstream
  on its own.
- **Nothing is virtualised, and on this evidence nothing needs to be.** See
  below; this was the opposite of what this file predicted.
- **Dialogs that ask for typed input** (Save As wants a name and a folder)
  can be answered here only with whatever the engine already had. Their
  buttons work; their fields are not drawn.
- **No renaming or moving builds**, though PoB's own `MoveFolder` would
  work now that the file search does.
- **Rename is in-memory.** `setBuildName` marks the build dirty; it does not
  rename the file, because in PoB the name *is* the file name and renaming
  happens inside Save As.
- **Loadouts are tree specs.** `buildMode.loadoutsList`, the sets linked
  with `{name}` markers, is a richer thing that only exists after
  `SyncLoadouts`, and is not surfaced yet.
- **The dev host is still a game engine.** One command starts it now, but
  LÖVE is a dev-loop convenience; a shipping build replaces `main.lua` and
  `conf.lua` with the real host and keeps `api.lua` and `server.lua`.
- The header needs about 1350px. Past that the loadout picker is dropped;
  below roughly 1150px it will scroll rather than hide anything that
  reports build state.
- No light theme. This is a dark application beside a dark game, and a real
  light theme is work, not a media query.
- Keyboard shortcuts, drag and drop, and the tooltip system are untouched.
