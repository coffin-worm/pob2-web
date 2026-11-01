"""Rebuilds the build-mode top stat bar as a modern segmented readout.

Before: one monospace string, four unlabelled number pairs, a 1px white
border over pure black. You had to already know that the third pair is
weapon set II.

After: four labelled segments separated by hairline dividers, with a type
hierarchy -- muted 9px label, bright 14px value -- inside the restyle's
rounded surface. Colour is reserved for meaning: a segment goes red only
when it is over budget.

The control keeps its height (20px), because the top bar's other controls
share that row and a taller box would collide with the viewport below.
"""

import io, os

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
fails = []
CRLF = {}


def read(p):
    with io.open(p, encoding="utf-8", newline="") as f:
        t = f.read()
    CRLF[p] = "\r\n" in t
    return t.replace("\r\n", "\n")


def write(p, t):
    if CRLF.get(p):
        t = t.replace("\n", "\r\n")
    with io.open(p, "w", encoding="utf-8", newline="") as f:
        f.write(t)


def rep(text, old, new, tag):
    n = text.count(old)
    if n == 0 and new in text:
        return text
    if n != 1:
        fails.append("%s: matched %d times (want 1)" % (tag, n))
        return text
    return text.replace(old, new)


OLD_DRAW = (
    '\tself.controls.pointDisplay.width = function(control)\n'
    '\t\treturn DrawStringWidth(16, "FIXED", control.str) + 8\n'
    '\tend\n'
    '\tself.controls.pointDisplay.Draw = function(control)\n'
    '\t\tlocal x, y = control:GetPos()\n'
    '\t\tlocal width, height = control:GetSize()\n'
    '\t\tSetDrawColor(1, 1, 1)\n'
    '\t\tDrawImage(nil, x, y, width, height)\n'
    '\t\tSetDrawColor(0, 0, 0)\n'
    '\t\tDrawImage(nil, x + 1, y + 1, width - 2, height - 2)\n'
    '\t\tSetDrawColor(1, 1, 1)\n'
    '\t\tDrawString(x + 4, y + 2, "LEFT", 16, "FIXED", control.str)\n'
)

NEW_DRAW = (
    '\t-- Segmented stat readout. Each segment is { label, value, over }.\n'
    '\tlocal STAT_PAD, STAT_GAP = 9, 8\n'
    '\tlocal STAT_LABEL, STAT_VALUE = 11, 14\n'
    '\n'
    '\tlocal function statSegWidth(seg)\n'
    '\t\treturn DrawStringWidth(STAT_LABEL, "VAR BOLD", seg.label) + 6\n'
    '\t\t     + DrawStringWidth(STAT_VALUE, "VAR", seg.value)\n'
    '\tend\n'
    '\n'
    '\tself.controls.pointDisplay.width = function(control)\n'
    '\t\tlocal segs = control.segs\n'
    '\t\tif not segs or #segs == 0 then\n'
    '\t\t\treturn 180\n'
    '\t\tend\n'
    '\t\tlocal w = STAT_PAD * 2\n'
    '\t\tfor i, seg in ipairs(segs) do\n'
    '\t\t\tw = w + statSegWidth(seg)\n'
    '\t\t\tif i < #segs then\n'
    '\t\t\t\tw = w + STAT_GAP * 2 + 1\n'
    '\t\t\tend\n'
    '\t\tend\n'
    '\t\treturn w\n'
    '\tend\n'
    '\tself.controls.pointDisplay.Draw = function(control)\n'
    '\t\tlocal x, y = control:GetPos()\n'
    '\t\tlocal width, height = control:GetSize()\n'
    '\t\tSetUIColor("border")\n'
    '\t\tDrawRoundRect(x, y, width, height)\n'
    '\t\tSetUIColor("fill")\n'
    '\t\tDrawRoundRect(x + 1, y + 1, width - 2, height - 2)\n'
    '\t\tlocal valueTop = y + (height - STAT_VALUE) / 2 - 1\n'
    '\t\tlocal labelTop = valueTop + m_floor((STAT_VALUE - STAT_LABEL) * 0.8 + 0.5)\n'
    '\t\tlocal cx = x + STAT_PAD\n'
    '\t\tfor i, seg in ipairs(control.segs or {}) do\n'
    '\t\t\tSetDrawColor(0.62, 0.62, 0.67)\n'
    '\t\t\tDrawString(cx, labelTop, "LEFT", STAT_LABEL, "VAR BOLD", seg.label)\n'
    '\t\t\tcx = cx + DrawStringWidth(STAT_LABEL, "VAR BOLD", seg.label) + 6\n'
    '\t\t\tif seg.over then\n'
    '\t\t\t\tSetDrawColor(0.88, 0.33, 0.33)\n'
    '\t\t\telse\n'
    '\t\t\t\tSetDrawColor(0.93, 0.93, 0.95)\n'
    '\t\t\tend\n'
    '\t\t\tDrawString(cx, valueTop, "LEFT", STAT_VALUE, "VAR", seg.value)\n'
    '\t\t\tcx = cx + DrawStringWidth(STAT_VALUE, "VAR", seg.value)\n'
    '\t\t\tif i < #control.segs then\n'
    '\t\t\t\tcx = cx + STAT_GAP\n'
    '\t\t\t\tSetUIColor("border")\n'
    '\t\t\t\tDrawImage(nil, cx, y + 5, 1, height - 10)\n'
    '\t\t\t\tcx = cx + 1 + STAT_GAP\n'
    '\t\t\tend\n'
    '\t\tend\n'
)

