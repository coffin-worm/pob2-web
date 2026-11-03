"""Puts the Items tab on the shared layout vocabulary.

The Items screen is the densest in PoB and the one that reads as most
cramped, but the cause is not what it looks like. Its controls are already
chained with anchors -- `{ "TOPLEFT", prev, "BOTTOMLEFT" }` with the gap in
the rect -- so the pitch is derived, not hardcoded. What is hardcoded is the
*same measurement in two places*: the rows are 20px with a 4px gap, and the
section height functions then compute their own extent as `rows * 24 + 4`
with 24 written out by hand, fourteen times. Change the row size and every
one of those is wrong, silently, because a section that reports the wrong
height just clips or leaves a hole.

The second defect is that the two regions disagree. The item-slot list runs
20px rows on a 2px gap (pitch 22) while the item editor runs the same rows
on a 4px gap (pitch 24). Nothing chose that; they were written at different
times. Unifying them on one pitch is most of what "give it breathing room"
means here -- the slot list gains 2px per row and the two halves of the
screen finally share a rhythm.

So this pass:

  * adds rowDense / rowCompact / stackGap / hugGap and densePitch() to
    uiLayout, beside the primary rowHeight the top bar uses -- a dense
    scrolling property editor wants a smaller row than a toolbar, and
    pretending otherwise is how you get a 24px dropdown in a list of forty
  * rewrites the rects between the tab's first and last layout control to
    name those tokens
  * replaces the fourteen hand-written pitch constants with densePitch()

Heights outside the scale (18px sliders, 14px labels, the fixed panel sizes)
are left alone: they are one-offs, and inventing a token per one-off is how
a vocabulary stops being one.

Scope is the tab's own layout, lines ~150-1200. The popup dialogs further
down the file are shared with other tabs and have their own geometry.

Run order: after apply_layout.py, which this depends on for uiLayout.
"""

import io, os, re

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


def rep(t, old, new, tag, want=1):
    n = t.count(old)
    if n == 0 and new in t:
        return t
    if n != want:
        fails.append("%s: matched %d (want %d)" % (tag, n, want))
        return t
    return t.replace(old, new)


# ------------------------------------------------------------- the vocabulary
c = os.path.join(ROOT, "Modules", "Common.lua")
t = read(c)

if "rowDense" not in t:
    t = rep(t,
        "\trowHeight    = 24, -- one standard control\n",
        "\trowHeight    = 24, -- one standard control\n"
        "\trowDense     = 20, -- a row inside a dense scrolling panel\n"
        "\trowCompact   = 16, -- an inline label beside a field\n"
        "\tstackGap     = 4, -- between stacked rows in a dense panel\n"
        "\thugGap       = 2, -- between a label and the field it labels\n",
        "uiLayout dense tokens")
    t = rep(t,
        "-- Offset of row `n` (0-based) within a stack of rows.\n",
        "-- Top of one dense row to the top of the next. The section height\n"
        "-- functions in ItemsTab budget their extent in these.\n"
        "function uiLayout.densePitch()\n"
        "\treturn uiLayout.rowDense + uiLayout.stackGap\n"
        "end\n"
        "\n"
        "-- A sub-row tucked under its parent: the affix range slider that\n"
        "-- appears beneath its affix dropdown.\n"
        "function uiLayout.subRowPitch()\n"
        "\treturn uiLayout.rowCompact + uiLayout.stackGap\n"
        "end\n"
        "\n"
        "-- Offset of row `n` (0-based) within a stack of rows.\n",
        "uiLayout.densePitch")
    write(c, t)

# ------------------------------------------------------------------ the rects
p = os.path.join(ROOT, "Classes", "ItemsTab.lua")
t = read(p)
lines = t.split("\n")

CTRL = re.compile(
    r'new\("(?:Button|DropDown|Edit|CheckBox|Slider|Label|ScrollBar)Control"\)'
    r':\w+Control\('
    # The anchor may carry a fourth element, the collapse flag.
    r'(?P<anchor>nil|\{ "(?P<pt>[A-Z]+)", .+?, "(?P<opt>[A-Z]+)"'
    r'(?:, (?:true|false))? \})'
    r', \{ (?P<x>-?\d+), (?P<y>-?\d+), (?P<w>\d+), (?P<h>\d+) \}')

