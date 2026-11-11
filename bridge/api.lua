-- The bridge's view of a build, and the commands that change it.
--
-- Host-agnostic on purpose: nothing in here knows about LOVE, sockets or
-- HTTP. It takes the live `buildMode` table and returns plain Lua values, so
-- the same file works under a standalone interpreter, inside the shipping exe,
-- or behind an FFI host later. Only main.lua is throwaway.
--
-- The rule throughout: read what PoB computed, and write by calling the
-- control callbacks PoB already has. Reimplementing either side would make
-- this a second source of truth, and a second source of truth is the thing
-- the whole exercise is trying to avoid.

local api = {}

local math_floor = math.floor

-- PoB labels carry inline colour codes (^7, ^xRRGGBB). They are presentation
-- for a renderer that no longer exists on this path.
local function strip(s)
	return (tostring(s or ""):gsub("%^x%x%x%x%x%x%x", ""):gsub("%^%d", ""))
end

-- Some of those colours mean something (a warning, a damage type, an
-- over-cap resistance) so they are classified into names rather than
-- dropped or passed through as hex. Passing the hex through would bake PoB's
-- palette into a UI whose whole point is not to look like PoB; dropping it
-- would lose the only thing marking a resistance as uncapped.
local TONE = {
	["^x5CF0BB"] = "custom",
	["^xFF9922"] = "warning",
	["^x33FF77"] = "positive",
	["^xDD0022"] = "negative",
	["^xF05050"] = "unsupported",
	["^xB97123"] = "fire",
	["^x3F6DB3"] = "cold",
	["^xADAA47"] = "lightning",
	["^xD02090"] = "chaos",
	["^xE07030"] = "offence",
	["^x8080E0"] = "defence",
	["^x88FFFF"] = "source",
	["^x7F7F7F"] = "dim",
	["^xC8C8C8"] = "normal",
	["^7"] = "normal",
	["^8"] = "dim",
}

