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

-- PoB labels carry inline colour codes (^7, ^xRRGGBB). They are presentation
-- for a renderer that no longer exists on this path.
local function strip(s)
	return (tostring(s or ""):gsub("%^x%x%x%x%x%x%x", ""):gsub("%^%d", ""))
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

	-- PoB answers some commands with a modal rather than by doing the thing --
	-- changing class with an allocated tree, Save As, Back with unsaved work.
	-- A headless bridge that ignored this would look like it had hung, so the
	-- popup travels with the state and the UI can say what is being waited on.
	local popup = nil
	if main and main.popups and main.popups[1] then
		-- Only the title travels. A popup's controls are a keyed table, not an
		-- array, and its buttons mean nothing without the dialog drawn around
		-- them; reporting the title is enough to say what is being waited on.
		popup = { title = strip(main.popups[1].title or "Waiting") }
	end

	return {
		ready = true,
		buildName = build.buildName or "",
		unsaved = build.unsaved and true or false,
		dbFileName = build.dbFileName or nil,

		characterLevel = build.characterLevel or 1,
		levelAutoMode = build.characterLevelAutoMode and true or false,

		classId = curClassId or 0,
		classes = classes,
		ascendClassId = (spec and spec.curAscendClassId) or 0,
		ascendancies = ascendancies,

		loadoutId = loadoutId,
		loadouts = loadouts,

		points = points,
		popup = popup,
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
