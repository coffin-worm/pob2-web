import io, os, re

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src")
CLS = os.path.join(ROOT, "Classes")
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


def rep(text, old, new, want, tag):
    got = text.count(old)
    if got != want:
        fails.append("%s: expected %d match(es), found %d" % (tag, want, got))
        return text
    return text.replace(old, new)


def fn_slice(text, header, tag):
    i = text.find(header)
    if i < 0:
        fails.append("%s: function header not found" % tag)
        return None
    j = text.find("\nfunction ", i + 1)
    if j < 0:
        j = len(text)
    return (i, j)


# ---------- 1. central style table ----------
g = os.path.join(ROOT, "Data", "Global.lua")
t = read(g)
if "uiStyle" not in t:
    style = (
        "uiStyle = {\n"
        "\tborder         = { 0.28, 0.28, 0.31 },\n"
        "\tborderHover    = { 0.46, 0.46, 0.51 },\n"
        "\tborderActive   = { 0.60, 0.60, 0.66 },\n"
        "\tborderDisable  = { 0.16, 0.16, 0.17 },\n"
        "\tfill           = { 0.09, 0.09, 0.10 },\n"
        "\tfillHover      = { 0.15, 0.15, 0.17 },\n"
        "\tfillPressed    = { 0.05, 0.05, 0.06 },\n"
        "\tfillDisable    = { 0.05, 0.05, 0.05 },\n"
        "\tfillSunken     = { 0.06, 0.06, 0.07 },\n"
        "\tfillField      = { 0.07, 0.07, 0.08 },\n"
        "\tfillFieldFocus = { 0.11, 0.11, 0.13 },\n"
        "}\n"
        "\n"
        "function SetUIColor(key)\n"
        "\tlocal c = uiStyle[key]\n"
        "\tSetDrawColor(c[1], c[2], c[3])\n"
        "end\n"
        "\n"
    )
    t = rep(t, "colorCodes = {", style + "colorCodes = {", 1, "Global.lua anchor")
    write(g, t)

# ---------- 2. ButtonControl ----------
p = os.path.join(CLS, "ButtonControl.lua")
t = read(p)
t = rep(
    t,
    '\tif not enabled then\n'
    '\t\tSetDrawColor(0.33, 0.33, 0.33)\n'
    '\telseif mOver or locked then\n'
    '\t\tSetDrawColor(1, 1, 1)\n'
    '\telse\n'
    '\t\tSetDrawColor(0.5, 0.5, 0.5)\n'
    '\tend\n'
    '\tDrawImage(nil, x, y, width, height)\n'
    '\tif not enabled then\n'
    '\t\tSetDrawColor(0, 0, 0)\n'
    '\telseif self.clicked and mOver then\n'
    '\t\tSetDrawColor(0.5, 0.5, 0.5)\n'
    '\telseif mOver or locked then\n'
    '\t\tSetDrawColor(0.33, 0.33, 0.33)\n'
    '\telse\n'
    '\t\tSetDrawColor(0, 0, 0)\n'
    '\tend',
    '\tif not enabled then\n'
    '\t\tSetUIColor("borderDisable")\n'
    '\telseif mOver or locked then\n'
    '\t\tSetUIColor("borderHover")\n'
    '\telse\n'
    '\t\tSetUIColor("border")\n'
    '\tend\n'
    '\tDrawImage(nil, x, y, width, height)\n'
    '\tif not enabled then\n'
    '\t\tSetUIColor("fillDisable")\n'
    '\telseif self.clicked and mOver then\n'
    '\t\tSetUIColor("fillPressed")\n'
    '\telseif mOver or locked then\n'
    '\t\tSetUIColor("fillHover")\n'
    '\telse\n'
    '\t\tSetUIColor("fill")\n'
    '\tend',
    1,
    "ButtonControl",
)
write(p, t)

