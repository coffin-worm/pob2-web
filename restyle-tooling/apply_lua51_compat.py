"""Rewrites PoB's compound assignments to valid Lua 5.1.

PoB's bundled SimpleGraphic runtime ships a LuaJIT patched to accept
`x += y`, `x ..= y` and friends. That syntax is not valid Lua 5.1 / stock
LuaJIT, so any alternative host -- LOVE, a plain lua interpreter, an
embedding -- fails to parse the source at all.

Fifteen sites across twelve files. Each is rewritten to the equivalent
explicit form, which the patched runtime accepts just as happily, so the
native build is unaffected.

The right-hand side is always parenthesised. Without that,
    y += cond and 24 or 0
becomes
    y = y + cond and 24 or 0
which parses as `(y + cond) and 24 or 0` -- a silent behaviour change, and
exactly the kind of thing a careless regex would ship.
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


EDITS = [
    ("Classes/CompareBuySimilar.lua",
     'url ..= "/" .. encodedLeague',
     'url = url .. ("/" .. encodedLeague)'),
    ("Classes/CompareBuySimilar.lua",
     'url ..= "/" .. tradeHelpers.B64GzipEncode(queryJson)',
     'url = url .. ("/" .. tradeHelpers.B64GzipEncode(queryJson))'),
    ("Classes/Item.lua",
     "disabledRuneLines[strippedModLine] -= 1",
     "disabledRuneLines[strippedModLine] = disabledRuneLines[strippedModLine] - (1)"),
    ("Classes/ItemsTab.lua",
     "rows += 1",
     "rows = rows + (1)"),
    ("Classes/ItemsTab.lua",
     "y += self.controls.displayItemBaseVariant:IsShown() and 24 or 0",
     "y = y + (self.controls.displayItemBaseVariant:IsShown() and 24 or 0)"),
    ("Classes/ItemsTab.lua",
     "y += self.controls.displayItemVersion:IsShown() and 24 or 0",
     "y = y + (self.controls.displayItemVersion:IsShown() and 24 or 0)"),
    ("Classes/PassiveTreeView.lua",
     "connectorHandleQueue.n += 1",
     "connectorHandleQueue.n = connectorHandleQueue.n + (1)"),
    ("Classes/Tooltip.lua",
     "closeBrace += 1",
     "closeBrace = closeBrace + (1)"),
    ("Classes/Tooltip.lua",
     'if char == "{" then depth += 1 elseif char == "}" then depth -= 1 end',
     'if char == "{" then depth = depth + (1) elseif char == "}" then depth = depth - (1) end'),
    ("Classes/Tooltip.lua",
     'do line += 1 end',
     'do line = line + (1) end'),
    ("Classes/Tooltip.lua",
     'do lastLine += 1 end',
     'do lastLine = lastLine + (1) end'),
    ("Classes/Tooltip.lua",
     "\t\tline += 1",
     "\t\tline = line + (1)"),
    ("Modules/CalcSetup.lua",
     "limit.count += count",
     "limit.count = limit.count + (count)"),
    ("Modules/ItemTools.lua",
     "implicitIndex += 1",
     "implicitIndex = implicitIndex + (1)"),
    ("Modules/Main.lua",
     "count += 1",
     "count = count + (1)"),
    ("Export/Scripts/uModsToText.lua",
     'prefix ..= "{desecrated}"',
     'prefix = prefix .. ("{desecrated}")'),

    # Safe navigation (`a?.b`) is the runtime's second syntax extension.
    # `a and a.b` is the faithful equivalent: it yields nil when `a` is nil
    # and otherwise the field, false included.
    ("Classes/GemTooltip.lua",
     'displayInstance.gemData?.gemType == "Support"',
     '(displayInstance.gemData and displayInstance.gemData.gemType) == "Support"'),
    ("Modules/BuildExportPoE2.lua",
     "local activeId = activeGem.gemData?.gameId",
     "local activeId = (activeGem.gemData and activeGem.gemData.gameId)"),
    ("Modules/BuildExportPoE2.lua",
     "gem.gemData?.grantedEffect.support then",
     "(gem.gemData and gem.gemData.grantedEffect.support) then"),
    ("Modules/BuildExportPoE2.lua",
     "local supId = gem.gemData?.gameId",
     "local supId = (gem.gemData and gem.gemData.gameId)"),
    ("Modules/BuildExportPoE2.lua",
     "specIndex = loadout?.specId,",
     "specIndex = (loadout and loadout.specId),"),
    ("Modules/BuildExportPoE2.lua",
     "skillSetId = loadout?.skillSetId,",
     "skillSetId = (loadout and loadout.skillSetId),"),
    ("Modules/BuildExportPoE2.lua",
     "itemSetId = loadout?.itemSetId,",
     "itemSetId = (loadout and loadout.itemSetId),"),
    ("Modules/ModParser.lua",
     "local skillType = SkillType?.[skillTypeMap[skillTypeMaybe]]",
     "local skillType = (SkillType and SkillType[skillTypeMap[skillTypeMaybe]])"),

    # Fourth extension: Rust-style lambda shorthand, `|args| -> expr`.
    # One site in the whole tree.
    ("Modules/CalcOffence.lua",
     "{ __index = |_, key| -> skillCfg.skillCond[key] or cfg.skillCond[key] }",
     "{ __index = function(_, key) return skillCfg.skillCond[key] or cfg.skillCond[key] end }"),
]

by_file = {}
for rel, old, new in EDITS:
    by_file.setdefault(rel, []).append((old, new))

for rel, ops in by_file.items():
    p = os.path.join(ROOT, rel.replace("/", os.sep))
    t = read(p)
    for old, new in ops:
        n = t.count(old)
        if n == 0 and new in t:
            continue  # already rewritten
        if n != 1:
            fails.append("%s: %r matched %d times (want 1)" % (rel, old, n))
            continue
        t = t.replace(old, new)
    write(p, t)

# Sweep for anything the explicit list missed.
#
# Do NOT skip lines containing `==`: the first pass did, which hid
# Tooltip.lua:237 (`if char == "{" then depth += 1 ... end`) behind its own
# comparison. The operator alternation already can't match `==`/`<=`/`~=`.
# The real false positives are Lua patterns -- `%s*=%s*` contains `*=` --
# so reject matches whose preceding characters carry a `%`.
op = re.compile(r"(\+=|-=|\*=|/=|\.\.=)")
left = []
for root, dirs, files in os.walk(ROOT):
    for fn in files:
        if not fn.endswith(".lua") or fn.startswith("_"):
            continue
        p = os.path.join(root, fn)
        for i, line in enumerate(read(p).split("\n"), 1):
            stripped = line.strip()
            if stripped.startswith("--"):
                continue
            for m in op.finditer(line):
                if "%" in line[max(0, m.start() - 2):m.start()]:
                    continue
                left.append("%s:%d: %s" % (os.path.relpath(p, ROOT), i, stripped))
                break

# ---------------------------------------------------------------------------
# Third extension: bare `continue`. Lua 5.1 has no such keyword, and 5.2's
# goto is the standard spelling -- which this codebase already uses in 50-odd
# other places, so the rewrite matches local convention rather than inventing
# one. Each site becomes `goto continue`, with a `::continue::` label added at
# the end of the enclosing loop body.
#
# A label at the very end of a block sits outside the scope of locals declared
# in that block, so jumping forward past `local activeId` to it is legal.
CONTINUE_FILES = ["Classes/Item.lua", "Modules/BuildExportPoE2.lua"]


def indent_of(line):
    return line[:len(line) - len(line.lstrip())]


def is_bare_continue(line):
    s = line.strip()
    if "goto continue" in s or "::continue::" in s:
        return False
    return s == "continue" or s == "continue end" or s.endswith(" continue end")


def rewrite_one(lines):
    """Rewrite the first bare `continue`. Returns False when none are left.

    Sites are located by scanning, not by line number: inserting a label
    shifts every line below it, so a hardcoded list silently drifts on the
    second run -- which is how an earlier version produced `goto goto
    continue`.
    """
    i = next((k for k, l in enumerate(lines) if is_bare_continue(l)), None)
    if i is None:
        return False
    own = indent_of(lines[i])
    loop = None
    for j in range(i - 1, -1, -1):
        s, ind = lines[j].strip(), indent_of(lines[j])
        if (s.startswith("for ") or s.startswith("while ")) and len(ind) < len(own):
            loop = j
            break
    if loop is None:
        raise RuntimeError("no enclosing loop above line %d" % (i + 1))
    loop_ind = indent_of(lines[loop])
    end = next((j for j in range(loop + 1, len(lines))
                if lines[j].strip() == "end" and indent_of(lines[j]) == loop_ind), None)
    if end is None:
        raise RuntimeError("no loop end below line %d" % (loop + 1))
    lines[i] = lines[i].replace("continue", "goto continue")
    if lines[end - 1].strip() != "::continue::":
        lines.insert(end, loop_ind + "\t::continue::")
    return True


for rel in CONTINUE_FILES:
    p = os.path.join(ROOT, rel.replace("/", os.sep))
    lines = read(p).split("\n")
    try:
        n = 0
        while rewrite_one(lines):
            n += 1
            if n > 50:
                raise RuntimeError("runaway rewrite")
        write(p, "\n".join(lines))
    except RuntimeError as e:
        fails.append("%s: %s" % (rel, e))

bare = []
for root, dirs, files in os.walk(ROOT):
    for fn in files:
        if not fn.endswith(".lua") or fn.startswith("_"):
            continue
        p = os.path.join(root, fn)
        for i, line in enumerate(read(p).split("\n"), 1):
            if is_bare_continue(line):
                bare.append("%s:%d: %s" % (os.path.relpath(p, ROOT), i, line.strip()))

nav = []
for root, dirs, files in os.walk(ROOT):
    for fn in files:
        if not fn.endswith(".lua") or fn.startswith("_"):
            continue
        p = os.path.join(root, fn)
        for i, line in enumerate(read(p).split("\n"), 1):
            if "?." in line and "%" not in line:
                nav.append("%s:%d: %s" % (os.path.relpath(p, ROOT), i, line.strip()))

print("FAILURES:" if fails else "all %d rewrites applied cleanly" % len(EDITS))
for f in fails:
    print("  - " + f)
print("remaining compound-assignment sites: %d" % len(left))
for l in left:
    print("  ! " + l)
print("remaining safe-navigation sites: %d" % len(nav))
for l in nav:
    print("  ! " + l)
print("remaining bare-continue sites: %d" % len(bare))
for l in bare:
    print("  ! " + l)