HEIGHTS = {"20": "uiLayout.rowDense", "16": "uiLayout.rowCompact"}
# A gap between stacked rows, and a gap between controls sitting side by side.
STACK = {"2": "uiLayout.stackGap", "4": "uiLayout.stackGap", "8": "uiLayout.gap"}
INLINE = {"2": "uiLayout.tightGap", "4": "uiLayout.tightGap", "8": "uiLayout.gap"}
# A label anchored to the left of its field keeps hugging it.
HUG = {"-2": "-uiLayout.hugGap"}

# Bounds: the tab's own layout, between its first control and the scroll bars.
# Everything after is popup dialogs shared with other tabs.
START = next(i for i, l in enumerate(lines) if "self.controls.setSelect" in l)
END = next(i for i, l in enumerate(lines) if "self.controls.scrollBarV" in l)

counts = {"height": 0, "stack": 0, "inline": 0, "hug": 0}


def convert(m):
    x, y, h = m.group("x"), m.group("y"), m.group("h")
    pt, opt = m.group("pt"), m.group("opt")
    nx, ny, nh = x, y, h

    if h in HEIGHTS:
        nh = HEIGHTS[h]
        counts["height"] += 1

    if pt and opt:
        if pt.startswith("TOP") and opt.startswith("BOTTOM") and y in STACK:
            ny = STACK[y]
            counts["stack"] += 1
        elif ((pt == "LEFT" and opt == "RIGHT")
              or (pt == "TOPLEFT" and opt == "TOPRIGHT")) and x in INLINE:
            nx = INLINE[x]
            counts["inline"] += 1
        elif pt == "RIGHT" and opt == "LEFT" and x in HUG:
            nx = HUG[x]
            counts["hug"] += 1

    return m.group(0).replace(
        "{ %s, %s, %s, %s }" % (x, y, m.group("w"), h),
        "{ %s, %s, %s, %s }" % (nx, ny, m.group("w"), nh))


for i in range(START, END + 1):
    lines[i] = CTRL.sub(convert, lines[i])

t = "\n".join(lines)

# One construction wraps its rect onto a continuation line, so the line-scoped
# pass above cannot see its anchor. Same control, same treatment.
t = rep(t,
    '\t\t{ 8, 0, 100, 20 }, "Buy similar", function()\n',
    '\t\t{ uiLayout.tightGap, 0, 100, uiLayout.rowDense }, "Buy similar", function()\n',
    "buy similar rect")

# ------------------------------------------------------- the pitch arithmetic
# Every one of these is "one dense row's worth of vertical space", written as
# a bare 24 because nothing named it.
PITCH = "uiLayout.densePitch()"

t = rep(t, "\t\t\treturn rows > 0 and rows * 24 + 4 or 0\n",
        "\t\t\treturn rows > 0 and rows * %s + uiLayout.stackGap or 0\n" % PITCH,
        "variant section rows")

for field in ["variantList", "baseList", "hasAltVariant", "hasAltVariant2",
              "hasAltVariant3", "hasAltVariant4", "hasAltVariant5"]:
    t = rep(t, "(self.displayItem.%s and 24 or 0)" % field,
            "(self.displayItem.%s and %s or 0)" % (field, PITCH),
            "variant section " + field)

t = rep(t, "\t\treturn self.controls.displayItemVersion:IsShown() and 24 or 0\n",
        "\t\treturn self.controls.displayItemVersion:IsShown() and %s or 0\n" % PITCH,
        "version row height")
t = rep(t, "\t\ty = y + (self.controls.displayItemBaseVariant:IsShown() and 24 or 0)\n",
        "\t\ty = y + (self.controls.displayItemBaseVariant:IsShown() and %s or 0)\n" % PITCH,
        "base variant offset")
t = rep(t, "\t\ty = y + (self.controls.displayItemVersion:IsShown() and 24 or 0)\n",
        "\t\ty = y + (self.controls.displayItemVersion:IsShown() and %s or 0)\n" % PITCH,
        "version offset")

# The rune and affix sections accumulate a row at a time.
t = rep(t, "\t\t\t\th = h + 24\n", "\t\t\t\th = h + %s\n" % PITCH,
        "rune/affix row accumulate", want=2)

# The same pitch again, this time inside the rows' own y functions, where it
# had been written as a bare 24 a second time.
t = rep(t, "\t\t\treturn i == 1 and 0 or 24\n",
        "\t\t\treturn i == 1 and 0 or %s\n" % PITCH, "rune row y")

