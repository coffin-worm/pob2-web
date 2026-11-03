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

-- Some of those colours mean something -- a warning, a damage type, an
-- over-cap resistance -- so they are classified into names rather than
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

------------------------------------------------------------ the calcs tab

--- The Calcs tab: 30 sections, 1081 defined rows, of which the active skill
--- decides a few hundred.
---
--- Visibility and formatting are both PoB's. A row is shown when
--- CalcsTab:CheckFlag passes it against the active skill's flags, and its
--- value comes from formatCalcStr (Modules/CalcFormat.lua) resolving a
--- template like "{2:output:Speed}" against the actor.
---
--- UpdateSize is skipped deliberately. It is the layout pass -- positions,
--- heights, collapse state -- and the only thing here that depends on it is
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

	for _, section in ipairs(tab.sectionList) do
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

			for _, subSec in ipairs(section.subSection or {}) do
				local rows = asArray({})

				for _, rowData in ipairs(subSec.data or {}) do
					if tab:CheckFlag(rowData, actor) then
						-- A column slot is kept even when it has nothing in
						-- it. PoB's rows carry empty placeholders -- "Added
						-- Min" starts with a bare {} because it has no "All
						-- Types" figure -- and UpdateSize gives every slot an
						-- x offset whether or not it has a format. Dropping
						-- the empties instead of emptying them shifts the
						-- whole row left and silently misaligns the matrix
						-- against its own header.
						local values, tones = asArray({}), asArray({})
						local hasValue, hasTone = false, false
						for _, colData in ipairs(rowData) do
							local text, tone = "", "normal"
							if colData.format and tab:CheckFlag(colData, actor) then
								text = format(colData.format, colData) or ""
								-- The damage-type colours live on the header
								-- row's format strings.
								tone = toneOf(colData.format)
							end
							values[#values + 1] = text
							tones[#tones + 1] = tone
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
