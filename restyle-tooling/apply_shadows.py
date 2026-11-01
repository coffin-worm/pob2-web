"""Adds soft shadows and elevation to PoB2's floating surfaces.

Shadows go on things that float over content -- popup dialogs and open
dropdown panels -- not on inline buttons. On a near-black UI a drop shadow
under a button is invisible; the surface fill already carries that job. What
a shadow does earn is separating a panel from the tree or item list behind
it.

Generates Assets/roundshadow.png (a blurred rounded rect, sliced 9 ways) and
adds DrawShadow() beside DrawRoundRect() in Modules/Common.lua.
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


# ---------- 1. the shadow texture ----------
# N x N white RGBA. Alpha is a rounded rect inset by BLUR, with a smoothstep
# falloff over BLUR pixels. Sliced at N/2, each quadrant is one corner of the
# shadow; the middle row/column stretch as the edges.
N = 64
BLUR = 16.0
RADIUS = 12.0
HALF = N / 2.0
EXT = HALF - BLUR  # half-extent of the solid core


def sdf_round_rect(px, py):
    qx = abs(px) - EXT + RADIUS
    qy = abs(py) - EXT + RADIUS
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - RADIUS


rows = []
for py in range(N):
    row = bytearray()
    for px in range(N):
        d = sdf_round_rect(px + 0.5 - HALF, py + 0.5 - HALF)
        t = min(max(d / BLUR, 0.0), 1.0)
        a = 1.0 - (3.0 * t * t - 2.0 * t * t * t)  # smoothstep falloff
        row += bytes((255, 255, 255, int(round(255.0 * a))))
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
    + chunk(b"IHDR", struct.pack(">IIBBBBB", N, N, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(raw, 9))
    + chunk(b"IEND", b"")
)
asset = os.path.join(ROOT, "Assets", "roundshadow.png")
with open(asset, "wb") as f:
    f.write(png)
print("wrote %s (%d bytes)" % (asset, len(png)))

# ---------- 2. DrawShadow in Modules/Common.lua ----------
c = os.path.join(ROOT, "Modules", "Common.lua")
t = read(c)

if "DrawShadow" not in t:
    t = rep(
        t,
        "\tradius         = 4,\n",
        "\tradius         = 4,\n"
        "\tshadowSpread   = 14,\n"
        "\tshadowAlpha    = 0.55,\n"
        "\tshadowOffsetY  = 3,\n",
        1,
        "Common.lua uiStyle shadow keys",
    )

    SHADOW = '''
do
\tlocal shadowImage
\tlocal shadowState = 0 -- 0 = untried, 1 = loaded, 2 = unavailable

\tlocal function getShadowImage()
\t\tif shadowState == 0 then
\t\t\tshadowImage = NewImageHandle()
\t\t\tshadowImage:Load("Assets/roundshadow.png", "CLAMP")
\t\t\tshadowState = shadowImage:IsValid() and 1 or 2
\t\tend
\t\tif shadowState == 1 then
\t\t\treturn shadowImage
\t\tend
\tend

\t-- Soft drop shadow behind a floating surface. Call immediately BEFORE
\t-- drawing the surface itself; the surface then covers the opaque middle.
\t-- Leaves the draw colour set to the shadow colour, so callers must set
\t-- their own colour afterwards.
\tfunction DrawShadow(x, y, width, height)
\t\tlocal s = uiStyle.shadowSpread or 0
\t\tlocal img = s >= 1 and getShadowImage()
\t\tif not img then
\t\t\treturn
\t\tend
\t\tlocal sx = x - s
\t\tlocal sy = y - s + (uiStyle.shadowOffsetY or 0)
\t\tlocal sw = width + s * 2
\t\tlocal sh = height + s * 2
\t\tif sw < s * 2 or sh < s * 2 then
\t\t\treturn
\t\tend
\t\tlocal e = 1 / 64 -- half-width of the stretched middle strip, in tex coords
\t\tSetDrawColor(0, 0, 0, uiStyle.shadowAlpha or 0.5)
\t\tDrawImage(img, sx, sy, s, s, 0, 0, 0.5, 0.5)
\t\tDrawImage(img, sx + sw - s, sy, s, s, 0.5, 0, 1, 0.5)
\t\tDrawImage(img, sx, sy + sh - s, s, s, 0, 0.5, 0.5, 1)
\t\tDrawImage(img, sx + sw - s, sy + sh - s, s, s, 0.5, 0.5, 1, 1)
\t\tDrawImage(img, sx + s, sy, sw - s * 2, s, 0.5 - e, 0, 0.5 + e, 0.5)
\t\tDrawImage(img, sx + s, sy + sh - s, sw - s * 2, s, 0.5 - e, 0.5, 0.5 + e, 1)
\t\tDrawImage(img, sx, sy + s, s, sh - s * 2, 0, 0.5 - e, 0.5, 0.5 + e)
\t\tDrawImage(img, sx + sw - s, sy + s, s, sh - s * 2, 0.5, 0.5 - e, 1, 0.5 + e)
\t\tDrawImage(nil, sx + s, sy + s, sw - s * 2, sh - s * 2)
\tend
end
'''
    t = t.rstrip("\n") + "\n" + SHADOW
    write(c, t)

# ---------- 3. PopupDialog: shadow + rounded + restyled chrome ----------
p = os.path.join(CLS, "PopupDialog.lua")
t = read(p)
t = rep(
    t,
    "\tSetDrawColor(0.8, 0.8, 0.8)\n"
    "\tDrawImage(nil, x, y, width, height)\n"
    "\tSetDrawColor(0.1, 0.1, 0.1)\n"
    "\tDrawImage(nil, x + 2, y + 2, width - 4, height - 4)",
    "\tDrawShadow(x, y, width, height)\n"
    "\tSetUIColor(\"borderActive\")\n"
    "\tDrawRoundRect(x, y, width, height)\n"
    "\tSetUIColor(\"fill\")\n"
    "\tDrawRoundRect(x + 2, y + 2, width - 4, height - 4)",
    1,
    "PopupDialog background",
)
write(p, t)

# ---------- 4. DropDownControl: shadow under the open panel ----------
p = os.path.join(CLS, "DropDownControl.lua")
t = read(p)
t = rep(
    t,
    "\tif self.dropped then\n"
    "\t\tSetDrawLayer(nil, 5)\n"
    "\t\tDrawRoundRect(x, dropY, self.droppedWidth, dropExtra)\n"
    "\t\tSetDrawLayer(nil, 0)\n"
    "\tend",
    "\tif self.dropped then\n"
    "\t\tSetDrawLayer(nil, 5)\n"
    "\t\tDrawShadow(x, dropY, self.droppedWidth, dropExtra)\n"
    "\t\tSetUIColor(\"borderHover\")\n"
    "\t\tDrawRoundRect(x, dropY, self.droppedWidth, dropExtra)\n"
    "\t\tSetDrawLayer(nil, 0)\n"
    "\tend",
    1,
    "DropDown panel shadow",
)
write(p, t)

print("FAILURES:" if fails else "all replacements applied cleanly")
for f in fails:
    print("  - " + f)
