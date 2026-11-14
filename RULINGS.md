# Rulings

Mechanics that were measured rather than assumed, and mistakes that were
corrected. One entry per ruling, newest last, each with how it was
established, so a later reader can disbelieve it cheaply.

This file is in the repository on purpose. `MCP-COLLAB.md` is a working log
between two sessions and is ignored; this is what survives it.

A ruling belongs here when all three hold: it was surprising, it was checked
against the engine or the game rather than reasoned from modifier text, and
getting it wrong would change advice. Anything PoB's own README or this
repository's READMEs already say does not need repeating here.

---

## Weapon set points are discounted in pairs, not individually

PoB's passive counter is `PointsUsed - min(setI, setII)`
(`Build.lua:1092`, drawn at `:1127`). A weapon set point buys one slot
allocated differently in each set, so a point spent into set I alone pairs
with nothing and comes out of the shared pool.

Allocating fourteen nodes with `weaponSet=1` therefore moves the passive
count by fourteen as well. Nothing is charged twice, and filling the other
set hands those points back one for one.

**Measured 2026-11-13** on a throwaway engine: one node to set I gave
passives 1, set I 1. Twelve more to set II gave passives 12, not 13.
Thirteen against twelve gave 13. An import with 24 and 24 is discounted all
24, which is why its set nodes look free while freshly allocated ones do
not.

A route allocated normally that runs back through set nodes retags them to
the shared pool, which moves both counters at once and is not a refund.

## A skill is calculated on one stat set at a time

A granted effect can declare several stat sets, and PoB calculates the
selected one and no other. Essence Drain has `Projectile` and `Damage over
Time` (`act_int.lua:6511`), the second carrying
`base_chaos_damage_to_deal_per_minute`.

So a chaos damage over time build read on its projectile reports the hit
alone, and anything ranked on those numbers scores duration, Wither and the
damage over time passives at zero. The zero is the wrong question, not an
answer.

**Measured 2026-11-13** on a level 67 Lich: projectile 1,233.3 DPS, damage
over time 3,386.5. `pob_build` now names the set it is measuring, and
`pob_set_main_skill statSet=` moves it.

## PoB lands every character import on the Endgame resistance penalty

`EstimatePlayerProgress` records its answer as a string in `build.Act`
(`Build.lua:1124`), and the import reads it back expecting a number for the
act case (`ImportTab.lua:992-1000`). `"Act 5"` matches neither branch, so
the index stays at the 7 it was initialised with: Endgame, which is 60% off
every elemental resistance.

A character partway through the campaign therefore imports with resistances
sixty points below the game's, which reads as the whole build being wrong
rather than as one dropdown being wrong.

**Measured 2026-11-11** against a real account import, and corrected on both
import paths in the bridge. Confirmed by the character's owner against the
game's own numbers.
