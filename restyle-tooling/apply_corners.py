"""Adds rounded corners to the PoB2 control restyle.

Also relocates uiStyle/SetUIColor from Data/Global.lua to Modules/Common.lua:
the data exporter (src/Export/Main.lua) instantiates ButtonControl,
EditControl and DropDownControl but never loads Data/Global.lua, so the
first pass left a nil-global crash on that path. Common.lua is loaded by
both Modules/Main.lua and Export/Main.lua.
"""

import io, os, math, zlib, struct

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


# ---------- 1. the corner texture ----------
# 64x64 white RGBA, alpha = antialiased disc of radius 32. Each quadrant is a
# quarter disc, so DrawImage's texture-coord form can pull one corner at a time.
SIZE, SS = 64, 4
R = SIZE / 2.0
rows = []
for py in range(SIZE):
    row = bytearray()
    for px in range(SIZE):
        hits = 0
        for sy in range(SS):
            for sx in range(SS):
                dx = px + (sx + 0.5) / SS - R
                dy = py + (sy + 0.5) / SS - R
                if dx * dx + dy * dy <= R * R:
                    hits += 1
        a = int(round(255.0 * hits / (SS * SS)))
        row += bytes((255, 255, 255, a))
    rows.append(bytes(row))

raw = b"".join(b"\x00" + r for r in rows)


def chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(raw, 9))
    + chunk(b"IEND", b"")
)
asset = os.path.join(ROOT, "Assets", "roundrect.png")
with open(asset, "wb") as f:
    f.write(png)
print("wrote %s (%d bytes)" % (asset, len(png)))