# ---------- 3. CheckBoxControl ----------
p = os.path.join(CLS, "CheckBoxControl.lua")
t = read(p)
t = rep(
    t,
    '\tif not enabled then\n'
    '\t\tSetDrawColor(0.33, 0.33, 0.33)\n'
    '\telseif mOver then\n'
    '\t\tSetDrawColor(1, 1, 1)\n'
    '\telseif self.borderFunc then',
    '\tif not enabled then\n'
    '\t\tSetUIColor("borderDisable")\n'
    '\telseif mOver then\n'
    '\t\tSetUIColor("borderHover")\n'
    '\telseif self.borderFunc then',
    1,
    "CheckBoxControl border",
)
t = rep(
    t,
    '\telseif self.checkImage and self.state then\n'
    '\t\tSetDrawColor(0.75, 0.75, 0.75)\n'
    '\telse\n'
    '\t\tSetDrawColor(0.5, 0.5, 0.5)\n'
    '\tend\n'
    '\tDrawImage(nil, x, y, size, size)\n'
    '\tif not enabled then\n'
    '\t\tSetDrawColor(0, 0, 0)\n'
    '\telseif self.clicked and mOver then\n'
    '\t\tSetDrawColor(0.5, 0.5, 0.5)\n'
    '\telseif mOver then\n'
    '\t\tSetDrawColor(0.33, 0.33, 0.33)\n'
    '\telse\n'
    '\t\tSetDrawColor(0, 0, 0)\n'
    '\tend',
    '\telseif self.checkImage and self.state then\n'
    '\t\tSetUIColor("borderActive")\n'
    '\telse\n'
    '\t\tSetUIColor("border")\n'
    '\tend\n'
    '\tDrawImage(nil, x, y, size, size)\n'
    '\tif not enabled then\n'
    '\t\tSetUIColor("fillDisable")\n'
    '\telseif self.clicked and mOver then\n'
    '\t\tSetUIColor("fillPressed")\n'
    '\telseif mOver then\n'
    '\t\tSetUIColor("fillHover")\n'
    '\telse\n'
    '\t\tSetUIColor("fill")\n'
    '\tend',
    1,
    "CheckBoxControl fill",
)
write(p, t)

# ---------- 4. DropDownControl ----------
p = os.path.join(CLS, "DropDownControl.lua")
t = read(p)
t = rep(
    t,
    '\tif not enabled then\n'
    '\t\tSetDrawColor(0.33, 0.33, 0.33)\n'
    '\telseif mOver or self.dropped then\n'
    '\t\tSetDrawColor(1, 1, 1)\n'
    '\telseif self.borderFunc then',
    '\tif not enabled then\n'
    '\t\tSetUIColor("borderDisable")\n'
    '\telseif mOver or self.dropped then\n'
    '\t\tSetUIColor("borderHover")\n'
    '\telseif self.borderFunc then',
    1,
    "DropDown border",
)
t = rep(
    t,
    '\tif not enabled or self.dropped then\n'
    '\t\tSetDrawColor(0, 0, 0)\n'
    '\telseif mOver then\n'
    '\t\tSetDrawColor(0.33, 0.33, 0.33)\n'
    '\telse\n'
    '\t\tSetDrawColor(0, 0, 0)\n'
    '\tend',
    '\tif not enabled or self.dropped then\n'
    '\t\tSetUIColor("fill")\n'
    '\telseif mOver then\n'
    '\t\tSetUIColor("fillHover")\n'
    '\telse\n'
    '\t\tSetUIColor("fill")\n'
    '\tend',
    1,
    "DropDown fill",
)
t = rep(
    t,
    '\tif not enabled then\n'
    '\t\tSetDrawColor(0.33, 0.33, 0.33)\n'
    '\telseif mOver or self.dropped then\n'
    '\t\tSetDrawColor(1, 1, 1)\n'
    '\telse\n'
    '\t\tSetDrawColor(0.5, 0.5, 0.5)\n'
    '\tend\n'
    '\tmain:DrawArrow',
    '\tif not enabled then\n'
    '\t\tSetUIColor("borderDisable")\n'
    '\telseif mOver or self.dropped then\n'
    '\t\tSetUIColor("borderActive")\n'
    '\telse\n'
    '\t\tSetUIColor("borderHover")\n'
    '\tend\n'
    '\tmain:DrawArrow',
    1,
    "DropDown arrow",
)
t = rep(
    t,
    '\t\tSetDrawColor(0, 0, 0)\n'
    '\t\tDrawImage(nil, x + 1, dropY + 1, self.droppedWidth - 2, dropExtra - 2)',
    '\t\tSetUIColor("fill")\n'
    '\t\tDrawImage(nil, x + 1, dropY + 1, self.droppedWidth - 2, dropExtra - 2)',
    1,
    "DropDown list bg",
)
write(p, t)