-- PoB names about seventy colours in Data/Global.lua and uses them
-- everywhere: item rarities, damage types, crafted and enchanted mods,
-- class names. The hand-written table above covers what the first three
-- screens needed; the rest is learned from colorCodes itself rather than
-- copied, so the two cannot drift apart.
--
-- The curated entries win, and the rest are taken in name order, because
-- several names share one code (MARAUDER, WARRIOR, STRENGTH and LIFE are
-- all ^xE05030) and `pairs` would otherwise pick a different one on every
-- boot, which is the sort of thing that makes a UI flicker between two
-- correct answers.
local function learnColours()
	if type(colorCodes) ~= "table" then
		return
	end
	local names = {}
	for name in pairs(colorCodes) do
		names[#names + 1] = name
	end
	table.sort(names)
	for _, name in ipairs(names) do
		local code = colorCodes[name]
		if type(code) == "string" and not TONE[code] then
			TONE[code] = name:lower()
		end
	end
end

learnColours()

local function toneOf(s)
	s = tostring(s or "")
	local code = s:match("^(%^x%x%x%x%x%x%x)") or s:match("^(%^%d)")
	return code and TONE[code] or "normal"
end

-- dkjson cannot tell an empty Lua table meant as a list from one meant as an
-- object, and encodes both as {}. An empty warnings list arriving as {}
-- instead of [] is enough to throw on .map() in the UI, so lists are tagged.
local function asArray(t)
	return setmetatable(t, { __jsontype = "array" })
end

-- The point display formats its own "used/max" strings and keeps the operands
-- as locals, so parsing the string back is the only way to read them without
-- duplicating the budget arithmetic. Parsing one of PoB's own strings is the
-- lesser evil: if the rules change, this follows.
local function budget(seg)
	local used, max = tostring(seg and seg.value or ""):match("^%s*(%-?%d+)%s*/%s*(%-?%d+)")
	return {
		used = tonumber(used) or 0,
		max = tonumber(max) or 0,
		over = seg and seg.over and true or false,
	}
end

local SEG_KEY = {
	["Passives"] = "passives",
	["Set I"] = "weaponSet1",
	["Set II"] = "weaponSet2",
	["Asc"] = "ascendancy",
}

local EMPTY_BUDGET = { used = 0, max = 0, over = false }

--- A revision that only ever goes up, for clients that refetch when it moves.
---
--- PoB's own `outputRevision` counts recalculations within one build and is
--- set back to 1 by `buildMode:Init` (`Build.lua:641`), so opening a build
--- *lowers* it, and opening one in an engine that has not recalculated since
--- it booted sets 1 to 1. A client watching for a change sees nothing and
--- goes on showing the build before it: that is an empty tree where a
--- hundred allocated nodes should be.
---
--- So the count that leaves here is of changes rather than of
--- recalculations. The build's identity is part of it because a different
--- build is different output even when both have recalculated the same
--- number of times.
local revisionSeen = { output = nil, name = nil, file = nil, count = 0 }

function api.revision(build)
	local output = build and build.outputRevision or 0
	local name = build and build.buildName or ""
	local file = build and build.dbFileName or ""
	if revisionSeen.output ~= output
		or revisionSeen.name ~= name
		or revisionSeen.file ~= file then
		revisionSeen.output, revisionSeen.name, revisionSeen.file = output, name, file
		revisionSeen.count = revisionSeen.count + 1
	end
	return revisionSeen.count
end

--- The whole of what the header renders, as plain serialisable values.
function api.snapshot(build)
	if not build or not build.controls then
		return { ready = false }
	end

	local controls = build.controls
	local spec = build.spec
	local curClassId = spec and spec.curClassId

	local classes, ascendancies = {}, {}
	if controls.classDrop and controls.classDrop.list then
		for _, entry in ipairs(controls.classDrop.list) do
			classes[#classes + 1] = { id = entry.classId, name = strip(entry.label) }
			if entry.classId == curClassId then
				for _, asc in ipairs(entry.ascendancies or {}) do
					ascendancies[#ascendancies + 1] = { id = asc.ascendClassId, name = strip(asc.label) }
				end
			end
		end
	end

	-- A "loadout" in the top bar is a passive tree spec. loadoutsList is only
	-- populated once SyncLoadouts has run and holds just the specs that opted
	-- in with a {name} marker, so the spec list is both the real thing and the
	-- one that is always there.
	local loadouts, loadoutId = {}, 1
	if build.treeTab and build.treeTab.specList then
		for i, s in ipairs(build.treeTab.specList) do
			loadouts[#loadouts + 1] = { id = i, name = strip(s.title or "Default") }
		end
		loadoutId = build.treeTab.activeSpec or 1
	end

	local points = {
		passives = EMPTY_BUDGET,
		weaponSet1 = EMPTY_BUDGET,
		weaponSet2 = EMPTY_BUDGET,
		ascendancy = EMPTY_BUDGET,
	}
	local segs = controls.pointDisplay and controls.pointDisplay.segs
	for _, seg in ipairs(segs or {}) do
		local key = SEG_KEY[strip(seg.label)]
		if key then
			points[key] = budget(seg)
		end
	end

	local popup = api.popup()

	return {
		ready = true,
		buildName = build.buildName or "",
		unsaved = build.unsaved and true or false,
		-- A number that changes whenever what the engine would answer has
		-- changed. The Calcs tab and the tree's allocation are expensive
		-- enough to be fetched when this moves rather than on a timer.
		outputRevision = api.revision(build),
		dbFileName = build.dbFileName or nil,
		-- PoB's "Export Support", which lives on the Import tab and writes
		-- the party tab. Here because a checkbox needs to know its own
		-- state, and one boolean is cheaper than a route for it.
		exportBuffs = build.partyTab and build.partyTab.enableExportBuffs and true or false,
		-- PoB's own campaign estimate, "Act 5" or "Endgame", worked out
		-- from the allocated passive points. It decides the elemental
		-- resistance penalty, so it is worth being able to see.
		act = type(build.Act) == "string" and build.Act or nil,

		characterLevel = build.characterLevel or 1,
		levelAutoMode = build.characterLevelAutoMode and true or false,

		classId = curClassId or 0,
		classes = asArray(classes),
		ascendClassId = (spec and spec.curAscendClassId) or 0,
		ascendancies = asArray(ascendancies),

		loadoutId = loadoutId,
		loadouts = asArray(loadouts),

		points = points,
		popup = popup,
	}
end

--- Whatever PoB is waiting on, as something answerable.
---
--- PoB answers some commands with a modal rather than by doing the thing:
--- changing class with an allocated tree, Back with unsaved work, a build
--- that failed to load. This used to travel as a title and nothing else,
--- which told the user the engine was stuck without giving them any way
--- out of it.
---
--- A popup's controls are one mixed table: the array part is the message,
--- one LabelControl per line, and the named keys are its buttons. Read that
--- way it is general: any dialog PoB opens comes through, not only the ones
--- anticipated here, and the buttons are answered by their own Click, which
--- is the engine's guard for whether they can be pressed at all.
---
--- `enterControl` and `escapeControl` are the dialog's own idea of which
--- button is the default and which is the way out.
local function controlLabel(control)
	local label = control and control.label
	if type(label) == "function" then
		local ok, result = pcall(label)
		label = ok and result or nil
	end
	return type(label) == "string" and strip(label) or nil
end

function api.popup()
	local popup = main and main.popups and main.popups[1]
	if not popup then
		return nil
	end

	local lines, buttons, needsInput = asArray({}), asArray({}), false
	for key, control in pairs(popup.controls or {}) do
		local class = control._className
		if class == "ButtonControl" then
			local ok, enabled = pcall(control.IsEnabled, control)
			buttons[#buttons + 1] = {
				key = tostring(key),
				label = controlLabel(control) or tostring(key),
				enabled = (not ok) or enabled ~= false,
			}
		elseif class == "LabelControl" then
			local text = controlLabel(control)
			if text and text ~= "" then
				lines[#lines + 1] = text
			end
		elseif class ~= nil then
			-- An edit box, a list, a dropdown: this dialog is asking for
			-- something a yes or no cannot answer.
			needsInput = true
		end
	end

	-- Buttons come out of a keyed table, so their order is undefined;
	-- sorted so the dialog does not shuffle between polls.
	table.sort(buttons, function(a, b) return a.key < b.key end)

	return {
		title = strip(popup.title or "Waiting"),
		lines = lines,
		buttons = buttons,
		defaultKey = type(popup.enterControl) == "string" and popup.enterControl or nil,
		cancelKey = type(popup.escapeControl) == "string" and popup.escapeControl or nil,
		-- True when answering it needs more than a button press. Said
		-- rather than hidden, so the UI can offer the way out instead of
		-- a button that would commit a default nobody chose.
		needsInput = needsInput or nil,
		-- PoB stacks them; answering one can reveal another.
		depth = #main.popups,
	}
end

--------------------------------------------------------------- the sidebar

local SIZE = { [18] = "header", [16] = "normal", [14] = "small" }

local function dropdownOptions(drop)
	local options = asArray({})
	for i, entry in ipairs(drop and drop.list or {}) do
		options[#options + 1] = {
			id = i,
			name = strip(type(entry) == "table" and (entry.label or entry[1]) or entry),
		}
	end
	return options, (drop and drop.selIndex) or 1
end

--- The stat sidebar, as PoB has already built it.
---
--- RefreshStatList does the filtering (skill flags, condFunc per stat) and
--- the number formatting, and both are game rules. Rebuilding them here from
--- displayStats would be a second set of rules to keep in step, so this reads
--- controls.statBox.list and only classifies what it finds: a line with two
--- columns is a stat, one centred column is a note on the stat above it, and
--- the row height is PoB's own emphasis.
function api.stats(build)
	if not build or not build.controls then
		return { ready = false }
	end

	local lines = asArray({})
	for _, entry in ipairs(build.controls.statBox and build.controls.statBox.list or {}) do
		local left, right = entry[1], entry[2]
		-- The trailing colon is part of the drawn string, not the label.
		local label = (strip(left):gsub(":%s*$", ""))
		if label ~= "" or right then
			lines[#lines + 1] = {
				label = label,
				value = right and strip(right) or nil,
				tone = toneOf(left),
				size = SIZE[entry.height] or "normal",
				note = (right == nil and entry.align == "CENTER_X") or nil,
			}
		end
	end

	local warnings = asArray({})
	for _, line in ipairs(build.controls.warnings and build.controls.warnings.lines or {}) do
		warnings[#warnings + 1] = strip(line)
	end

	local socketGroups, socketGroupId = dropdownOptions(build.controls.mainSocketGroup)
	local skills, skillId = dropdownOptions(build.controls.mainSkill)

	return {
		ready = true,
		lines = lines,
		warnings = warnings,
		socketGroupId = socketGroupId,
		socketGroups = socketGroups,
		skillId = skillId,
		skills = skills,
	}
end

-------------------------------------------------------------- the tree

--- One node's drawn size. PoB keeps two boxes per node: the frame around it
--- and the icon inside, and they differ by type (a keystone's frame is 120
--- against an icon of 82). GetNodeTargetSize has already decided both.
local function nodeSizes(node)
	local target = node.targetSize or {}
	local frame = target.overlay
	return target.width or 0, (frame and frame.width) or target.width or 0
end

--- The passive tree's geometry and artwork: where every node is, what it
--- joins to, which sprite it wears, and what it does.
---
--- Positions are PoB's. It resolves each node's group, orbit and orbit index
--- into node.x/node.y once at load (PassiveTree.lua:574), so there is no
--- orbit trigonometry to repeat here, which is just as well, since getting
--- it subtly wrong would be invisible until the tree looked faintly bent.
---
--- Art is PoB's too, by name: node.icon and node.overlay[state] are asset
--- names the renderer looks up in its texture atlases, and web/tools has a
--- script that unpacks the same atlases into one the browser can read. The
--- names are the contract between the two, so nothing here has an opinion
--- about which picture a notable gets.
---
--- Big enough to be worth fetching once: none of this changes while a build
--- is open, only when the tree version does. Allocation and the backdrops
--- that follow the class are a separate, small route.
function api.tree(build)
	local spec = build and build.spec
	local treeNodes = spec and spec.nodes
	local tree = spec and spec.tree
	if not treeNodes or not tree then
		return { ready = false }
	end

	local nodes = asArray({})
	local minX, minY, maxX, maxY

	-- 4546 nodes draw from 576 icons and about 210 frame sets, and the names
	-- are long asset paths. Sending each node an index into a palette instead
	-- of its own copy of "Art/2DArt/SkillIcons/passives/..." takes the
	-- payload from 1.7 MB to under 700 kB, and lets the renderer resolve each
	-- sprite to an atlas rect once rather than once per node.
	local icons, iconIndex = asArray({}), {}
	local frameSets, frameIndex = asArray({}), {}

	local function internIcon(name)
		if not name or name == "" then return nil end
		if not iconIndex[name] then
			icons[#icons + 1] = name
			iconIndex[name] = #icons
		end
		return iconIndex[name]
	end

	local function internFrames(overlay)
		if not overlay or not overlay.unalloc then return nil end
		local key = (overlay.alloc or "") .. "|" .. (overlay.path or "") .. "|" .. overlay.unalloc
		if not frameIndex[key] then
			frameSets[#frameSets + 1] = {
				alloc = overlay.alloc,
				path = overlay.path,
				unalloc = overlay.unalloc,
			}
			frameIndex[key] = #frameSets
		end
		return frameIndex[key]
	end

	for id, node in pairs(treeNodes) do
		-- OnlyImage nodes are decoration with no meaning, and a node with no
		-- position is not on the tree (cluster jewel notables, mostly).
		if node.x and node.y and node.type ~= "OnlyImage" then
			local x, y = math_floor(node.x + 0.5), math_floor(node.y + 0.5)
			local iconSize, frameSize = nodeSizes(node)

			local stats = asArray({})
			for _, line in ipairs(node.sd or {}) do
				stats[#stats + 1] = strip(line)
			end

			nodes[#nodes + 1] = {
				id = id,
				x = x,
				y = y,
				type = node.type or "Normal",
				name = strip(node.dn or node.name or ""),
				-- Ascendancy nodes live in their own distant groups; PoB
				-- draws them as a separate overlay rather than in place.
				ascendancy = node.ascendancyName or nil,
				icon = internIcon(node.icon),
				-- Three sprites per node, one per allocation state. PoB
				-- resolves these in ProcessNode, taking the node's own
				-- nodeOverlay when it has one (ascendancy frames do) and the
				-- per-type default otherwise.
				frames = internFrames(node.overlay),
				iconSize = iconSize,
				frameSize = frameSize,
				stats = stats,
				-- A string on this tree, a list of lines on older ones.
				flavour = node.flavourText
					and strip(type(node.flavourText) == "table"
						and table.concat(node.flavourText, "\n")
						or node.flavourText)
					or nil,
			}

			if not node.ascendancyName then
				minX = (not minX or x < minX) and x or minX
				minY = (not minY or y < minY) and y or minY
				maxX = (not maxX or x > maxX) and x or maxX
				maxY = (not maxY or y > maxY) and y or maxY
			end
		end
	end

	-- PoB's own connector list, not the links. The two are not the same: it
	-- drops the links it does not draw (between an ascendancy and the tree
	-- proper, and out of a class start), and it knows which connections curve.
	--
	-- A curve is an arc of an orbit, and BuildArc puts that orbit's centre in
	-- the first vertex of the quad it builds. Both endpoints are on the
	-- circle through it by construction, so centre plus the two node
	-- positions is the whole arc: no radius or sweep to re-derive, and
	-- nothing to get subtly wrong. `arcErrors` below is that claim checked.
	--
	-- Connectors wider than 90 degrees arrive as two, because PoB's arc
	-- texture only covers 90. That is a fact about the texture, not about the
	-- tree, so the pair collapses back into the one arc it describes.
	local connectors, seen, arcErrors = asArray({}), {}, 0
	for _, connector in ipairs(tree.connectors or {}) do
		local a, b = connector.nodeId1, connector.nodeId2
		if a and b then
			if a > b then a, b = b, a end
			local key = a .. ":" .. b
			if not seen[key] then
				seen[key] = true
				local entry = { a, b }
				if connector.type ~= "LineConnector" then
					local vert = connector.vert and connector.vert.Normal
					local n1, n2 = treeNodes[a], treeNodes[b]
					if vert and n1 and n2 then
						local cx, cy = vert[1], vert[2]
						local r1 = math.sqrt((n1.x - cx) ^ 2 + (n1.y - cy) ^ 2)
						local r2 = math.sqrt((n2.x - cx) ^ 2 + (n2.y - cy) ^ 2)
						if math.abs(r1 - r2) > 1 then
							arcErrors = arcErrors + 1
						else
							entry[3] = math_floor(cx + 0.5)
							entry[4] = math_floor(cy + 0.5)
						end
					end
				end
				connectors[#connectors + 1] = entry
			end
		end
	end

	return {
		ready = true,
		nodes = nodes,
		connectors = connectors,
		-- Palettes the nodes' `icon` and `frames` index into, 1-based.
		icons = icons,
		frameSets = frameSets,
		bounds = { minX = minX or 0, minY = minY or 0, maxX = maxX or 0, maxY = maxY or 0 },
		-- Arcs whose two endpoints did not land on one circle about the
		-- centre PoB gave. Should be zero; if it is not, those connections
		-- fell back to straight lines and the tree is drawing a lie.
		arcErrors = arcErrors,
	}
end

--- The route a click would take, as the engine would take it.
---
--- GetEffectiveAllocationPath, not `node.path`: AllocNode calls the former,
--- and the two differ exactly where it matters: a path that runs through
--- a weapon-set branch, or one shortened by an Intuitive Leap style jewel.
--- A preview built on the raw path would be right almost always and wrong
--- on the builds that care.
---
--- One node at a time, on demand. Every reachable node's route at once is
--- the whole tree several times over.
function api.treePath(build, nodeId)
	local spec = build and build.spec
	local node = spec and spec.nodes and spec.nodes[tonumber(nodeId) or 0]
	if not node then
		return { ready = false, error = "no node with id " .. tostring(nodeId) }
	end
	if node.alloc then
		return { ready = true, id = node.id, path = asArray({}), cost = 0, allocated = true }
	end
	if not node.path or #node.path == 0 then
		return { ready = true, id = node.id, path = asArray({}), cost = 0, reachable = false }
	end

	local ok, path = pcall(spec.GetEffectiveAllocationPath, spec, node)
	if not ok or not path then
		return { ready = false, error = "the engine would not path to that node" }
	end

	local ids, cost = asArray({}), 0
	for _, pathNode in ipairs(path) do
		ids[#ids + 1] = pathNode.id
		if not pathNode.alloc then
			cost = cost + 1
		end
	end
	return { ready = true, id = node.id, path = ids, cost = cost }
end

--- What is allocated, and what could be. Small, and changes on every click.
---
--- `path` is PoB's own reachability answer, rebuilt by
--- BuildAllDependsAndPaths: a node with no path cannot be reached from the
--- allocated tree, which is exactly what makes it unclickable.
---
--- `weaponSets` carries the allocated nodes that belong to one weapon set
--- rather than to the tree as a whole, as `[id, 1]` or `[id, 2]`. They are
--- in `allocated` as well: the set is a fact about how the point was paid
--- for, not a separate kind of allocation.
function api.treeAlloc(build)
	local spec = build and build.spec
	if not spec or not spec.nodes then
		return { ready = false }
	end

	local allocated, reachable, weaponSets = asArray({}), asArray({}), asArray({})
	for id, node in pairs(spec.nodes) do
		if node.alloc then
			allocated[#allocated + 1] = id
			-- A node paid for out of one weapon set's own points rather
			-- than the shared pool. PoB keeps that on the node as
			-- `allocMode`, 0 for the ordinary case, and only the exceptions
			-- are worth sending: a tree has a handful of these and a
			-- hundred of the others.
			local mode = node.allocMode or 0
			if mode > 0 then
				weaponSets[#weaponSets + 1] = asArray({ id, mode })
			end
		elseif node.path and #node.path > 0 then
			-- Each reachable node travels with what clicking it would
			-- cost. pathDist is PoB's own figure from the same search that
			-- built the path: nodes already allocated weigh nothing, so it
			-- is the number of new points, not the length of the route.
			-- Sent with the allocation rather than asked for on hover,
			-- because a round trip per mouse-move is not a thing worth
			-- building to answer a number the engine already has.
			reachable[#reachable + 1] = asArray({ id, node.pathDist or #node.path })
		end
	end

	return {
		ready = true,
		allocated = allocated,
		reachable = reachable,
		weaponSets = weaponSets,
		classId = spec.curClassId or 0,
		ascendClassId = spec.curAscendClassId or 0,
		backdrop = api.treeBackdrop(spec),
	}
end

--- Where the painted backdrops go, for the class this spec is currently on.
---
--- These follow the class and the ascendancy rather than the tree, which is
--- why they ride with the allocation instead of with the geometry. PoB picks
--- the ascendancy's artwork over the class's whenever one is chosen, draws
--- the tree's own centrepiece on top, and turns the lit half of it to face
--- the class's start node.
--- PoB's DrawAsset draws an asset from -width to +width about its anchor
--- (PassiveTreeView.lua:1386), so the declared width is a half-extent and
--- the picture covers twice it. Doubling here rather than in the renderer
--- keeps that a fact about PoB, stated once, instead of a magic 2 in the
--- drawing code.
local function backdropOf(record)
	if not record or not record.image then
		return nil
	end
	return {
		image = record.image,
		x = math_floor((record.x or 0) + 0.5),
		y = math_floor((record.y or 0) + 0.5),
		width = (record.width or 0) * 2,
		height = (record.height or 0) * 2,
	}
end

function api.treeBackdrop(spec)
	local tree = spec and spec.tree
	local class = tree and tree.classes and tree.classes[spec.curClassId]
	local background = class and class.background
	if not background then
		return nil
	end

	local chosen = background
	local ascend = class.classes and class.classes[spec.curAscendClassId or 0]
	if ascend and ascend.background then
		chosen = ascend.background
	end

	local backdrop = backdropOf(chosen)
	backdrop.x, backdrop.y = math_floor((background.x or 0) + 0.5), math_floor((background.y or 0) + 0.5)

	-- The centrepiece is one image with a lit overlay, and the overlay is
	-- rotated to point at the class's start node. PoB computes the angle at
	-- draw time; it depends only on the start node, so it is reported rather
	-- than left for the UI to work out which node that is.
	local startNode = spec.nodes and class.startNodeId and spec.nodes[class.startNodeId]
	if background.bg then
		backdrop.centre = {
			image = "BGTree",
			width = (background.bg.width or 0) * 2,
			height = (background.bg.height or 0) * 2,
		}
	end
	if background.active and startNode then
		backdrop.active = {
			image = "BGTreeActive",
			width = (background.active.width or 0) * 2,
			height = (background.active.height or 0) * 2,
			angle = math.pi / 2 + math.atan2(startNode.y - background.y, startNode.x - background.x),
		}
	end

	-- The ascendancy clusters sit thousands of units away in their own
	-- groups, each on its own painted disc.
	local ascendancies = asArray({})
	for name, data in pairs(tree.ascendNameMap or {}) do
		local record = data.ascendClass and data.ascendClass.background
		local entry = backdropOf(record)
		if entry then
			entry.name = name
			entry.current = (name == spec.curAscendClassBaseName) or nil
			ascendancies[#ascendancies + 1] = entry
		end
	end
	backdrop.ascendancies = ascendancies

	return backdrop
end

------------------------------------------------------------ the calcs tab

--- The Calcs tab: 30 sections, 1081 defined rows, of which the active skill
--- decides a few hundred.
---
--- Visibility and formatting are both PoB's. A row is shown when
--- CalcsTab:CheckFlag passes it against the active skill's flags, and its
--- value comes from formatCalcStr (Modules/CalcFormat.lua) resolving a
--- template like "{2:output:Speed}" against the actor.
---
--- UpdateSize is skipped deliberately. It is the layout pass (positions,
--- heights, collapse state) and the only thing here that depends on it is
--- the CheckFlag call it makes first, which this does directly. Collapse
--- state is skipped for the same reason: which sections are folded is this
--- UI's business, and hiding the rows here would stop it ever being able to
--- show them.
---
--- UpdateSize also calls a section's updateFunc, and exactly one section has
--- one: SkillSelect, which is hand-built in CalcsTab.lua rather than coming
--- from CalcSections.lua, carries controls instead of values, and uses its
--- updateFunc to refresh those controls' lists. So it is run, and that
--- section is surfaced as a selector rather than as rows of data.
---
--- Note that this selector is the Calcs tab's own (`input.skill_number`) and
--- is deliberately not the sidebar's main socket group. PoB keeps them
--- apart: the sidebar always reports Effective DPS for the main skill, while
--- this tab details whichever skill you point it at.
function api.calcs(build)
	local tab = build and build.calcsTab
	local env = tab and tab.calcsEnv
	if not tab or not env or not tab.sectionList then
		return { ready = false }
	end

	local actor = (tab.input and tab.input.showMinion and env.minion) or env.player
	if not actor or not actor.mainSkill then
		return { ready = false }
	end

	-- CompareTab wraps every one of these in pcall, which is reason enough.
	local function format(template, colData)
		if not template then return nil end
		local ok, text = pcall(formatCalcStr, template, actor, colData)
		return ok and strip(text) or nil
	end

	local sections, rowCount = asArray({}), 0
	local selector = nil

	for sIdx, section in ipairs(tab.sectionList) do
		if section.id == "SkillSelect" then
			-- Its updateFunc is what repopulates the dropdown lists; without
			-- it they hold whatever was there when the tab was built.
			if section.updateFunc then
				pcall(section.updateFunc, section)
			end
			local controls = section.controls or {}
			local groups, groupId = dropdownOptions(controls.mainSocketGroup)
			local skills, skillId = dropdownOptions(controls.mainSkill)
			selector = {
				socketGroupId = groupId,
				socketGroups = groups,
				skillId = skillId,
				skills = skills,
			}
		elseif not section.isOverlay and tab:CheckFlag(section, actor) then
			local subSections, sectionRows = asArray({}), 0

			for subIdx, subSec in ipairs(section.subSection or {}) do
				local rows = asArray({})

				for rowIdx, rowData in ipairs(subSec.data or {}) do
					if tab:CheckFlag(rowData, actor) then
						-- A column slot is kept even when it has nothing in
						-- it. PoB's rows carry empty placeholders, "Added
						-- Min" starts with a bare {} because it has no "All
						-- Types" figure, and UpdateSize gives every slot an
						-- x offset whether or not it has a format. Dropping
						-- the empties instead of emptying them shifts the
						-- whole row left and silently misaligns the matrix
						-- against its own header.
						local values, tones = asArray({}), asArray({})
						-- Where this cell's breakdown lives, by PoB's own indices
						-- rather than the ones this response ends up with: rows
						-- that format to nothing are dropped below, so the two
						-- numberings part company almost immediately.
						local refs = asArray({})
						local hasValue, hasTone, hasRef = false, false, false
						for colIdx, colData in ipairs(rowData) do
							local text, tone = "", "normal"
							if colData.format and tab:CheckFlag(colData, actor) then
								text = format(colData.format, colData) or ""
								-- The damage-type colours live on the header
								-- row's format strings.
								tone = toneOf(colData.format)
							end
							values[#values + 1] = text
							tones[#tones + 1] = tone
							-- A cell carries a breakdown when it has section
							-- descriptors in its array part. Most do not.
							local ref = ""
							if text ~= "" and #colData > 0 then
								ref = sIdx .. "." .. subIdx .. "." .. rowIdx .. "." .. colIdx
								hasRef = true
							end
							refs[#refs + 1] = ref
							hasValue = hasValue or text ~= ""
							hasTone = hasTone or tone ~= "normal"
						end
						-- A row whose every column formats to nothing is a
						-- blank line in PoB. Dropping it is this bridge's one
						-- presentation call, and it is not a game rule: the
						-- row was already decided to apply, it just has
						-- nothing to say.
						if hasValue then
							rows[#rows + 1] = {
								label = strip(rowData.label),
								values = values,
								-- Only when it says something, to keep the
								-- common row a plain list of strings.
								tones = hasTone and tones or nil,
								refs = hasRef and refs or nil,
							}
							sectionRows = sectionRows + 1
						end
					end
				end

				if #rows > 0 then
					subSections[#subSections + 1] = {
						label = strip(subSec.label),
						extra = format(subSec.data.extra),
						rows = rows,
					}
				end
			end

			if sectionRows > 0 then
				sections[#sections + 1] = {
					id = section.id,
					-- 1 is offence and the wide sections, 2 defence; PoB lays
					-- the two groups out in separate column runs.
					group = section.group or 1,
					-- How many of PoB's 230px columns the section asks for.
					-- The damage matrices want three; most want one.
					width = section.widthCols or 1,
					tone = toneOf(section.colour),
					subSections = subSections,
				}
				rowCount = rowCount + sectionRows
			end
		end
	end

	return {
		ready = true,
		sections = sections,
		rowCount = rowCount,
		selector = selector,
	}
end

------------------------------------------------------------- the items tab

--- PoB's slots are a flat list of dropdowns, and the list is longer than it
--- looks: twelve equipment slots, two weapon sets, five flasks, and six
--- jewel sockets hanging off every slot that can carry them. Which of those
--- are on screen at any moment is decided by the slot's own `shown` closure
--- (weapon-set swaps, the third ring that only exists with a tree flag) and
--- by `inactive` (a jewel socket whose passive is not allocated).
---
--- Both are asked rather than reimplemented, because both are build state:
--- the third ring slot appears because a modDB flag says so, and no table
--- of slot names on the web side could know that.
local function slotShown(slot)
	if slot.inactive then
		return false
	end
	local ok, shown = pcall(function()
		return slot:IsShown()
	end)
	-- IsShown returns the `shown` property, which for the conditional slots
	-- is a closure over build state, and the third ring's returns nil, not
	-- false, when its tree flag is absent. Coerced rather than compared,
	-- because `nil ~= false` is true and that put an extra ring on screen.
	if not ok then
		return true
	end
	return shown and true or false
end

--- A slot's dropdown: "None" plus every item PoB considers valid for it.
---
--- IsItemValidForSlot is a real game rule: a two-handed weapon blocks the
--- off-hand, a jewel only fits a socket whose passive allows its rarity,
--- so the list travels as PoB built it rather than being filtered here.
local function slotOptions(slot)
	local options = asArray({})
	for index, id in ipairs(slot.items or {}) do
		local label = slot.list and slot.list[index]
		options[#options + 1] = {
			id = id,
			name = strip(label or (id == 0 and "None" or ("Item " .. id))),
			rarity = label and toneOf(label) or nil,
		}
	end
	return options
end

--- Everything the items screen draws, except the item tooltips.
---
--- PopulateSlots is run first for the same reason the Calcs selector runs
--- its updateFunc: these lists are only rebuilt when something changes them,
--- so a bridge that never populated would serve empty dropdowns until the
--- first edit. It is also what reconciles a slot holding an item that is no
--- longer valid for it, which is PoB's normalisation and not this file's.
function api.items(build)
	local tab = build and build.itemsTab
	if not tab or not tab.orderedSlots then
		return { ready = false }
	end

	-- Both of these are normally run by the tab's own layout pass, which
	-- never happens headless. PopulateSlots rebuilds the per-slot item
	-- lists; UpdateSockets decides which jewel sockets exist, by looking at
	-- what the tree has allocated. Without the second, all nineteen sockets
	-- are reported as available regardless of the tree.
	tab:PopulateSlots()
	pcall(tab.UpdateSockets, tab)

	local slots = asArray({})
	for _, slot in ipairs(tab.orderedSlots) do
		if slotShown(slot) then
			local entry = {
				name = slot.slotName,
				label = strip(slot.label or slot.slotName),
				itemId = slot.selItemId or 0,
				options = slotOptions(slot),
				-- A jewel socket belongs to the passive tree, not to a piece
				-- of equipment, and is grouped apart in the UI.
				socket = slot.nodeId and true or nil,
				jewel = slot.parentSlot and slot.parentSlot.slotName or nil,
				weaponSet = slot.weaponSet,
			}
			-- Flasks are the only slots that can be equipped but turned
			-- off, and the checkbox is part of what the slot means.
			--
			-- Set here rather than in the table above, where `cond and
			-- (x and true or false) or nil` collapses a legitimate false
			-- back to nil and the key disappears. It made no difference to
			-- the checkbox, which reads a missing key as unticked either
			-- way, but "this flask is off" and "this is not a flask" are
			-- not the same answer and should not arrive as the same bytes.
			if slot.slotName:match("Flask") then
				entry.flask = true
				entry.active = slot.active and true or false
			end
			slots[#slots + 1] = entry
		end
	end

	-- itemOrderList is PoB's own sort: by the slot an item belongs in, then
	-- by where it is equipped. Reproducing that ordering on the web side
	-- would mean reproducing GetPrimarySlot, which is a table of base types.
	local items = asArray({})
	for _, id in ipairs(tab.itemOrderList or {}) do
		local item = tab.items[id]
		if item then
			local equipped = nil
			local ok, slot = pcall(tab.GetEquippedSlotForItem, tab, item)
			if ok and slot then
				equipped = slot.slotName
			end
			items[#items + 1] = {
				id = id,
				name = strip(item.name or item.title or item.baseName or "Item"),
				base = strip(item.baseName or ""),
				rarity = item.rarity or "NORMAL",
				equipped = equipped,
			}
		end
	end

	local sets = asArray({})
	for _, id in ipairs(tab.itemSetOrderList or {}) do
		local set = tab.itemSets and tab.itemSets[id]
		if set then
			sets[#sets + 1] = { id = id, name = strip(set.title or "Default") }
		end
	end

	return {
		ready = true,
		slots = slots,
		items = items,
		sets = sets,
		setId = tab.activeItemSetId or 0,
		-- Which of the two weapon sets the slots above are showing.
		weaponSet = (tab.activeItemSet and tab.activeItemSet.useSecondWeaponSet) and 2 or 1,
	}
end

--- Read a Tooltip's lines as the UI's line model.
---
--- Shared by the item and gem panels, because PoB builds all of them the
--- same way: a Tooltip is a list of {size, text, block, separatorImage},
--- `block` separating the thing itself from whatever comparison follows it.
---
--- colorCodes.TIP is dropped and counted. It is used in exactly one way
--- across the codebase (advice about the desktop UI's keyboard shortcuts,
--- "Press Ctrl+D", "Right click this socket") and none of those keys do
--- anything here, so forwarding them would tell the user something untrue
--- about the application in front of them.
local function tooltipLines(tooltip)
	local lines, tips = asArray({}), 0
	for _, line in ipairs(tooltip.lines or {}) do
		if line.separatorImage or not line.text then
			lines[#lines + 1] = { separator = true, block = line.block or 1 }
		elseif toneOf(line.text) == "tip" then
			tips = tips + 1
		elseif strip(line.text):match("^%s*$") then
			-- A line with no text is not a line. PoB spaces its tooltips
			-- with separators, which are kept above, so this only ever
			-- catches a header a caller did not want: the per-slot item
			-- comparisons are headed by the slot itself.
		else
			-- Leading spaces are trimmed. In the gem tooltip they are
			-- `iconNameIndent` and `iconTagIndent`: a hole PoB leaves for
			-- the gem icon it draws over the text. Nothing draws an icon
			-- there here, and HTML collapses the spaces anyway, so keeping
			-- them would be a ragged left edge for no reason.
			lines[#lines + 1] = {
				text = (strip(line.text):gsub("^%s+", ""):gsub("%s+$", "")),
				tone = toneOf(line.text),
				size = line.size or 16,
				block = line.block or 1,
				centre = line.center or nil,
			}
		end
	end
	return lines, tips
end

--- One item, as PoB itself would draw it.
---
--- This is the whole reason the items screen is cheap. AddItemTooltip
--- already knows how to lay an item out (the rarity header, the base, the
--- requirements, implicits above explicits, every mod in its own colour,
--- the unsupported ones called out) and with a slot it also runs the
--- comparison that produces "Equipping this item will...". All of that is
--- game knowledge, and none of it is worth having a second copy of.
---
--- So a Tooltip is built and its `lines` are read, exactly as the sidebar
--- reads statBox.list. A line is {size, text, block, separatorImage}; block
--- is what separates the item itself from the equip delta beneath it.
function api.itemDetail(build, itemId, slotName)
	local tab = build and build.itemsTab
	local item = tab and tab.items and tab.items[tonumber(itemId) or 0]
	if not item then
		return { ready = false }
	end

	local slot = slotName and tab.slots and tab.slots[slotName] or nil
	local tooltip = new("Tooltip"):Tooltip()
	local ok, err = pcall(tab.AddItemTooltip, tab, tooltip, item, slot)
	if not ok then
		return { ready = false, error = tostring(err) }
	end

	local lines, tips = tooltipLines(tooltip)

	return {
		ready = true,
		id = item.id,
		name = strip(item.name or item.title or ""),
		rarity = item.rarity or "NORMAL",
		-- The slot this was rendered against, so the UI can say what the
		-- delta beneath it is a delta against.
		slot = slot and slot.slotName or nil,
		lines = lines,
		-- Reported rather than silently swallowed, so the count is visible
		-- if PoB ever starts using that colour for something that matters.
		droppedTips = tips,
	}
end

------------------------------------------------------- the item database

-- PoB's magic-character escape for the search box, verbatim. `(` and `)`
-- are deliberately left unescaped: matchOrPattern reads them as an
-- alternation group, which is how a search for "(life|mana)" works in the
-- desktop app. Escaping them would silently remove a feature.
local function escapeNeedle(text)
	return (tostring(text or ""):lower():gsub("[%-%.%+%[%]%$%^%%%?%*]", "%%%0"))
end

local function anyModMatches(lines, needle)
	for _, line in pairs(lines or {}) do
		local ok, matched = pcall(string.matchOrPattern, tostring(line.line or ""):lower(), needle)
		if ok and matched then
			return true
		end
	end
	return false
end

-- Anywhere, Names or Modifiers, which is PoB's own three-way switch. The
-- modifier side reads the four mod-line lists an Item carries and then,
-- only if none of them matched, the parsed modifier names with the spaces
-- taken out of both sides: that last pass is what lets "increasedlife"
-- find what "increased life" would not.
local function matchesSearch(item, needle, mode)
	if not needle or needle == "" then
		return true
	end
	if mode == "anywhere" or mode == "names" then
		local ok, matched = pcall(string.matchOrPattern, tostring(item.name or ""):lower(), needle)
		if ok and matched then
			return true
		end
	end
	if mode == "anywhere" or mode == "mods" then
		if anyModMatches(item.enchantModLines, needle)
			or anyModMatches(item.runeModLines, needle)
			or anyModMatches(item.implicitModLines, needle)
			or anyModMatches(item.explicitModLines, needle)
		then
			return true
		end
		local tight = needle:gsub(" ", "")
		for _, mod in ipairs(item.baseModList or {}) do
			local ok, matched = pcall(string.matchOrPattern, tostring(mod.name or ""):lower(), tight)
			if ok and matched then
				return true
			end
		end
	end
	return false
end

-- "Ring 1" is a slot the build has; "Ring" is what the filter offers. PoB
-- compares both the whole name and the name with its trailing number taken
-- off, so one filter entry covers both rings.
local function matchesSlot(item, want)
	if want == "" or want == "any" then
		return true
	end
	local ok, primary = pcall(item.GetPrimarySlot, item)
	if not ok or not primary then
		return false
	end
	return primary == want or primary:gsub(" %d", "") == want
end

-- Four of these are groups rather than types: Armour is "has an armour
-- value", Jewellery is three named types, and the two melee entries are a
-- question for the weapon table rather than for the item.
local function matchesType(build, item, want)
	if want == "" or want == "any" then
		return true
	end
	if want == "armour" then
		return (item.base and item.base.armour) and true or false
	elseif want == "jewellery" then
		return item.type == "Amulet" or item.type == "Ring" or item.type == "Belt"
	elseif want == "melee1h" or want == "melee2h" then
		local info = build.data and build.data.weaponTypeInfo and build.data.weaponTypeInfo[item.type]
		if not (info and info.melee
			and ((want == "melee1h" and info.oneHand) or (want == "melee2h" and not info.oneHand)))
		then
			return false
		end
		-- A Staff counts as melee only as a Warstaff. The plain kind is a
		-- caster weapon that happens to share the type name.
		if item.type == "Staff" and item.base and item.base.subType ~= "Warstaff" then
			return false
		end
		return true
	end
	return item.type == want
end

local function matchesLeague(item, want)
	if want == "" or want == "any" then
		return true
	end
	if want == "none" then
		return not item.league
	end
	if not item.league then
		return false
	end
	local ok, matched = pcall(string.match, tostring(item.league), want)
	return (ok and matched) and true or false
end

-- Obtainability is a definition, not a flag: no item says it is
-- obtainable, only that it is no longer or that it came from a race. The
-- other five are substring tests on the source line PoB already wrote.
local function matchesSource(item, want)
	if want == "any" then
		return true
	end
	local source = tostring(item.source or "")
	local obtainable = not (source == "No longer obtainable"
		or (item.league and item.league == "Race Events"))
	if want == "obtainable" then
		return obtainable
	elseif want == "unobtainable" then
		return not obtainable
	elseif want == "vendor" then
		return source == "Vendor Recipe"
	elseif want == "upgraded" then
		return source:match("Upgraded from") and true or false
	elseif want == "boss" then
		return source:match("Drops from unique") and true or false
	elseif want == "corruption" then
		return source:match("Vaal Orb") and true or false
	end
	return true
end

-- Level, attributes, or both. PoB's "Current useable" is the pair, which
-- is why the two checks below are written as separate conditions rather
-- than as a three-way branch.
local function matchesRequirement(build, item, want)
	if want == "" or want == "any" then
		return true
	end
	local req = item.requirements
	if (want == "level" or want == "useable")
		and req and req.level and req.level > (build.characterLevel or 0)
	then
		return false
	end
	if want == "attributes" or want == "useable" then
		local out = (build.calcsTab and build.calcsTab.mainOutput) or {}
		if req and ((req.strMod or 0) > (out.Str or 0)
			or (req.dexMod or 0) > (out.Dex or 0)
			or (req.intMod or 0) > (out.Int or 0))
		then
			return false
		end
	end
	return true
end

local DBS = {
	{ key = "unique", get = function() return main and main.uniqueDB end },
	{ key = "rare", get = function() return main and main.rareDB end },
}

local function dbsLoading()
	for _, entry in ipairs(DBS) do
		local db = entry.get()
		if not db or db.loading then
			return true
		end
	end
	return false
end

-- PoB's NAME comparator: the leading "The " is not part of a name for
-- sorting purposes, so The Anvil files under A.
local function byName(a, b)
	return (a.name:gsub("^The ", "")) < (b.name:gsub("^The ", ""))
end

--- The filtered list, in name order, with nothing measured yet.
---
--- Pure data: no calculation, no engine, a few hundred items. It runs in
--- full on every request, because caching something this cheap would only
--- add a way for it to go stale.
local function filterList(build, f)
	local kept, hiddenBySource = {}, 0
	for _, entry in ipairs(DBS) do
		if f.db == "all" or f.db == entry.key then
			local db = entry.get()
			for name, item in pairs(db and db.list or {}) do
				if item.base
					and matchesSlot(item, f.slot)
					and matchesType(build, item, f.type)
					and matchesLeague(item, f.league)
					and matchesRequirement(build, item, f.requirement)
					and matchesSearch(item, f.needle, f.mode)
				then
					if matchesSource(item, f.source) then
						kept[#kept + 1] = { name = name, item = item, db = entry.key }
					else
						-- Counted rather than dropped in silence. Obtainable
						-- is the default here as it is in PoB, and a name
						-- search that finds only legacy variants would
						-- otherwise report nothing and look broken.
						hiddenBySource = hiddenBySource + 1
					end
				end
			end
		end
	end
	table.sort(kept, byName)
	return kept, hiddenBySource
end

--- The powerStatList entry a sort key names.
---
--- Held by reference rather than copied, because GetFromOutput reads
--- `transform` off it: "Taken Fire dmg" sorts on the negated value, and
--- re-deriving that rule here would be a second copy of it.
local function sortEntry(key)
	if type(data) ~= "table" or type(data.powerStatList) ~= "table" then
		return nil
	end
	for _, stat in ipairs(data.powerStatList) do
		if not stat.ignoreForItems and stat.stat == key then
			return stat
		end
	end
	return nil
end

--- What this item would be worth, in the best slot it fits.
---
--- PoB's loop, including both toggles: a flask is not swapped into a slot,
--- it is turned on, and so is a charm. Everything else replaces whatever
--- the slot is holding. An item that fits two slots is worth what the
--- better of the two is worth, which is why this keeps a maximum rather
--- than a sum.
---
--- Two numbers come back. `power` is the sort key, transform and all, and
--- `shown` is the same stat with the transform skipped, which is what a
--- reader wants to see: nobody reads "Taken Fire dmg: -412" as good news.
local function measure(tab, job, item)
	local power, shown
	for slotName, slot in pairs(tab.slots or {}) do
		local okValid, valid = pcall(tab.IsItemValidForSlot, tab, item, slotName)
		if okValid and valid and not slot.inactive
			and (not slot.weaponSet or slot.weaponSet == job.weaponSet)
		then
			local override
			if item.base.flask then
				override = { toggleFlask = item }
			elseif item.base.charm then
				override = { toggleCharm = item }
			else
				override = { repSlotName = slotName, repItem = item }
			end
			local okCalc, output = pcall(job.calcFunc, override, job.useFullDPS)
			if okCalc and type(output) == "table" then
				local okStat, value = pcall(data.powerStatList.GetFromOutput, output, job.stat)
				if okStat and type(value) == "number" and (not power or value > power) then
					power = value
					local okRaw, raw = pcall(data.powerStatList.GetFromOutput, output, job.stat, true)
					shown = (okRaw and type(raw) == "number") and raw or value
				end
			end
		end
	end
	return power, shown
end

--- One scan at a time, keyed by the question it answers.
---
--- PoB runs this inside a coroutine that yields to the draw loop every
--- 50ms and reports "Sorting... (N%)" in the meantime. There is no draw
--- loop on this side, so the same scan yields to the HTTP loop instead:
--- each request spends a fixed budget on it and reports how far it got,
--- and the next request for the same question carries on from there.
--- Asking a different question drops it, and so does recalculating the
--- build, because every measurement is against the build as it was.
local sortJob = nil

--- How much of the list one request will measure.
---
--- PoB yields every 50ms because it owes the draw loop a frame. This owes
--- an HTTP client a response, which is a looser obligation, so the budget
--- is larger: fewer round trips for the same scan, and progress still
--- lands four or five times a second.
local SORT_BUDGET = 0.2

local function sortKey(build, f)
	return table.concat({
		f.db, f.slot, f.type, f.league, f.requirement, f.source,
		f.mode, f.needle, f.sort, tostring(build.outputRevision),
	}, "\1")
end

--- One row of the list.
---
--- The source line arrives as `Drops from unique{Arbiter of Ash} in
--- normal{The Burning Monolith}`, where the braces are PoB's way of
--- colouring a boss name differently from the zone it is in.
--- FormatItemSource turns them into colour codes, which strip then takes
--- off: borrowing PoB's own formatter rather than matching the four brace
--- kinds again here.
local function itemRow(tab, entry)
	local item = entry.item
	local ok, primary = pcall(item.GetPrimarySlot, item)
	local source
	if item.source then
		local okSource, formatted = pcall(tab.FormatItemSource, tab, item.source)
		source = strip(okSource and formatted or item.source)
	end
	return {
		name = entry.name,
		base = strip(item.baseName or ""),
		rarity = item.rarity or "NORMAL",
		slot = ok and primary or nil,
		db = entry.db,
		league = item.league and strip(item.league) or nil,
		source = source,
		level = item.requirements and item.requirements.level or nil,
		-- Only on a stat sort. `value` is the stat as a reader should see
		-- it and `delta` is the change against the build as it stands,
		-- which is the number the question was really about. Absent
		-- together when the item fits no slot this build has.
		value = entry.shown or nil,
		delta = entry.delta or nil,
		fits = entry.power ~= nil or nil,
	}
end

--- Search PoB's unique and rare databases.
---
--- main.uniqueDB.list is keyed by name and holds a parsed Item each, built
--- once at startup from Data/Uniques; main.rareDB.list is the same for the
--- rare templates. Both are scanned together, because "what could go in
--- this slot" does not care which file an item came from.
---
--- Every filter is PoB's, read off DoesItemMatchFilters: the same axes,
--- the same precedence, the same defaults. A filter that quietly disagreed
--- with the desktop app would be worse than no filter at all.
---
--- Sorting by a stat is the part that costs something. It runs the
--- calculator against every candidate in every slot it fits, which is a
--- few hundred full passes, so it is spread over as many requests as it
--- takes and reports its progress on each one.
function api.itemSearch(build, query)
	local tab = build and build.itemsTab
	if not tab or not main then
		return { ready = false }
	end

	query = query or {}
	local f = {
		needle = escapeNeedle(query.q),
		mode = query.mode or "anywhere",
		db = query.db or "all",
		slot = query.slot or "",
		type = query.type or "",
		league = query.league or "",
		requirement = query.req or "any",
		source = query.source or "obtainable",
		sort = query.sort or "name",
	}
	local limit = tonumber(query.limit) or 40
	local loading = dbsLoading() or nil

	local stat = f.sort ~= "name" and sortEntry(f.sort) or nil
	if f.sort ~= "name" and not stat then
		return { ready = false, error = "no such sort: " .. tostring(f.sort) }
	end

	if not stat then
		-- Name order needs no engine, so there is nothing to resume and
		-- the answer is complete the moment it is asked for.
		sortJob = nil
		local kept, hidden = filterList(build, f)
		local rows = asArray({})
		for i = 1, math.min(#kept, limit) do
			rows[i] = itemRow(tab, kept[i])
		end
		return {
			ready = true,
			results = rows,
			total = #kept,
			truncated = #kept > #rows,
			hiddenBySource = (f.source == "obtainable" and hidden > 0) and hidden or nil,
			sort = "name",
			sortLabel = "Name",
			loading = loading,
		}
	end

	local key = sortKey(build, f)
	if not sortJob or sortJob.key ~= key then
		local calcsTab = build.calcsTab
		if not (calcsTab and calcsTab.GetMiscCalculator) then
			return { ready = false, error = "the calculator is not available yet" }
		end
		local calcFunc, calcBase = calcsTab:GetMiscCalculator()
		if not calcFunc then
			return { ready = false, error = "the calculator is not available yet" }
		end

		-- Which slots exist at all is build state, and it is those slots
		-- IsItemValidForSlot is asked about below.
		tab:PopulateSlots()
		pcall(tab.UpdateSockets, tab)

		local env = calcsTab.mainEnv
		local kept, hidden = filterList(build, f)
		local okBase, base = pcall(data.powerStatList.GetFromOutput, calcBase, stat, true)
		sortJob = {
			key = key,
			list = kept,
			hidden = hidden,
			at = 1,
			calcFunc = calcFunc,
			stat = stat,
			useFullDPS = stat.stat == "FullDPS",
			base = (okBase and type(base) == "number") and base or nil,
			weaponSet = (env and env.weaponSet)
				or ((tab.activeItemSet and tab.activeItemSet.useSecondWeaponSet) and 2 or 1),
		}
	end

	local job = sortJob
	-- Restored by hand, as every other calculation here does: measuring
	-- raises it, and leaving it raised would have the UI believe the user
	-- had changed something.
	local buildFlag = build.buildFlag
	local started = os.clock()
	while job.at <= #job.list do
		local entry = job.list[job.at]
		entry.power, entry.shown = measure(tab, job, entry.item)
		if entry.shown and job.base then
			entry.delta = entry.shown - job.base
		end
		job.at = job.at + 1
		if os.clock() - started > SORT_BUDGET then
			break
		end
	end
	build.buildFlag = buildFlag

	-- Ranked among what has been measured, not among everything that
	-- matched, so a scan still running reorders as it goes. The UI says so
	-- rather than pretending the top of the list is settled.
	local ranked = {}
	for i = 1, job.at - 1 do
		ranked[#ranked + 1] = job.list[i]
	end
	table.sort(ranked, function(a, b)
		if a.power ~= b.power then
			-- An item that fits nothing this build has goes last. It is
			-- still listed, because the filters counted it.
			if a.power == nil then return false end
			if b.power == nil then return true end
			return b.power < a.power
		end
		return byName(a, b)
	end)

	local rows = asArray({})
	for i = 1, math.min(#ranked, limit) do
		rows[i] = itemRow(tab, ranked[i])
	end

	local scanning = job.at <= #job.list
	return {
		ready = true,
		results = rows,
		total = #job.list,
		truncated = #ranked > #rows,
		hiddenBySource = (f.source == "obtainable" and job.hidden > 0) and job.hidden or nil,
		sort = f.sort,
		sortLabel = strip(stat.label or f.sort),
		baseline = job.base,
		-- While this is set the list is a leaderboard in progress: ask
		-- again with the same filters to carry the scan on.
		scanning = scanning or nil,
		scanned = job.at - 1,
		loading = loading,
	}
end

--- The values each filter offers, and the stats the list can sort by.
---
--- PoB walks the database once at first open to learn its leagues and item
--- types, because both are data rather than rules: a league exists because
--- an item says it does. Done once here too, and cached, so the UI never
--- hardcodes a list the data can change underneath it. Not cached while
--- the databases are still parsing, or the cache would hold whichever half
--- had loaded.
local dbFacets = nil

local function sortedKeys(set)
	local keys = asArray({})
	for key in pairs(set) do
		keys[#keys + 1] = key
	end
	table.sort(keys)
	return keys
end

function api.itemFilters()
	if not main then
		return { ready = false }
	end

	local loading = dbsLoading()
	if not dbFacets or (dbFacets.partial and not loading) then
		local leagues, types = {}, {}
		for _, entry in ipairs(DBS) do
			local db = entry.get()
			for _, item in pairs(db and db.list or {}) do
				-- One item can name several leagues, comma separated.
				for league in tostring(item.league or ""):gmatch(" ?([%w ]+),?") do
					leagues[league] = true
				end
				if item.type then
					types[item.type] = true
				end
			end
		end
		dbFacets = {
			leagues = sortedKeys(leagues),
			types = sortedKeys(types),
			partial = loading or nil,
		}
	end

	local sorts = asArray({ { key = "name", label = "Name" } })
	for _, stat in ipairs((type(data) == "table" and data.powerStatList) or {}) do
		if not stat.ignoreForItems and stat.stat then
			sorts[#sorts + 1] = { key = stat.stat, label = strip(stat.label or stat.stat) }
		end
	end

	return {
		ready = true,
		loading = loading or nil,
		-- PoB's own slot list, which is deliberately shorter than the set
		-- of slots a build has: one entry covers both rings.
		slots = asArray({
			"Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves",
			"Boots", "Amulet", "Ring", "Belt", "Jewel",
		}),
		-- The four groups come first because they are the useful ones; the
		-- bare types after them are what the data happens to contain.
		typeGroups = asArray({
			{ key = "armour", label = "Armour" },
			{ key = "jewellery", label = "Jewellery" },
			{ key = "melee1h", label = "One Handed Melee" },
			{ key = "melee2h", label = "Two Handed Melee" },
		}),
		types = dbFacets.types,
		leagues = dbFacets.leagues,
		sorts = sorts,
		sources = asArray({
			{ key = "obtainable", label = "Obtainable" },
			{ key = "any", label = "Any source" },
			{ key = "unobtainable", label = "Unobtainable" },
			{ key = "vendor", label = "Vendor Recipe" },
			{ key = "upgraded", label = "Upgraded" },
			{ key = "boss", label = "Boss Item" },
			{ key = "corruption", label = "Corruption" },
		}),
		requirements = asArray({
			{ key = "any", label = "Any requirements" },
			{ key = "level", label = "Current level" },
			{ key = "attributes", label = "Current attributes" },
			{ key = "useable", label = "Current useable" },
		}),
		modes = asArray({
			{ key = "anywhere", label = "Anywhere" },
			{ key = "names", label = "Names" },
			{ key = "mods", label = "Modifiers" },
		}),
	}
end

------------------------------------------------------------ the skills tab

--- One gem in a socket group, as the editor needs it.
---
--- ProcessSocketGroup has already resolved gemId into gemData, set the
--- colour from the granted effect's attribute, and recorded errMsg for a
--- gem the build cannot actually use. All of that is read rather than
--- recomputed: which gems are valid is a game rule with a lot of history in
--- it.
local function gemSummary(index, gem)
	local data = gem.gemData
	local effect = gem.grantedEffect or (data and data.grantedEffect)
	return {
		index = index,
		name = strip(gem.nameSpec or (data and data.name) or ""),
		level = gem.level or 1,
		quality = gem.quality or 0,
		enabled = gem.enabled ~= false,
		count = gem.count or 1,
		-- PoB colours a gem by its attribute: red, green or blue.
		tone = toneOf(gem.color or ""),
		support = effect and effect.support and true or nil,
		tags = data and data.tagString ~= "" and strip(data.tagString) or nil,
		maxLevel = data and data.naturalMaxLevel or nil,
		-- Set when the gem cannot be used: a support that supports
		-- nothing here, a name that matched two gems, an active skill that
		-- is hidden from the side bar.
		error = gem.errMsg and strip(gem.errMsg) or nil,
	}
end

--- One socket group in the list.
---
--- `displayLabel` is PoB's, built during the calculation pass out of the
--- group's own label or the names of the active skills in it. The list
--- control decorates it with "(Disabled)", "(Active)" and "(FullDPS)" in
--- colour; those travel as flags instead, so the UI can draw badges rather
--- than parse a string back apart.
local function groupSummary(tab, index, group)
	local skills = asArray({})
	for _, skill in ipairs(group.displaySkillList or {}) do
		local effect = skill.activeEffect and skill.activeEffect.grantedEffect
		local name = effect and effect.name
		-- A meta gem's granted effect carries an empty name rather than no
		-- name, and "" is truthy in Lua, so the fallback below never fired
		-- and the list read "grants , Mirage Archer, Ice Shot". The gem's
		-- own name is what that skill is called anywhere a person looks.
		if type(name) ~= "string" or name:match("^%s*$") then
			local gemData = skill.activeEffect and skill.activeEffect.gemData
			name = (gemData and gemData.name) or (effect and effect.id) or "?"
		end
		skills[#skills + 1] = strip(name)
	end

	-- PoB's own label: "Set 1", "Set 2" or "Both". Its own method, because
	-- "both" is the absence of either flag rather than the presence of
	-- two, which is not a rule worth restating here and getting wrong.
	local okSet, weaponSet = pcall(tab.GetSocketGroupWeaponSetLabel, tab, group)

	local source = nil
	local single = group.sourceItem or group.sourceNode
	if single then
		source = strip(single.name or single.dn or "")
	elseif group.source then
		source = strip(tostring(group.source))
	end

	return {
		index = index,
		label = strip(group.displayLabel or group.label or "?"),
		-- The group's own name, which is what is editable; displayLabel
		-- falls back to the skill names when this is empty.
		name = strip(group.label or ""),
		slot = group.slot or nil,
		enabled = group.enabled ~= false,
		fullDPS = group.includeInFullDPS and true or nil,
		main = tab.build.mainSocketGroup == index or nil,
		-- Groups granted by an item or a passive cannot be deleted or
		-- renamed; PoB rebuilds them on every pass.
		source = source,
		gemCount = #(group.gemList or {}),
		skills = skills,
		weaponSet = okSet and weaponSet or nil,
	}
end

--- The skills screen: socket groups, and the gems in the one being edited.
---
--- ProcessSocketGroup is run over the group being edited for the same
--- reason the items screen runs PopulateSlots: it is what resolves each
--- gem's id into its data, and nothing runs it headless.
function api.skills(build, groupIndex)
	local tab = build and build.skillsTab
	if not tab or not tab.socketGroupList then
		return { ready = false }
	end

	local groups = asArray({})
	for index, group in ipairs(tab.socketGroupList) do
		groups[#groups + 1] = groupSummary(tab, index, group)
	end

	local sets = asArray({})
	for _, id in ipairs(tab.skillSetOrderList or {}) do
		local set = tab.skillSets and tab.skillSets[id]
		if set then
			sets[#sets + 1] = { id = id, name = strip(set.title or "Default") }
		end
	end

	local selected, gems = nil, nil
	local group = groupIndex and tab.socketGroupList[tonumber(groupIndex) or 0]
	if group then
		pcall(tab.ProcessSocketGroup, tab, group)
		selected = tonumber(groupIndex)
		gems = asArray({})
		for index, gem in ipairs(group.gemList or {}) do
			gems[#gems + 1] = gemSummary(index, gem)
		end
	end

	return {
		ready = true,
		groups = groups,
		sets = sets,
		setId = tab.activeSkillSetId or 0,
		mainGroup = build.mainSocketGroup or 0,
		selected = selected,
		gems = gems,
	}
end

--- What a socket group actually does, as PoB describes it.
---
--- AddSocketGroupTooltip walks the group's active skills and their effect
--- lists, naming each gem with its level and quality in the attribute's own
--- colour, and names the item or passive that granted the group. It also
--- resolves deferred default attacks first, which is why the engine's own
--- entry point is used rather than the display list directly.
function api.socketGroupDetail(build, groupIndex)
	local tab = build and build.skillsTab
	local group = tab and tab.socketGroupList and tab.socketGroupList[tonumber(groupIndex) or 0]
	if not group then
		return { ready = false }
	end

	local tooltip = new("Tooltip"):Tooltip()
	local ok, err = pcall(tab.AddSocketGroupTooltip, tab, tooltip, group)
	if not ok then
		return { ready = false, error = tostring(err) }
	end

	local lines, tips = tooltipLines(tooltip)
	return { ready = true, index = tonumber(groupIndex), lines = lines, droppedTips = tips }
end

--- One gem, as PoB itself would draw it.
---
--- Everything the gem panel shows comes from GemTooltip.AddGemTooltip: the
--- tags, the requirements at this level, the stat lines for the current
--- level and quality, and the quality bonus. Reproducing any of that would
--- mean reproducing how a granted effect's levels and stat sets resolve.
function api.gemDetail(build, groupIndex, gemIndex)
	local tab = build and build.skillsTab
	local group = tab and tab.socketGroupList and tab.socketGroupList[tonumber(groupIndex) or 0]
	local gem = group and group.gemList and group.gemList[tonumber(gemIndex) or 0]
	if not gem then
		return { ready = false }
	end
	if not gem.gemData then
		-- A gem the build cannot resolve has no tooltip to draw, and its
		-- own error message is the useful thing to say.
		return { ready = false, error = gem.errMsg and strip(gem.errMsg) or "that gem is not resolved" }
	end

	local gemTooltip = LoadModule("Classes/GemTooltip")
	local tooltip = new("Tooltip"):Tooltip()
	local ok, err = pcall(gemTooltip.AddGemTooltip, tooltip, build, gem, {})
	if not ok then
		return { ready = false, error = tostring(err) }
	end

	local lines, tips = tooltipLines(tooltip)
	return {
		ready = true,
		group = tonumber(groupIndex),
		gem = tonumber(gemIndex),
		name = strip(gem.nameSpec or ""),
		lines = lines,
		droppedTips = tips,
	}
end

--- Search every gem the game has, by name.
---
--- data.gems is keyed by the metadata path and holds the parsed gem, so the
--- id that comes back here is what addGem takes. Supports and actives are
--- distinguished because that is the first thing you want to know about a
--- gem you are looking for.
function api.gemSearch(query, limit)
	local needle = tostring(query or ""):lower()
	local max = tonumber(limit) or 40
	if #needle < 2 or not data or not data.gems then
		return { ready = true, results = asArray({}), total = 0 }
	end

	local results, total = asArray({}), 0
	for gemId, gem in pairs(data.gems) do
		local name = gem.name
		if name and tostring(name):lower():find(needle, 1, true) then
			total = total + 1
			if #results < max then
				local effect = gem.grantedEffect
				results[#results + 1] = {
					id = gemId,
					name = strip(name),
					support = effect and effect.support and true or nil,
					tags = gem.tagString ~= "" and strip(gem.tagString) or nil,
					maxLevel = gem.naturalMaxLevel or nil,
				}
			end
		end
	end

	table.sort(results, function(a, b) return a.name < b.name end)
	return { ready = true, results = results, total = total, truncated = total > #results }
end

------------------------------------------------------------ the config tab

--- PoB's configuration options, in their declared order.
---
--- The same table ConfigTab builds its controls from: section markers and
--- 547 option definitions, interleaved. Required rather than reproduced,
--- obviously, and `require` returns the instance ConfigTab already holds.
local configOptions
local function loadConfigOptions()
	if configOptions == nil then
		local ok, result = pcall(require, "Modules.ConfigOptions")
		configOptions = ok and result or false
	end
	return configOptions or nil
end

--- The tooltip PoB would show for one option.
---
--- `control.tooltipText` is assembled from every `ifCond`, `ifFlag` and
--- `tooltip` the option declared, and some of those are functions of the
--- live mod list: "You will automatically be considered to be on Low Life
--- if you have at least 43% Life reserved" is computed from the build. So
--- it is called rather than read from the option definition.
local function optionTooltip(control)
	local text = control.tooltipText
	if type(text) == "function" then
		local ok, result = pcall(text)
		text = ok and result or nil
	end
	if type(text) ~= "string" or text == "" then
		return nil
	end
	local lines = asArray({})
	for line in (strip(text) .. "\n"):gmatch("([^\n]*)\n") do
		lines[#lines + 1] = line
	end
	return lines
end

--- The build's configuration: every option that currently applies to it.
---
--- The interesting thing about this screen is how much of it is usually
--- not on it. There are 547 options and a given build is asked perhaps
--- forty of them, because PoB only shows an option when the build could
--- answer it: `ifCond` against the conditions the calculation actually
--- used, `ifFlag` against the mod list, `ifSkillData` against the active
--- skill, `ifNode` against the allocated tree. That gating is a function of
--- the whole calculation, so every option's visibility is asked of its own
--- control rather than worked out here.
---
--- Two rules in that closure are worth knowing about, because neither is
--- obvious and both would be wrong if reimplemented. An option that no
--- longer applies is still shown when its value differs from the default,
--- so a setting cannot go on affecting the build from somewhere you cannot
--- see it. And `toggleConfigs`, the tab's "show all", reveals the
--- build-gated options but deliberately not the ones gated on another
--- option being set, because those would have nothing to attach to.
function api.config(build)
	local tab = build and build.configTab
	local varList = loadConfigOptions()
	if not tab or not tab.varControls or not varList then
		return { ready = false }
	end

	local set = tab.configSets and tab.configSets[tab.activeConfigSetId]
	if not set then
		return { ready = false }
	end

	local sections, current = asArray({}), nil
	local shownCount = 0

	-- PoB's option list is not quite unique. As of this tree,
	-- `conditionEnemyExitedPresenceRecently` is declared twice (once as
	-- "Enemy exited Presence Recently?" gated on ExitedPresenceRecently,
	-- and again as "Enemy entered Presence Recently?" gated on
	-- EnteredPresenceRecently) so two different questions write to one
	-- input. That is an upstream bug rather than something to paper over,
	-- but sending both would give the UI two controls bound to one value,
	-- where ticking either ticks both. The first wins and the rest are
	-- reported, so the collision is visible instead of silent.
	local emitted, duplicates = {}, asArray({})

	for _, varData in ipairs(varList) do
		if varData.section then
			current = {
				name = strip(varData.section),
				-- PoB lays the sections out in three columns.
				col = varData.col or 1,
				options = asArray({}),
			}
			sections[#sections + 1] = current
		elseif varData.var and current then
			if emitted[varData.var] then
				duplicates[#duplicates + 1] = varData.var
				goto continue
			end
			emitted[varData.var] = true
			local control = tab.varControls[varData.var]
			local ok, shown = pcall(function()
				return control and control:IsShown()
			end)
			if ok and shown then
				shownCount = shownCount + 1

				local value = set.input[varData.var]
				local default = tab:GetDefaultState(varData.var, type(value))

				local options = nil
				if varData.type == "list" then
					options = asArray({})
					for _, entry in ipairs(varData.list or {}) do
						options[#options + 1] = {
							value = entry.val,
							label = strip(entry.label or tostring(entry.val)),
							tone = toneOf(entry.label),
						}
					end
				end

				current.options[#current.options + 1] = {
					var = varData.var,
					-- check | count | integer | countAllowZero | float |
					-- list | text
					type = varData.type or "check",
					label = strip(varData.label or varData.var),
					value = value,
					placeholder = set.placeholder[varData.var],
					default = default,
					-- PoB draws a blue border round an option that is not
					-- at its default; the UI needs the same cue, and the
					-- comparison is the tab's own.
					changed = (value ~= nil and value ~= default) or nil,
					list = options,
					tooltip = optionTooltip(control),
				}
			end
		end
		::continue::
	end

	-- Sections that asked nothing of this build are not worth a heading.
	local kept = asArray({})
	for _, section in ipairs(sections) do
		if #section.options > 0 then
			kept[#kept + 1] = section
		end
	end

	local sets = asArray({})
	for _, id in ipairs(tab.configSetOrderList or {}) do
		local entry = tab.configSets and tab.configSets[id]
		if entry then
			sets[#sets + 1] = { id = id, name = strip(entry.title or "Default") }
		end
	end

	-- Free-text modifier blocks, which is how a build describes something
	-- PoB has no option for.
	local customMods = asArray({})
	for index, block in ipairs(set.customModsList or {}) do
		customMods[#customMods + 1] = {
			index = index,
			title = strip(block.title or ""),
			enabled = block.enabled ~= false,
			text = tostring(block.text or ""),
		}
	end

	return {
		ready = true,
		sections = kept,
		sets = sets,
		setId = tab.activeConfigSetId or 0,
		showAll = tab.toggleConfigs and true or false,
		customMods = customMods,
		shown = shownCount,
		-- Options declared more than once upstream, dropped after the
		-- first. Should be one entry today; anything else is news.
		duplicates = duplicates,
		-- How many there are in total, so the screen can say what it is
		-- not showing rather than looking like that is all there is.
		total = #varList,
	}
end

-------------------------------------------------------------- the notes

-- The twelve colours the desktop Notes tab offers as buttons, in its own
-- order. Only the names are written down: the codes are read out of
-- colorCodes, because the palette is PoB's and it has been changed before.
-- DEFAULT is the exception, because NotesTab writes "^7" literally rather
-- than naming a colour.
local NOTE_COLOURS = {
	"NORMAL", "MAGIC", "RARE", "UNIQUE",
	"FIRE", "COLD", "LIGHTNING", "CHAOS",
	"STRENGTH", "DEXTERITY", "INTELLIGENCE",
}

-- The ten indexed colours `^0` to `^9` resolve against. Unlike the named
-- palette there is nothing to read these out of: they belong to the
-- renderer rather than to PoB's data, and both the SimpleGraphic host and
-- the LOVE one define the same table.
local DIGIT_HEX = {
	["0"] = "#000000", ["1"] = "#ff0000", ["2"] = "#00ff00", ["3"] = "#0000ff",
	["4"] = "#ffff00", ["5"] = "#ff00ff", ["6"] = "#00ffff", ["7"] = "#ffffff",
	["8"] = "#b3b3b3", ["9"] = "#666666",
}

--- A caret escape as a CSS colour, or nil if it is not one.
local function hexOf(code)
	code = tostring(code or "")
	local hex = code:match("^%^[xX](%x%x%x%x%x%x)")
	if hex then
		return "#" .. hex:lower()
	end
	local digit = code:match("^%^(%d)")
	return digit and DIGIT_HEX[digit] or nil
end

--- The notes, and what is needed to colour them.
---
--- One text buffer on a build, which is the whole of the desktop tab: the
--- notes are free text, saved into the build XML by `NotesTab:Save`, and
--- read by nothing else. No calculation depends on them.
---
--- The only subtlety is the caret escapes. `^xRRGGBB` and `^0` to `^9` set
--- the colour of everything after them, and the desktop tab shows them
--- with a toggle that rewrites `^` to `^_` throughout so the codes become
--- visible as text. That is a trick for making one widget do two jobs, and
--- it is a destructive one: the buffer really is rewritten. There are two
--- widgets here, an editor and a preview beside it, so the toggle is not
--- needed and the buffer is always read in its real form.
function api.notes(build)
	local tab = build and build.notesTab
	local edit = tab and tab.controls and tab.controls.edit
	if not edit then
		return { ready = false }
	end

	-- If the desktop tab was left with its toggle on, the buffer is
	-- carrying escaped codes. Putting it back is what Save does too.
	if tab.showColorCodes then
		pcall(tab.SetShowColorCodes, tab, false)
	end

	local palette = asArray({})
	for _, name in ipairs(NOTE_COLOURS) do
		local code = type(colorCodes) == "table" and colorCodes[name] or nil
		local hex = hexOf(code)
		if hex then
			palette[#palette + 1] = { name = name, code = code, hex = hex }
		end
	end
	palette[#palette + 1] = { name = "DEFAULT", code = "^7", hex = DIGIT_HEX["7"] }

	return {
		ready = true,
		text = edit.buf or "",
		-- PoB's own comparison against what was loaded. Reported so the UI
		-- can say whether what is on screen has reached the file yet.
		modified = tab.modFlag and true or nil,
		palette = palette,
		digits = DIGIT_HEX,
	}
end

----------------------------------------------------------- crafting

-- Prefixes and suffixes are two tables on the item with the same shape, so
-- everything below takes the pair as one argument.
local AFFIX_TABLE = { prefix = "prefixes", suffix = "suffixes" }
local AFFIX_TYPE = { prefix = "Prefix", suffix = "Suffix" }

--- How many rows of one kind this item has.
---
--- `limit` is set per item where it differs; otherwise it is half the
--- total, because an item's affix budget is split evenly between the two.
local function affixLimit(item, outputTable)
	local table_ = item[outputTable]
	return (table_ and table_.limit) or math.floor((item.affixLimit or 0) / 2)
end

--- The candidates for one affix row, as PoB builds them.
---
--- `UpdateAffixControl` fills a DropDownControl rather than returning a
--- list, so it is handed a stub carrying the four fields it writes to and
--- the list is read back off it. What it does is the whole of PoB's affix
--- rule: which mods this base can roll at all (`GetModSpawnWeight` against
--- the base's tags), which groups the other rows have already used up, the
--- tags those rows add, and the grouping of a mod's tiers into one entry.
--- None of that is worth a second opinion.
---
--- Note what it does *not* do: filter by item level. The data carries a
--- `level` on every mod and PoB ignores it here, so a level 1 ring offers
--- the level 81 tier. That is the desktop app's behaviour and this reports
--- the tier levels rather than quietly disagreeing with it.
local function affixControl(tab, item, kind, index)
	local control = { slider = {} }
	local ok, err = pcall(
		tab.UpdateAffixControl, tab, control, item, AFFIX_TYPE[kind], AFFIX_TABLE[kind], index
	)
	if not ok then
		return nil, tostring(err)
	end
	return control
end

--- What a mod reads at a given roll.
---
--- The mod's lines carry their ranges as `(5-8)`; applyRange resolves them
--- the same way the item's own tooltip does, so a row can say "+7 to
--- Strength" rather than making the reader interpolate.
local function modLines(mod, roll)
	local lines = asArray({})
	for _, line in ipairs(mod or {}) do
		local ok, resolved = pcall(itemLib.applyRange, line, roll or 0.5)
		lines[#lines + 1] = strip(ok and resolved or line)
	end
	return lines
end

--- One affix row: what is in it, and where that sits among the tiers.
local function affixRow(tab, item, kind, index)
	local slot = item[AFFIX_TABLE[kind]][index] or {}
	local row = { index = index }

	local modId = slot.modId
	if not modId or modId == "None" then
		return row
	end

	local mod = item.affixes[modId]
	if not mod then
		-- An affix the item can no longer roll, which happens when a base
		-- is swapped under a saved craft. Named rather than hidden.
		row.modId = modId
		row.unknown = true
		return row
	end

	-- A roll can arrive outside 0 to 1 from an imported legacy item. The
	-- value is reported as it is rather than clamped, because clamping it
	-- here would silently rewrite the item on the next read.
	local roll = type(slot.range) == "table" and slot.range[1] or slot.range
	row.modId = modId
	row.affix = strip(mod.affix or "")
	row.group = mod.group
	row.level = mod.level
	row.roll = type(roll) == "number" and roll or nil
	row.lines = modLines(mod, roll)

	-- Which tier this is, out of how many, which needs the row's own
	-- candidate list because the tiers are grouped there.
	local control = affixControl(tab, item, kind, index)
	local entry = control and control.list and control.list[control.selIndex]
	if type(entry) == "table" and entry.modList then
		row.label = strip(entry.label or "")
		row.tierCount = #entry.modList
		for tier, id in ipairs(entry.modList) do
			if id == modId then
				row.tier = tier
				break
			end
		end
		row.modIds = asArray(entry.modList)
	end
	return row
end

--- Whether this item can carry rune sockets at all.
---
--- PoB's own `canHaveAugmentSockets`, which is a file-local one-liner in
--- the Items tab rather than a method, so it is repeated here: a base with
--- a socket limit, a base that overrides what may go in its sockets, or an
--- item that already has some.
local function canSocket(item)
	return (item.base and item.base.socketLimit and item.base.socketLimit > 0)
		or item.socketedAugmentTypeOverride ~= nil
		or (item.itemSocketCount or 0) > 0
end

--- One rune, as the list needs it.
local function runeEntry(rune)
	local lines = asArray({})
	for _, line in ipairs(rune.lines or {}) do
		lines[#lines + 1] = strip(line)
	end
	return {
		name = rune.name,
		label = strip(rune.label or lines[1] or rune.name),
		lines = lines,
		-- Rune or SoulCore. A base can be restricted to one or the other,
		-- and the filter below has already applied that, but the kind is
		-- still worth saying: they are different objects in the game.
		type = rune.type,
		-- The level the rune itself needs, which is not the item's.
		req = rune.req,
		-- How many of this rune one item may carry, where the game caps it.
		limit = rune.limit,
		-- A rune that cannot be taken out again once it is in.
		socketBound = rune.isSocketBound or nil,
	}
end

--- The runes and soul cores this item's sockets will accept.
---
--- `GetValidRunesForItem` is the whole rule and it is a real one: the
--- socket's own augment type, the soul core types the base names, the
--- SocketedRunesOnly and SocketedSoulCoresOnly flags a unique can carry,
--- and the two blanket restrictions on uniques and on jewellery. It also
--- merges the several mod lines one rune can have into a single entry.
--- Reimplementing that would be six chances to disagree with the game.
function api.craftRunes(build, query)
	local tab = build and build.itemsTab
	local item = tab and tab.displayItem
	if not item then
		return { ready = false }
	end
	if not canSocket(item) then
		return { ready = false, error = "this base has no rune sockets" }
	end

	local ok, runes = pcall(tab.GetValidRunesForItem, tab, item)
	if not ok then
		return { ready = false, error = tostring(runes) }
	end

	local needle = tostring(query or ""):lower()
	local options, total = asArray({}), 0
	for _, rune in ipairs(runes or {}) do
		-- The first entry is PoB's "None", which is the empty socket
		-- rather than something to put in one.
		if rune.name and rune.name ~= "None" then
			local entry = runeEntry(rune)
			local hay = (entry.name .. " " .. entry.label .. " " .. table.concat(entry.lines, " ")):lower()
			if needle == "" or hay:find(needle, 1, true) then
				total = total + 1
				options[#options + 1] = entry
			end
		end
	end

	return {
		ready = true,
		options = options,
		total = total,
	}
end

--- Whether this item can be anointed at all.
---
--- PoB's own `isAnointable`, a file-local in the Items tab rather than a
--- method, so it is repeated here: an amulet, or anything carrying the line
--- that says Cassia can anoint it. The three further clauses in PoB's copy
--- (not sanctified, not corrupted, not mirrored) are commented out there,
--- so they are left out here too.
local function isAnointable(item)
	return (item and item.base and (item.canBeAnointed or item.base.type == "Amulet"))
		and true or false
end

--- Whether a notable can be anointed: PoB's `IsAnointableNode`.
---
--- The whole test is that the node has a recipe, which is the distilled
--- emotions the anoint costs. 875 nodes on the current tree have one.
local function isAnointableNode(node)
	return (node and node.recipe and #node.recipe >= 1) and true or false
end

--- The anoint slots this item has, and what is in each.
---
--- PoB keeps an anoint as an enchant line reading "Allocates <notable>",
--- and `anointEnchantSlot` indexes `enchantModLines` rather than the
--- anoints within it: slot 2 is the second enchant line, which is only the
--- second anoint if the first line is one as well.
---
--- The gating is PoB's own, one button per slot: the second needs the line
--- that allows an additional instilled modifier and a first line to sit
--- after, the third needs two, the fourth three. Shared with the write
--- side rather than written twice, so what the panel offers and what the
--- engine will accept cannot drift apart.
local function anointSlots(item)
	local slots = asArray({})
	if not isAnointable(item) then
		return slots
	end
	local lines = item.enchantModLines or {}
	for index = 1, 4 do
		local allowed = index == 1
			or (index == 2 and item.canHaveTwoEnchants and #lines > 0)
			or (index == 3 and item.canHaveThreeEnchants and #lines > 1)
			or (index == 4 and item.canHaveFourEnchants and #lines > 2)
		if allowed then
			local line = lines[index] and strip(lines[index].line or "")
			local node = line and line:match("^Allocates (.+)$")
			slots[#slots + 1] = {
				index = index,
				node = node,
				-- What this enchant line holds when it is not an anoint.
				-- Anointing replaces the line whatever is in it, which is
				-- PoB's behaviour, so it is worth a warning before the
				-- click rather than a surprise after it.
				other = (line and not node and line:match("%S")) and line or nil,
			}
		end
	end
	return slots
end

--- One notable, as the anoint list needs it.
local function anointEntry(build, node)
	local lines = asArray({})
	for _, line in ipairs(node.sd or {}) do
		if line and line:match("%S") then
			lines[#lines + 1] = strip(line)
		end
	end
	-- Copied rather than passed through: tagging a list for the encoder
	-- sets a metatable on it, and this one belongs to the tree.
	local recipe = asArray({})
	for _, emotion in ipairs(node.recipe or {}) do
		recipe[#recipe + 1] = emotion
	end
	return {
		id = node.id,
		name = strip(node.dn or node.name or ""),
		lines = lines,
		-- The distilled emotions the anoint costs. Three, mostly.
		recipe = recipe,
		-- Already on the tree, so anointing it would change nothing. PoB
		-- says so in its tooltip rather than hiding the node, and so does
		-- this.
		allocated = (build.spec and build.spec.allocNodes
			and build.spec.allocNodes[node.id]) and true or nil,
	}
end

---------------------------------------------------------------- corrupting

-- `data.itemMods.Corruption` is keyed by modifier id, and the dialog's own
-- lists carry the modifier tables rather than their keys. One reverse map,
-- built once, so a choice can travel over HTTP as an id and come back as
-- the identical table the dialog is holding.
local corruptionIds

local function corruptionId(mod)
	if not corruptionIds then
		corruptionIds = {}
		for modId, entry in pairs(data.itemMods.Corruption or {}) do
			corruptionIds[entry] = modId
		end
	end
	return corruptionIds[mod]
end

--- One corruption implicit, as the list needs it.
local function corruptionEntry(mod)
	local lines = asArray({})
	for _, line in ipairs(mod) do
		if line and line:match("%S") then
			lines[#lines + 1] = strip(line)
		end
	end
	return {
		modId = corruptionId(mod),
		lines = lines,
		-- One modifier per group, which is why taking the same group in a
		-- second slot is not offered.
		group = mod.group,
	}
end

--- A corruption, as asked for over the wire.
---
--- The same shape either way: a JSON body gives real tables, a query string
--- gives "1:ModId,2:ModId", and both say the same thing. Keyed by slot
--- rather than positional, because a draft with only the second slot filled
--- is a thing a person does.
local function corruptionDraft(value)
	value = type(value) == "table" and value or {}
	local draft = {
		source = value.source,
		-- PoB's Corrupted button writes one half of its dialog or the
		-- other, never both, and the half it writes is whichever one is
		-- showing. So the mode is not a convenience here, it is the rule.
		mode = (value.mode == "ranges") and "ranges" or "implicits",
		implicits = {},
		ranges = {},
	}
	local function each(field, fn)
		local raw = value[field]
		if type(raw) == "table" then
			for key, entry in pairs(raw) do
				local index = tonumber(key)
				if index then fn(index, entry) end
			end
		elseif type(raw) == "string" then
			for chunk in raw:gmatch("[^,]+") do
				local key, entry = chunk:match("^(%d+):(.*)$")
				if key then fn(tonumber(key), entry) end
			end
		end
	end
	each("implicits", function(index, entry)
		if entry ~= nil and entry ~= "" then
			draft.implicits[index] = tostring(entry)
		end
	end)
	each("ranges", function(index, entry)
		local number = tonumber(entry)
		if number then draft.ranges[index] = number end
	end)
	return draft
end

--- The roll-range rows the dialog built, by explicit modifier index.
---
--- One per explicit that actually scales, keyed by its place in
--- `explicitModLines`, so the set has holes in it and has to be read back
--- off the controls rather than counted.
local function corruptionRangeRows(controls)
	local rows, ordered = {}, {}
	for key, control in pairs(controls) do
		local index = tonumber(tostring(key):match("^rollRangeSlider(%d+)$") or "")
		if index then
			rows[index] = control
			ordered[#ordered + 1] = index
		end
	end
	table.sort(ordered)
	return rows, ordered
end

--- How many implicit slots the dialog is offering.
local function corruptionSlots(controls)
	local slots = 0
	for index = 1, 8 do
		local drop = controls["enchant" .. index]
		if drop and drop.shown then slots = index end
	end
	return slots
end

--- PoB's corruption dialog, opened, driven, and closed again.
---
--- Driven rather than reimplemented, which is the only honest option here:
--- `corruptItem` and `applyCorruptionMods` are closures inside
--- `CorruptDisplayItem` rather than methods, so nothing outside can call
--- them. What is reachable is the dialog itself, and it holds everything
--- that matters: the modifier list already filtered by what this base can
--- spawn and sorted PoB's way, the group exclusion between slots, the
--- roll-range rows for the explicits that scale, and a Corrupted button
--- that is the real write. So the dialog is opened headless, its controls
--- are set, and its own button is pressed.
---
--- `body` is handed the controls and its return value comes back out. The
--- dialog is closed on the way out whatever happens, including the extra
--- close the Corrupted button does for itself.
local function withCorruptionDialog(build, value, body)
	local tab = build and build.itemsTab
	local item = tab and tab.displayItem
	if not item then
		return nil, "nothing is on the bench"
	end
	if not item.base then
		return nil, "this item has no base, so it cannot be corrupted"
	end
	if not item.corruptible then
		return nil, "a " .. tostring(item.base.type or "item") .. " cannot be corrupted"
	end

	local draft = corruptionDraft(value)
	local depth = #main.popups
	local opened, openErr = pcall(tab.CorruptDisplayItem, tab)
	local controls = main.popups[1] and main.popups[1].controls
	if not opened or not controls or not controls.save then
		while #main.popups > depth do main:ClosePopup() end
		return nil, "the corruption dialog would not open: " .. tostring(openErr)
	end

	local ok, result, failure = pcall(function()
		-- Source first: on a helmet it swaps the whole list for Glimpse of
		-- Chaos's eight, and it rebuilds the slots underneath.
		if draft.source and draft.source ~= "" then
			local want = (draft.source == "SpecialCorrupted") and "Glimpse of Chaos" or "Corrupted"
			local found
			for index, entry in ipairs(controls.source.list or {}) do
				if entry == want then found = index end
			end
			if not found then
				return nil, "this item has no " .. tostring(draft.source) .. " corruption"
			end
			controls.source.selIndex = found
			controls.source.selFunc(found, want)
		end

		if draft.mode == "ranges" then
			local _, ordered = corruptionRangeRows(controls)
			if #ordered == 0 then
				return nil, "this item has no modifiers that a corruption would scale"
			end
			-- Which half of the dialog is showing is also which half its
			-- button writes, so the mode is set by pressing PoB's own tab.
			controls.rolls.onClick()
			for index, wanted in pairs(draft.ranges) do
				local slider = controls["rollRangeSlider" .. index]
				if not slider then
					return nil, "modifier " .. tostring(index)
						.. " does not scale, so it has no roll range"
				end
				local range = math.min(1.22, math.max(0.78, tonumber(wanted) or 1))
				slider.val = (range - 0.78) / 0.44
				slider.changeFunc(slider.val)
			end
		else
			-- Ascending, because each choice takes its group out of the
			-- other slots' lists: in any other order the same draft would
			-- be accepted or refused depending on which key came first.
			local slots = {}
			for index in pairs(draft.implicits) do slots[#slots + 1] = index end
			table.sort(slots)

			-- Read off the dialog rather than off the draft: a Glimpse of
			-- Chaos helmet opens on the special list without being asked,
			-- so the source that is active is not always the one named.
			local active = controls.source.list[controls.source.selIndex]
			local wantType = (active == "Glimpse of Chaos") and "SpecialCorrupted" or "Corrupted"
			local sourceName = { Corrupted = "Corrupted", SpecialCorrupted = "Glimpse of Chaos" }

			local taken = {}
			for _, index in ipairs(slots) do
				local modId = draft.implicits[index]
				local drop = controls["enchant" .. index]
				if not drop or not drop.shown then
					return nil, "this item has no corruption slot " .. tostring(index)
				end
				local mod = data.itemMods.Corruption[modId]
				if not mod then
					return nil, "no corruption modifier called " .. tostring(modId)
				end
				-- The two sources are two separate lists, so a modifier
				-- from the other one is a wrong source rather than a base
				-- that cannot take it.
				if mod.type ~= wantType then
					return nil, strip(mod[1] or modId) .. " comes from "
						.. (sourceName[mod.type] or tostring(mod.type))
						.. ", not " .. (sourceName[wantType] or wantType)
				end
				if taken[mod.group] then
					return nil, "slot " .. tostring(taken[mod.group])
						.. " already has a modifier from this group, and an item can carry one"
				end
				drop:SelByValue(mod, "mod")
				local chosen = drop.list[drop.selIndex]
				if not chosen or chosen.mod ~= mod then
					return nil, strip(mod[1] or modId) .. " cannot be corrupted onto this base"
				end
				taken[mod.group] = index
				-- Rebuilding the other slots' lists around this choice is
				-- the dropdown's own callback.
				drop.selFunc(drop.selIndex, chosen)
			end
		end

		return body(controls)
	end)

	while #main.popups > depth do
		main:ClosePopup()
	end

	if not ok then
		return nil, tostring(result)
	end
	if failure then
		return nil, failure
	end
	return result
end

--- The corruption implicits the bench item could take, and what it carries.
---
--- The filtering is PoB's and it is a game rule: a modifier of the right
--- type whose spawn weight on this base is above zero, which is the game's
--- own answer to what a Vaal Orb can put on a pair of boots. The sort is
--- PoB's too. Both are read off the dialog rather than rebuilt here.
function api.craftCorruptions(build, source, query)
	local tab = build and build.itemsTab
	local item = tab and tab.displayItem
	local needle = escapeNeedle(query)
	local searching = needle:match("%S") and true or false

	local function matches(lines)
		for _, line in ipairs(lines) do
			local ok, hit = pcall(string.matchOrPattern, line:lower(), needle)
			if ok and hit then return true end
		end
		return false
	end

	local result, err = withCorruptionDialog(build, { source = source }, function(controls)
		local sources = asArray({})
		for _, entry in ipairs(controls.source.list or {}) do
			sources[#sources + 1] = {
				id = (entry == "Glimpse of Chaos") and "SpecialCorrupted" or "Corrupted",
				name = entry,
			}
		end

		local options, total = asArray({}), 0
		for _, listMod in ipairs(controls.enchant1.list or {}) do
			-- The dialog's first entry is its "None", which is an empty
			-- slot rather than something to put in one.
			if listMod.mod then
				local entry = corruptionEntry(listMod.mod)
				if not searching or matches(entry.lines) then
					total = total + 1
					options[#options + 1] = entry
				end
			end
		end

		-- The roll ranges, which are the dialog's other half: one row per
		-- explicit that a corruption would scale, between 0.78 and 1.22 of
		-- what it rolled. Uniques only, because only they keep a roll as a
		-- range the whole way through rather than as a number.
		local ranges = asArray({})
		local _, ordered = corruptionRangeRows(controls)
		for _, index in ipairs(ordered) do
			local modLine = item.explicitModLines and item.explicitModLines[index]
			ranges[#ranges + 1] = {
				index = index,
				line = modLine and strip(modLine.line) or nil,
				value = (modLine and modLine.corruptedRange) or 1,
				scaled = (strip(controls["rollRangeLabel" .. index].label or "")
					:gsub("%s*\n%s*", " ")),
			}
		end

		return {
			sources = sources,
			slots = corruptionSlots(controls),
			options = options,
			total = total,
			ranges = ranges,
		}
	end)

	if not result then
		return { ready = false, error = err }
	end

	-- What the item already carries, matched back to the modifiers that
	-- would have produced it. PoB's dialog opens empty whatever the item
	-- holds, so corrupting a corrupted item there quietly drops what was
	-- on it; said here instead, and the panel starts from it.
	local current = asArray({})
	local seen = {}
	for _, modLine in ipairs(item.enchantModLines or {}) do
		local line = strip(modLine.line or "")
		if not line:match("^Allocates ") then
			local bare = (line:gsub("^{tags:[^}]*}", ""))
			local entry = { line = bare }
			for modId, mod in pairs(data.itemMods.Corruption or {}) do
				for _, candidate in ipairs(mod) do
					if candidate == bare then
						entry.modId = modId
						entry.group = mod.group
						break
					end
				end
				if entry.modId then break end
			end
			-- A modifier with two lines arrives as two enchant lines, and
			-- it is still one choice.
			if not entry.modId or not seen[entry.modId] then
				if entry.modId then seen[entry.modId] = true end
				current[#current + 1] = entry
			end
		end
	end

	result.ready = true
	result.current = current
	result.corrupted = item.corrupted or nil
	return result
end

--- The item on the bench, as something being crafted.
---
--- Crafting in PoB always happens on `displayItem`, never on an equipped
--- item, which is the same bench this app already stages pasted and
--- database items on. So this is a second view of one thing rather than a
--- second place to put items.
---------------------------------------------------------------- catalysts

--- PoB's own catalyst dropdown, or nothing.
---
--- Every fact about catalysts in PoB is a local. The thirteen names live in
--- `ItemsTab`, the thirteen tag sets in `Item`, and the scalar function
--- that joins them is private to the latter. The dropdown is the one piece
--- reachable from outside, and it carries the names in its own list, so
--- that is where they are read rather than copied into this file.
local function catalystControl(tab)
	local control = tab and tab.controls and tab.controls.displayItemCatalyst
	return (control and control.list and control.shown) and control or nil
end

--- Whether a catalyst can go on the bench item, by PoB's own test.
---
--- The dropdown's `shown` predicate rather than its `IsShown`, which also
--- walks the anchor chain and so answers a question about the desktop
--- layout. What the predicate asks is a ring, an amulet or a jewel whose
--- modifiers carry tags to scale, and that is exactly what the game sells
--- catalysts for: thirteen for jewellery, the same thirteen refined for
--- jewels, and none for anything else.
local function catalystApplies(tab)
	local control = catalystControl(tab)
	if not control then
		return false
	end
	local ok, shown = pcall(control.shown)
	return (ok and shown) and true or false
end

--- What the dropdown would default the quality to.
---
--- PoB's `selFunc` picks this the first time a catalyst goes on. It is
--- repeated here only to seed a preview that is asked for before anything
--- has been committed: the value that lands on the item still comes from
--- the dropdown, so the two cannot drift apart where it counts.
local function catalystDefaultQuality(item)
	return (item.name or item.baseName or ""):match("Breach Ring") and 50 or 20
end

--- Bring PoB's affix dropdowns back in line with the item.
---
--- The bench sets affixes on the item and recrafts it, which is what the
--- craft dialog does, but it never touches the nine dropdowns the desktop
--- tab keeps beside them: in a headless engine those sit empty. That costs
--- nothing until something asks PoB to re-fire them, and the catalyst
--- dropdown does exactly that, because a catalyst changes what every affix
--- would roll. An empty dropdown fired at the item writes its emptiness
--- onto it, which is one modifier quietly gone.
local function syncAffixControls(tab, item)
	if not item.crafted then
		return true
	end
	return pcall(tab.UpdateAffixControls, tab)
end

--- The thirteen, as the dropdown names them. Index 0 is its first entry,
--- the placeholder that means no catalyst, and is left out here: the panel
--- has its own word for nothing.
local function catalystOptions(tab)
	local control = catalystControl(tab)
	local options = asArray({})
	for index = 2, #(control and control.list or {}) do
		options[#options + 1] = { id = index - 1, name = strip(control.list[index]) }
	end
	return options
end

function api.craftState(build)
	local tab = build and build.itemsTab
	local item = tab and tab.displayItem
	if not item then
		return { ready = false }
	end

	local state = {
		ready = true,
		name = strip(item.name or item.title or item.baseName or ""),
		baseName = strip(item.baseName or ""),
		itemType = item.type,
		rarity = item.rarity or "NORMAL",
		-- Affix rows exist only for a crafted item, which in PoB means a
		-- magic or rare one made in the craft dialog or parsed from text
		-- that said so. A unique, or a rare copied out of the game, has
		-- its modifiers as plain text and no slots to put them in.
		crafted = item.crafted and true or false,
		affixLimit = item.affixLimit,
		corrupted = item.corrupted or nil,
		-- Quality is editable only where the base has any: a ring has
		-- none, and offering the control anyway would be a lie.
		quality = item.quality,
		qualityEditable = (item.quality ~= nil and item.base and item.base.quality) and true or nil,
		prefixes = asArray({}),
		suffixes = asArray({}),
	}

	-- Sockets, and what is in them. PoB keeps `item.runes` as a flat
	-- array of names, one per socket, with "None" for an empty one.
	if canSocket(item) then
		-- PoB's own repair pass: a rune that the item can no longer take,
		-- because the base changed under it, is reset to None here rather
		-- than reported as something it is not.
		pcall(tab.UpdateRuneControls, tab)

		local byName = {}
		local okRunes, valid = pcall(tab.GetValidRunesForItem, tab, item)
		for _, rune in ipairs(okRunes and valid or {}) do
			byName[rune.name] = rune
		end

		local runes = asArray({})
		for index = 1, (item.itemSocketCount or 0) do
			local name = item.runes and item.runes[index]
			local row = { index = index }
			if name and name ~= "None" then
				row.name = name
				local rune = byName[name]
				if rune then
					local entry = runeEntry(rune)
					row.label = entry.label
					row.lines = entry.lines
					row.type = entry.type
					row.socketBound = entry.socketBound
				else
					row.unknown = true
				end
			end
			runes[#runes + 1] = row
		end

		state.sockets = {
			rune = item.itemSocketCount or 0,
			jewel = item.jewelSocketCount or 0,
			-- PoB's own cap, which its edit box enforces by rewriting
			-- anything larger back down to it.
			max = 6,
			-- What the base itself comes with. PoB lets you ask for more
			-- than this, so it is reported rather than enforced: the
			-- number is worth seeing before you craft an item the game
			-- would not hand you.
			natural = item.base and item.base.socketLimit or nil,
		}
		state.runes = runes
	end

	-- Corrupting, which is a single irreversible step rather than a set
	-- of slots, so only the two facts the panel needs to offer it are here:
	-- the lists behind it come from /craft/corruptions, which has to open
	-- PoB's own dialog to read them.
	state.corrupt = {
		corruptible = item.corruptible and true or false,
		-- Already corrupted. PoB lets you corrupt again, which replaces the
		-- implicits, so this is said rather than used to hide the panel.
		corrupted = item.corrupted and true or nil,
	}

	-- Catalysts, which are jewellery quality: thirteen of them, each
	-- scaling the modifiers that carry its own tag. Only what the panel
	-- needs to offer the section is here, because pricing the thirteen
	-- means thirteen calculator runs and that is /craft/catalysts.
	if catalystApplies(tab) then
		state.catalyst = {
			catalyst = item.catalyst or 0,
			quality = item.catalystQuality,
			options = catalystOptions(tab),
		}
	end

	-- Anoints, which are enchant lines rather than affixes: an amulet
	-- carries them whether or not it was crafted, so this sits outside the
	-- `crafted` test below.
	if isAnointable(item) then
		state.anoint = { slots = anointSlots(item) }
	end

	if item.crafted then
		for kind, outputTable in pairs(AFFIX_TABLE) do
			local rows = state[outputTable]
			for index = 1, affixLimit(item, outputTable) do
				rows[#rows + 1] = affixRow(tab, item, kind, index)
			end
		end
	end

	return state
end

--- Everything one affix row could hold.
---
--- Its own endpoint rather than part of the state above, because the list
--- runs to a few hundred entries per row and depends on what the other
--- rows are holding: it has to be asked for again after every change, and
--- sending six of them on every read would be most of the payload.
---
--- Each option is one modifier with all of its tiers, lowest first. The
--- desktop app puts tier and roll on a single slider spanning every tier,
--- which is one control doing two jobs; the two numbers are reported apart
--- here, since that is how they are stored.
function api.craftAffixes(build, kind, index, query)
	local tab = build and build.itemsTab
	local item = tab and tab.displayItem
	kind = tostring(kind or ""):lower()
	index = tonumber(index)
	if not item or not AFFIX_TABLE[kind] or not index then
		return { ready = false }
	end
	if not item.crafted then
		return { ready = false, error = "this item is not crafted, so it has no affix slots" }
	end
	if index < 1 or index > affixLimit(item, AFFIX_TABLE[kind]) then
		return { ready = false, error = "no " .. kind .. " slot " .. tostring(index) }
	end

	local control, err = affixControl(tab, item, kind, index)
	if not control then
		return { ready = false, error = err }
	end

	local needle = tostring(query or ""):lower()
	local options, total = asArray({}), 0
	for _, entry in ipairs(control.list or {}) do
		-- The first entry is the string "None", which is the clear
		-- gesture rather than an option.
		if type(entry) == "table" and entry.modList and entry.modList[1] then
			local top = item.affixes[entry.modList[#entry.modList]]
			local label = strip(entry.label or "")
			local affix = strip((top and top.affix) or "")
			if needle == "" or label:lower():find(needle, 1, true)
				or affix:lower():find(needle, 1, true)
			then
				total = total + 1
				options[#options + 1] = {
					-- The lowest tier's id, which is stable and unique
					-- enough to key a list row on.
					key = entry.modList[1],
					label = label,
					affix = affix,
					modIds = asArray(entry.modList),
					tierCount = #entry.modList,
					-- Reported so a row can say "tier 9, level 81" rather
					-- than leaving the reader to guess what a tier costs.
					levels = (function()
						local levels = asArray({})
						for i, id in ipairs(entry.modList) do
							local mod = item.affixes[id]
							levels[i] = mod and mod.level or 0
						end
						return levels
					end)(),
					haveRange = entry.haveRange and true or nil,
					-- What the top tier would read at a middling roll,
					-- which is what the label's `#` placeholders hide.
					preview = modLines(top, 0.5),
				}
			end
		end
	end

	return {
		ready = true,
		kind = kind,
		index = index,
		options = options,
		total = total,
		-- What is in the row now, so the list can mark it.
		selected = (item[AFFIX_TABLE[kind]][index] or {}).modId,
	}
end

--- The bases an item can be crafted on.
---
--- PoB groups every base by type and subtype into `itemBaseLists`, sorted
--- by required level, and that grouping is what its craft dialog offers.
--- Read rather than rebuilt: which bases exist, and which are hidden, is
--- game data.
function api.craftBases(build, typeName)
	local data = build and build.data
	if not data or not data.itemBaseTypeList then
		return { ready = false }
	end

	local types = asArray({})
	for _, name in ipairs(data.itemBaseTypeList) do
		types[#types + 1] = name
	end

	local bases = asArray({})
	typeName = tostring(typeName or "")
	for _, entry in ipairs(data.itemBaseLists[typeName] or {}) do
		bases[#bases + 1] = {
			name = entry.name,
			label = strip(entry.label or entry.name),
			level = entry.base and entry.base.req and entry.base.req.level or nil,
		}
	end

	return {
		ready = true,
		types = types,
		type = typeName ~= "" and typeName or nil,
		bases = bases,
		-- PoB's own four, in its own order. NORMAL and UNIQUE make an item
		-- with no affix slots: the first has no modifiers to give and the
		-- second carries its own as text.
		rarities = asArray({ "NORMAL", "MAGIC", "RARE", "UNIQUE" }),
	}
end

--- The notables this item could be anointed with.
---
--- PoB's list is the whole passive tree filtered by `IsAnointableNode`,
--- which is "has a recipe". That is 875 nodes, so this is a search rather
--- than a list, with the three modes the desktop control has and the same
--- `matchOrPattern` behind them, so `(life|mana)` works here as it does in
--- the item database.
---
--- "Anywhere" also matches the recipe. The desktop app filters emotions
--- with thirteen checkboxes above its list; one box that searches them is
--- the same question asked faster, and typing Greed finds every notable
--- that costs one.
function api.craftAnoints(build, query, mode, limit)
	local tab = build and build.itemsTab
	local item = tab and tab.displayItem
	if not item then
		return { ready = false }
	end
	if not isAnointable(item) then
		return { ready = false, error = "this item cannot be anointed" }
	end
	local nodes = build.spec and build.spec.tree and build.spec.tree.nodes
	if not nodes then
		return { ready = false, error = "the tree is not loaded" }
	end

	mode = tostring(mode or "anywhere"):lower()
	local needle = escapeNeedle(query)
	local searching = needle:match("%S") and true or false
	limit = math.min(400, math.max(1, math_floor(tonumber(limit) or 150)))

	local function matches(text)
		local ok, matched = pcall(string.matchOrPattern, tostring(text or ""):lower(), needle)
		return (ok and matched) and true or false
	end

	-- Matching nodes are collected before any are dropped, then sorted,
	-- then cut: `pairs` over the tree has no order, so cutting first would
	-- hand back an arbitrary slice of the answer that reads like all of it.
	local found = {}
	for _, node in pairs(nodes) do
		if isAnointableNode(node) then
			local hit = not searching
			if searching then
				if mode == "anywhere" or mode == "names" then
					hit = matches(node.dn)
				end
				if not hit and (mode == "anywhere" or mode == "modifiers") then
					for _, line in ipairs(node.sd or {}) do
						if matches(line) then
							hit = true
							break
						end
					end
				end
				if not hit and mode == "anywhere" then
					for _, emotion in ipairs(node.recipe) do
						if matches(emotion) then
							hit = true
							break
						end
					end
				end
			end
			if hit then
				found[#found + 1] = node
			end
		end
	end

	table.sort(found, function(a, b)
		return tostring(a.dn or "") < tostring(b.dn or "")
	end)

	local options = asArray({})
	for index = 1, math.min(limit, #found) do
		options[#options + 1] = anointEntry(build, found[index])
	end

	return {
		ready = true,
		options = options,
		total = #found,
		-- Said outright: a list that stops at a hundred and fifty of eight
		-- hundred and does not say so reads as the whole answer.
		truncated = (#found > #options) or nil,
	}
end

-------------------------------------------------------- import and export

--- A build code is base64 of the deflated build XML, in the URL-safe
--- alphabet. PoB's own transforms, both directions, so a code from here
--- opens in the desktop app and vice versa.
function api.decodeCode(code)
	code = tostring(code or ""):gsub("%s+", "")
	if code == "" then
		return nil, "no code"
	end
	-- Build sites hand out the code as the last path segment of a URL;
	-- taking it is friendlier than telling the user to trim it themselves.
	-- A link is never fetched here: only read.
	local tail = code:match("^https?://[%w%.%-]+/[%w%-/]*/([%w%-_=]+)$")
		or code:match("^https?://[%w%.%-]+/([%w%-_=]+)$")
	if tail then
		code = tail
	end

	local raw = common.base64.decode((code:gsub("-", "+"):gsub("_", "/")))
	if not raw or raw == "" then
		return nil, "that is not valid base64"
	end
	local xml = Inflate(raw)
	if not xml or xml == "" then
		return nil, "the code decoded but would not decompress"
	end
	-- The cleaned code travels back too, so callers measure the code
	-- rather than whatever URL it arrived wrapped in.
	return xml, code
end

--- What a code contains, without importing it.
---
--- PoB's import box validates as you type and says "Code is valid"; this
--- goes a little further and reads the class and level out of the decoded
--- XML, because "valid" is not the question anyone actually has. Nothing
--- is changed: the build on screen is untouched until the import runs.
function api.inspectCode(code)
	local xml, cleaned = api.decodeCode(code)
	if not xml then
		return { valid = false, error = cleaned }
	end

	local parsed, parseErr = common.xml.ParseXML(xml)
	if not parsed then
		return { valid = false, error = "decoded, but the XML did not parse: " .. tostring(parseErr) }
	end

	-- The root is PathOfBuilding2; the Build element carries the summary.
	local summary = {}
	for _, node in ipairs(parsed[1] or parsed) do
		if type(node) == "table" and node.elem == "Build" then
			summary = node.attrib or {}
			break
		end
	end

	return {
		valid = true,
		level = tonumber(summary.level),
		class = summary.className,
		ascendancy = summary.ascendClassName ~= "None" and summary.ascendClassName or nil,
		-- Both sizes, because the ratio is the interesting part of a code.
		codeBytes = #cleaned,
		xmlBytes = #xml,
	}
end

--- The current build as a code, exactly as the desktop app's Export does.
function api.buildCode(build)
	if not build or not build.SaveDB then
		return { ready = false }
	end
	local ok, xml = pcall(build.SaveDB, build, "code")
	if not ok or not xml then
		return { ready = false, error = "the build would not serialise" }
	end
	local packed = Deflate(xml)
	if not packed or packed == "" then
		return { ready = false, error = "deflate is not available in this host" }
	end
	local code = (common.base64.encode(packed):gsub("%+", "-"):gsub("/", "_"))
	return { ready = true, code = code, codeBytes = #code, xmlBytes = #xml }
end

------------------------------------------------------------- the build list

--- PoB's own builds-folder scanner.
---
--- Modules/BuildListHelpers is already UI-free: it is shared by the
--- startup list and the Compare tab's folder import, so the scan, the
--- header read and the sort are all the engine's. It reads the class,
--- ascendancy and level out of the first 2 kB of each file rather than
--- loading the build, which is what makes listing a folder cheap.
local buildListHelpers
local function loadBuildList()
	if buildListHelpers == nil then
		local ok, result = pcall(require, "Modules.BuildListHelpers")
		buildListHelpers = ok and result or false
	end
	return buildListHelpers or nil
end

local SORT_MODES = { NAME = true, CLASS = true, EDITED = true, LEVEL = true }

--- Everything in the builds folder, with the open build marked.
---
--- Folders come back flattened, each carrying its own subPath, because the
--- scanner recurses and the UI can nest them again if it wants to. The
--- alternative, one request per folder, would be a round trip per
--- expand for a tree that is usually a dozen entries.
function api.builds(build, sortMode)
	local helpers = loadBuildList()
	if not helpers or not main or not main.buildPath then
		return { ready = false, error = "the engine has no builds folder" }
	end

	local ok, list = pcall(helpers.ScanFolder, "")
	if not ok then
		return { ready = false, error = tostring(list) }
	end

	sortMode = SORT_MODES[tostring(sortMode or ""):upper()] and tostring(sortMode):upper() or "EDITED"
	pcall(helpers.SortList, list, sortMode)

	local open = build and build.dbFileName or nil
	local entries = asArray({})
	for _, entry in ipairs(list) do
		if entry.folderName then
			entries[#entries + 1] = {
				kind = "folder",
				name = strip(entry.folderName),
				subPath = entry.subPath or "",
				modified = entry.modified,
			}
		else
			entries[#entries + 1] = {
				kind = "build",
				name = strip(entry.buildName or entry.fileName or ""),
				fileName = entry.fileName,
				subPath = entry.subPath or "",
				path = entry.fullFileName,
				modified = entry.modified,
				level = entry.level,
				class = entry.className,
				-- "None" is how an unchosen ascendancy is stored.
				ascendancy = entry.ascendClassName ~= "None" and entry.ascendClassName or nil,
				-- The one currently loaded, so the list can say so rather
				-- than making the user remember.
				open = open and entry.fullFileName == open or nil,
			}
		end
	end

	return {
		ready = true,
		entries = entries,
		buildPath = main.buildPath,
		sort = sortMode,
		-- Where the open build lives, or nil when it has never been saved.
		openPath = open or nil,
		unsaved = build and build.unsaved and true or false,
	}
end


------------------------------------------------------------- the compare

--- PoB's own skill-flag test, copied because it is file-local to
--- CompareTab.lua. Sixteen mechanical lines; the alternative is to not
--- filter, which would show every build every stat.
local function matchFlags(reqFlags, notFlags, flags)
	if type(reqFlags) == "string" then reqFlags = { reqFlags } end
	if reqFlags then
		for _, flag in ipairs(reqFlags) do
			if not flags[flag] then return false end
		end
	end
	if type(notFlags) == "string" then notFlags = { notFlags } end
	if notFlags then
		for _, flag in ipairs(notFlags) do
			if flags[flag] then return false end
		end
	end
	return true
end

local function skillFlags(actor)
	return actor and actor.mainSkill and actor.mainSkill.activeEffect.statSet.skillFlags or {}
end

--- Format one stat the way PoB formats it: its own `fmt`, its own
--- percentage/modifier multiplier, and its own thousands separators.
local function formatStat(statData, value)
	local multiplier = (statData.pc or statData.mod) and 100 or 1
	return formatNumSep(string.format("%" .. (statData.fmt or "d"), value * multiplier))
end

--- A build against another, stat by stat.
---
--- This is the one screen where PoB's rules are reproduced rather than
--- called. Every other panel in this UI reads something the engine already
--- built (a Tooltip, a statBox, a control's shown()) but the
--- side-by-side comparison exists only inside CompareTab:DrawStatList
--- (line 3308), interleaved with the DrawString calls that put it on the
--- screen. There is no data-only version to call.
---
--- So the control flow below is a transcription of that function, in its
--- order, with its skips: the SkillDPS row that does not fit a two-column
--- layout, hidden stats, stats neither build's active skill uses, table
--- values, stats that are zero on both sides, and condFunc. Everything
--- inside it is still the engine's (statData.fmt, condFunc, lowerIsBetter,
--- formatNumSep) so what is duplicated is the sequence, not the rules.
--- If DrawStatList changes, this has to follow; nothing will notice on its
--- own, which is the cost of the one place I could not avoid it.
function api.compare(build)
	local tab = build and build.compareTab
	if not tab then
		return { ready = false, error = "this engine has no compare tab" }
	end

	local entries = asArray({})
	for index, entry in ipairs(tab.compareEntries or {}) do
		local spec = entry.spec
		entries[#entries + 1] = {
			index = index,
			label = strip(entry.label or entry.buildName or ("Build " .. index)),
			class = spec and spec.curClassName or nil,
			ascendancy = spec and spec.curAscendClassName ~= "None" and spec.curAscendClassName or nil,
			level = entry.characterLevel,
			active = index == tab.activeCompareIndex or nil,
		}
	end

	local active = tab.compareEntries and tab.compareEntries[tab.activeCompareIndex or 0]
	if not active then
		return { ready = true, entries = entries, active = 0 }
	end

	local primaryEnv = build.calcsTab and build.calcsTab.mainEnv
	local compareEnv = active.calcsTab and active.calcsTab.mainEnv
	local primaryOutput = build.calcsTab and build.calcsTab.mainOutput
	local compareOutput = active:GetOutput()
	if not primaryOutput or not compareOutput then
		return { ready = true, entries = entries, active = tab.activeCompareIndex, rows = asArray({}) }
	end

	local primaryFlags = skillFlags(primaryEnv and primaryEnv.player)
	local compareFlags = skillFlags(compareEnv and compareEnv.player)

	local rows = asArray({})
	for _, statData in ipairs(build.displayStats or {}) do
		if not statData.stat and not statData.label then
			-- An empty entry is a section break, the same as in the sidebar.
			rows[#rows + 1] = { gap = true }
		elseif statData.stat == "SkillDPS" or statData.hideStat then
			-- SkillDPS is several rows per skill; PoB leaves it out of this
			-- layout too.
		elseif matchFlags(statData.flag, statData.notFlag, primaryFlags)
			or matchFlags(statData.flag, statData.notFlag, compareFlags) then
			if statData.stat then
				local a = primaryOutput[statData.stat] or 0
				local b = compareOutput[statData.stat] or 0
				if statData.childStat then
					a = type(a) == "table" and a[statData.childStat] or 0
					b = type(b) == "table" and b[statData.childStat] or 0
				end
				if type(a) == "table" or type(b) == "table" then
					a, b = 0, 0
				end

				local shown = (a ~= 0 or b ~= 0)
					and (not statData.condFunc
						or statData.condFunc(a, primaryOutput)
						or statData.condFunc(b, compareOutput))

				if shown then
					local row = {
						label = strip(statData.label or statData.stat),
						tone = toneOf(statData.color or ""),
						primary = formatStat(statData, a),
						compare = formatStat(statData, b),
					}
					local diff = b - a
					if diff > 0.001 or diff < -0.001 then
						row.diff = formatNumSep(string.format(
							"%+" .. (statData.fmt or "d"),
							diff * ((statData.pc or statData.mod) and 100 or 1)
						))
						if a ~= 0 then
							row.percent = b / a * 100 - 100
						end
						-- Which direction is an improvement is the stat's
						-- own business: more resistance is good, more mana
						-- cost is not.
						row.better = ((statData.lowerIsBetter and diff < 0)
							or (not statData.lowerIsBetter and diff > 0)) and true or false
					end
					rows[#rows + 1] = row
				end
			elseif statData.label and statData.condFunc then
				-- A label with no number: "Chaos Resistance: Immune" is
				-- either shown or it is not.
				local onPrimary = statData.condFunc(primaryOutput)
				local onCompare = statData.condFunc(compareOutput)
				if onPrimary or onCompare then
					rows[#rows + 1] = {
						label = strip(statData.label),
						tone = toneOf(statData.color or ""),
						primary = onPrimary and strip(statData.val or "") or "-",
						compare = onCompare and strip(statData.val or "") or "-",
					}
				end
			end
		end
	end

	return {
		ready = true,
		entries = entries,
		active = tab.activeCompareIndex,
		primary = {
			name = strip(build.buildName or ""),
			class = build.spec and build.spec.curClassName or nil,
			ascendancy = build.spec and build.spec.curAscendClassName ~= "None"
				and build.spec.curAscendClassName or nil,
			level = build.characterLevel,
		},
		compare = {
			name = strip(active.label or active.buildName or ""),
			class = active.spec and active.spec.curClassName or nil,
			ascendancy = active.spec and active.spec.curAscendClassName ~= "None"
				and active.spec.curAscendClassName or nil,
			level = active.characterLevel,
		},
		rows = rows,
	}
end

--- One skill's stats, without making it the main one.
---
--- The stat sidebar is always about the main skill, so asking what a
--- second skill costs meant switching to it, reading, and switching back,
--- with the build sitting on the wrong skill in between and an
--- interruption leaving it there. `mainSocketGroup` is an argument to the
--- misc calculator, the same way `repSlotName`/`repItem` are for the item
--- bench, so this is the engine answering a hypothetical rather than the
--- build being moved and moved back.
---
--- The index within the group has no such argument: CalcSetup reads
--- `group.mainActiveSkill` straight off the group, so that one field is
--- set and put back around the call. It is the same mutate-and-restore
--- every what-if here does, and it is one field on one group rather than
--- the build's own main skill.
---
--- One honest difference from the sidebar. `calcFunc` hands back an output
--- table and no env, and the sidebar hides stats that the active skill's
--- own flags say do not apply to it. Without the env those flags cannot
--- be read, so a row is kept here when it has a value and dropped when it
--- does not. Every number is still the engine's; what is approximated is
--- which rows are worth printing.
function api.skillStats(build, groupIndex, skillIndex)
	local tab = build and build.skillsTab
	local index = tonumber(groupIndex) or 0
	local group = tab and tab.socketGroupList and tab.socketGroupList[index]
	if not group then
		return { ready = false, error = "no socket group " .. tostring(groupIndex) }
	end

	local calcsTab = build.calcsTab
	if not calcsTab or not calcsTab.GetMiscCalculator then
		return { ready = false, error = "the engine has no calculator yet" }
	end
	local calcFunc = calcsTab:GetMiscCalculator()
	if not calcFunc then
		return { ready = false, error = "the engine has not finished its first calculation" }
	end

	-- What this group grants, so a caller can say which of them it means.
	local skills = asArray({})
	for _, skill in ipairs(group.displaySkillList or {}) do
		local effect = skill.activeEffect and skill.activeEffect.grantedEffect
		local name = effect and effect.name
		if type(name) ~= "string" or name:match("^%s*$") then
			local gemData = skill.activeEffect and skill.activeEffect.gemData
			name = (gemData and gemData.name) or (effect and effect.id) or "?"
		end
		skills[#skills + 1] = strip(name)
	end

	local wanted = tonumber(skillIndex)
	if wanted and (wanted < 1 or wanted > #skills) then
		return {
			ready = false,
			error = "no skill " .. tostring(skillIndex) .. " in that group; it grants " .. #skills,
		}
	end

	local okSet, weaponSet = pcall(tab.GetSocketGroupWeaponSet, tab, group)
	local buildFlag = build.buildFlag
	local stored = group.mainActiveSkill
	if wanted then
		group.mainActiveSkill = wanted
	end
	local ok, output = pcall(calcFunc, {
		mainSocketGroup = index,
		weaponSet = okSet and weaponSet or nil,
	})
	group.mainActiveSkill = stored
	build.buildFlag = buildFlag

	if not ok then
		return { ready = false, error = tostring(output) }
	end

	-- The same walk api.compare does, against one output instead of two.
	local lines = asArray({})
	for _, statData in ipairs(build.displayStats or {}) do
		if not statData.stat and not statData.label then
			lines[#lines + 1] = { gap = true }
		elseif statData.stat == "SkillDPS" or statData.hideStat then
			-- SkillDPS is several rows per skill, and PoB leaves it out of
			-- a list like this one for the same reason.
		elseif statData.stat then
			local value = output[statData.stat] or 0
			if statData.childStat then
				value = type(value) == "table" and value[statData.childStat] or 0
			end
			if type(value) ~= "table" and value ~= 0
				and (not statData.condFunc or statData.condFunc(value, output))
			then
				lines[#lines + 1] = {
					label = strip(statData.label or statData.stat),
					tone = toneOf(statData.color or ""),
					value = formatStat(statData, value),
				}
			end
		elseif statData.label and statData.condFunc and statData.condFunc(output) then
			lines[#lines + 1] = {
				label = strip(statData.label),
				tone = toneOf(statData.color or ""),
				value = strip(statData.val or ""),
			}
		end
	end

	return {
		ready = true,
		group = index,
		groupLabel = strip(group.displayLabel or group.label or "?"),
		skills = skills,
		-- Which of them these numbers are about: what was asked for, else
		-- the one the group is already pointed at.
		skill = wanted or stored or 1,
		weaponSet = okSet and weaponSet or nil,
		main = build.mainSocketGroup == index or nil,
		lines = lines,
	}
end

--------------------------------------------------------- editing an item

--- What is editable about one item.
---
--- Three things, which between them cover what the desktop tab's editor
--- panel is for:
---
--- * the raw text, which is the escape hatch. PoB's items are defined by
---   their text and parsed back from it, so editing that covers crafting,
---   custom modifiers, quality, corruption and anything else there is no
---   control for.
--- * the modifier ranges. A unique's "(10-20) to maximum Life" is a roll,
---   and `rangeLineList` holds one entry per such line with its position
---   between the bounds. This is the control people actually use.
--- * the variant, for uniques that have more than one version.
---
--- The item's appearance is not here: the panel reads it from /item, which
--- is PoB's own tooltip and already knows how to draw the result.
function api.itemEdit(build, itemId)
	local tab = build and build.itemsTab
	local item = tab and tab.items and tab.items[tonumber(itemId) or 0]
	if not item then
		return { ready = false }
	end

	local ranges = asArray({})
	for index, entry in ipairs(item.rangeLineList or {}) do
		ranges[#ranges + 1] = {
			index = index,
			line = strip(entry.line or ""),
			-- 0 is the bottom of the roll, 1 the top.
			range = entry.range or 0,
		}
	end

	local variants = asArray({})
	for index, name in ipairs(item.variantList or {}) do
		variants[#variants + 1] = { index = index, name = strip(tostring(name)) }
	end

	local ok, raw = pcall(item.BuildRaw, item)

	return {
		ready = true,
		id = item.id,
		name = strip(item.name or item.title or ""),
		rarity = item.rarity or "NORMAL",
		raw = ok and raw or nil,
		ranges = ranges,
		variants = variants,
		variant = item.variant,
		-- Variant groups are a second mechanism, where several dropdowns
		-- each pick from their own set. Reported so the UI can say the
		-- simple control does not apply rather than quietly mis-setting it.
		variantGroups = item.HasVariantGroups and item:HasVariantGroups() or nil,
	}
end

----------------------------------------------------------------- what if

--- Run the build again with something changed, and report the difference.
---
--- PoB does this behind the tooltips on its checkboxes: it flips the
--- setting, rebuilds the mod list, runs the misc calculator, flips back,
--- and compares. The result is "Enabling this will give you: +12% more
--- DPS", which is the only thing that makes a list of seventy options
--- navigable.
---
--- `apply` makes the change and returns a function that undoes it. Both
--- run inside this pcall, so a change that throws halfway is still put
--- back: the build the user is looking at must not be left holding a
--- setting nobody chose.
--- Two of the engine's outputs, as the difference between them.
---
--- Split out because there are two ways to get the second output and only
--- one way to read it. `whatIf` below changes the build, recalculates and
--- changes it back; an item comparison does not have to touch the build at
--- all, because GetMiscCalculator takes the substitution as an argument.
--- Both end up here.
--- `nodeCount` is PoB's per-point column: given the number of passives a
--- change costs, every line also reports what it buys per point spent,
--- which is the only way to compare a route of six nodes with one of two.
local function renderCompare(build, calcBase, output, header, nodeCount)
	local tooltip = new("Tooltip"):Tooltip()
	-- The comparison can fail where the change removes the thing being
	-- compared: turning off the only socket group leaves no main skill,
	-- and buildMode's own AddStatComparesToTooltip reaches straight
	-- through it. Reported, because "it broke" and "nothing moved" look
	-- identical from an empty list and only one of them is fine.
	local compared, compareErr = pcall(
		build.AddStatComparesToTooltip, build, tooltip, calcBase, output, header or "", nodeCount
	)
	if not compared then
		return { ready = false, error = "the comparison failed: " .. tostring(compareErr) }
	end

	local lines, tips = tooltipLines(tooltip)
	return {
		ready = true,
		lines = lines,
		droppedTips = tips,
		-- Nothing moved. Worth saying outright rather than showing an
		-- empty panel that looks like it failed to load.
		unchanged = #lines == 0 or nil,
	}
end

local function whatIf(build, apply, header)
	local calcsTab = build and build.calcsTab
	if not calcsTab or not calcsTab.GetMiscCalculator then
		return { ready = false, error = "the engine has no calculator yet" }
	end
	local calcFunc, calcBase = calcsTab:GetMiscCalculator()
	if not calcFunc or not calcBase then
		return { ready = false, error = "the engine has not finished its first calculation" }
	end

	-- buildFlag is restored by hand: the rebuilds below set it, and
	-- leaving it set would make the UI think the build had changed.
	local buildFlag = build.buildFlag
	local undo
	local ok, result = pcall(function()
		undo = apply()
		return calcFunc()
	end)
	if undo then
		pcall(undo)
	end
	build.buildFlag = buildFlag

	if not ok then
		return { ready = false, error = tostring(result) }
	end

	return renderCompare(build, calcBase, result, header)
end

--- What flipping one configuration option would do.
---
--- Only the checkboxes, unless a value is given: for a list or a count
--- there is no "the other way round", and guessing one would answer a
--- question nobody asked.
function api.configWhatIf(build, name, value)
	local tab = build and build.configTab
	local varList = loadConfigOptions()
	if not tab or not varList then
		return { ready = false, error = "no configuration" }
	end

	local varData
	for _, entry in ipairs(varList) do
		if entry.var == name then
			varData = entry
			break
		end
	end
	if not varData then
		return { ready = false, error = "no configuration option called " .. tostring(name) }
	end

	local set = tab.configSets[tab.activeConfigSetId]
	local current = set.input[name]
	local target
	if value ~= nil then
		target = value
	elseif varData.type == "check" then
		target = not current
	else
		return { ready = false, error = "only checkboxes can be flipped without a value" }
	end

	local header = (varData.type == "check" and not current)
		and "^7Enabling this will give you:"
		or "^7Disabling this will give you:"

	return whatIf(build, function()
		set.input[name] = target
		tab:BuildModList()
		return function()
			set.input[name] = current
			tab:BuildModList()
		end
	end, header)
end

--- What turning one socket group off, or on, would do.
function api.socketGroupWhatIf(build, groupIndex)
	local tab = build and build.skillsTab
	local group = tab and tab.socketGroupList and tab.socketGroupList[tonumber(groupIndex) or 0]
	if not group then
		return { ready = false, error = "no socket group " .. tostring(groupIndex) }
	end

	local current = group.enabled ~= false
	local header = current
		and "^7Disabling this group will give you:"
		or "^7Enabling this group will give you:"

	return whatIf(build, function()
		group.enabled = not current
		return function()
			group.enabled = current
		end
	end, header)
end

--- Where one number on the Calcs tab came from.
---
--- The Calcs tab is a wall of results, and until now that is all it was
--- here: the desktop one answers "why is it that?" on a click, and this
--- read-only copy of it could not. The answer is the engine's and it is
--- already computed: every calculation pass fills `actor.breakdown` with
--- the working behind each output, and `CalcBreakdownControl` turns one
--- cell's worth of that into sections.
---
--- So this drives PoB's own control rather than reading `breakdown`
--- directly. Deciding which sections a cell produces means honouring the
--- flags on each descriptor, resolving dotted `ns.name` keys, sorting and
--- labelling the tables, and listing contributing modifiers through four
--- format functions. All of that is `SetBreakdownData`, which builds a
--- `sectionList` and only then measures it for drawing, so the content is
--- readable without drawing anything.
---
--- A cell is addressed by its position in PoB's own tables rather than by
--- a name, because the cells have no names: the Calcs tab is literally a
--- nested list of format strings.
function api.calcsBreakdown(build, ref)
	local tab = build and build.calcsTab
	local ctrl = tab and tab.controls and tab.controls.breakdown
	if not tab or not ctrl then
		return { ready = false, error = "the calculation tab has no breakdown control" }
	end

	local s, sub, row, col = tostring(ref or ""):match("^(%d+)%.(%d+)%.(%d+)%.(%d+)$")
	if not s then
		return { ready = false, error = "expected a reference like 3.1.4.2" }
	end

	local section = tab.sectionList and tab.sectionList[tonumber(s)]
	local subSec = section and section.subSection and section.subSection[tonumber(sub)]
	local rowData = subSec and subSec.data and subSec.data[tonumber(row)]
	local colData = rowData and rowData[tonumber(col)]
	if not colData then
		return { ready = false, error = "no cell at " .. tostring(ref) }
	end
	if #colData == 0 then
		return { ready = false, error = "that number has no working to show" }
	end

	-- SetBreakdownData returns early when handed what it already holds,
	-- and calls back into the tab to clear the on-screen selection when a
	-- cell turns out to have nothing. Neither is wanted here: this is a
	-- question, not a selection, and the tab's own state is not ours to
	-- move.
	local hadSource, hadClear, hadPinned = ctrl.sourceData, ctrl.clearDisplayFunc, ctrl.pinned
	ctrl.sourceData = nil
	ctrl.clearDisplayFunc = function() end

	-- The sizing pass that follows the content pass measures text, and
	-- headless that is a stub. If it throws, the sections are already
	-- built: what is lost is their width in pixels, which is not a thing
	-- this answer carries anyway.
	local built = pcall(ctrl.SetBreakdownData, ctrl, colData, false)
	local sectionList = ctrl.sectionList or {}

	local out = asArray({})
	for _, part in ipairs(sectionList) do
		if part.type == "TEXT" then
			local lines = asArray({})
			for _, line in ipairs(part.lines or {}) do
				lines[#lines + 1] = { text = strip(tostring(line)), tone = toneOf(tostring(line)) }
			end
			out[#out + 1] = { type = "text", lines = lines }
		elseif part.type == "TABLE" then
			local cols = asArray({})
			for _, c in ipairs(part.colList or {}) do
				cols[#cols + 1] = { key = c.key, label = strip(c.label or c.key), right = c.right or nil }
			end
			-- Projected onto the declared columns only. A row also carries
			-- the item it came from and a function to draw its tooltip,
			-- and neither is something to put on the wire.
			local rows = asArray({})
			for _, r in ipairs(part.rowList or {}) do
				local cells = asArray({})
				local anything = false
				for _, c in ipairs(part.colList or {}) do
					local v = r[c.key]
					local text = (v ~= nil and type(v) ~= "function" and type(v) ~= "table")
						and strip(tostring(v))
						or ""
					cells[#cells + 1] = { text = text, tone = toneOf(tostring(v or "")) }
					anything = anything or text ~= ""
				end
				if anything then
					rows[#rows + 1] = cells
				end
			end
			out[#out + 1] = {
				type = "table",
				label = part.label and strip(part.label) or nil,
				footer = part.footer and strip(part.footer) or nil,
				cols = cols,
				rows = rows,
			}
		elseif part.type == "RADIUS" then
			-- PoB draws a circle to scale here. The number is the part
			-- that survives being read rather than looked at.
			out[#out + 1] = { type = "radius", radius = part.radius }
		end
	end

	-- Put the control back as it was found.
	ctrl.sourceData = nil
	pcall(ctrl.SetBreakdownData, ctrl, hadSource, hadPinned)
	ctrl.clearDisplayFunc = hadClear

	return {
		ready = true,
		ref = ref,
		label = rowData.label and strip(rowData.label) or nil,
		sections = out,
		-- Said outright: a cell can have descriptors whose flags all fail
		-- for the current skill, which is a different thing from an error.
		empty = #out == 0 or nil,
		partial = (not built) or nil,
	}
end

--- What allocating or unallocating one node would do.
---
--- The signature interaction of the desktop tree: hover a node and it
--- tells you what the point is worth, in the stats you care about, before
--- you spend it. PoB does this with addNodes/removeNodes on the misc
--- calculator, which substitutes without mutating, so this is the same
--- shape as the item bench rather than the config what-if.
---
--- Two answers, not one, and the second is the one people actually need.
--- A node you cannot reach in a single step costs the whole route to it,
--- and what the route is worth is a different question from what the node
--- is worth. The route's answer carries its length, which is what turns
--- the comparison into a per-point one: six nodes for 8% life is a worse
--- deal than two nodes for 5%, and only the per-point column says so.
function api.treeWhatIf(build, nodeId)
	local spec = build and build.spec
	local node = spec and spec.nodes and spec.nodes[tonumber(nodeId) or 0]
	if not node then
		return { ready = false, error = "no node with id " .. tostring(nodeId) }
	end

	local calcsTab = build.calcsTab
	if not calcsTab or not calcsTab.GetMiscCalculator then
		return { ready = false, error = "the engine has no calculator yet" }
	end
	local calcFunc, calcBase = calcsTab:GetMiscCalculator()
	if not calcFunc or not calcBase then
		return { ready = false, error = "the engine has not finished its first calculation" }
	end

	-- A node an item hands you is not a node you allocated, so the only
	-- question that makes sense about it is what losing it would cost.
	local granted = calcsTab.mainEnv
		and calcsTab.mainEnv.grantedPassives
		and calcsTab.mainEnv.grantedPassives[node.id]
		or false

	-- PoB's own path: what this node holds up when it is allocated, and
	-- what it would take to reach it when it is not.
	local path = (node.alloc and node.depends) or node.path or {}
	local pathNodes, pathLength = {}, 0
	for _, pathNode in pairs(path) do
		pathNodes[pathNode] = true
		pathLength = pathLength + 1
	end

	local function run(override)
		local ok, out = pcall(calcFunc, override)
		if ok then
			return out
		end
		return nil, tostring(out)
	end

	-- Restored by hand, as everywhere else here: the passes below raise it
	-- and leaving it raised would have the UI believe the build changed.
	local buildFlag = build.buildFlag

	local header, pathHeader
	local nodeOutput, nodeErr, pathOutput
	if node.alloc then
		header = "^7Unallocating this node will give you:"
		pathHeader = "^7Unallocating this node and all nodes depending on it will give you:"
		nodeOutput, nodeErr = run({ removeNodes = { [node] = true } })
		if pathLength > 1 then
			pathOutput = run({ removeNodes = pathNodes })
		end
	elseif granted then
		header = "^7This node is granted by an item. Removing it will give you:"
		nodeOutput, nodeErr = run({ removeNodes = { [node.id] = true } })
	else
		header = "^7Allocating this node will give you:"
		pathHeader = "^7Allocating this node and all nodes leading to it will give you:"
		nodeOutput, nodeErr = run({ addNodes = { [node] = true } })
		if pathLength > 1 then
			pathOutput = run({ addNodes = pathNodes })
		end
	end

	build.buildFlag = buildFlag

	if not nodeOutput then
		return { ready = false, error = nodeErr or "the calculation failed" }
	end

	-- PoB's own condition for offering the route as well. A node reached
	-- through an Intuitive Leap style jewel has no route to price.
	local routeWorthAsking = pathOutput
		and not granted
		and (node.alloc or #(node.intuitiveLeapLikesAffecting or {}) == 0)

	return {
		ready = true,
		id = node.id,
		allocated = node.alloc and true or nil,
		granted = granted and true or nil,
		node = renderCompare(build, calcBase, nodeOutput, header),
		path = routeWorthAsking
			and renderCompare(build, calcBase, pathOutput, pathHeader, pathLength)
			or nil,
		-- How many nodes the route covers, so the UI can say what it costs
		-- without counting the engine's lines.
		pathLength = routeWorthAsking and pathLength or nil,
	}
end

--- What switching a flask or a charm on, or off, would do.
---
--- Equipped but inactive is a state only these two have, and the question
--- "is this flask worth a slot?" is not the same as "is it worth
--- drinking". PoB keys the substitution on the item rather than the slot,
--- and reads the current state out of the calculation environment rather
--- than off the slot, because a flask can be active in the build without
--- the slot saying so.
function api.slotWhatIf(build, slotName)
	local tab = build and build.itemsTab
	local slot = tab and tab.slots and tab.slots[tostring(slotName)]
	if not slot then
		return { ready = false, error = "no slot named " .. tostring(slotName) }
	end
	local item = tab.items[slot.selItemId]
	if not item then
		return { ready = false, error = "nothing is equipped in " .. strip(slot.label or slotName) }
	end
	local base = item.base
	if not base or not (base.flask or base.charm) then
		return { ready = false, error = "only a flask or a charm can be switched on and off" }
	end

	local env = build.calcsTab and build.calcsTab.mainEnv
	if not env then
		return { ready = false, error = "the engine has not finished its first calculation" }
	end

	local flask = base.flask and true or false
	local on = flask and (env.flasks and env.flasks[item]) or (env.charms and env.charms[item])
	local noun = flask and "flask" or "charm"
	local header = on
		and ("^7Deactivating this " .. noun .. " will give you:")
		or ("^7Activating this " .. noun .. " will give you:")

	-- Nothing to revert: the toggle is an argument to the calculator, not
	-- a change to the build, so whatIf's apply/undo shape is not needed.
	local calcFunc, calcBase = build.calcsTab:GetMiscCalculator()
	if not calcFunc or not calcBase then
		return { ready = false, error = "the engine has not finished its first calculation" }
	end
	local buildFlag = build.buildFlag
	local ok, output = pcall(calcFunc, flask and { toggleFlask = item } or { toggleCharm = item })
	build.buildFlag = buildFlag
	if not ok then
		return { ready = false, error = tostring(output) }
	end
	return renderCompare(build, calcBase, output, header)
end

--- What anointing this notable would do.
---
--- PoB's own comparison, which is not the one the item bench makes: both
--- sides substitute the bench item into its primary slot, so the difference
--- is the anoint alone rather than the whole item against what is equipped.
--- A nil node asks what taking the current anoint off would cost.
function api.anointWhatIf(build, slot, nodeId)
	local tab = build and build.itemsTab
	local item = tab and tab.displayItem
	if not item then
		return { ready = false }
	end
	if not isAnointable(item) then
		return { ready = false, error = "this item cannot be anointed" }
	end

	local node
	if nodeId ~= nil and nodeId ~= "" then
		local nodes = build.spec and build.spec.tree and build.spec.tree.nodes
		node = nodes and nodes[tonumber(nodeId) or nodeId]
		if not node then
			return { ready = false, error = "no node with id " .. tostring(nodeId) }
		end
		if not isAnointableNode(node) then
			return { ready = false, error = strip(node.dn or "that node") .. " cannot be anointed" }
		end
	end

	-- PoB's two early answers, which are not failures. Nothing can give you
	-- the same notable twice, so the comparison is skipped rather than run
	-- and reported as an empty one.
	if node then
		if build.spec and build.spec.allocNodes and build.spec.allocNodes[node.id] then
			return {
				ready = true, lines = asArray({}), unchanged = true,
				reason = "this node is already allocated on the tree",
			}
		end
		local okAnoints, anoints = pcall(tab.getAnoint, tab, item)
		for _, name in ipairs((okAnoints and anoints) or {}) do
			if name == node.dn then
				return {
					ready = true, lines = asArray({}), unchanged = true,
					reason = "this node is already anointed",
				}
			end
		end
	end

	local calcsTab = build.calcsTab
	if not calcsTab or not calcsTab.GetMiscCalculator then
		return { ready = false, error = "the engine has no calculator yet" }
	end
	local calcFunc = calcsTab:GetMiscCalculator()
	if not calcFunc then
		return { ready = false, error = "the engine has not finished its first calculation" }
	end

	-- `anointItem` reads this field rather than taking an argument, so it is
	-- set on every call: commands arrive here in any order and a slot left
	-- over from the last one would anoint the wrong line.
	tab.anointEnchantSlot = math_floor(tonumber(slot) or 1)

	local repSlotName = item:GetPrimarySlot()
	local buildFlag = build.buildFlag
	local okBase, base = pcall(calcFunc, { repSlotName = repSlotName, repItem = item })
	local okNew, output = pcall(function()
		return calcFunc({ repSlotName = repSlotName, repItem = tab:anointItem(node) })
	end)
	build.buildFlag = buildFlag
	if not okBase then
		return { ready = false, error = tostring(base) }
	end
	if not okNew then
		return { ready = false, error = tostring(output) }
	end

	local header = node
		and ("^7Anointing " .. node.dn .. " will give you:")
		or "^7Removing this anoint will give you:"
	return renderCompare(build, base, output, header)
end

--- What corrupting the item would do, before it is done.
---
--- The dialog's Corrupted button is the only way to its `corruptItem`, so
--- the preview presses it, keeps the item that came out, and puts the old
--- one back on the bench. The same object goes back, so nothing downstream
--- sees a new item.
---
--- The item comes out whole, which means one call can answer both halves of
--- the question: the item as PoB would draw it, and what the build would
--- gain. PoB cannot quite say that. Its button hover draws the item with no
--- comparison, and its per-modifier hover compares that one modifier
--- against the uncorrupted item, so two implicits chosen together are never
--- priced together.
function api.corruptPreview(build, value)
	local tab = build and build.itemsTab
	local calcsTab = build and build.calcsTab
	if not calcsTab or not calcsTab.GetMiscCalculator then
		return { ready = false, error = "the engine has no calculator yet" }
	end
	local calcFunc = calcsTab:GetMiscCalculator()
	if not calcFunc then
		return { ready = false, error = "the engine has not finished its first calculation" }
	end

	-- buildFlag is restored by hand: the rebuilds below set it, and leaving
	-- it set would make the UI think the build itself had changed.
	local buildFlag = build.buildFlag
	local staged, err = withCorruptionDialog(build, value, function(controls)
		local before = tab.displayItem
		controls.save.onClick()
		local after = tab.displayItem
		tab:SetDisplayItem(before)
		if after == before then
			return nil, "the dialog did not produce an item"
		end
		return { before = before, after = after }
	end)
	if not staged then
		build.buildFlag = buildFlag
		return { ready = false, error = err }
	end

	local tooltip = new("Tooltip"):Tooltip()
	local drew, drawErr = pcall(tab.AddItemTooltip, tab, tooltip, staged.after)
	if not drew then
		build.buildFlag = buildFlag
		return { ready = false, error = tostring(drawErr) }
	end
	-- The item only. PoB's own tooltip puts its "Equipping this item will
	-- give you" block underneath, and that compares the whole item against
	-- what is in the slot now, which is a different question from the one
	-- this panel is asking and is already answered on the bench above it.
	local drawn, tips = tooltipLines(tooltip)
	local lines = asArray({})
	for _, line in ipairs(drawn) do
		if (line.block or 1) == 1 then lines[#lines + 1] = line end
	end

	-- The slot PoB would compare against, which is the equipped one where
	-- the item is equipped and the primary one otherwise. Both sides use
	-- it, so the answer is the corruption rather than the whole item.
	local slotName = tab:GetComparisonSlotNameForItem(staged.before)
	local okBase, base = pcall(calcFunc, { repSlotName = slotName, repItem = staged.before })
	local okNew, output = pcall(calcFunc, { repSlotName = slotName, repItem = staged.after })
	build.buildFlag = buildFlag
	if not okBase then
		return { ready = false, error = tostring(base) }
	end
	if not okNew then
		return { ready = false, error = tostring(output) }
	end

	return {
		ready = true,
		item = lines,
		droppedTips = tips,
		slot = slotName,
		compare = renderCompare(build, base, output, "^7Corrupting this will give you:"),
	}
end

--- The lines a catalyst would scale, as PoB would read them out.
---
--- `BuildAndParseRaw` leaves its scalar on every mod line it touched, so
--- which modifiers a catalyst reaches is not worked out again here: it is
--- read off the parse, and rendered with PoB's own range function so the
--- numbers are the tooltip's rather than an approximation of them.
local function catalystScaledLines(item)
	local lines = asArray({})
	for _, lineTable in ipairs({ item.implicitModLines or {}, item.explicitModLines or {} }) do
		for _, modLine in ipairs(lineTable) do
			local scalar = modLine.valueScalar
			if scalar and scalar ~= 1 and modLine.line then
				local ok, rendered = pcall(
					itemLib.applyRange, (modLine.line:gsub("\n", " ")),
					modLine.range or 1, scalar, modLine.corruptedRange
				)
				lines[#lines + 1] = strip(ok and rendered or modLine.line)
			end
		end
	end
	return lines
end

--- What each catalyst would do to the item on the bench.
---
--- Thirteen answers in one call, which the desktop app cannot give. Its
--- dropdown applies one and redraws, so comparing two means applying each
--- in turn and remembering what the last one said, and the tooltip's
--- quality line reports the number without saying which modifiers it
--- reached. Most of the thirteen scale nothing at all on a given ring, and
--- that is worth seeing at a glance rather than one at a time.
---
--- Nothing on the bench is touched. Each candidate is a clone built from
--- the item's own text with the catalyst set on it, handed to the
--- calculator as a replacement for the slot the item would sit in, which
--- is how PoB's own hover comparisons work.
function api.craftCatalysts(build, value)
	local tab = build and build.itemsTab
	local item = tab and tab.displayItem
	if not item then
		return { ready = false }
	end
	if not catalystApplies(tab) then
		return {
			ready = false,
			error = "a catalyst needs a ring, an amulet or a jewel whose modifiers carry tags",
		}
	end
	local control = catalystControl(tab)
	local calcsTab = build.calcsTab
	if not calcsTab or not calcsTab.GetMiscCalculator then
		return { ready = false, error = "the engine has no calculator yet" }
	end
	local calcFunc = calcsTab:GetMiscCalculator()
	if not calcFunc then
		return { ready = false, error = "the engine has not finished its first calculation" }
	end

	-- The quality every candidate is priced at, so the thirteen answers are
	-- comparable: what was asked for, else what the item already carries,
	-- else what the dropdown would pick.
	local asked = tonumber(type(value) == "table" and value.quality or value)
	local quality = math.min(99, math.max(0, math.floor(
		asked or item.catalystQuality or catalystDefaultQuality(item)
	)))

	local slotName = tab:GetComparisonSlotNameForItem(item)
	local raw = item:BuildRaw()
	local buildFlag = build.buildFlag
	local okBase, base = pcall(calcFunc, { repSlotName = slotName, repItem = item })
	if not okBase then
		build.buildFlag = buildFlag
		return { ready = false, error = tostring(base) }
	end

	local options = asArray({})
	-- Id 0 is the dropdown's placeholder entry, which takes the catalyst
	-- off again. Offered only where there is one to take off, and priced
	-- like the rest, because coming off is as much a change as going on.
	local first = (item.catalyst and item.catalyst > 0) and 0 or 1
	for id = first, #control.list - 1 do
		local name = id == 0 and "No catalyst" or strip(control.list[id + 1])
		local row = {
			id = id,
			name = name,
			current = ((item.catalyst or 0) == id) or nil,
		}
		local clone = new("Item"):Item(raw)
		clone.catalyst = id
		clone.catalystQuality = (id > 0) and quality or nil
		local okBuild, buildErr = pcall(clone.BuildAndParseRaw, clone)
		if not okBuild then
			row.error = tostring(buildErr)
		else
			row.scales = catalystScaledLines(clone)
			local okNew, output = pcall(calcFunc, { repSlotName = slotName, repItem = clone })
			if okNew then
				-- The row already carries the name, so the header PoB writes
				-- above its comparison reads as a continuation of it rather
				-- than saying the same thing twice.
				row.compare = renderCompare(build, base, output, "^7would give you:")
			else
				row.compare = { ready = false, error = tostring(output) }
			end
		end
		options[#options + 1] = row
	end
	build.buildFlag = buildFlag

	return {
		ready = true,
		slot = slotName,
		quality = quality,
		catalyst = item.catalyst or 0,
		options = options,
	}
end

--- What a gem being off, or at 20 quality, would do.
---
--- Unlike the tree and the item bench, the calculator has no argument for
--- a gem, so these are the apply-and-revert shape: PoB's own tooltips
--- write the field, recalculate and write it back, and so does this.
function api.gemWhatIf(build, groupIndex, gemIndex, subject, level)
	local tab = build and build.skillsTab
	local group = tab and tab.socketGroupList and tab.socketGroupList[tonumber(groupIndex) or 0]
	local gem = group and group.gemList and group.gemList[tonumber(gemIndex) or 0]
	if not gem then
		return {
			ready = false,
			error = "no gem " .. tostring(gemIndex) .. " in group " .. tostring(groupIndex),
		}
	end

	-- A level is the one gem change with a number in it, and the one PoB
	-- has no tooltip for: its own panel asks about enabling and about
	-- quality, and a level is something you type and then read the sheet.
	if subject == "level" then
		local wanted = math_floor(tonumber(level) or 0)
		if wanted < 1 then
			return { ready = false, error = "expected a level of 1 or more" }
		end
		if wanted == (gem.level or 1) then
			return {
				ready = false,
				error = "this gem is already at level " .. tostring(wanted),
			}
		end
		local stored = gem.level
		return whatIf(build, function()
			gem.level = wanted
			return function()
				gem.level = stored
			end
		end, string.format("^7Taking this gem to level %d will give you:", wanted))
	end

	if subject == "quality" then
		if (gem.quality or 0) >= 20 then
			return { ready = false, error = "this gem is already at 20 quality or better" }
		end
		local stored = gem.quality
		return whatIf(build, function()
			gem.quality = 20
			return function()
				gem.quality = stored
			end
		end, "^7Setting to 20 quality will give you:")
	end

	local on = gem.enabled
	return whatIf(build, function()
		gem.enabled = not on
		return function()
			gem.enabled = on
		end
	end, on and "^7Disabling this gem will give you:" or "^7Enabling this gem will give you:")
end

--- The item on the bench, against every slot it could go in.
---
--- This is the desktop tab's actual working loop, and it was the one thing
--- missing from this screen: paste an item, and before committing to
--- anything, see what it would do in each slot it fits. PoB keeps the
--- pasted item as `displayItem` and answers that on hover, one slot at a
--- time; this answers it for every candidate at once, because a list is
--- what a web UI has where the desktop had a tooltip and a mouse.
---
--- Nothing is mutated. GetMiscCalculator's `repSlotName`/`repItem` pair
--- means exactly "recalculate as if this item were in that slot", which is
--- how ItemsTab's own anoint and rune tooltips work, so the deltas are the
--- engine's and the build is never left holding a half-equipped item. That
--- matters more than it sounds: the alternative is equip, read, unequip,
--- and an interruption in the middle of that leaves the build wrong.
function api.stagedItem(build)
	local tab = build and build.itemsTab
	local item = tab and tab.displayItem
	if not item then
		return { ready = false }
	end

	-- The same two passes /items needs. Which slots exist at all is build
	-- state, and it is those slots IsItemValidForSlot is asked about below.
	tab:PopulateSlots()
	pcall(tab.UpdateSockets, tab)

	-- The item itself, and only the item.
	--
	-- AddItemTooltip given no slot does not mean "no comparison": it means
	-- every slot, appended to the item in one column. That is the desktop
	-- layout, where the tooltip is all there is. Here the slots are their
	-- own list below, so asking for both would print each comparison
	-- twice. showStatDifferences is the engine's own switch for this, the
	-- one Ctrl+D throws in the Items tab, and it sits at the end of the
	-- tooltip: turning it off leaves the item untouched and drops only the
	-- part being rendered properly further down.
	local showing = tab.showStatDifferences
	tab.showStatDifferences = false
	local tooltip = new("Tooltip"):Tooltip()
	local drawn, drawErr = pcall(tab.AddItemTooltip, tab, tooltip, item)
	tab.showStatDifferences = showing
	if not drawn then
		return { ready = false, error = tostring(drawErr) }
	end
	local lines, tips = tooltipLines(tooltip)

	local primary
	local okPrimary, prim = pcall(item.GetPrimarySlot, item)
	if okPrimary then
		primary = prim
	end

	local calcsTab = build.calcsTab
	local calcFunc, calcBase
	if calcsTab and calcsTab.GetMiscCalculator then
		calcFunc, calcBase = calcsTab:GetMiscCalculator()
	end

	-- Restored by hand, as whatIf does: the calculations below raise it,
	-- and leaving it raised would have the UI believe the build changed.
	local buildFlag = build.buildFlag

	-- Which slots are candidates is PoB's own rule, taken from the same
	-- place its tooltip builds this list: valid for the item, not
	-- inactive, and belonging to the weapon set actually in play. Without
	-- that last clause a one-hander offers both sets and half the answers
	-- are about gear the build is not currently wearing.
	local env = build.calcsTab and build.calcsTab.mainEnv
	local weaponSet = (env and env.weaponSet)
		or ((tab.activeItemSet and tab.activeItemSet.useSecondWeaponSet) and 2 or 1)

	local candidates = {}
	for slotName, slot in pairs(tab.slots or {}) do
		local okValid, valid = pcall(tab.IsItemValidForSlot, tab, item, slotName)
		if okValid and valid and not slot.inactive
			and (not slot.weaponSet or slot.weaponSet == weaponSet)
			and (slot.weaponSet or slotShown(slot))
		then
			candidates[#candidates + 1] = slot
		end
	end

	local isUnique = item.rarity == "UNIQUE" or item.rarity == "RELIC"
	local sameUniqueCount = 0
	local entries = {}
	for _, slot in ipairs(candidates) do
		local held = tab.items[slot.selItemId]
		local sameUnique = (isUnique and held and item.name == held.name) or false
		if sameUnique and item.limit then
			sameUniqueCount = sameUniqueCount + 1
		end
		local output, calcErr
		if calcFunc and calcBase then
			-- A nil repItem means "take it out", which is the right
			-- question when the staged item is the one already in here.
			local okCalc, res = pcall(calcFunc, {
				repSlotName = slot.slotName,
				repItem = (item ~= held) and item or nil,
			})
			if okCalc then output = res else calcErr = tostring(res) end
		end
		entries[#entries + 1] = {
			slot = slot,
			held = held,
			sameUnique = sameUnique,
			removing = (item == held) or nil,
			output = output,
			calcErr = calcErr,
		}
	end

	build.buildFlag = buildFlag

	-- A unique with a limit, already worn as many times as it allows:
	-- the only honest question left is what swapping one of those for
	-- this one would do, so the other slots are dropped rather than
	-- offered as places it cannot legally go.
	local limited = item.limit and sameUniqueCount == item.limit or false
	if limited then
		local kept = {}
		for _, entry in ipairs(entries) do
			if entry.sameUnique then
				kept[#kept + 1] = entry
			end
		end
		entries = kept
	end

	--- Same unique, or the same base type and subtype: the slot whose
	--- contents this item is actually an alternative to.
	local function similar(entry)
		local held = entry.held
		if not held then
			return 0
		end
		local sameBase = not isUnique
			and held.rarity ~= "UNIQUE" and held.rarity ~= "RELIC"
			and item.base and held.base
			and item.base.type == held.base.type
			and item.base.subType == held.base.subType
		return (sameBase or entry.sameUnique) and 1 or 0
	end

	-- PoB's own ordering, key for key: an empty slot first, then the slot
	-- holding something comparable, then by what the build would actually
	-- do (full DPS, combined DPS, effective hit pool), then by name so
	-- the result is stable. This is the part that makes the list useful
	-- rather than long: the slot worth reading is the one at the top.
	local function keysOf(entry)
		local out = entry.output or {}
		return {
			entry.slot.selItemId == 0 and 1 or 0,
			similar(entry),
			out.FullDPS,
			out.CombinedDPS,
			out.TotalEHP,
			entry.slot.label,
			entry.slot.slotName,
		}
	end
	table.sort(entries, function(a, b)
		if a == b then
			return false
		end
		local ak, bk = keysOf(a), keysOf(b)
		for i = 1, #ak do
			-- A missing key is skipped rather than treated as zero: the
			-- stat may simply not apply to this build.
			if ak[i] ~= nil and bk[i] ~= nil then
				if ak[i] > bk[i] then
					return true
				elseif ak[i] < bk[i] then
					return false
				end
			end
		end
		return false
	end)

	local slots = asArray({})
	for _, entry in ipairs(entries) do
		local slot = entry.slot
		local out = entry.output or {}
		local row = {
			name = slot.slotName,
			label = strip(slot.label or slot.slotName),
			-- Where AddItem would have put it unaided. Not the same thing
			-- as the best slot, and worth saying separately.
			primary = (slot.slotName == primary) or nil,
			weaponSet = slot.weaponSet,
			socket = slot.nodeId and true or nil,
			-- The staged item is already in this slot, so the comparison
			-- below is what taking it out would do.
			removing = entry.removing,
			empty = (slot.selItemId == 0) or nil,
			-- Why this slot sorted where it did, so the UI can say it.
			similar = similar(entry) == 1 or nil,
			-- The three numbers the ordering turns on, reported so the UI
			-- can show a headline without parsing the comparison lines.
			fullDPS = out.FullDPS,
			combinedDPS = out.CombinedDPS,
			totalEHP = out.TotalEHP,
		}
		-- What it would displace. Named, because "+40 life" means one
		-- thing against an empty slot and another against a good ring.
		if entry.held then
			row.replaces = {
				id = slot.selItemId,
				name = strip(entry.held.name or entry.held.title or entry.held.baseName or "Item"),
				rarity = entry.held.rarity or "NORMAL",
			}
		end
		if entry.calcErr then
			row.compare = { ready = false, error = entry.calcErr }
		elseif entry.output then
			row.compare = renderCompare(build, calcBase, entry.output, "")
		end
		slots[#slots + 1] = row
	end

	return {
		ready = true,
		name = strip(item.name or item.title or item.baseName or "Item"),
		base = strip(item.baseName or ""),
		rarity = item.rarity or "NORMAL",
		primarySlot = primary,
		lines = lines,
		droppedTips = tips,
		slots = slots,
		-- How many of this unique may be worn at once, and whether that
		-- many already are. The slot list is narrowed to the ones holding
		-- a copy when it is, and saying so is the difference between
		-- "these are your options" and "these are all your options".
		limit = item.limit,
		limited = limited or nil,
		-- Nothing takes it: a jewel with no socket allocated, a shield
		-- behind a two-hander. Worth saying outright, because an empty
		-- list reads as a failure to load.
		fitsNothing = #slots == 0 or nil,
	}
end

------------------------------------------------------------------- commands

local commands = {}

function commands.setCharacterLevel(build, value)
	local n = math.max(1, math.min(100, math.floor(tonumber(value) or 1)))
	local ctrl = build.controls.characterLevel
	if not ctrl then return nil, "no level control" end
	-- SetText alone would move the box without telling the engine. The change
	-- callback is what clears auto mode and raises the recalculation flags.
	ctrl:SetText(tostring(n))
	if ctrl.changeFunc then ctrl.changeFunc(tostring(n)) end
	return true
end

function commands.setLevelAutoMode(build, value)
	local want = value and true or false
	local ctrl = build.controls.levelScalingButton
	if not ctrl or not ctrl.onClick then return nil, "no level mode control" end
	-- The button toggles; it does not take a value.
	if (build.characterLevelAutoMode and true or false) ~= want then
		ctrl.onClick()
	end
	return true
end

function commands.setClass(build, value)
	local id = tonumber(value)
	local drop = build.controls.classDrop
	if not drop or not drop.list then return nil, "no class control" end
	for i, entry in ipairs(drop.list) do
		if entry.classId == id then
			if drop.selFunc then drop.selFunc(i, entry) end
			drop:SelByValue(id, "classId")
			-- The ascendancy list belongs to the class, so it has to follow.
			-- This is what Build.lua does for itself after a class change.
			local ascend = build.controls.ascendDrop
			if ascend then
				ascend.list = drop:GetSelValueByKey("ascendancies")
				ascend:SelByValue(build.spec and build.spec.curAscendClassId or 0, "ascendClassId")
			end
			return true
		end
	end
	return nil, "no class with id " .. tostring(value)
end

function commands.setAscendancy(build, value)
	local id = tonumber(value)
	local drop = build.controls.ascendDrop
	if not drop then return nil, "no ascendancy control" end
	for i, entry in ipairs(drop.list or {}) do
		if entry.ascendClassId == id then
			if drop.selFunc then drop.selFunc(i, entry) end
			drop:SelByValue(id, "ascendClassId")
			return true
		end
	end
	return nil, "no ascendancy with id " .. tostring(value)
end

function commands.setLoadout(build, value)
	local i = tonumber(value)
	local treeTab = build.treeTab
	if not treeTab or not treeTab.specList then return nil, "no tree tab" end
	if not treeTab.specList[i] then return nil, "no spec at index " .. tostring(value) end
	treeTab:SetActiveSpec(i)
	return true
end

--- Replace the notes.
---
--- The whole buffer at once, which is what SetText takes and what Save
--- writes back out.
---
--- The modFlag line below is the one `NotesTab:Draw` runs, and it has to
--- be repeated here because that Draw only happens while the Notes tab is
--- the one on screen. Headless, it never is. Without this the notes would
--- still be saved, since Save reads the buffer either way, but the build
--- would not say it had unsaved work in it, which is a worse failure than
--- losing the text: you would have no reason to press Save.
---
--- It is the comparison rather than a flat `true`, exactly as PoB has it,
--- so typing the notes back to what they were clears the flag again.
function commands.setNotes(build, value)
	local tab = build.notesTab
	local edit = tab and tab.controls and tab.controls.edit
	if not edit then
		return nil, "this build has no notes"
	end
	local text = type(value) == "table" and value.text or value
	if type(text) ~= "string" then
		return nil, "expected { text = ... }"
	end
	-- Escaped caret codes are a display mode of the desktop editor. Writing
	-- them into the buffer would save them, and they would come back as
	-- literal text rather than as colours.
	pcall(tab.SetShowColorCodes, tab, false)
	edit:SetText(text)
	tab.modFlag = (tab.lastContent ~= edit.buf)
	return true
end

--- Create an item to craft on, and put it on the bench.
---
--- PoB's own dialog, driven rather than reimplemented. The item is built
--- by `makeItem`, a local closure inside `CraftItem` carrying sixty lines
--- of base handling: the socket count a martial weapon gets, the implicit
--- lines parsed off the base, quality normalisation, the rarity downgrade
--- flasks and charms get from rare to magic, the Transcendent Limb forced
--- to normal. There is no way to reach it except through the dialog it
--- lives in, so the dialog is opened, its dropdowns are set through their
--- own callbacks, and its own Create button is pressed.
---
--- The type dropdown's callback is what rebuilds the base list, so the
--- order below is not arbitrary: type first, then base.
function commands.craftItem(build, value)
	local tab = build.itemsTab
	value = type(value) == "table" and value or {}

	local opened = pcall(tab.CraftItem, tab)
	local popup = main and main.popups and main.popups[1]
	local controls = popup and popup.controls
	if not opened or not controls or not controls.save then
		if popup then pcall(main.ClosePopup, main) end
		return nil, "the craft dialog did not open"
	end

	local ok, err = pcall(function()
		local typeName = tostring(value.type or "")
		local typeIndex
		for i, name in ipairs(build.data.itemBaseTypeList or {}) do
			if name == typeName then
				typeIndex = i
				break
			end
		end
		if not typeIndex then
			error("no item type named " .. typeName, 0)
		end
		controls.type.selIndex = typeIndex
		controls.type.selFunc(typeIndex, typeName)

		local baseName = tostring(value.base or "")
		local baseIndex
		for i, entry in ipairs(controls.base.list or {}) do
			if entry.name == baseName then
				baseIndex = i
				break
			end
		end
		if not baseIndex then
			error("no base named " .. baseName .. " under " .. typeName, 0)
		end
		controls.base.selIndex = baseIndex

		local rarity = tostring(value.rarity or "RARE"):upper()
		local rarityIndex
		for i, entry in ipairs(controls.rarity.list or {}) do
			if tostring(entry.rarity or ""):upper() == rarity then
				rarityIndex = i
				break
			end
		end
		if not rarityIndex then
			error("no rarity named " .. rarity, 0)
		end
		controls.rarity.selIndex = rarityIndex

		if type(value.name) == "string" and value.name:match("%S") then
			controls.title:SetText(value.name)
		end

		-- Closes the dialog itself, builds the item and stages it.
		controls.save.onClick()
	end)

	-- Create opens the text editor afterwards for a rarity that has no
	-- affix slots, because on the desktop that is the only way to give it
	-- modifiers. Here the bench already has a text box, so the second
	-- dialog is closed: a popup left standing blocks every screen rather
	-- than this one.
	while main.popups[1] do
		pcall(main.ClosePopup, main)
	end

	if not ok then
		return nil, tostring(err)
	end
	return true
end

--- Put a modifier in an affix row, or take one out.
---
--- An affix slot is `{ modId, range }`: which tier of which modifier, and
--- where in that tier's range it rolled, 0 for the bottom and 1 for the
--- top. Setting the pair and calling `Craft()` is exactly what the desktop
--- dropdown's own callback does; `Craft()` rebuilds the item's explicit
--- modifier lines from the affix tables and leaves custom modifiers alone.
---
--- `modId` names a tier, not a modifier: the tiers of one modifier come
--- back from /craft/affixes as `modIds`, lowest first.
function commands.setCraftAffix(build, value)
	local tab = build.itemsTab
	local item = tab and tab.displayItem
	if not item then
		return nil, "nothing is on the bench"
	end
	if not item.crafted then
		return nil, "this item is not crafted, so it has no affix slots"
	end

	value = type(value) == "table" and value or {}
	local kind = tostring(value.kind or ""):lower()
	local outputTable = AFFIX_TABLE[kind]
	if not outputTable then
		return nil, "expected kind prefix or suffix"
	end
	local index = tonumber(value.index)
	if not index or index < 1 or index > affixLimit(item, outputTable) then
		return nil, "no " .. kind .. " slot " .. tostring(value.index)
	end

	-- Carried across, because it is a property of the slot rather than of
	-- the modifier in it: a fractured slot stays fractured.
	local fractured = (item[outputTable][index] or {}).fractured

	if value.modId == nil or value.modId == false or value.modId == "None" then
		-- PoB's own empty value. Not nil, because the row has to stay
		-- addressable for the next change.
		item[outputTable][index] = { modId = "None", fractured = fractured }
	else
		local modId = tostring(value.modId)
		if not item.affixes[modId] then
			return nil, "this item cannot roll " .. modId
		end
		local roll = tonumber(value.roll)
		if roll == nil then
			local held = (item[outputTable][index] or {}).range
			roll = type(held) == "number" and held or 0.5
		end
		item[outputTable][index] = {
			modId = modId,
			range = math.min(1, math.max(0, roll)),
			fractured = fractured,
		}
	end

	local ok, err = pcall(item.Craft, item)
	if not ok then
		return nil, tostring(err)
	end
	return true
end

--- Put a rune in a socket, or take one out.
---
--- `item.runes` is a flat array of rune names, one per socket, with PoB's
--- own "None" for an empty one. Setting the name and calling UpdateRunes
--- then BuildAndParseRaw is exactly what the desktop dropdown does:
--- UpdateRunes is what merges the socketed runes' lines into the item,
--- including the stacking of two of the same, and the rebuild is what
--- makes the result readable as an item again.
function commands.setRune(build, value)
	local tab = build.itemsTab
	local item = tab and tab.displayItem
	if not item then
		return nil, "nothing is on the bench"
	end
	if (item.itemSocketCount or 0) < 1 then
		return nil, "this item has no rune sockets"
	end

	value = type(value) == "table" and value or {}
	local index = tonumber(value.index)
	if not index or index < 1 or index > item.itemSocketCount then
		return nil, "no socket " .. tostring(value.index)
	end

	local name = value.name
	if name == nil or name == false or name == "None" then
		name = "None"
	else
		name = tostring(name)
		-- Checked against the item's own valid list rather than against
		-- every rune the game has: which runes a socket takes is a real
		-- restriction and silently accepting a wrong one would build an
		-- item that cannot exist.
		local ok, valid = pcall(tab.GetValidRunesForItem, tab, item)
		local found = false
		for _, rune in ipairs(ok and valid or {}) do
			if rune.name == name then
				found = true
				break
			end
		end
		if not found then
			return nil, "this item cannot socket " .. name
		end
	end

	item.runes = item.runes or {}
	item.runes[index] = name

	local ok, err = pcall(function()
		item:UpdateRunes()
		item:BuildAndParseRaw()
	end)
	if not ok then
		return nil, tostring(err)
	end
	return true
end

--- Set how many sockets the bench item has.
---
--- Two kinds, as the desktop tab has: rune sockets, whose contents are
--- runes, and jewel sockets, which only count. Both are capped at six,
--- which is PoB's own limit rather than a guess: its edit box rewrites
--- anything larger straight back down to it.
---
--- Shrinking the count drops the runes past it for good: UpdateRunes
--- rebuilds the item's lines from the sockets that remain, and the
--- rebuild after it re-reads the item from that text. Putting the sockets
--- back leaves them empty. Checked rather than assumed, because the
--- forgiving behaviour is the one you would expect.
function commands.setSocketCount(build, value)
	local tab = build.itemsTab
	local item = tab and tab.displayItem
	if not item then
		return nil, "nothing is on the bench"
	end

	value = type(value) == "table" and value or {}
	local kind = tostring(value.kind or "rune"):lower()
	if kind ~= "rune" and kind ~= "jewel" then
		return nil, "expected kind rune or jewel"
	end
	local count = tonumber(value.count)
	if not count then
		return nil, "expected { count = ... }"
	end
	count = math.min(6, math.max(0, math.floor(count)))

	local ok, err = pcall(function()
		if kind == "rune" then
			item.itemSocketCount = count
			item:UpdateRunes()
		else
			item.jewelSocketCount = count
		end
		item:BuildAndParseRaw()
	end)
	if not ok then
		return nil, tostring(err)
	end
	return true
end

--- Anoint the bench item, or take its anoint off.
---
--- `anointItem` builds a new item rather than changing this one: an anoint
--- is an enchant line, enchant lines live in the item's text, so the text
--- is rewritten and reparsed. The bench item is therefore replaced, which
--- is what PoB's own Save button does with the result.
---
--- Anointing replaces whatever is in that enchant line, anoint or not. The
--- slot list reports what each one holds so the warning can come before the
--- click; the rule for which slots exist is shared with that list rather
--- than repeated, because an insert past the end of `enchantModLines` would
--- leave a hole rather than fail.
function commands.setAnoint(build, value)
	local tab = build.itemsTab
	local item = tab and tab.displayItem
	if not item then
		return nil, "nothing is on the bench"
	end
	if not isAnointable(item) then
		return nil, "this item cannot be anointed"
	end

	value = type(value) == "table" and value or {}
	local slot = math_floor(tonumber(value.slot) or 1)
	local allowed = false
	for _, entry in ipairs(anointSlots(item)) do
		if entry.index == slot then
			allowed = true
			break
		end
	end
	if not allowed then
		return nil, "this item has no anoint slot " .. tostring(value.slot or slot)
	end

	local node
	local nodeId = value.node
	if nodeId ~= nil and nodeId ~= false and nodeId ~= "" then
		local nodes = build.spec and build.spec.tree and build.spec.tree.nodes
		node = nodes and nodes[tonumber(nodeId) or nodeId]
		if not node then
			return nil, "no node with id " .. tostring(nodeId)
		end
		if not isAnointableNode(node) then
			return nil, strip(node.dn or "that node") .. " cannot be anointed"
		end
	end

	tab.anointEnchantSlot = slot
	local ok, err = pcall(function()
		tab:SetDisplayItem(tab:anointItem(node))
	end)
	if not ok then
		return nil, tostring(err)
	end
	return true
end

--- Corrupt the bench item.
---
--- One command for what PoB's dialog does on Save, because that is what it
--- is: the implicits, or the roll ranges, are assembled first and committed
--- once. Everything until this call is a draft held in the browser, which
--- is the one place in this panel where that is right: corrupting is the
--- only crafting step the game will not let you take back, and PoB puts a
--- Cancel next to it for exactly that reason.
function commands.corruptItem(build, value)
	local ok, err = withCorruptionDialog(build, value, function(controls)
		controls.save.onClick()
		return true
	end)
	if not ok then
		return nil, err
	end
	return true
end

--- Set the bench item's quality.
---
--- Two digits, as PoB's own edit box allows, and only where the base has
--- quality at all. BuildAndParseRaw is what applies it: quality scales the
--- base's own values rather than adding a modifier, so the item has to be
--- rebuilt from its text rather than recrafted.
function commands.setCraftQuality(build, value)
	local tab = build.itemsTab
	local item = tab and tab.displayItem
	if not item then
		return nil, "nothing is on the bench"
	end
	if item.quality == nil or not (item.base and item.base.quality) then
		return nil, "this base has no quality"
	end

	local quality = tonumber(type(value) == "table" and value.quality or value)
	if not quality then
		return nil, "expected { quality = ... }"
	end
	item.quality = math.min(99, math.max(0, math.floor(quality)))

	local ok, err = pcall(item.BuildAndParseRaw, item)
	if not ok then
		return nil, tostring(err)
	end
	return true
end

--- Put a catalyst on the bench item, or take it off.
---
--- The dropdown's own `selFunc` rather than the two fields it sets, because
--- it does three more things worth having: it picks the quality the first
--- time a catalyst goes on, fifty for a Breach Ring and twenty otherwise;
--- it forces every affix selector to re-read its values, since a catalyst
--- changes what each affix would roll; and it rebuilds the item from its
--- text. Writing `item.catalyst` by hand would leave the affix rows
--- describing the item as it was.
function commands.setCatalyst(build, value)
	local tab = build and build.itemsTab
	local item = tab and tab.displayItem
	if not item then
		return nil, "nothing is on the bench"
	end
	if not catalystApplies(tab) then
		return nil, "a catalyst needs a ring, an amulet or a jewel whose modifiers carry tags"
	end
	local control = catalystControl(tab)

	local wanted = tonumber(type(value) == "table" and value.catalyst or value)
	if wanted == nil then
		return nil, "expected { catalyst = 0..13 }"
	end
	wanted = math.floor(wanted)
	if wanted < 0 or wanted > #control.list - 1 then
		return nil, "there is no catalyst " .. tostring(wanted)
	end

	-- Before the dropdown fires, not after: its own handler re-reads every
	-- affix control, so they have to already agree with the item. Reported
	-- rather than swallowed, because the failure is silent otherwise: the
	-- catalyst lands and a modifier is gone.
	local okSync, syncErr = syncAffixControls(tab, item)
	if not okSync then
		return nil, "the affix controls could not be brought in line: " .. tostring(syncErr)
	end

	local okSel, selErr = pcall(control.selFunc, wanted + 1, control.list[wanted + 1])
	if not okSel then
		return nil, tostring(selErr)
	end

	-- Quality second, so the dropdown has already seeded its default and
	-- this writes over it. PoB's box takes two digits and the scalar it
	-- feeds, (100 + quality) / 100, has no cap of its own, so the same two
	-- digits are the limit here.
	local quality = type(value) == "table" and tonumber(value.quality) or nil
	if quality and wanted > 0 then
		local edit = tab.controls.displayItemCatalystQualityEdit
		if not edit then
			return nil, "the engine has no catalyst quality control"
		end
		local text = tostring(math.min(99, math.max(0, math.floor(quality))))
		-- The quality box re-reads the affix controls too, for the same
		-- reason, so they are brought back in line between the two.
		local okAgain, againErr = syncAffixControls(tab, item)
		if not okAgain then
			return nil, "the affix controls could not be brought in line: " .. tostring(againErr)
		end
		edit:SetText(text)
		local okEdit, editErr = pcall(edit.changeFunc, text)
		if not okEdit then
			return nil, tostring(editErr)
		end
	end
	return true
end

function commands.setBuildName(build, value)
	-- Renaming in PoB proper happens inside Save As, because the name is also
	-- the file name. This sets the in-memory name and marks the build dirty;
	-- the file is only touched when the user saves.
	build.buildName = tostring(value or "")
	build.modFlag = true
	return true
end

local function click(name)
	return function(build)
		local ctrl = build.controls[name]
		if not ctrl or not ctrl.onClick then return nil, "no " .. name .. " control" end
		ctrl.onClick()
		return true
	end
end

commands.save = click("save")
commands.saveAs = click("saveAs")
commands.back = click("back")

--- Both main-skill dropdowns act on the index alone, and SetSel would remap
--- it through the drop-list offset, so this mirrors what SetSel does for a
--- plain list: set the index, then call the callback that raises the flags.
local function selectInDropdown(name)
	return function(build, value)
		local index = tonumber(value)
		local drop = build.controls[name]
		if not drop or not drop.list then return nil, "no " .. name .. " control" end
		local entry = drop.list[index]
		if not entry then return nil, "no option " .. tostring(value) .. " in " .. name end
		drop.selIndex = index
		if drop.selFunc then drop.selFunc(index, entry) end
		return true
	end
end

commands.setSocketGroup = selectInDropdown("mainSocketGroup")
commands.setMainSkill = selectInDropdown("mainSkill")

--- The Calcs tab drives its own skill selection through input.skill_number,
--- separately from the sidebar's main socket group. Its controls hang off
--- the hand-built SkillSelect section rather than off buildMode.
local function calcsSelectControl(build, name)
	for _, section in ipairs(build.calcsTab and build.calcsTab.sectionList or {}) do
		if section.id == "SkillSelect" then
			-- These lists are only repopulated by the section's updateFunc,
			-- which normally runs during layout. Without running it here, a
			-- command issued before anything has fetched /calcs indexes an
			-- empty list and fails.
			if section.updateFunc then
				pcall(section.updateFunc, section)
			end
			return section.controls and section.controls[name]
		end
	end
	return nil
end

local function selectInCalcs(name)
	return function(build, value)
		local index = tonumber(value)
		local drop = calcsSelectControl(build, name)
		if not drop or not drop.list then return nil, "no calcs " .. name .. " control" end
		local entry = drop.list[index]
		if not entry then return nil, "no option " .. tostring(value) .. " in calcs " .. name end
		drop.selIndex = index
		if drop.selFunc then drop.selFunc(index, entry) end
		return true
	end
end

commands.setCalcsSocketGroup = selectInCalcs("mainSocketGroup")
commands.setCalcsSkill = selectInCalcs("mainSkill")

--- Allocate or deallocate a passive, as a left-click on the tree does.
---
--- AllocNode walks the node's own path, so clicking something three nodes
--- away allocates the route to it exactly as PoB does. A node with no path
--- cannot be reached and is refused rather than quietly doing nothing.
---
--- Not handled, all of which open dialogs or need modifier keys in PoB:
--- attribute-node swapping, cross-class ascendancy switching, and jewel
--- sockets. Those arrive as a plain allocation here.
function commands.toggleNode(build, value)
	local id = tonumber(value)
	local spec = build.spec
	local node = spec and spec.nodes and spec.nodes[id]
	if not node then
		return nil, "no node with id " .. tostring(value)
	end

	if node.alloc then
		spec:DeallocNode(node)
	elseif node.path and #node.path > 0 then
		spec:AllocNode(node)
	else
		return nil, "node is not reachable from the allocated tree"
	end

	spec:AddUndoState()
	build.buildFlag = true
	return true
end

--------------------------------------------------------------- item commands

--- Put an item in a slot, or take one out with id 0.
---
--- This is what the slot dropdown's own callback does, in its order:
--- SetSelItemId, then repopulate every slot (equipping a two-hander empties
--- the off-hand, and a jewel changes which sockets exist), then an undo
--- state, then raise the recalculation flag.
function commands.setSlotItem(build, value)
	local tab = build.itemsTab
	local slotName = type(value) == "table" and value.slot
	local itemId = tonumber(type(value) == "table" and value.item) or 0
	local slot = tab and tab.slots and slotName and tab.slots[slotName]
	if not slot then
		return nil, "no slot named " .. tostring(slotName)
	end
	if itemId ~= 0 and not (tab.items and tab.items[itemId]) then
		return nil, "no item with id " .. tostring(itemId)
	end
	-- Asking PoB rather than trusting the caller: a dropdown built from a
	-- stale /items is the obvious way for this to arrive wrong.
	if itemId ~= 0 and not tab:IsItemValidForSlot(tab.items[itemId], slotName) then
		return nil, "that item does not fit " .. slotName
	end

	slot:SetSelItemId(itemId)
	tab:PopulateSlots()
	tab:AddUndoState()
	build.buildFlag = true
	return true
end

--- Turn a flask on or off without unequipping it.
function commands.setSlotActive(build, value)
	local tab = build.itemsTab
	local slotName = type(value) == "table" and value.slot
	local slot = tab and tab.slots and slotName and tab.slots[slotName]
	if not slot then
		return nil, "no slot named " .. tostring(slotName)
	end
	slot.active = (type(value) == "table" and value.active) and true or false
	if slot.controls and slot.controls.activate then
		slot.controls.activate.state = slot.active
	end
	tab:AddUndoState()
	build.buildFlag = true
	return true
end

--- Add an item from PoB's own unique or rare database, and equip it.
---
--- Lifted from ItemDBControl:OnSelClick, including the weapon-set
--- redirection: with the second set showing, an item whose primary slot is
--- "Weapon 1" has to go to "Weapon 1 Swap", and a bridge that skipped that
--- would silently equip into the set you are not looking at.
function commands.addDbItem(build, value)
	local tab = build.itemsTab
	local name = type(value) == "table" and value.name or value
	if type(name) ~= "string" then
		return nil, "expected { name = ... }"
	end

	local source = (main.uniqueDB and main.uniqueDB.list and main.uniqueDB.list[name])
		or (main.rareDB and main.rareDB.list and main.rareDB.list[name])
	if not source or not source.raw then
		return nil, "no database item named " .. name
	end

	local item = new("Item"):Item(source.raw)
	item:NormaliseQuality()
	tab:AddItem(item, true)

	local slotName = item:GetPrimarySlot()
	if slotName and tab.slots[slotName] then
		if tab.slots[slotName].weaponSet == 1 and tab.activeItemSet.useSecondWeaponSet then
			slotName = slotName .. " Swap"
		end
		tab.slots[slotName]:SetSelItemId(item.id)
	end

	tab:PopulateSlots()
	tab:AddUndoState()
	build.buildFlag = true
	return true
end

--- Put a database item on the bench instead of equipping it.
---
--- The pairing the desktop app does not have: its database list equips on
--- click, so finding out what the best-ranked amulet would actually do
--- means wearing it and then putting the old one back. Every database item
--- carries the raw text it was parsed from, so this is stageItemText with
--- the text looked up rather than pasted.
--- Put an item on the bench from its raw text.
---
--- `CreateDisplayItemFromRaw` does not report anything. On text whose base
--- PoB does not know it leaves `displayItem` nil, and on text that is not
--- an item at all it leaves whatever was already there, so checking only
--- for nil calls a failure a success and answers about the previous item.
--- Comparing against what was on the bench catches both: a parse that
--- worked always replaces the object, even when the text is identical.
local function stage(tab, raw)
	local before = tab.displayItem
	tab:CreateDisplayItemFromRaw(raw, true)
	if not tab.displayItem or tab.displayItem == before then
		return nil, "that is not an item PoB recognises"
	end
	return true
end

function commands.stageDbItem(build, value)
	local tab = build.itemsTab
	local name = type(value) == "table" and value.name or value
	if type(name) ~= "string" then
		return nil, "expected { name = ... }"
	end

	local source = (main.uniqueDB and main.uniqueDB.list and main.uniqueDB.list[name])
		or (main.rareDB and main.rareDB.list and main.rareDB.list[name])
	if not source or not source.raw then
		return nil, "no database item named " .. name
	end

	local made, err = stage(tab, source.raw)
	if not made then
		return nil, err
	end
	return true
end

--- Add an item from its in-game text, as pasting into PoB does.
function commands.addItemText(build, value)
	local tab = build.itemsTab
	local raw = type(value) == "table" and value.text or value
	if type(raw) ~= "string" or raw:match("^%s*$") then
		return nil, "expected { text = ... }"
	end

	local made, err = stage(tab, raw)
	if not made then
		return nil, err
	end
	tab:AddDisplayItem()
	return true
end

--- Put pasted text on the bench without equipping it.
---
--- The same item addItemText makes; the difference is that this one stops
--- there. `displayItem` is where the desktop tab keeps the item being
--- worked on, and leaving it there is what gives /item/staged something to
--- answer about.
function commands.stageItemText(build, value)
	local tab = build.itemsTab
	local raw = type(value) == "table" and value.text or value
	if type(raw) ~= "string" or raw:match("^%s*$") then
		return nil, "expected { text = ... }"
	end

	local made, err = stage(tab, raw)
	if not made then
		return nil, err
	end
	return true
end

--- Take it off the bench again, equipping nothing.
function commands.clearStagedItem(build)
	local tab = build.itemsTab
	if not tab.displayItem then
		return nil, "nothing is staged"
	end
	tab:SetDisplayItem()
	return true
end

--- Commit the staged item, into a named slot or wherever PoB would put it.
---
--- AddDisplayItem's own argument is `noAutoEquip`, so asking for a
--- particular slot means adding without equipping and then equipping
--- deliberately. The slot is checked before anything is added: AddItem
--- would otherwise leave the item in the list with the slot unchanged,
--- which looks like the command half worked.
function commands.equipStagedItem(build, value)
	local tab = build.itemsTab
	local item = tab.displayItem
	if not item then
		return nil, "nothing is staged"
	end

	local slotName = type(value) == "table" and value.slot
		or (type(value) == "string" and value)
		or nil

	-- No slot asked for: AddItem's own auto-equip, which is the first
	-- empty slot that will take it, and the behaviour addItemText has.
	if not slotName then
		tab:AddDisplayItem()
		return true
	end

	local slot = tab.slots and tab.slots[slotName]
	if not slot then
		return nil, "no slot named " .. tostring(slotName)
	end
	local okValid, valid = pcall(tab.IsItemValidForSlot, tab, item, slotName)
	if not okValid or not valid then
		return nil, "that item does not fit " .. strip(slot.label or slotName)
	end

	-- AddItem assigns the id, on the same table `item` still points at.
	tab:AddDisplayItem(true)
	slot:SetSelItemId(item.id)
	tab:PopulateSlots()
	tab:AddUndoState()
	build.buildFlag = true
	return true
end

function commands.deleteItem(build, value)
	local tab = build.itemsTab
	local item = tab and tab.items and tab.items[tonumber(value) or 0]
	if not item then
		return nil, "no item with id " .. tostring(value)
	end
	tab:DeleteItem(item)
	tab:PopulateSlots()
	build.buildFlag = true
	return true
end

function commands.setItemSet(build, value)
	local tab = build.itemsTab
	local id = tonumber(value)
	if not tab or not id or not (tab.itemSets and tab.itemSets[id]) then
		return nil, "no item set with id " .. tostring(value)
	end
	tab:SetActiveItemSet(id)
	tab:AddUndoState()
	build.buildFlag = true
	return true
end

--- Switch between the two weapon sets.
---
--- The tab drives this from two buttons rather than a value, and each one
--- does more than set the flag: PoB's own handlers are used so whatever else
--- they do keeps happening.
function commands.setWeaponSet(build, value)
	local tab = build.itemsTab
	local want = (tonumber(value) or 1) == 2
	if not tab or not tab.activeItemSet then
		return nil, "no item set"
	end
	if (tab.activeItemSet.useSecondWeaponSet and true or false) == want then
		return true
	end
	local button = tab.controls and (want and tab.controls.weaponSwap2 or tab.controls.weaponSwap1)
	if button and button.onClick then
		button.onClick()
	else
		tab.activeItemSet.useSecondWeaponSet = want
		tab:PopulateSlots()
		tab:AddUndoState()
		build.buildFlag = true
	end
	return true
end

-------------------------------------------------------------- gem commands

local function socketGroupAt(build, index)
	local tab = build.skillsTab
	local group = tab and tab.socketGroupList and tab.socketGroupList[tonumber(index) or 0]
	return tab, group
end

--- What every gem and group edit does once the change is made. PoB's own
--- controls all end this way: reprocess the group, record undo, recalculate.
local function commitGroup(tab, group, build)
	if group then
		pcall(tab.ProcessSocketGroup, tab, group)
	end
	tab:AddUndoState()
	build.buildFlag = true
	return true
end

--- Add a gem to a socket group, from its id in PoB's gem data.
---
--- The instance is built exactly as the gem select control builds a new
--- one, because the defaults are not arbitrary: a gem with no level or
--- enableGlobal flags is not the same gem to the calculation engine.
function commands.addGem(build, value)
	local tab, group = socketGroupAt(build, type(value) == "table" and value.group)
	if not group then
		return nil, "no socket group " .. tostring(type(value) == "table" and value.group)
	end
	local gemId = type(value) == "table" and value.gem
	local gemData = gemId and data.gems and data.gems[gemId]
	if not gemData then
		return nil, "no gem with id " .. tostring(gemId)
	end

	table.insert(group.gemList, {
		nameSpec = gemData.name,
		gemId = gemId,
		-- The tab's own defaults, which the user can change there.
		level = gemData.naturalMaxLevel or 1,
		quality = tab.defaultGemQuality or 0,
		enabled = true,
		enableGlobal1 = true,
		enableGlobal2 = true,
		count = 1,
		new = true,
		corrupted = false,
		corruptLevel = 0,
	})
	return commitGroup(tab, group, build)
end

--- Change one gem's level, quality, count or enabled flag.
---
--- Level is clamped to the gem's own natural maximum plus the usual five
--- levels of corruption and gear, rather than to a number chosen here;
--- quality to 23, which is PoB's own cap in the tab.
function commands.setGem(build, value)
	local tab, group = socketGroupAt(build, type(value) == "table" and value.group)
	local gem = group and group.gemList and group.gemList[tonumber(type(value) == "table" and value.gem) or 0]
	if not gem then
		return nil, "no such gem"
	end

	if value.level ~= nil then
		local ceiling = (gem.gemData and gem.gemData.naturalMaxLevel or 20) + 20
		gem.level = math.max(1, math.min(ceiling, math.floor(tonumber(value.level) or 1)))
	end
	if value.quality ~= nil then
		gem.quality = math.max(0, math.min(23, math.floor(tonumber(value.quality) or 0)))
	end
	if value.count ~= nil then
		gem.count = math.max(1, math.floor(tonumber(value.count) or 1))
	end
	if value.enabled ~= nil then
		gem.enabled = value.enabled and true or false
	end
	return commitGroup(tab, group, build)
end

function commands.deleteGem(build, value)
	local tab, group = socketGroupAt(build, type(value) == "table" and value.group)
	local index = tonumber(type(value) == "table" and value.gem) or 0
	if not group or not group.gemList or not group.gemList[index] then
		return nil, "no such gem"
	end
	table.remove(group.gemList, index)
	return commitGroup(tab, group, build)
end

--- Add an empty socket group, as the list control's New button does.
function commands.addSocketGroup(build)
	local tab = build.skillsTab
	if not tab then return nil, "no skills tab" end
	table.insert(tab.socketGroupList, { label = "", enabled = true, gemList = {} })
	return commitGroup(tab, nil, build)
end

function commands.deleteSocketGroup(build, value)
	local tab, group = socketGroupAt(build, value)
	if not group then
		return nil, "no socket group " .. tostring(value)
	end
	-- Groups granted by an item or a passive are rebuilt on every pass, so
	-- deleting one would only make it come back.
	if group.source then
		return nil, "that group comes from " .. tostring(group.source) .. " and cannot be deleted"
	end
	table.remove(tab.socketGroupList, tonumber(value))
	return commitGroup(tab, nil, build)
end

function commands.setSocketGroupEnabled(build, value)
	local tab, group = socketGroupAt(build, type(value) == "table" and value.group)
	if not group then return nil, "no such socket group" end
	group.enabled = (type(value) == "table" and value.enabled) and true or false
	return commitGroup(tab, group, build)
end

function commands.setSocketGroupFullDPS(build, value)
	local tab, group = socketGroupAt(build, type(value) == "table" and value.group)
	if not group then return nil, "no such socket group" end
	group.includeInFullDPS = (type(value) == "table" and value.fullDPS) and true or false
	return commitGroup(tab, group, build)
end

function commands.setSocketGroupLabel(build, value)
	local tab, group = socketGroupAt(build, type(value) == "table" and value.group)
	if not group then return nil, "no such socket group" end
	group.label = tostring(type(value) == "table" and value.label or "")
	return commitGroup(tab, group, build)
end

function commands.setSkillSet(build, value)
	local tab = build.skillsTab
	local id = tonumber(value)
	if not tab or not id or not (tab.skillSets and tab.skillSets[id]) then
		return nil, "no skill set with id " .. tostring(value)
	end
	tab:SetActiveSkillSet(id)
	tab:AddUndoState()
	build.buildFlag = true
	return true
end

----------------------------------------------------------- config commands

--- Set one configuration option.
---
--- The value is coerced to the option's declared type rather than trusted:
--- the input table is read by the calculation engine, and a "3" where it
--- expects 3 is the kind of thing that produces a wrong number rather than
--- an error. nil clears the option back to its default, which is what the
--- tab's own controls do with an empty field.
function commands.setConfig(build, value)
	local tab = build.configTab
	local varList = loadConfigOptions()
	local name = type(value) == "table" and value.var
	if not tab or not varList or type(name) ~= "string" then
		return nil, "expected { var = ..., value = ... }"
	end

	local varData
	for _, entry in ipairs(varList) do
		if entry.var == name then
			varData = entry
			break
		end
	end
	if not varData then
		return nil, "no configuration option called " .. name
	end

	local set = tab.configSets[tab.activeConfigSetId]
	local raw = value.value
	local coerced
	if raw == nil then
		coerced = nil
	elseif varData.type == "check" then
		coerced = raw and true or false
	elseif varData.type == "list" then
		-- The value has to be one the option offers; anything else would
		-- reach the engine as an unknown enum.
		for _, entry in ipairs(varData.list or {}) do
			if entry.val == raw then
				coerced = raw
				break
			end
		end
		if coerced == nil then
			return nil, tostring(raw) .. " is not an option for " .. name
		end
	elseif varData.type == "text" then
		coerced = tostring(raw)
	else
		coerced = tonumber(raw)
		if coerced == nil then
			return nil, tostring(raw) .. " is not a number"
		end
		if varData.type ~= "float" then
			coerced = math.floor(coerced)
		end
		-- "count" means a non-negative count; "integer" and
		-- "countAllowZero" are the ones that may go below one.
		if varData.type == "count" and coerced < 0 then
			coerced = 0
		end
	end

	set.input[name] = coerced
	tab:AddUndoState()
	tab:BuildModList()
	build.buildFlag = true
	return true
end

--- Reveal the options this build does not currently use.
function commands.setConfigShowAll(build, value)
	local tab = build.configTab
	if not tab then return nil, "no config tab" end
	-- Written out rather than `a and b or c`: with b false that idiom
	-- falls through to c, so passing { showAll = false } turned it on.
	local want = value
	if type(value) == "table" then
		want = value.showAll
	end
	tab.toggleConfigs = want and true or false
	return true
end

function commands.setConfigSet(build, value)
	local tab = build.configTab
	local id = tonumber(value)
	if not tab or not id or not (tab.configSets and tab.configSets[id]) then
		return nil, "no config set with id " .. tostring(value)
	end
	tab:SetActiveConfigSet(id)
	tab:AddUndoState()
	build.buildFlag = true
	return true
end

--- Edit one block of custom modifiers.
function commands.setCustomMods(build, value)
	local tab = build.configTab
	local set = tab and tab.configSets[tab.activeConfigSetId]
	local index = tonumber(type(value) == "table" and value.index) or 0
	local block = set and set.customModsList and set.customModsList[index]
	if not block then
		return nil, "no custom modifier block " .. tostring(index)
	end
	if value.text ~= nil then
		block.text = tostring(value.text)
	end
	if value.title ~= nil then
		block.title = tostring(value.title)
	end
	if value.enabled ~= nil then
		block.enabled = value.enabled and true or false
	end
	tab:AddUndoState()
	tab:BuildModList()
	build.buildFlag = true
	return true
end

function commands.addCustomModBlock(build)
	local tab = build.configTab
	local set = tab and tab.configSets[tab.activeConfigSetId]
	if not set then return nil, "no config set" end
	set.customModsList = set.customModsList or {}
	table.insert(set.customModsList, {
		title = "Group " .. (#set.customModsList + 1),
		enabled = true,
		text = "",
	})
	tab:AddUndoState()
	tab:BuildModList()
	build.buildFlag = true
	return true
end

--- Remove a block. PoB keeps one empty block rather than none, because the
--- tab has nowhere to type otherwise.
function commands.deleteCustomModBlock(build, value)
	local tab = build.configTab
	local set = tab and tab.configSets[tab.activeConfigSetId]
	local index = tonumber(value) or 0
	if not set or not set.customModsList or not set.customModsList[index] then
		return nil, "no custom modifier block " .. tostring(value)
	end
	table.remove(set.customModsList, index)
	if #set.customModsList == 0 then
		table.insert(set.customModsList, { title = "Default", enabled = true, text = "" })
	end
	tab:AddUndoState()
	tab:BuildModList()
	build.buildFlag = true
	return true
end

----------------------------------------------------------- build commands

--- The characters Windows will not take in a file name, which is also what
--- PoB's Save As box strips.
local function safeName(name)
	return (tostring(name or ""):gsub("[\\/:%*%?\"<>|%c]", "-"):gsub("^%s+", ""):gsub("%s+$", ""))
end

--- Save the open build to the file it came from.
function commands.saveBuild(build)
	if not build.dbFileName then
		return nil, "this build has never been saved; give it a name first"
	end
	local ok, err = pcall(build.SaveDBFile, build)
	if not ok then
		return nil, tostring(err)
	end
	return true
end

--- Save it under a new name, which is also how a new build first lands on
--- disk. Follows OpenSaveAsPopup: build the path from main.buildPath and
--- the chosen folder, set the three fields together, then write.
function commands.saveBuildAs(build, value)
	local name = safeName(type(value) == "table" and value.name)
	if name == "" then
		return nil, "a build needs a name"
	end
	local subPath = tostring(type(value) == "table" and value.folder or "")
	if subPath ~= "" and not subPath:match("/$") then
		subPath = subPath .. "/"
	end

	local path = main.buildPath .. subPath .. name .. ".xml"
	if not (type(value) == "table" and value.overwrite) then
		-- PoB's own box disables Save when the name is taken rather than
		-- asking; refusing with the reason is the same answer.
		local existing = io.open(path, "r")
		if existing then
			existing:close()
			return nil, "there is already a build called " .. name
		end
	end

	build.dbFileName = path
	build.buildName = name
	build.dbFileSubPath = subPath
	local ok, err = pcall(build.SaveDBFile, build)
	if not ok then
		return nil, tostring(err)
	end
	return true
end

--- Delete a build file.
---
--- Refuses the open build: PoB closes it first, and deleting the file out
--- from under a loaded build leaves the UI pointing at nothing.
function commands.deleteBuild(build, value)
	local path = type(value) == "table" and value.path or value
	if type(path) ~= "string" or path == "" then
		return nil, "expected { path = ... }"
	end
	-- Written as a comparison, not `not a == b`: that parses as
	-- `(not a) == b` and would let any path through.
	if path:sub(1, #main.buildPath) ~= main.buildPath then
		return nil, "that is not inside the builds folder"
	end
	if build and build.dbFileName == path then
		return nil, "that build is open; open another one first"
	end
	local existing = io.open(path, "r")
	if not existing then
		return nil, "there is no build at " .. path
	end
	existing:close()

	local ok, err = os.remove(path)
	if not ok then
		return nil, tostring(err)
	end
	return true
end

function commands.newBuildFolder(build, value)
	local name = safeName(type(value) == "table" and value.name)
	if name == "" then
		return nil, "a folder needs a name"
	end
	local subPath = tostring(type(value) == "table" and value.folder or "")
	if subPath ~= "" and not subPath:match("/$") then
		subPath = subPath .. "/"
	end
	local ok, err = MakeDir(main.buildPath .. subPath .. name)
	if not ok then
		return nil, tostring(err)
	end
	return true
end

------------------------------------------------------- character import

--- PoB's own four import checkboxes, and what it builds them as.
---
--- Each is read by the import methods as `controls.<name>.state`, so the
--- way to ask for a different import is to set them and call the method,
--- which is exactly what the desktop buttons do.
local IMPORT_BOXES = {
	{ key = "deleteJewels", control = "charImportTreeClearJewels", default = true },
	{ key = "deleteSkills", control = "charImportItemsClearSkills", default = true },
	{ key = "deleteEquipment", control = "charImportItemsClearItems", default = true },
	{ key = "ignoreWeaponSwap", control = "charImportItemsIgnoreWeaponSwap", default = false },
}

--- Set the elemental resistance penalty from PoB's own act estimate.
---
--- Working around a bug in PoB, which is why this is here at all.
--- `EstimatePlayerProgress` records its answer as a string: `build.Act` is
--- "Endgame" or "Act 5" (Build.lua:1124, the only place it is assigned).
--- The import then reads it expecting a number for the act case
--- (ImportTab.lua:992-1000): one branch handles the string "Endgame", the
--- other handles `type(Act) == "number"`, and "Act 5" is neither. So the
--- index never moves off the 7 it was initialised with, and every
--- character import lands on Endgame, -60% to all elemental resistances.
---
--- On a character who has just finished Act 4 that is thirty points of
--- resistance that are not missing in the game, which reads as the whole
--- calculation being wrong rather than as one dropdown.
---
--- Corrected here because `src/` stays unmodified. It reads PoB's own
--- estimate and drives PoB's own control, which is the gesture ImportTab
--- was making; only the parse is ours. `EstimatePlayerProgress` is run
--- first so this is right for an items-only import too, where PoB would
--- never have refreshed the estimate at all.
local function fixResistancePenalty(build)
	local controls = build and build.configTab and build.configTab.varControls
	local control = controls and controls["resistancePenalty"]
	if not control then
		return
	end

	pcall(build.EstimatePlayerProgress, build)

	local act = build.Act
	local index
	if act == "Endgame" then
		index = 7
	elseif type(act) == "string" then
		index = tonumber(act:match("^Act (%d+)$"))
	elseif type(act) == "number" then
		index = act
	end
	if not index then
		return
	end

	pcall(control.SetSel, control, math.min(7, math.max(1, math.floor(index))))
end

--- Set the resistance penalty from the act estimate, on its own.
---
--- Exposed as well as run on import, because a build imported before this
--- existed still carries the wrong value and re-importing to fix a
--- dropdown is a silly thing to have to do.
function commands.estimateResistancePenalty(build)
	local controls = build and build.configTab and build.configTab.varControls
	if not controls or not controls["resistancePenalty"] then
		return nil, "this engine has no resistance penalty control"
	end
	fixResistancePenalty(build)
	build.buildFlag = true
	return true
end

--- Import a character, the way the desktop tab's two buttons do.
---
--- Deliberately not `loadBuildFromJSON`, which is HeadlessWrapper's
--- convenience and opens a *new* build before importing into it. The
--- desktop imports into the build you already have, and that difference is
--- the whole point of having two buttons: importing a tree without
--- touching the items, or re-importing items after a respec, only means
--- anything if what is already there survives. A caller that wants a fresh
--- build says so by opening one first.
---
--- The checkboxes are always set rather than left alone, because a control
--- keeps whatever the last call gave it, and an import that quietly
--- depended on the previous one would be a bad thing to debug.
function commands.importCharacter(build, value)
	local tab = build and build.importTab
	if not tab or not tab.controls then
		return nil, "this engine has no import tab"
	end

	value = type(value) == "table" and value or {}
	local json = value.json
	if type(json) ~= "string" or json:match("^%s*$") then
		return nil, "expected { json = ... }"
	end

	local dkjson = require("dkjson")
	local decoded = dkjson.decode(json)
	if type(decoded) ~= "table" then
		return nil, "that is not JSON PoB can read"
	end
	-- The API wraps the character in an envelope. The import methods want
	-- what is inside it, and a caller holding either shape is reasonable.
	if type(decoded.character) == "table" then
		decoded = decoded.character
	end

	local tree = value.tree ~= false
	local items = value.items ~= false
	if not tree and not items then
		return nil, "nothing to import: ask for the tree, the items, or both"
	end

	-- Checked before anything is touched, because PoB's import deletes
	-- first and reads the payload second: `ImportItemsAndSkills` clears the
	-- equipment and the skill groups and only then reaches
	-- `ipairs(charData.equipment)`, so a payload missing that key leaves a
	-- gutted build behind a Lua error. Validating here turns that into
	-- nothing happening.
	if items then
		if type(decoded.equipment) ~= "table" then
			return nil, "that character has no equipment list, so there is nothing to import"
		end
		-- A character with no skills at all is a real thing, and PoB's own
		-- loop over this would rather have an empty table than a nil.
		if decoded.skills == nil then decoded.skills = {} end
	end
	if tree then
		if type(decoded.passives) ~= "table" then
			return nil, "that character has no passive data, so there is no tree to import"
		end
		if type(decoded.class) ~= "string" then
			return nil, "that character has no class, so the tree cannot be imported"
		end
		if type(decoded.passives.hashes) ~= "table" then
			return nil, "that character's passive data has no node list"
		end
		if decoded.jewels == nil then decoded.jewels = {} end
		-- PoB iterates these three without guarding them, and the game's
		-- own API omits them for a character that has none. Defaulting is
		-- the difference between importing a tree with no masteries and
		-- failing on a nil halfway through deleting the old one.
		if decoded.passives.specialisations == nil then decoded.passives.specialisations = {} end
		if decoded.passives.skill_overrides == nil then decoded.passives.skill_overrides = {} end
		if decoded.passives.jewel_data == nil then decoded.passives.jewel_data = {} end
		if decoded.passives.quest_stats == nil then decoded.passives.quest_stats = {} end
	end

	for _, box in ipairs(IMPORT_BOXES) do
		local control = tab.controls[box.control]
		-- Loudly, rather than skipping it: a missing control would mean
		-- the import quietly ignoring what was asked for, and PoB renaming
		-- one should break here and not somewhere further downstream.
		if not control then
			return nil, "this engine's import tab has no " .. box.control
		end
		local wanted = value[box.key]
		if wanted == nil then
			control.state = box.default
		else
			control.state = wanted and true or false
		end
	end

	-- Items first, then the tree, which is the order HeadlessWrapper uses
	-- and the one that works: both set the character level, and the tree's
	-- is the one PoB goes on to estimate quest progress from.
	if items then
		local ok, err = pcall(tab.ImportItemsAndSkills, tab, decoded)
		if not ok then
			return nil, "the items would not import: " .. tostring(err)
		end
	end
	if tree then
		local ok, err = pcall(tab.ImportPassiveTreeAndJewels, tab, decoded)
		if not ok then
			return nil, "the tree would not import: " .. tostring(err)
		end
	end

	fixResistancePenalty(build)
	build.buildFlag = true
	return true
end

--- Import a code over the build that is already open, keeping its file.
---
--- The difference from `POST /code/import` is the two arguments to Init:
--- that route goes through `loadBuildFromXML`, which opens an unsaved
--- build with a name derived from the code, and this keeps the current
--- file name and build name so a later save writes back to the same file.
--- They are PoB's own "Import to a new build" and "Import to this build",
--- and the desktop warns about this one because it erases what is there.
---
--- Shutdown first, as ImportTab does: Init on a live build leaves the old
--- tabs and their controls behind.
function commands.importCodeHere(build, value)
	local code = type(value) == "table" and value.code or value
	if type(code) ~= "string" or code:match("^%s*$") then
		return nil, "expected { code = ... }"
	end

	local detail = api.inspectCode(code)
	if not detail.valid then
		return nil, detail.error or "that code is not valid"
	end
	local xml, err = api.decodeCode(code)
	if not xml then
		return nil, tostring(err)
	end

	local fileName, buildName = build.dbFileName, build.buildName
	local ok, failure = pcall(function()
		build:Shutdown()
		build:Init(fileName, buildName, xml, false)
	end)
	if not ok then
		return nil, tostring(failure)
	end
	return true
end

--- PoB's "Export Support", which is a party setting rather than an export one.
---
--- The checkbox lives on the Import tab and writes `partyTab`, where the
--- calculator reads it: with it on, this build's own buffs are exported to
--- whoever imports it as a party member.
function commands.setExportBuffs(build, value)
	local party = build and build.partyTab
	if not party then
		return nil, "this engine has no party tab"
	end
	local wanted = value
	if type(value) == "table" then wanted = value.enabled end
	party.enableExportBuffs = wanted and true or false
	build.buildFlag = true
	return true
end

--------------------------------------------------------- compare commands

--- Load another build to compare against, from a code or a saved file.
---
--- CompareTab:ImportBuild builds a CompareEntry (PoB's own lightweight
--- build wrapper, which loads the XML, creates the tabs and runs the
--- calculation without any of the UI chrome) and refuses if the result
--- has no output, which is the check worth keeping.
function commands.addCompare(build, value)
	local tab = build.compareTab
	if not tab then
		return nil, "this engine has no compare tab"
	end

	local xml, label
	if type(value) == "table" and value.path then
		local file, ferr = io.open(value.path, "r")
		if not file then
			return nil, "cannot open: " .. tostring(ferr)
		end
		xml = file:read("*a")
		file:close()
		-- Slashes normalised first so the name match needs no character
		-- class containing a backslash, which is a reliable way to get the
		-- escaping wrong in a Lua string inside a Lua pattern.
		local normalised = tostring(value.path):gsub("\\", "/")
		label = normalised:match("([^/]+)%.xml$") or "Build"
	elseif type(value) == "table" and value.code then
		local decoded, err = api.decodeCode(value.code)
		if not decoded then
			return nil, tostring(err)
		end
		xml = decoded
		local detail = api.inspectCode(value.code)
		label = detail.valid and (detail.ascendancy or detail.class) or "Imported build"
	else
		return nil, "expected { code = ... } or { path = ... }"
	end

	if not tab:ImportBuild(xml, label) then
		return nil, "that build loaded but produced no output"
	end
	-- UpdateBuildSelector touches the tab's own controls, which are not
	-- laid out headless; the import itself has already happened.
	pcall(tab.UpdateBuildSelector, tab)
	return true
end

function commands.setCompare(build, value)
	local tab = build.compareTab
	local index = tonumber(value) or 0
	if not tab or not tab.compareEntries or not tab.compareEntries[index] then
		return nil, "no comparison build " .. tostring(value)
	end
	tab.activeCompareIndex = index
	return true
end

function commands.removeCompare(build, value)
	local tab = build.compareTab
	local index = tonumber(value) or 0
	if not tab or not tab.compareEntries or not tab.compareEntries[index] then
		return nil, "no comparison build " .. tostring(value)
	end
	tab:RemoveBuild(index)
	pcall(tab.UpdateBuildSelector, tab)
	return true
end

------------------------------------------------------- item edit commands

--- Everything an item edit ends with. Mutating the item is the save: the
--- table in itemsTab.items is the one the build holds, so there is nothing
--- to add back. PopulateSlots is what notices if the item stopped fitting
--- the slot it was in.
local function commitItem(tab, item, build)
	local ok, err = pcall(item.BuildAndParseRaw, item)
	if not ok then
		return nil, "that item would not parse: " .. tostring(err)
	end
	tab:PopulateSlots()
	tab:AddUndoState()
	build.buildFlag = true
	return true
end

local function itemFor(build, value)
	local tab = build.itemsTab
	local id = tonumber(type(value) == "table" and value.item) or 0
	return tab, tab and tab.items and tab.items[id]
end

--- Replace an item's text and reparse it.
---
--- ParseRaw on the item already in the build keeps its id, so whatever it
--- was equipped in stays equipped, unless the new text is a different
--- base, in which case PopulateSlots takes it out, which is the engine's
--- call and the right one.
function commands.setItemText(build, value)
	local tab, item = itemFor(build, value)
	if not item then
		return nil, "no item with id " .. tostring(type(value) == "table" and value.item)
	end
	local text = type(value) == "table" and value.text
	if type(text) ~= "string" or text:match("^%s*$") then
		return nil, "expected { item = ..., text = ... }"
	end

	-- Parsed into a throwaway first. ParseRaw on the live item would leave
	-- it half-rewritten if the text turns out not to be an item, and the
	-- build holds that table.
	local probe = new("Item"):Item(text)
	if not probe.base then
		return nil, "that is not an item PoB recognises"
	end

	local ok, err = pcall(item.ParseRaw, item, text)
	if not ok then
		return nil, "that item would not parse: " .. tostring(err)
	end
	tab:PopulateSlots()
	tab:AddUndoState()
	build.buildFlag = true
	return true
end

--- Move one modifier's roll between its bounds. 0 is the lowest the line
--- can roll, 1 the highest; PoB's own slider is the same number.
function commands.setItemRange(build, value)
	local tab, item = itemFor(build, value)
	local index = tonumber(type(value) == "table" and value.line) or 0
	local entry = item and item.rangeLineList and item.rangeLineList[index]
	if not entry then
		return nil, "no adjustable modifier at that position"
	end
	local range = tonumber(type(value) == "table" and value.range)
	if not range then
		return nil, "expected { item = ..., line = ..., range = 0..1 }"
	end
	entry.range = math.max(0, math.min(1, range))
	return commitItem(tab, item, build)
end

function commands.setItemVariant(build, value)
	local tab, item = itemFor(build, value)
	if not item then
		return nil, "no such item"
	end
	if item.HasVariantGroups and item:HasVariantGroups() then
		-- Grouped variants are several independent choices with their own
		-- ids; setting `variant` would pick the wrong thing silently.
		return nil, "that item uses variant groups, which this editor does not set yet"
	end
	local index = tonumber(type(value) == "table" and value.variant) or 0
	if not (item.variantList and item.variantList[index]) then
		return nil, "no variant " .. tostring(index)
	end
	item.variant = index
	return commitItem(tab, item, build)
end

--- Press one of the open dialog's buttons.
---
--- Through the control's own Click, which checks IsShown and IsEnabled
--- first, so a button the dialog has greyed out stays greyed out, and
--- the handler behind it is PoB's, closing the popup and doing whatever it
--- was going to do.
function commands.answerPopup(build, value)
	local popup = main and main.popups and main.popups[1]
	if not popup then
		return nil, "no dialog is open"
	end
	local key = type(value) == "table" and value.button or value
	-- A confirm dialog's buttons are not all named: the three-button
	-- layout t_inserts two of them, so their keys are integers while
	-- `confirm` is a string. They come out of JSON as strings either way,
	-- and in Lua t[4] and t["4"] are different keys, which looks exactly
	-- like a button that quietly does nothing.
	local controls = popup.controls or {}
	local control = (type(key) == "string" or type(key) == "number")
		and (controls[key] or controls[tonumber(key) or false])
	if not control or control._className ~= "ButtonControl" then
		return nil, "this dialog has no button called " .. tostring(key)
	end

	local before = #main.popups
	local ok, err = pcall(control.Click, control)
	if not ok then
		return nil, tostring(err)
	end
	-- Click does nothing at all when the button is disabled, which would
	-- otherwise look like the answer was accepted and ignored.
	if #main.popups == before and main.popups[1] == popup then
		return nil, "that button is not available right now"
	end
	return true
end

function commands.dismissPopup(build)
	if main and main.popups and main.popups[1] and main.ClosePopup then
		main:ClosePopup()
		return true
	end
	return nil, "no popup open"
end

--- Run one command. Returns ok, err.
function api.apply(build, action, value)
	if not build then return nil, "no build loaded" end
	local fn = commands[action]
	if not fn then return nil, "unknown action: " .. tostring(action) end
	return fn(build, value)
end

function api.commandNames()
	local names = {}
	for name in pairs(commands) do names[#names + 1] = name end
	table.sort(names)
	return names
end

return api