# ---------- 2. lift uiStyle out of Data/Global.lua ----------
OLD_STYLE_BLOCK = (
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

g = os.path.join(ROOT, "Data", "Global.lua")
t = read(g)
if OLD_STYLE_BLOCK in t:
    write(g, rep(t, OLD_STYLE_BLOCK, "", 1, "Global.lua removal"))
elif "uiStyle" in t:
    fails.append("Global.lua: uiStyle present but not in the expected form")

# ---------- 3. install the style + helper in Modules/Common.lua ----------
COMMON_BLOCK = '''
-- Control chrome: one table drives every hand-drawn control's colors and
-- corner radius. Lives here rather than in Data/Global.lua because the data
-- exporter loads Common but not Global, and it draws controls too.
uiStyle = {
\tradius         = 4,
\tborder         = { 0.28, 0.28, 0.31 },
\tborderHover    = { 0.46, 0.46, 0.51 },
\tborderActive   = { 0.60, 0.60, 0.66 },
\tborderDisable  = { 0.16, 0.16, 0.17 },
\tfill           = { 0.09, 0.09, 0.10 },
\tfillHover      = { 0.15, 0.15, 0.17 },
\tfillPressed    = { 0.05, 0.05, 0.06 },
\tfillDisable    = { 0.05, 0.05, 0.05 },
\tfillSunken     = { 0.06, 0.06, 0.07 },
\tfillField      = { 0.07, 0.07, 0.08 },
\tfillFieldFocus = { 0.11, 0.11, 0.13 },
}

function SetUIColor(key)
\tlocal c = uiStyle[key]
\tSetDrawColor(c[1], c[2], c[3])
end

do
\tlocal cornerImage
\tlocal cornerState = 0 -- 0 = untried, 1 = loaded, 2 = unavailable

\tlocal function getCornerImage()
\t\tif cornerState == 0 then
\t\t\tcornerImage = NewImageHandle()
\t\t\tcornerImage:Load("Assets/roundrect.png", "CLAMP")
\t\t\tcornerState = cornerImage:IsValid() and 1 or 2
\t\tend
\t\tif cornerState == 1 then
\t\t\treturn cornerImage
\t\tend
\tend

\t-- Rounded equivalent of DrawImage(nil, x, y, width, height). Four corner
\t-- quads sampled from the quadrants of a disc texture, plus three solid
\t-- rects for the middle. Falls back to a square rect when the radius does
\t-- not fit or the texture is missing.
\tfunction DrawRoundRect(x, y, width, height, radius)
\t\tradius = m_min(radius or uiStyle.radius or 0, m_floor(width / 2), m_floor(height / 2))
\t\tlocal img = radius >= 1 and getCornerImage()
\t\tif not img then
\t\t\tDrawImage(nil, x, y, width, height)
\t\t\treturn
\t\tend
\t\tlocal r = radius
\t\tDrawImage(img, x, y, r, r, 0, 0, 0.5, 0.5)
\t\tDrawImage(img, x + width - r, y, r, r, 0.5, 0, 1, 0.5)
\t\tDrawImage(img, x, y + height - r, r, r, 0, 0.5, 0.5, 1)
\t\tDrawImage(img, x + width - r, y + height - r, r, r, 0.5, 0.5, 1, 1)
\t\tDrawImage(nil, x + r, y, width - r * 2, height)
\t\tDrawImage(nil, x, y + r, r, height - r * 2)
\t\tDrawImage(nil, x + width - r, y + r, r, height - r * 2)
\tend
end
'''

c = os.path.join(ROOT, "Modules", "Common.lua")
t = read(c)
if "DrawRoundRect" not in t:
    need = []
    if "\nlocal m_min = math.min" not in t:
        need.append("local m_min = math.min")
    if "\nlocal m_floor = math.floor" not in t:
        need.append("local m_floor = math.floor")
    t = t.rstrip("\n") + "\n"
    if need:
        t += "\n" + "\n".join(need) + "\n"
    t += COMMON_BLOCK
    write(c, t)

# ---------- 4. route the controls through DrawRoundRect ----------
PLAN = [
    ("ButtonControl.lua", [
        ("DrawImage(nil, x, y, width, height)",
         "DrawRoundRect(x, y, width, height)", 1),
        ("DrawImage(nil, x + 1, y + 1, width - 2, height - 2)",
         "DrawRoundRect(x + 1, y + 1, width - 2, height - 2)", 2),
    ]),
    ("CheckBoxControl.lua", [
        ("DrawImage(nil, x, y, size, size)",
         "DrawRoundRect(x, y, size, size)", 1),
        ("DrawImage(nil, x + 1, y + 1, size - 2, size - 2)",
         "DrawRoundRect(x + 1, y + 1, size - 2, size - 2)", 1),
    ]),
    ("DropDownControl.lua", [
        ("DrawImage(nil, x, y, width, height)",
         "DrawRoundRect(x, y, width, height)", 2),
        ("DrawImage(nil, x + 1, y + 1, width - 2, height - 2)",
         "DrawRoundRect(x + 1, y + 1, width - 2, height - 2)", 1),
        ("DrawImage(nil, x, dropY, self.droppedWidth, dropExtra)",
         "DrawRoundRect(x, dropY, self.droppedWidth, dropExtra)", 1),
        ("DrawImage(nil, x + 1, dropY + 1, self.droppedWidth - 2, dropExtra - 2)",
         "DrawRoundRect(x + 1, dropY + 1, self.droppedWidth - 2, dropExtra - 2)", 1),
    ]),
    ("EditControl.lua", [
        ("DrawImage(nil, x, y, width, height)",
         "DrawRoundRect(x, y, width, height)", 1),
        ("DrawImage(nil, x + 1, y + 1, width - 2, height - 2)",
         "DrawRoundRect(x + 1, y + 1, width - 2, height - 2)", 1),
    ]),
    ("SliderControl.lua", [
        ("DrawImage(nil, x, y, width, height)",
         "DrawRoundRect(x, y, width, height)", 1),
        ("DrawImage(nil, x + 1, y + 1, width - 2, height - 2)",
         "DrawRoundRect(x + 1, y + 1, width - 2, height - 2)", 1),
        ("DrawImage(nil, x + 2 + knobX, y + 2, self.knobSize - 2, self.knobSize - 2)",
         "DrawRoundRect(x + 2 + knobX, y + 2, self.knobSize - 2, self.knobSize - 2)", 1),
    ]),
    # Scrollbars: knob only. The arrow buttons and groove are thin chrome and
    # read better square at 16px; a rounded knob alone is the modern shape.
    ("ScrollBarControl.lua", [
        ("DrawImage(nil, x + height + knobPos + 1, y + 2, self.knobDim - 2, height - 4)",
         "DrawRoundRect(x + height + knobPos + 1, y + 2, self.knobDim - 2, height - 4)", 1),
        ("DrawImage(nil, x + 2, y + width + knobPos + 1, width - 4, self.knobDim - 2)",
         "DrawRoundRect(x + 2, y + width + knobPos + 1, width - 4, self.knobDim - 2)", 1),
    ]),
]

for fname, ops in PLAN:
    p = os.path.join(CLS, fname)
    t = read(p)
    if "DrawRoundRect" in t:
        continue
    for old, new, want in ops:
        t = rep(t, old, new, want, "%s :: %s" % (fname, old[:46]))
    write(p, t)

print("FAILURES:" if fails else "all replacements applied cleanly")
for f in fails:
    print("  - " + f)