# ---------- 5. EditControl ----------
p = os.path.join(CLS, "EditControl.lua")
t = read(p)
t = rep(
    t,
    '\tif not enabled then\n'
    '\t\tSetDrawColor(0.33, 0.33, 0.33)\n'
    '\telseif mOver then\n'
    '\t\tSetDrawColor(1, 1, 1)\n'
    '\telseif self.borderFunc then\n'
    '\t\tlocal r, g, b = self.borderFunc()\n'
    '\t\tSetDrawColor(r, g, b)\n'
    '\telse\n'
    '\t\tSetDrawColor(0.5, 0.5, 0.5)\n'
    '\tend\n'
    '\tDrawImage(nil, x, y, width, height)\n'
    '\tif not enabled then\n'
    '\t\tSetDrawColor(0, 0, 0)\n'
    '\telseif self.hasFocus or mOver then\n'
    '\t\tif self.lineHeight then\n'
    '\t\t\tSetDrawColor(0.1, 0.1, 0.1)\n'
    '\t\telse\n'
    '\t\t\tSetDrawColor(0.15, 0.15, 0.15)\n'
    '\t\tend\n'
    '\telse\n'
    '\t\tSetDrawColor(0, 0, 0)\n'
    '\tend',
    '\tif not enabled then\n'
    '\t\tSetUIColor("borderDisable")\n'
    '\telseif mOver then\n'
    '\t\tSetUIColor("borderHover")\n'
    '\telseif self.borderFunc then\n'
    '\t\tlocal r, g, b = self.borderFunc()\n'
    '\t\tSetDrawColor(r, g, b)\n'
    '\telse\n'
    '\t\tSetUIColor("border")\n'
    '\tend\n'
    '\tDrawImage(nil, x, y, width, height)\n'
    '\tif not enabled then\n'
    '\t\tSetUIColor("fillDisable")\n'
    '\telseif self.hasFocus or mOver then\n'
    '\t\tSetUIColor("fillFieldFocus")\n'
    '\telse\n'
    '\t\tSetUIColor("fillField")\n'
    '\tend',
    1,
    "EditControl",
)
write(p, t)

# ---------- 6. SliderControl ----------
p = os.path.join(CLS, "SliderControl.lua")
t = read(p)
t = rep(
    t,
    '\tif not enabled then\n'
    '\t\tSetDrawColor(0.33, 0.33, 0.33)\n'
    '\telseif self.dragging or mOver then\n'
    '\t\tSetDrawColor(1, 1, 1)\n'
    '\telse\n'
    '\t\tSetDrawColor(0.5, 0.5, 0.5)\n'
    '\tend\n'
    '\tDrawImage(nil, x, y, width, height)\n'
    '\tSetDrawColor(0, 0, 0)',
    '\tif not enabled then\n'
    '\t\tSetUIColor("borderDisable")\n'
    '\telseif self.dragging or mOver then\n'
    '\t\tSetUIColor("borderHover")\n'
    '\telse\n'
    '\t\tSetUIColor("border")\n'
    '\tend\n'
    '\tDrawImage(nil, x, y, width, height)\n'
    '\tSetUIColor("fillSunken")',
    1,
    "Slider track",
)
t = rep(
    t,
    '\t\tif self.dragging or mOverComp == "KNOB" then\n'
    '\t\t\tSetDrawColor(1, 1, 1)\n'
    '\t\telse\n'
    '\t\t\tSetDrawColor(0.5, 0.5, 0.5)\n'
    '\t\tend',
    '\t\tif self.dragging or mOverComp == "KNOB" then\n'
    '\t\t\tSetUIColor("borderActive")\n'
    '\t\telse\n'
    '\t\t\tSetUIColor("borderHover")\n'
    '\t\tend',
    1,
    "Slider knob",
)
write(p, t)

# ---------- 7. ScrollBarControl (scoped to Draw) ----------
p = os.path.join(CLS, "ScrollBarControl.lua")
t = read(p)
sl = fn_slice(t, "function ScrollBarClass:Draw", "ScrollBarControl")
if sl:
    a, b = sl
    body = t[a:b]
    for comp in ("UP", "DOWN"):
        body = rep(
            body,
            '\tif enabled and mOverComp == "%s" then\n'
            '\t\tSetDrawColor(0.33, 0.33, 0.33)\n'
            '\telse\n'
            '\t\tSetDrawColor(0, 0, 0)\n'
            '\tend' % comp,
            '\tif enabled and mOverComp == "%s" then\n'
            '\t\tSetUIColor("fillHover")\n'
            '\telse\n'
            '\t\tSetUIColor("fill")\n'
            '\tend' % comp,
            1,
            "ScrollBar %s fill" % comp,
        )
    body = body.replace("SetDrawColor(0.33, 0.33, 0.33)", 'SetUIColor("borderDisable")')
    body = body.replace("SetDrawColor(1, 1, 1)", 'SetUIColor("borderHover")')
    body = body.replace("SetDrawColor(0.5, 0.5, 0.5)", 'SetUIColor("border")')
    body = body.replace("SetDrawColor(0, 0, 0)", 'SetUIColor("fillSunken")')
    left = re.findall(r"SetDrawColor\([0-9.]", body)
    if left:
        fails.append("ScrollBar: %d unconverted numeric SetDrawColor remain" % len(left))
    write(p, t[:a] + body + t[b:])

print("FAILURES:" if fails else "all replacements applied cleanly")
for f in fails:
    print("  - " + f)
