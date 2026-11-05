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
		-- Incremented by buildMode:OnFrame on every recalculation. The Calcs
		-- tab is expensive enough that it is fetched when this moves rather
		-- than on a timer.
		outputRevision = build.outputRevision or 0,
		dbFileName = build.dbFileName or nil,

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
function api.treeAlloc(build)
	local spec = build and build.spec
	if not spec or not spec.nodes then
		return { ready = false }
	end

	local allocated, reachable = asArray({}), asArray({})
	for id, node in pairs(spec.nodes) do
		if node.alloc then
			allocated[#allocated + 1] = id
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

--- Search PoB's unique and rare databases.
---
--- main.uniqueDB.list is keyed by name and holds a parsed Item each, built
--- once at startup from Data/Uniques. Only a name match is offered: the real
--- tab filters by league, slot, obtainability and six other axes, and all of
--- that is UI state that would have to live somewhere on this side.
function api.itemSearch(query, limit)
	local needle = tostring(query or ""):lower()
	local max = tonumber(limit) or 40
	if #needle < 2 or not main then
		return { ready = true, results = asArray({}), truncated = false }
	end

	local results, total = asArray({}), 0
	for _, db in ipairs({ main.uniqueDB, main.rareDB }) do
		for name, item in pairs(db and db.list or {}) do
			if tostring(name):lower():find(needle, 1, true) and item.base then
				total = total + 1
				if #results < max then
					local ok, primary = pcall(item.GetPrimarySlot, item)
					results[#results + 1] = {
						name = name,
						base = strip(item.baseName or ""),
						rarity = item.rarity or "NORMAL",
						slot = ok and primary or nil,
					}
				end
			end
		end
	end

	table.sort(results, function(a, b) return a.name < b.name end)
	return { ready = true, results = results, total = total, truncated = total > #results }
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
		skills[#skills + 1] = strip((effect and effect.name) or "?")
	end

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

--- What a gem being off, or at 20 quality, would do.
---
--- Unlike the tree and the item bench, the calculator has no argument for
--- a gem, so these are the apply-and-revert shape: PoB's own tooltips
--- write the field, recalculate and write it back, and so does this.
function api.gemWhatIf(build, groupIndex, gemIndex, subject)
	local tab = build and build.skillsTab
	local group = tab and tab.socketGroupList and tab.socketGroupList[tonumber(groupIndex) or 0]
	local gem = group and group.gemList and group.gemList[tonumber(gemIndex) or 0]
	if not gem then
		return {
			ready = false,
			error = "no gem " .. tostring(gemIndex) .. " in group " .. tostring(groupIndex),
		}
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

--- Add an item from its in-game text, as pasting into PoB does.
---
--- CreateDisplayItemFromRaw leaves displayItem nil when the base is not one
--- PoB knows, which is the only failure worth reporting: everything else it
--- parses leniently and flags as unsupported on the item itself.
function commands.addItemText(build, value)
	local tab = build.itemsTab
	local raw = type(value) == "table" and value.text or value
	if type(raw) ~= "string" or raw:match("^%s*$") then
		return nil, "expected { text = ... }"
	end

	tab:CreateDisplayItemFromRaw(raw, true)
	if not tab.displayItem then
		return nil, "that is not an item PoB recognises"
	end
	tab:AddDisplayItem()
	return true
end

--- Put pasted text on the bench without equipping it.
---
--- The same CreateDisplayItemFromRaw addItemText makes; the difference is
--- that this one stops there. `displayItem` is where the desktop tab keeps
--- the item being worked on, and leaving it there is what gives
--- /item/staged something to answer about.
function commands.stageItemText(build, value)
	local tab = build.itemsTab
	local raw = type(value) == "table" and value.text or value
	if type(raw) ~= "string" or raw:match("^%s*$") then
		return nil, "expected { text = ... }"
	end

	tab:CreateDisplayItemFromRaw(raw, true)
	if not tab.displayItem then
		return nil, "that is not an item PoB recognises"
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
