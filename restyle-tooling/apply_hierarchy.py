"""Gives buttons a role-based treatment instead of one uniform look.

Every control currently gets the same border, fill and radius, which flattens
the hierarchy: the active tab is drawn exactly like a hovered one, so `Tree`
and `Skills` are nearly indistinguishable and nothing tells you where you are.

The role signal already exists in the data. `locked` is set as a function on
every button that belongs to a selection group (the mode tabs, the weapon-swap
pair, the item-DB pair, Compare's sub-tabs) and left unset everywhere else, so
`GetProperty("locked")` gives three states:

    nil    a plain action button   -- Save, Back, Dismiss
    false  an unselected group member
    true   the selected one

Treatment follows: the selected member is the one element allowed to look like
a distinct raised object; its siblings recede to near-flat with muted labels;
plain action buttons keep the neutral middle. Selection then reads at a glance
rather than being a 0.06 difference in fill.
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


# ------------------------------------------------------------------ tokens
c = os.path.join(ROOT, "Modules", "Common.lua")
t = read(c)
if "fillSelected" not in t:
    t = rep(t,
        "\tfillFieldFocus = { 0.11, 0.11, 0.13 },\n",
        "\tfillFieldFocus = { 0.11, 0.11, 0.13 },\n"
        "\t-- Selection group: the chosen member lifts, its siblings recede.\n"
        "\tfillSelected   = { 0.24, 0.24, 0.28 },\n"
        "\tfillQuiet      = { 0.055, 0.055, 0.065 },\n"
        "\tborderQuiet    = { 0.17, 0.17, 0.19 },\n"
        "\t-- Label colours, so text carries hierarchy alongside the surface.\n"
        "\ttext           = { 0.92, 0.92, 0.94 },\n"
        "\ttextStrong     = { 1.00, 1.00, 1.00 },\n"
        "\ttextMuted      = { 0.60, 0.60, 0.65 },\n"
        "\ttextDisable    = { 0.35, 0.35, 0.37 },\n",
        "uiStyle selection tokens")
    write(c, t)

# ------------------------------------------------------------------ buttons
p = os.path.join(ROOT, "Classes", "ButtonControl.lua")
t = read(p)

t = rep(t,
    '\tlocal locked = self:GetProperty("locked")\n'
    '\tif not enabled then\n'
    '\t\tSetUIColor("borderDisable")\n'
    '\telseif mOver or locked then\n'
    '\t\tSetUIColor("borderHover")\n'
    '\telse\n'
    '\t\tSetUIColor("border")\n'
    '\tend\n'
    '\tDrawRoundRect(x, y, width, height)\n'
    '\tif not enabled then\n'
    '\t\tSetUIColor("fillDisable")\n'
    '\telseif self.clicked and mOver then\n'
    '\t\tSetUIColor("fillPressed")\n'
    '\telseif mOver or locked then\n'
    '\t\tSetUIColor("fillHover")\n'
    '\telse\n'
    '\t\tSetUIColor("fill")\n'
    '\tend\n'
    '\tDrawRoundRect(x + 1, y + 1, width - 2, height - 2)\n',

    '\tlocal locked = self:GetProperty("locked")\n'
    '\t-- nil = plain action button, false = unselected group member,\n'
    '\t-- true = the selected one. See restyle-tooling/apply_hierarchy.py.\n'
    '\tlocal inGroup = locked ~= nil\n'
    '\tif not enabled then\n'
    '\t\tSetUIColor("borderDisable")\n'
    '\telseif locked then\n'
    '\t\tSetUIColor("borderActive")\n'
    '\telseif mOver then\n'
    '\t\tSetUIColor("borderHover")\n'
    '\telseif inGroup then\n'
    '\t\tSetUIColor("borderQuiet")\n'
    '\telse\n'
    '\t\tSetUIColor("border")\n'
    '\tend\n'
    '\tDrawRoundRect(x, y, width, height)\n'
    '\tif not enabled then\n'
    '\t\tSetUIColor("fillDisable")\n'
    '\telseif self.clicked and mOver then\n'
    '\t\tSetUIColor("fillPressed")\n'
    '\telseif locked then\n'
    '\t\tSetUIColor("fillSelected")\n'
    '\telseif mOver then\n'
    '\t\tSetUIColor("fillHover")\n'
    '\telseif inGroup then\n'
    '\t\tSetUIColor("fillQuiet")\n'
    '\telse\n'
    '\t\tSetUIColor("fill")\n'
    '\tend\n'
    '\tDrawRoundRect(x + 1, y + 1, width - 2, height - 2)\n',
    "ButtonControl surface")

t = rep(t,
    '\tif enabled then\n'
    '\t\tSetDrawColor(1, 1, 1)\n'
    '\telse\n'
    '\t\tSetDrawColor(0.33, 0.33, 0.33)\n'
    '\tend\n'
    '\tlocal label = self:GetProperty("label")\n',

    '\tif not enabled then\n'
    '\t\tSetUIColor("textDisable")\n'
    '\telseif locked or mOver then\n'
    '\t\tSetUIColor("textStrong")\n'
    '\telseif inGroup then\n'
    '\t\tSetUIColor("textMuted")\n'
    '\telse\n'
    '\t\tSetUIColor("text")\n'
    '\tend\n'
    '\tlocal label = self:GetProperty("label")\n',
    "ButtonControl label")

write(p, t)

print("FAILURES:" if fails else "hierarchy applied cleanly")
for f in fails:
    print("  - " + f)