# An affix row is taller when its range slider is showing. That slider is a
# 16px control on a 4px gap, and both this budget and the section's
# accumulator spelled the total as 18 -- correct only while the gap was 2.
SUB = "uiLayout.subRowPitch()"
t = rep(t,
    "\t\t\treturn i == 1 and 0 or 24 + (prev.slider:IsShown() and 18 or 0)\n",
    "\t\t\treturn i == 1 and 0 or %s + (prev.slider:IsShown() and %s or 0)\n" % (PITCH, SUB),
    "affix row y")
t = rep(t, "\t\t\t\t\th = h + 18\n", "\t\t\t\t\th = h + %s\n" % SUB,
        "affix slider accumulate")

# Scroll extent: the bottom of the last slot plus one row of padding.
t = rep(t, "\t\tlocal maxY = select(2, self.lastSlot:GetPos()) + 24\n",
        "\t\tlocal maxY = select(2, self.lastSlot:GetPos()) + %s\n" % PITCH,
        "slot scroll extent")

# The equipped-item slots take their position as positional arguments rather
# than a rect, so the pass above cannot see them -- which is why the slot list
# kept its own 22px pitch while the editor beside it moved to 24.
t = rep(t, ", 0, 2, self,", ", 0, uiLayout.stackGap, self,", "slot rows", want=4)

write(p, t)

# The section containers are plain Controls whose height is a function, so
# the rect pass cannot see them. Only the first carries a gap -- the rest
# stack flush and pad themselves -- and it separates the button row above
# from the editor below.
t = rep(t,
    'self.controls.displayItemSectionVariant = new("Control"):Control({ "TOPLEFT", self.controls.addDisplayItem, "BOTTOMLEFT" }, { 0, 8, 0, function()',
    'self.controls.displayItemSectionVariant = new("Control"):Control({ "TOPLEFT", self.controls.addDisplayItem, "BOTTOMLEFT" }, { 0, uiLayout.gap, 0, function()',
    "first section gap")

write(p, t)

# --------------------------------------------------------- the slot control
p = os.path.join(ROOT, "Classes", "ItemSlotControl.lua")
t = read(p)

t = rep(t, "\tself:DropDownControl(anchor, {x, y, 310, 20}, { }, function(index, value)",
        "\tself:DropDownControl(anchor, {x, y, 310, uiLayout.rowDense}, { }, function(index, value)",
        "slot row height")
t = rep(t,
    '{"LEFT",self,"RIGHT"}, {2, 0, 20, 20}, "~"',
    '{"LEFT",self,"RIGHT"}, {uiLayout.hugGap, 0, uiLayout.rowDense, uiLayout.rowDense}, "~"',
    "slot note button")
t = rep(t,
    '{ "RIGHT", self, "LEFT" }, { -2, 0, 20 }, nil, function(state)',
    '{ "RIGHT", self, "LEFT" }, { -uiLayout.hugGap, 0, uiLayout.rowDense }, nil, function(state)',
    "slot activate checkbox", want=2)

# Where a slot has an activation checkbox, its label is pushed left past it.
# -24 is the checkbox's own width plus the gap on either side, so it has to
# move when the row does or the two overlap.
t = rep(t, "\t\tself.labelOffset = -24\n",
        "\t\tself.labelOffset = -(uiLayout.rowDense + uiLayout.hugGap * 2)\n",
        "slot label offset with checkbox", want=2)
t = rep(t, "\t\tself.labelOffset = -2\n",
        "\t\tself.labelOffset = -uiLayout.hugGap\n",
        "slot label offset plain")

# The slot's own label never went through the font cap, so it still scales
# with the row -- the one control apply_breathing_room.py did not reach,
# because it draws its label itself rather than through DropDownControl.
t = rep(t,
    '\tDrawString(x + self.labelOffset, y + 2, "RIGHT_X", height - 4, "VAR", "^7"..self.label..":")\n',
    '\tlocal labelSize = ControlFontSize(height)\n'
    '\tDrawString(x + self.labelOffset, y + (height - labelSize) / 2, "RIGHT_X", labelSize, "VAR", "^7"..self.label..":")\n',
    "slot label size")

write(p, t)

print("FAILURES:" if fails else
      "items layout applied cleanly (%d heights, %d stack gaps, %d inline gaps, %d hugs)"
      % (counts["height"], counts["stack"], counts["inline"], counts["hug"]))
for f in fails:
    print("  - " + f)