OLD_STR = (
    '\t\tself.controls.pointDisplay.str = string.format(\n'
    '\t\t\t"%s%3d / %3d %s%2d / %2d %s%2d / %2d   %s%d / %d",\n'
    '\t\t\tnormalPassives > usedMax and colorCodes.NEGATIVE or "^7",\n'
    '\t\t\tnormalPassives, usedMax,\n'
    '\t\t\tcolorCodes.NEGATIVE,\n'
    '\t\t\tweaponSet1Used, maxWeaponSets + extraWeaponSets,\n'
    '\t\t\tcolorCodes.POSITIVE,\n'
    '\t\t\tweaponSet2Used, maxWeaponSets + extraWeaponSets,\n'
    '\t\t\tAscUsed > ascMax and colorCodes.NEGATIVE or "^7",\n'
    '\t\t\tAscUsed, ascMax\n'
    '\t\t)\n'
)

NEW_STR = (
    '\t\tlocal weaponMax = maxWeaponSets + extraWeaponSets\n'
    '\t\tself.controls.pointDisplay.segs = {\n'
    '\t\t\t{ label = "Passives", value = normalPassives .. "/" .. usedMax,\n'
    '\t\t\t  over = normalPassives > usedMax },\n'
    '\t\t\t{ label = "Set I", value = weaponSet1Used .. "/" .. weaponMax,\n'
    '\t\t\t  over = weaponSet1Used > weaponMax },\n'
    '\t\t\t{ label = "Set II", value = weaponSet2Used .. "/" .. weaponMax,\n'
    '\t\t\t  over = weaponSet2Used > weaponMax },\n'
    '\t\t\t{ label = "Asc", value = AscUsed .. "/" .. ascMax,\n'
    '\t\t\t  over = AscUsed > ascMax },\n'
    '\t\t}\n'
)

p = os.path.join(ROOT, "Modules", "Build.lua")
t = read(p)
t = rep(t, OLD_DRAW, NEW_DRAW, "pointDisplay width+Draw")
t = rep(t, OLD_STR, NEW_STR, "pointDisplay content")
write(p, t)

print("FAILURES:" if fails else "stat bar rebuilt cleanly")
for f in fails:
    print("  - " + f)
