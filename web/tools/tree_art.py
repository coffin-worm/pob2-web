#!/usr/bin/env python3
"""Turn PoB's passive-tree textures into something a browser can draw.

PoB ships its tree art as zstd-compressed DDS *texture arrays*: one file per
(cell size, compression) pair, each holding dozens or hundreds of array
slices, with tree.json's `ddsCoords` naming them. The renderer uploads those
straight to the GPU. A canvas-2D renderer cannot, so this decodes them once
into PNG atlases plus a manifest of sprite rects, and the big single-image
backgrounds into WebP.

No third-party packages beyond Pillow: zstd comes from Python 3.14's stdlib
(compression.zstd, PEP 784), and Pillow already decodes BC1 and BC7 DDS.

Output is a build product, not a source asset -- it is gitignored, and the
tree falls back to drawing plain circles when it is absent.
"""

from __future__ import annotations

import argparse
import io
import json
import struct
import sys
import time
from pathlib import Path

try:
    import compression.zstd as zstd
except ModuleNotFoundError:  # pragma: no cover
    sys.exit("needs Python 3.14+ for compression.zstd (PEP 784)")

try:
    from PIL import Image
except ModuleNotFoundError:  # pragma: no cover
    sys.exit("needs Pillow: pip install pillow")

# Atlases deliberately left unpacked.
#
# mastery-active-effect is the glow drawn behind an allocated notable: 60
# slices of 784x776, which is 146 MB of pixels for pure decoration.
#
# The skills-disabled atlases hold a greyed-out copy of every icon under the
# same asset names as the lit ones, so PoB's own ddsMap keeps whichever file
# its `pairs` loop reaches last. It never asks for the greyed copy -- it tints
# the lit one instead -- so unpacking them would only decode 500 images to
# have them overwritten by name.
SKIP_ATLASES = {
    "mastery-active-effect_784_776_BC7.dds.zst",
    "skills-disabled_128_128_BC1.dds.zst",
    "skills-disabled_172_172_BC1.dds.zst",
    "skills-disabled_176_176_BC1.dds.zst",
    "skills-disabled_64_64_BC1.dds.zst",
}

# Whole images rather than sprite sheets, so each slice is written as its own
# file. Packing 35 of them at 1500px would need a 9000px atlas, and only one
# class background is ever on screen.
BACKDROP_ATLASES = {
    "ascendancy-background_1500_1500_BC7.dds.zst": 1500,
    # 4008px is more than any viewport will show of it: the tree is ~11000
    # units across and this covers the middle.
    "ascendancy-background_4008_4008_BC7.dds.zst": 2048,
}

# Named in PassiveTreeView rather than in the tree data, so collecting the
# referenced names from tree.json alone misses them.
EXTRA_SPRITES = {"AscendancyMiddle", "AzmeriAscendancyMiddle"}

MAX_ATLAS = 4096
PAD = 2  # keeps bilinear sampling from bleeding between neighbours

# Every sprite is drawn into a box the engine chose, and those boxes are all
# well under the source art: a 128px icon lands in a 37-54px node, a 217px
# keystone frame in 120px. Shrinking the atlas to 3/4 keeps it sharp at the
# deepest zoom this view allows (0.9) even at device pixel ratio 2, and turns
# 11.6M pixels of atlas into 6.5M.
SPRITE_SCALE = 0.75


def dds_dims(raw: bytes) -> tuple[int, int, int]:
    """(width, height, arraySize) from a DDS header, DX10 extension included."""
    if raw[:4] != b"DDS ":
        raise ValueError("not a DDS file")
    height, width = struct.unpack("<II", raw[12:20])
    array_size = 1
    if raw[84:88] == b"DX10":
        array_size = struct.unpack("<I", raw[140:144])[0]
    return width, height, array_size


def load_array(path: Path) -> list:
    """Every array slice of a .dds.zst, as RGBA images.

    Pillow opens only slice 0 and offers no API for the rest, so the slices are
    split by hand: a DDS texture array stores each slice's whole mip chain back
    to back, so slice n starts at n * (one mip chain). Wrapping each in a
    one-slice DDS header keeps the actual BC1/BC7 decoding in Pillow, where it
    belongs.
    """
    raw = zstd.decompress(path.read_bytes())
    _, _, count = dds_dims(raw)
    if count == 1:
        im = Image.open(io.BytesIO(raw))
        im.load()
        return [im.convert("RGBA")]

    is_dx10 = raw[84:88] == b"DX10"
    header_len = 148 if is_dx10 else 128
    body = raw[header_len:]
    stride, rem = divmod(len(body), count)
    if rem:
        raise ValueError(f"{path.name}: {len(body)} bytes will not divide into {count} slices")

    header = bytearray(raw[:header_len])
    if is_dx10:
        header[140:144] = struct.pack("<I", 1)

    out = []
    for i in range(count):
        one = bytes(header) + body[i * stride : (i + 1) * stride]
        im = Image.open(io.BytesIO(one))
        im.load()
        out.append(im.convert("RGBA"))
    return out


