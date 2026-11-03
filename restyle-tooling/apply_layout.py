"""Replaces the top bar's and side bar's hardcoded coordinates with one
derived vocabulary.

Four times now a vertical change has broken the render in a place nothing
pointed at. The header went 32 -> 46 and the tab viewport, the side bar
background, the side bar's own origin, the main-skill label and finally the
header's painted edge each had to be chased down afterwards, every one found
by looking at a screenshot rather than by reading the code. The cause is not
that the numbers are absolute -- `Control.lua` anchors are parent-relative and
accept functions -- it is that the chrome, the controls and the viewports they
bound were each written with their own copy of the same measurement. Nothing
ties the 42 in `DrawImage(nil, 0, 0, main.screenW, 42)` to the 46 in
`tabViewPort.y`, so the two drift apart silently.

So: declare the outer measurements once in `uiLayout` and derive the rest.
After this pass the header's height is one number, and the fill, the edge, the
divider, the control row's vertical centring, the viewport top and the side
bar's origin are all expressions in it.

Most derivations reproduce the current pixel exactly. Two do not, and both are
corrections:

    top bar row y    11 -> 9    centred in the 42px fill (was 11 above, 7
                                below -- an asymmetry nobody chose)
    side bar top     72 -> 82   narrow-window mode only, where the build-name
       (narrow)                 chip moves into the side bar and its row was
                                budgeted 22px instead of a full row

`uiLayout` is read when controls are constructed, not per frame, so changing a
token takes effect when the build is reopened. The chrome draw calls do read it
per frame; that difference only matters if something mutates the table at
runtime, which nothing does.

Run order: after apply_breathing_room.py, whose output this matches.
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


def rep(t, old, new, tag):
    n = t.count(old)
    if n == 0 and new in t:
        return t
    if n != 1:
        fails.append("%s: matched %d (want 1)" % (tag, n))
        return t
    return t.replace(old, new)


# ------------------------------------------------------------- the vocabulary
LAYOUT = '''
-- Layout metrics. The chrome, the controls and the viewports they bound were
-- each written with their own copy of the same measurement, so a change to the
-- top bar's height left two or three sites behind every time and the overhang
-- only showed up in a screenshot. Declare the outer measurements here; derive
-- everything that follows from them.
--
-- Read at control construction, so a token change applies when the build is
-- reopened.
uiLayout = {
\tbarHeight    = 46, -- top bar, including its lower edge
\tsideBarWidth = 312, -- side bar, including its right edge
\trowHeight    = 24, -- one standard control
\tgap          = 8, -- between controls that are not one group
\ttightGap     = 4, -- within a group: segmented tabs, label/field pairs
\tpad          = 4, -- inset from a screen or panel edge
\tedge         = 4, -- the light divider drawn as a region's border
}

-- The painted part of the top bar, above its edge.
function uiLayout.barFill()
\treturn uiLayout.barHeight - uiLayout.edge
end

-- Vertical inset that centres one row of controls in the bar.
function uiLayout.barPadY()
\treturn m_floor((uiLayout.barFill() - uiLayout.rowHeight) / 2)
end

-- Top of one row to the top of the next.
function uiLayout.rowPitch()
\treturn uiLayout.rowHeight + uiLayout.gap
end

-- Offset of row `n` (0-based) within a stack of rows.
function uiLayout.row(n)
\treturn n * uiLayout.rowPitch()
end

-- Usable width inside the side bar, between its padding and its edge.
function uiLayout.sideBarContent()
\treturn uiLayout.sideBarWidth - uiLayout.edge - uiLayout.pad * 2
end

-- Top of the side bar's content. `extraRows` makes room for rows that only
-- appear at some window sizes, such as the build-name chip.
function uiLayout.sideBarTop(extraRows)
\treturn uiLayout.barHeight + uiLayout.pad + uiLayout.row(extraRows or 0)
end

-- The bitmap font atlases exist only at these pixel heights; see
-- runtime/SimpleGraphic/Fonts. Asking for any other size gets a scaled
-- neighbour rather than a hinted face, so snap on purpose instead of by
-- accident -- this is how an 11px label silently became a blurry 10 or 12.
local fontLadder = { 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 56, 64 }

function SnapFontSize(size)
\tif size <= fontLadder[1] then
\t\treturn fontLadder[1]
\tend
\tfor i = 2, #fontLadder do
\t\tlocal step = fontLadder[i]
\t\tif size <= step then
\t\t\tlocal below = fontLadder[i - 1]
\t\t\t-- Ties go to the larger size: between two equally wrong options,
\t\t\t-- the legible one.
\t\t\treturn (size - below < step - size) and below or step
\t\tend
\tend
\treturn fontLadder[#fontLadder]
end
'''

c = os.path.join(ROOT, "Modules", "Common.lua")
t = read(c)
if "uiLayout" not in t:
    t = t.rstrip("\n") + "\n" + LAYOUT
    write(c, t)

# Route the label cap through the ladder, so no control can ask for a size the
# atlases do not have.
t = read(c)
t = rep(t,
    "\tlocal cap = uiStyle.fontSize or 16\n"
    "\tif size > cap then\n"
    "\t\treturn cap\n"
    "\tend\n"
    "\treturn size\n",
    "\tlocal cap = uiStyle.fontSize or 16\n"
    "\tif size > cap then\n"
    "\t\tsize = cap\n"
    "\tend\n"
    "\treturn SnapFontSize(size)\n",
    "ControlFontSize snaps")
write(c, t)

# ---------------------------------------------------------------- the top bar
p = os.path.join(ROOT, "Modules", "Build.lua")
t = read(p)

ROW = "uiLayout.rowHeight"
GAP = "uiLayout.gap"
TIGHT = "uiLayout.tightGap"

# Anchors carry the row's y; every control in the row inherits it.
t = rep(t,
    'self.anchorTopBarLeft = new("Control"):Control(nil, { 4, 11, 0, 24 })',
    'self.anchorTopBarLeft = new("Control"):Control(nil, { uiLayout.pad, uiLayout.barPadY(), 0, %s })' % ROW,
    "anchorTopBarLeft")
# The right group's `+ 10` is how far past the centre divider it starts, not a
# gap between siblings. Tokenising it would couple the whole row's rhythm to
# one piece of centre-line tuning, so it stays a literal.
t = rep(t,
    'self.controls.characterLevel.width + 10 end, 11, 0, 24 })',
    'self.controls.characterLevel.width + 10 end, uiLayout.barPadY(), 0, %s })' % ROW,
    "anchorTopBarRight")

# Each control's rect: the leading number is the gap to its predecessor, the
# trailing one its height.
for prefix, old_rect, new_rect, tag in [
    ('self.controls.back = new("ButtonControl"):ButtonControl({ "LEFT", self.anchorTopBarLeft, "RIGHT" }, ',
     '{ 0, 0, 60,24 }', '{ 0, 0, 60, %s }' % ROW, "back"),
    ('self.controls.save = new("ButtonControl"):ButtonControl({ "LEFT", self.controls.back, "RIGHT" }, ',
     '{ 8, 0, 50,24 }', '{ %s, 0, 50, %s }' % (GAP, ROW), "save"),
    ('self.controls.saveAs = new("ButtonControl"):ButtonControl({ "LEFT", self.controls.save, "RIGHT" }, ',
     '{ 8, 0, 70,24 }', '{ %s, 0, 70, %s }' % (GAP, ROW), "saveAs"),
    ('self.controls.levelScalingButton = new("ButtonControl"):ButtonControl({ "LEFT", self.controls.pointDisplay, "RIGHT" }, ',
     '{ 8, 0, 50,24 }', '{ %s, 0, 50, %s }' % (GAP, ROW), "levelScaling"),
    ('self.controls.characterLevel = new("EditControl"):EditControl({ "LEFT", self.controls.levelScalingButton, "RIGHT" }, ',
     '{ 10, 0, 106,24 }', '{ %s, 0, 106, %s }' % (GAP, ROW), "characterLevel"),
    ('self.controls.classDrop = new("DropDownControl"):DropDownControl({ "LEFT", self.controls.characterLevel, "RIGHT" }, ',
     '{ 8, 0, 90,24 }', '{ %s, 0, 90, %s }' % (GAP, ROW), "classDrop"),
    ('self.controls.ascendDrop = new("DropDownControl"):DropDownControl({ "LEFT", self.controls.classDrop, "RIGHT" }, ',
     '{ 8, 0, 120,24 }', '{ %s, 0, 120, %s }' % (GAP, ROW), "ascendDrop"),
    ('self.controls.buildLoadouts = new("DropDownControl"):DropDownControl({ "LEFT", self.controls.ascendDrop, "RIGHT" }, ',
     '{ 8, 0, 190,24 }', '{ %s, 0, 190, %s }' % (GAP, ROW), "buildLoadouts"),
]:
    t = rep(t, prefix + old_rect, prefix + new_rect, tag)

# pointDisplay's x is computed; only its height is a literal.
t = rep(t,
    'return getPointDisplayX() end, 0, 0, 24 })',
    'return getPointDisplayX() end, 0, 0, %s })' % ROW,
    "pointDisplay height")

# The build-name chip. Its rect y (36) is dead -- the function below overrides
# it -- and a stale number beside a derived vocabulary is what this pass is
# for, so zero it.
t = rep(t,
    'self.controls.buildName = new("Control"):Control({ "LEFT", self.controls.saveAs, "RIGHT" }, { 4, 36, 0, 24 })',
    'self.controls.buildName = new("Control"):Control({ "LEFT", self.controls.saveAs, "RIGHT" }, { uiLayout.tightGap, 0, 0, %s })' % ROW,
    "buildName rect")
# In narrow mode the chip moves out of the top bar and becomes the side bar's
# first row, but its y was a bare 32 -- one row's pitch below a control that
# sits in the header. That put it at y=43, straddling the header's painted
# edge at 42..46, where the side bar background drew over its label and left
# the empty black name box behind. It belongs at the side bar's content top;
# the offset is from its anchor, which is a top-bar control.
t = rep(t,
    '\t\treturn buildNameConditional() and 32 or 0\n',
    '\t\treturn buildNameConditional() and (uiLayout.sideBarTop(0) - uiLayout.barPadY()) or 0\n',
    "buildName y")

# --------------------------------------------------------------- the side bar
t = rep(t,
    'self.anchorSideBar = new("Control"):Control(nil, { 4, 60, 0, 0 })',
    'self.anchorSideBar = new("Control"):Control(nil, { uiLayout.pad, 0, 0, 0 })',
    "anchorSideBar rect")
t = rep(t,
    '\t\treturn buildNameConditional() and 72 or 50\n',
    '\t\treturn uiLayout.sideBarTop(buildNameConditional() and 1 or 0)\n',
    "anchorSideBar y")

for name, anchor, old_rect, new_rect, tag in [
    ("modeImport", '{ "TOPLEFT", self.anchorSideBar, "TOPLEFT" }',
     '{ 0, 0, 134,24 }', '{ 0, uiLayout.row(0), 134, %s }' % ROW, "import"),
    ("modeNotes", '{ "LEFT", self.controls.modeImport, "RIGHT" }',
     '{ 4, 0, 58,24 }', '{ %s, 0, 58, %s }' % (TIGHT, ROW), "notes"),
    ("modeConfig", '{ "TOPRIGHT", self.anchorSideBar, "TOPLEFT" }',
     '{ 300, 0, 100,24 }', '{ uiLayout.sideBarContent(), uiLayout.row(0), 100, %s }' % ROW, "config"),
    ("modeTree", '{ "TOPLEFT", self.anchorSideBar, "TOPLEFT" }',
     '{ 0, 32, 72,24 }', '{ 0, uiLayout.row(1), 72, %s }' % ROW, "tree"),
    ("modeSkills", '{ "LEFT", self.controls.modeTree, "RIGHT" }',
     '{ 4, 0, 72,24 }', '{ %s, 0, 72, %s }' % (TIGHT, ROW), "skills"),
    ("modeItems", '{ "LEFT", self.controls.modeSkills, "RIGHT" }',
     '{ 4, 0, 72,24 }', '{ %s, 0, 72, %s }' % (TIGHT, ROW), "items"),
    ("modeCalcs", '{ "LEFT", self.controls.modeItems, "RIGHT" }',
     '{ 4, 0, 72,24 }', '{ %s, 0, 72, %s }' % (TIGHT, ROW), "calcs"),
    ("modeParty", '{ "TOPLEFT", self.anchorSideBar, "TOPLEFT" }',
     '{ 0, 64, 72,24 }', '{ 0, uiLayout.row(2), 72, %s }' % ROW, "party"),
    ("modeCompare", '{ "LEFT", self.controls.modeParty, "RIGHT" }',
     '{ 4, 0, 72,24 }', '{ %s, 0, 72, %s }' % (TIGHT, ROW), "compare"),
]:
    prefix = 'self.controls.%s = new("ButtonControl"):ButtonControl(%s, ' % (name, anchor)
    t = rep(t, prefix + old_rect, prefix + new_rect, "sidebar " + tag)

t = rep(t,
    '{ "TOPLEFT", self.anchorSideBar, "TOPLEFT" }, { 0, 96, 300, 16 }, "^7Main Skill:")',
    '{ "TOPLEFT", self.anchorSideBar, "TOPLEFT" }, { 0, uiLayout.row(3), uiLayout.sideBarContent(), 16 }, "^7Main Skill:")',
    "mainSkillLabel")

for name, other, tag in [
    ("mainSocketGroup", "mainSkillLabel", "socket group"),
    ("mainSkill", "mainSocketGroup", "main skill"),
]:
    prefix = ('self.controls.%s = new("DropDownControl"):DropDownControl({ "TOPLEFT", self.controls.%s, "BOTTOMLEFT" }, '
              % (name, other))
    t = rep(t, prefix + '{ 0, 4, 300, 22 }',
            prefix + '{ 0, %s, uiLayout.sideBarContent(), 22 }' % TIGHT,
            "sidebar " + tag)

# ------------------------------------------------- the chrome and the viewport
t = rep(t, "\tlocal sideBarWidth = 312\n",
        "\tlocal sideBarWidth = uiLayout.sideBarWidth\n", "sideBarWidth")
t = rep(t, "\t\ty = 46,\n", "\t\ty = uiLayout.barHeight,\n", "viewport y")
t = rep(t, "\t\theight = main.screenH - 46\n",
        "\t\theight = main.screenH - uiLayout.barHeight\n", "viewport height")

t = rep(t,
    "\tDrawImage(nil, 0, 0, main.screenW, 42)\n",
    "\tDrawImage(nil, 0, 0, main.screenW, uiLayout.barFill())\n", "header fill")
t = rep(t,
    "\tDrawImage(nil, 0, 42, main.screenW, 4)\n",
    "\tDrawImage(nil, 0, uiLayout.barFill(), main.screenW, uiLayout.edge)\n", "header edge")
t = rep(t,
    "\tDrawImage(nil, main.screenW/2 - 2, 0, 4, 42)\n",
    "\tDrawImage(nil, main.screenW/2 - uiLayout.edge / 2, 0, uiLayout.edge, uiLayout.barFill())\n",
    "header divider")

t = rep(t,
    "\tDrawImage(nil, 0, 46, sideBarWidth - 4, main.screenH - 46)\n",
    "\tDrawImage(nil, 0, uiLayout.barHeight, sideBarWidth - uiLayout.edge, main.screenH - uiLayout.barHeight)\n",
    "sidebar fill")
t = rep(t,
    "\tDrawImage(nil, sideBarWidth - 4, 46, 4, main.screenH - 46)\n",
    "\tDrawImage(nil, sideBarWidth - uiLayout.edge, uiLayout.barHeight, uiLayout.edge, main.screenH - uiLayout.barHeight)\n",
    "sidebar edge")

# The stat bar asked for an 11px label, which is not on the atlas ladder, so it
# was rendering as a scaled neighbour. 12 is the nearest real size.
t = rep(t, "\tlocal STAT_LABEL, STAT_VALUE = 11, 14\n",
        "\tlocal STAT_LABEL, STAT_VALUE = 12, 14\n", "stat label size")

write(p, t)

print("FAILURES:" if fails else "layout vocabulary applied cleanly")
for f in fails:
    print("  - " + f)
