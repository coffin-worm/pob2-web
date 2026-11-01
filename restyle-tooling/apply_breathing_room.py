"""Gives the UI room to breathe: taller top bar, bigger controls, same text.

The reason "make the controls bigger" does not fix PoB's density on its own:
every control derives its text size from its own height. ButtonControl draws
its label at `height - 4`, CheckBoxControl at `size - 4`, DropDownControl at
`height - 4`. So a taller control gets proportionally bigger text and nothing
is gained -- which is exactly what the existing UI-scaling override does, and
why turning it up magnifies the cramped layout instead of relieving it.

So the enabling change is a cap. `ControlFontSize()` clamps label size to
uiStyle.fontSize, which decouples text from box. Only then does a taller
control become whitespace instead of zoom.

Then the top bar goes 32 -> 46 with its controls 20 -> 24, centred at y=11
instead of crammed at y=4.
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


# ---------------------------------------------------------------- the cap
c = os.path.join(ROOT, "Modules", "Common.lua")
t = read(c)
if "ControlFontSize" not in t:
    t = rep(t, "\tradius         = 4,\n",
            "\tradius         = 4,\n\tfontSize       = 16,\n",
            "uiStyle.fontSize")
    t = t.rstrip("\n") + "\n" + '''
-- Control label size, capped. PoB derives text size from control height
-- (ButtonControl used height - 4, and friends), so growing a control grows
-- its text and the layout just zooms. Clamping to uiStyle.fontSize is what
-- turns extra height into whitespace instead of magnification.
function ControlFontSize(height, inset)
\tlocal size = height - (inset or 4)
\tlocal cap = uiStyle.fontSize or 16
\tif size > cap then
\t\treturn cap
\tend
\treturn size
end
'''
    write(c, t)

# -------------------------------------------------------------- the controls
p = os.path.join(ROOT, "Classes", "ButtonControl.lua")
t = read(p)
t = rep(t,
    '\t\tDrawString(x + width / 2, y + 2 - overSize, "CENTER_X", height - 4 + overSize * 2, "VAR", label)',
    '\t\tlocal labelSize = ControlFontSize(height) + overSize * 2\n'
    '\t\tDrawString(x + width / 2, y + (height - labelSize) / 2, "CENTER_X", labelSize, "VAR", label)',
    "ButtonControl label")
write(p, t)

p = os.path.join(ROOT, "Classes", "CheckBoxControl.lua")
t = read(p)
t = rep(t,
    '\t\t\tDrawString(x + size + 5, y + 2, "LEFT", size - 4, "VAR", label)',
    '\t\t\tlocal labelSize = ControlFontSize(size)\n'
    '\t\t\tDrawString(x + size + 5, y + (size - labelSize) / 2, "LEFT", labelSize, "VAR", label)',
    "CheckBox label right")
t = rep(t,
    '\t\t\tDrawString(x - 5, y + 2, "RIGHT_X", size - 4, "VAR", label)',
    '\t\t\tlocal labelSize = ControlFontSize(size)\n'
    '\t\t\tDrawString(x - 5, y + (size - labelSize) / 2, "RIGHT_X", labelSize, "VAR", label)',
    "CheckBox label left")
write(p, t)

p = os.path.join(ROOT, "Classes", "DropDownControl.lua")
t = read(p)
t = rep(t,
    '\tSetViewport(x + 2, y + 2, width - height, lineHeight)\n'
    '\tDrawString(0, 0, "LEFT", lineHeight, "VAR", selLabel or "")',
    '\tlocal selSize = ControlFontSize(height)\n'
    '\tlocal selTop = (lineHeight - selSize) / 2\n'
    '\tSetViewport(x + 2, y + 2, width - height, lineHeight)\n'
    '\tDrawString(0, selTop, "LEFT", selSize, "VAR", selLabel or "")',
    "DropDown selected label")
t = rep(t,
    '\t\tdrawStrikethrough(selLabel, 0, lineHeight)',
    '\t\tdrawStrikethrough(selLabel, selTop, selSize)',
    "DropDown strikethrough")
t = rep(t,
    '\t\tlocal dx = DrawStringWidth(lineHeight, "VAR", selDetail)\n'
    '\t\tDrawString(width - dx - 22, 0, "LEFT", lineHeight, "VAR", selDetail)',
    '\t\tlocal dx = DrawStringWidth(selSize, "VAR", selDetail)\n'
    '\t\tDrawString(width - dx - 22, selTop, "LEFT", selSize, "VAR", selDetail)',
    "DropDown detail")
write(p, t)

# --------------------------------------------------------------- the top bar
BAR, CTRL, CTRL_Y = 46, 24, 11

p = os.path.join(ROOT, "Modules", "Build.lua")
t = read(p)

for old, new, tag in [
    ("\t\ty = 32,\n", "\t\ty = %d,\n" % BAR, "viewport y"),
    ("\t\theight = main.screenH - 32\n", "\t\theight = main.screenH - %d\n" % BAR, "viewport height"),
    ("\tDrawImage(nil, 0, 32, sideBarWidth - 4, main.screenH - 32)\n",
     "\tDrawImage(nil, 0, %d, sideBarWidth - 4, main.screenH - %d)\n" % (BAR, BAR), "sidebar bg"),
    ("\tDrawImage(nil, sideBarWidth - 4, 32, 4, main.screenH - 32)\n",
     "\tDrawImage(nil, sideBarWidth - 4, %d, 4, main.screenH - %d)\n" % (BAR, BAR), "sidebar edge"),
]:
    t = rep(t, old, new, tag)

# Anchors carry the row's y; everything else inherits it.
t = rep(t, 'self.anchorTopBarLeft = new("Control"):Control(nil, { 4, 4, 0, 20 })',
        'self.anchorTopBarLeft = new("Control"):Control(nil, { 4, %d, 0, %d })' % (CTRL_Y, CTRL),
        "anchorTopBarLeft")
t = rep(t, 'self.controls.characterLevel.width + 10 end, 4, 0, 20 })',
        'self.controls.characterLevel.width + 10 end, %d, 0, %d })' % (CTRL_Y, CTRL),
        "anchorTopBarRight")

# Each control, matched with enough prefix to be unique.
for prefix, old_rect, tag in [
    ('self.controls.back = new("ButtonControl"):ButtonControl({ "LEFT", self.anchorTopBarLeft, "RIGHT" }, ',
     '{ 0, 0, 60, 20 }', "back"),
    ('self.controls.save = new("ButtonControl"):ButtonControl({ "LEFT", self.controls.back, "RIGHT" }, ',
     '{ 8, 0, 50, 20 }', "save"),
    ('self.controls.saveAs = new("ButtonControl"):ButtonControl({ "LEFT", self.controls.save, "RIGHT" }, ',
     '{ 8, 0, 70, 20 }', "saveAs"),
    ('self.controls.levelScalingButton = new("ButtonControl"):ButtonControl({ "LEFT", self.controls.pointDisplay, "RIGHT" }, ',
     '{ 8, 0, 50, 20 }', "levelScaling"),
    ('self.controls.characterLevel = new("EditControl"):EditControl({ "LEFT", self.controls.levelScalingButton, "RIGHT" }, ',
     '{ 10, 0, 106, 20 }', "characterLevel"),
    ('self.controls.classDrop = new("DropDownControl"):DropDownControl({ "LEFT", self.controls.characterLevel, "RIGHT" }, ',
     '{ 8, 0, 90, 20 }', "classDrop"),
    ('self.controls.ascendDrop = new("DropDownControl"):DropDownControl({ "LEFT", self.controls.classDrop, "RIGHT" }, ',
     '{ 8, 0, 120, 20 }', "ascendDrop"),
    ('self.controls.buildLoadouts = new("DropDownControl"):DropDownControl({ "LEFT", self.controls.ascendDrop, "RIGHT" }, ',
     '{ 8, 0, 190, 20 }', "buildLoadouts"),
]:
    new_rect = old_rect[:-5] + "%d }" % CTRL
    t = rep(t, prefix + old_rect, prefix + new_rect, tag)

# pointDisplay's rect is computed; only its height literal needs bumping.
t = rep(t,
    'self.controls.pointDisplay = new("Control"):Control({ "LEFT", self.anchorTopBarRight, "RIGHT" }, { function() return getPointDisplayX() end, 0, 0, 20 })',
    'self.controls.pointDisplay = new("Control"):Control({ "LEFT", self.anchorTopBarRight, "RIGHT" }, { function() return getPointDisplayX() end, 0, 0, %d })' % CTRL,
    "pointDisplay")

# The side bar and the build-name chip anchor off hardcoded absolute y values
# tuned for the old 32px bar. Left alone, the side bar starts *inside* the
# taller header and the chip collides with the first row of tab buttons.
t = rep(t,
    'self.controls.buildName = new("Control"):Control({ "LEFT", self.controls.saveAs, "RIGHT" }, { 4, 36, 0, 20 })',
    'self.controls.buildName = new("Control"):Control({ "LEFT", self.controls.saveAs, "RIGHT" }, { 4, 36, 0, %d })' % CTRL,
    "buildName height")
t = rep(t,
    '\t\treturn buildNameConditional() and 60 or 36\n',
    '\t\treturn buildNameConditional() and 72 or 50\n',
    "anchorSideBar y")

# The header's own chrome is painted separately from the viewport: a 28px
# background, a 4px light edge at y=28, and a centre divider. Moving the
# viewport without these leaves the buttons overhanging the painted edge.
# BAR splits as (BAR - EDGE) background + EDGE edge.
EDGE = 4
t = rep(t,
    "\tDrawImage(nil, 0, 0, main.screenW, 28)\n",
    "\tDrawImage(nil, 0, 0, main.screenW, %d)\n" % (BAR - EDGE),
    "header background")
t = rep(t,
    "\tDrawImage(nil, 0, 28, main.screenW, 4)\n",
    "\tDrawImage(nil, 0, %d, main.screenW, %d)\n" % (BAR - EDGE, EDGE),
    "header edge")
t = rep(t,
    "\tDrawImage(nil, main.screenW/2 - 2, 0, 4, 28)\n",
    "\tDrawImage(nil, main.screenW/2 - 2, 0, 4, %d)\n" % (BAR - EDGE),
    "header divider")

# Side-bar tab rows: 20px buttons on a 26px pitch is 6px of air between rows.
# Same treatment as the top bar -- 24px buttons on a 32px pitch -- so the two
# regions share one rhythm instead of each having its own.
ROW_PITCH = 32

for name, anchor, rect, tag in [
    ("modeImport", '{ "TOPLEFT", self.anchorSideBar, "TOPLEFT" }', "{ 0, 0, 134, 20 }", "import"),
    ("modeNotes", '{ "LEFT", self.controls.modeImport, "RIGHT" }', "{ 4, 0, 58, 20 }", "notes"),
    ("modeConfig", '{ "TOPRIGHT", self.anchorSideBar, "TOPLEFT" }', "{ 300, 0, 100, 20 }", "config"),
    ("modeTree", '{ "TOPLEFT", self.anchorSideBar, "TOPLEFT" }', "{ 0, 26, 72, 20 }", "tree"),
    ("modeSkills", '{ "LEFT", self.controls.modeTree, "RIGHT" }', "{ 4, 0, 72, 20 }", "skills"),
    ("modeItems", '{ "LEFT", self.controls.modeSkills, "RIGHT" }', "{ 4, 0, 72, 20 }", "items"),
    ("modeCalcs", '{ "LEFT", self.controls.modeItems, "RIGHT" }', "{ 4, 0, 72, 20 }", "calcs"),
    ("modeParty", '{ "TOPLEFT", self.anchorSideBar, "TOPLEFT" }', "{ 0, 52, 72, 20 }", "party"),
    ("modeCompare", '{ "LEFT", self.controls.modeParty, "RIGHT" }', "{ 4, 0, 72, 20 }", "compare"),
]:
    new_rect = rect[:-5] + "%d }" % CTRL
    if ", 26, " in new_rect:
        new_rect = new_rect.replace(", 26, ", ", %d, " % ROW_PITCH)
    elif ", 52, " in new_rect:
        new_rect = new_rect.replace(", 52, ", ", %d, " % (ROW_PITCH * 2))
    prefix = 'self.controls.%s = new("ButtonControl"):ButtonControl(%s, ' % (name, anchor)
    t = rep(t, prefix + rect, prefix + new_rect, "sidebar " + tag)

# Everything below the tab rows sits at a fixed offset that assumed three
# 20px rows on a 26px pitch (ending at 72). They now end at 88, so the next
# element has to move with them or it lands on top of the last row.
t = rep(t,
    'self.controls.mainSkillLabel = new("LabelControl"):LabelControl({ "TOPLEFT", self.anchorSideBar, "TOPLEFT" }, { 0, 80, 300, 16 }, "^7Main Skill:")',
    'self.controls.mainSkillLabel = new("LabelControl"):LabelControl({ "TOPLEFT", self.anchorSideBar, "TOPLEFT" }, { 0, %d, 300, 16 }, "^7Main Skill:")'
    % (ROW_PITCH * 2 + CTRL + 8),
    "mainSkillLabel y")

# The two skill dropdowns under it are 18px on a 2px gap -- the tightest pair
# in the side bar.
t = rep(t,
    'self.controls.mainSocketGroup = new("DropDownControl"):DropDownControl({ "TOPLEFT", self.controls.mainSkillLabel, "BOTTOMLEFT" }, { 0, 2, 300, 18 }, nil,',
    'self.controls.mainSocketGroup = new("DropDownControl"):DropDownControl({ "TOPLEFT", self.controls.mainSkillLabel, "BOTTOMLEFT" }, { 0, 4, 300, 22 }, nil,',
    "mainSocketGroup")
t = rep(t,
    'self.controls.mainSkill = new("DropDownControl"):DropDownControl({ "TOPLEFT", self.controls.mainSocketGroup, "BOTTOMLEFT" }, { 0, 2, 300, 18 }, nil,',
    'self.controls.mainSkill = new("DropDownControl"):DropDownControl({ "TOPLEFT", self.controls.mainSocketGroup, "BOTTOMLEFT" }, { 0, 4, 300, 22 }, nil,',
    "mainSkill")

write(p, t)

print("FAILURES:" if fails else "breathing room applied cleanly (bar %d, controls %d @ y=%d, rows %d)"
      % (BAR, CTRL, CTRL_Y, ROW_PITCH))
for f in fails:
    print("  - " + f)