def pack(sprites: list, name: str, out_dir: Path, lossless: bool) -> tuple[dict, list]:
    """Shelf-pack by descending height into as few atlases as needed.

    Shelf packing wastes some area against a maximal-rectangles packer, but
    these sprites come in a handful of uniform sizes, so rows pack nearly solid
    and the simpler algorithm is one less thing to be subtly wrong about.
    """
    sprites = sorted(sprites, key=lambda s: (-s[1].height, -s[1].width))
    pages = []
    entries: dict = {}

    page_sprites: list = []
    cursor_x = cursor_y = row_h = 0
    page_index = 0

    def flush() -> None:
        nonlocal page_sprites, cursor_x, cursor_y, row_h, page_index
        if not page_sprites:
            return
        width = max(px + im.width for _, im, px, _ in page_sprites) + PAD
        height = max(py + im.height for _, im, _, py in page_sprites) + PAD
        atlas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        for key, im, px, py in page_sprites:
            atlas.paste(im, (px, py))
            entries[key] = {"p": page_index, "x": px, "y": py, "w": im.width, "h": im.height}
        # WebP, because the same atlas is 9.8 MB as a PNG and 2.8 MB at q92,
        # and the lossy part is the RGB only -- WebP keeps alpha lossless, so
        # the cut-outs these sprites depend on stay exact.
        file = f"{name}-{page_index}.webp"
        atlas.save(out_dir / file, lossless=lossless, quality=80 if lossless else 92, method=4)
        pages.append({"file": file, "w": width, "h": height})
        page_sprites, cursor_x, cursor_y, row_h = [], 0, 0, 0
        page_index += 1

    for key, im in sprites:
        if im.width + PAD * 2 > MAX_ATLAS:
            raise ValueError(f"{key} is wider than one atlas")
        if cursor_x + im.width + PAD > MAX_ATLAS:
            cursor_x, cursor_y, row_h = 0, cursor_y + row_h + PAD, 0
        if cursor_y + im.height + PAD > MAX_ATLAS:
            flush()
        page_sprites.append((key, im, cursor_x + PAD, cursor_y + PAD))
        cursor_x += im.width + PAD
        row_h = max(row_h, im.height)
    flush()
    return entries, pages


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tree-data", default="src/TreeData")
    parser.add_argument("--version", default="0_5")
    parser.add_argument("--out", default="web/public/tree-art")
    parser.add_argument("--scale", type=float, default=SPRITE_SCALE)
    parser.add_argument("--lossless", action="store_true", help="lossless atlas, ~3x larger")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    src = Path(args.tree_data) / args.version
    out = Path(args.out)
    tree_json = src / "tree.json"
    if not tree_json.exists():
        sys.exit(f"no tree data at {tree_json}")

    manifest_path = out / "manifest.json"
    if manifest_path.exists() and not args.force:
        if tree_json.stat().st_mtime <= manifest_path.stat().st_mtime:
            print(f"{manifest_path} is up to date; pass --force to rebuild")
            return 0

    out.mkdir(parents=True, exist_ok=True)
    (out / "bg").mkdir(exist_ok=True)

    started = time.time()
    data = json.loads(tree_json.read_text(encoding="utf-8"))
    dds_coords = data["ddsCoords"]

    # Only what the tree asks for. The atlases also carry PoE1 leftovers --
    # legion jewel art, anointment oils, cluster-jewel frames -- and those are
    # the physically largest sprites in the set, so taking the lot would
    # quadruple the atlas for art no PoE2 node references.
    wanted = set()
    for node in data["nodes"].values():
        if node.get("icon"):
            wanted.add(node["icon"])
        for asset in (node.get("nodeOverlay") or {}).values():
            wanted.add(asset)
    for states in data["nodeOverlay"].values():
        wanted.update(states.values())
    wanted.update(EXTRA_SPRITES)

    sprites: list = []
    backdrops: dict = {}

    for file, names in sorted(dds_coords.items()):
        path = src / file
        if file in SKIP_ATLASES or not path.exists():
            continue
        if file not in BACKDROP_ATLASES and not wanted.intersection(names):
            continue

        slices = load_array(path)

        if file in BACKDROP_ATLASES:
            target = BACKDROP_ATLASES[file]
            for asset, coords in names.items():
                index = int(coords if isinstance(coords, (int, float)) else coords[4])
                im = slices[index - 1]
                if im.width > target:
                    im = im.resize((target, target), Image.LANCZOS)
                safe = asset.replace("/", "_").replace(" ", "_")
                # Lossy WebP: soft painted backdrops where lossless costs
                # megabytes to preserve detail nobody can see behind 4000 nodes.
                im.save(out / "bg" / f"{safe}.webp", quality=88, method=4)
                backdrops[asset] = {"file": f"bg/{safe}.webp", "w": im.width, "h": im.height}
            print(f"  {file}: {len(names)} backdrop(s)")
            continue

        kept = 0
        for asset, coords in names.items():
            if asset not in wanted:
                continue
            kept += 1
            if isinstance(coords, (int, float)):
                index, box = int(coords), None
            else:
                x0, y0, w, h = coords[0], coords[1], coords[2], coords[3]
                index, box = int(coords[4]), (x0, y0, x0 + w, y0 + h)
            im = slices[index - 1]
            if box and box != (0, 0, im.width, im.height):
                im = im.crop(box)
            if args.scale != 1.0:
                im = im.resize(
                    (max(1, round(im.width * args.scale)), max(1, round(im.height * args.scale))),
                    Image.LANCZOS,
                )
            sprites.append((asset, im))
        print(f"  {file}: {kept}/{len(names)} sprite(s)")

    entries, pages = pack(sprites, "sprites", out, args.lossless)

    manifest_path.write_text(
        json.dumps({
            "treeVersion": args.version,
            "pages": pages,
            "sprites": entries,
            "backdrops": backdrops,
        }),
        encoding="utf-8",
    )

    total = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    print(
        f"{len(entries)} sprites in {len(pages)} atlas(es), {len(backdrops)} backdrops, "
        f"{total / 1e6:.1f} MB, {time.time() - started:.1f}s -> {out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
