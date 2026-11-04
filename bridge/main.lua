-- The dev host for the bridge.
--
-- This is the throwaway file. LOVE is here only because lovec.exe is a
-- LuaJIT 2.1 host that is already installed and already proven to load PoB's
-- native DLLs; nothing about the bridge depends on it. api.lua and server.lua
-- have no idea it exists, so the shipping host (the existing exe, or Tauri
-- with mlua) replaces this file and keeps the other two.
--
-- Normally started by the web dev server (web/plugins/pob-bridge.ts), which
-- spawns it, waits for the ready line and proxies to it. To run it by hand,
-- set the working directory to src/ first, because HeadlessWrapper.lua
-- resolves _SimpleGraphic.def.lua and Launch.lua relative to the cwd:
--
--   cd C:\dev\pob2\src
--   "C:\Program Files\LOVE\lovec.exe" C:\dev\pob2\bridge
--
-- POB_SRC, POB_RUNTIME, POB_BRIDGE_DIR and POB_BRIDGE_PORT override the
-- defaults below.

--- A directory from the environment, with either slash and a guaranteed
--- trailing one, since every use here concatenates a file name onto it.
local function envDir(name, fallback)
	local value = os.getenv(name)
	if not value or value == "" then
		return fallback
	end
	value = value:gsub("\\", "/")
	return value:match("/$") and value or value .. "/"
end

local POB_SRC = envDir("POB_SRC", "C:/dev/pob2/src/")
local POB_RUNTIME = envDir("POB_RUNTIME", "C:/dev/pob2/runtime/")
local POB_BRIDGE = envDir("POB_BRIDGE_DIR", "C:/dev/pob2/bridge/")

-- A port given explicitly is the only one tried: when the caller picked it,
-- quietly moving to another one strands whoever is waiting on it.
local requestedPort = tonumber(os.getenv("POB_BRIDGE_PORT"))
local PORTS = requestedPort and { requestedPort } or { 49090, 49091, 49092 }
local TICK = 1 / 30

local function log(fmt, ...)
	io.stdout:write(string.format("[bridge] " .. fmt .. "\n", ...))
	io.stdout:flush()
end

local api, server
local booted, bootErr = false, nil
-- File-local, not a global: this shares a Lua state with the whole of PoB.
local frameCount = 0

------------------------------------------------------------------- the boot

local function boot()
	package.path = table.concat({
		POB_RUNTIME .. "lua/?.lua",
		POB_RUNTIME .. "lua/?/init.lua",
		POB_SRC .. "?.lua",
		package.path,
	}, ";")
	-- PoB's own C modules, LuaJIT 5.1 ABI like LOVE's own.
	package.cpath = POB_RUNTIME .. "?.dll;" .. package.cpath

	-- Modules/Main.lua:64 treats arg[1] as a build URL to download, and LOVE
	-- puts the game directory there. Left alone, PoB tries to fetch
	-- "C:/dev/pob2/bridge" from a build site, names the build after the
	-- failure message, and skips creating its own initial build.
	_G.arg = {}

	-- HeadlessWrapper resolves these relative to the cwd, so fail loudly here
	-- rather than with a confusing error from inside PoB.
	local probe = io.open("_SimpleGraphic.def.lua", "r")
	if not probe then
		error("working directory must be " .. POB_SRC .. " (see the header of this file)")
	end
	probe:close()

	-- HeadlessWrapper blocks on io.read when startup fails, which would hang a
	-- windowless process with nobody to type at it. Neutralised for the load;
	-- promptMsg is reported below instead.
	local realRead = io.read
	io.read = function() return nil end

	local ok, err = pcall(dofile, POB_SRC .. "HeadlessWrapper.lua")

	io.read = realRead
	if not ok then
		error(err)
	end

	if __mainObject__ and __mainObject__.promptMsg then
		error("PoB startup: " .. tostring(__mainObject__.promptMsg))
	end
end

--- The live buildMode table, or nil when no build is open.
---
--- Readiness is tested by the presence of an initialised control rather than
--- by a mode flag, because main.modes.BUILD is a persistent table that exists
--- long before a build has been opened into it.
local function currentBuild()
	local mode = main and main.modes and main.modes["BUILD"]
	if mode and mode.controls and mode.controls.classDrop then
		return mode
	end
	return nil
end

--- PoB catches errors inside its own frame handler and records them instead
--- of crashing, so a build whose calculations have died looks from outside
--- exactly like one that is merely empty. Without this, the UI would show a
--- blank sidebar and no reason for it.
local function engineError()
	local msg = __mainObject__ and __mainObject__.promptMsg
	if not msg then return nil end
	-- The message carries colour codes and the key hints for a dialog that
	-- does not exist here; keep the first line, which is the actual error.
	msg = tostring(msg):gsub("%^x%x%x%x%x%x%x", ""):gsub("%^%d", "")
	return (msg:gsub("^%s*Error:%s*", ""):match("^%s*(.-)%s*$"))
end

--- PoB settles a change over frames: a command raises buildFlag, and the
--- recalculation and the point display happen in the next OnFrame. Commands
--- therefore tick before answering, so the state returned is the state after
--- the change rather than the one before it.
local function settle(frames)
	for _ = 1, frames or 2 do
		runCallback("OnFrame")
	end
end

------------------------------------------------------------------- routing

local routes = {}

routes["GET /health"] = function()
	local build = currentBuild()
	return 200, {
		ok = true,
		booted = booted,
		error = bootErr and tostring(bootErr) or nil,
		buildOpen = build ~= nil,
		commands = api.commandNames(),

		-- PoB catches errors inside its own frame handler and surfaces them as
		-- a prompt rather than crashing, so a silently dead build looks
		-- exactly like a working one from outside. These say which it is.
		frames = frameCount,
		promptMsg = __mainObject__ and __mainObject__.promptMsg or nil,
		buildFlag = build and build.buildFlag or false,
		statLines = build and build.controls.statBox and #build.controls.statBox.list or -1,
	}
end

routes["GET /state"] = function()
	local snapshot = api.snapshot(currentBuild())
	snapshot.engineError = engineError()
	return 200, snapshot
end

--- Clear a recorded engine error. PoB's own dialog offers Enter to dismiss,
--- F4 for the build list and F5 to restart; this is the first of those. The
--- build is usually still broken afterwards, so the UI offers a new build
--- alongside it rather than implying this is a repair.
routes["POST /engine/dismiss"] = function()
	if __mainObject__ then __mainObject__.promptMsg = nil end
	return 200, { ok = true }
end

--- The sidebar is its own route rather than part of /state: it is an order of
--- magnitude more data, and the two are polled by different parts of the UI.
routes["GET /stats"] = function()
	local stats = api.stats(currentBuild())
	stats.engineError = engineError()
	return 200, stats
end

--- The tree's geometry. Fetched once: it only changes with the tree version.
routes["GET /tree"] = function()
	local started = os.clock()
	local tree = api.tree(currentBuild())
	tree.buildMs = math.floor((os.clock() - started) * 1000 + 0.5)
	return 200, tree
end

--- What is allocated on it. Small, and changes on every click.
routes["GET /tree/alloc"] = function()
	return 200, api.treeAlloc(currentBuild())
end

--- The Calcs tab. Much the most expensive route: it runs CheckFlag over a
--- thousand rows and formats every one that survives, so the UI fetches it
--- on demand rather than on the 1s poll the other two use.
--- The route a click on one node would allocate, and what it would cost.
routes["GET /tree/path"] = function(_, query)
	return 200, api.treePath(currentBuild(), query.node)
end

routes["GET /calcs"] = function()
	local started = os.clock()
	local calcs = api.calcs(currentBuild())
	calcs.engineError = engineError()
	calcs.buildMs = math.floor((os.clock() - started) * 1000 + 0.5)
	return 200, calcs
end

--- The items screen: slots, the item list and the item sets.
routes["GET /items"] = function()
	local started = os.clock()
	local items = api.items(currentBuild())
	items.engineError = engineError()
	items.buildMs = math.floor((os.clock() - started) * 1000 + 0.5)
	return 200, items
end

--- One item as PoB would draw it. Given ?slot= it also carries the
--- "Equipping this item will..." comparison, which is a full recalculation
--- against that slot, so it is a route of its own, fetched on demand.
routes["GET /item"] = function(_, query)
	local started = os.clock()
	local detail = api.itemDetail(currentBuild(), query.id, query.slot)
	detail.buildMs = math.floor((os.clock() - started) * 1000 + 0.5)
	return 200, detail
end

--- What is editable about one item: its text, its modifier rolls and its
--- variant. The item's appearance comes from /item, which is PoB's own
--- tooltip and already knows how to draw the result.
routes["GET /item/edit"] = function(_, query)
	return 200, api.itemEdit(currentBuild(), query.id)
end

--- PoB's unique and rare databases, by name.
routes["GET /items/search"] = function(_, query)
	return 200, api.itemSearch(query.q, query.limit)
end

--- The skills screen. `group` selects the socket group to expand into its
--- gem list; without it only the group list comes back.
routes["GET /skills"] = function(_, query)
	local started = os.clock()
	local skills = api.skills(currentBuild(), query.group)
	skills.engineError = engineError()
	skills.buildMs = math.floor((os.clock() - started) * 1000 + 0.5)
	return 200, skills
end

--- What a socket group actually does, as PoB describes it.
routes["GET /skills/group"] = function(_, query)
	local started = os.clock()
	local detail = api.socketGroupDetail(currentBuild(), query.index)
	detail.buildMs = math.floor((os.clock() - started) * 1000 + 0.5)
	return 200, detail
end

--- One gem as PoB would draw it, at its current level and quality.
routes["GET /gem"] = function(_, query)
	local started = os.clock()
	local detail = api.gemDetail(currentBuild(), query.group, query.gem)
	detail.buildMs = math.floor((os.clock() - started) * 1000 + 0.5)
	return 200, detail
end

--- Every gem the game has, by name.
routes["GET /gems/search"] = function(_, query)
	return 200, api.gemSearch(query.q, query.limit)
end

--- The configuration tab: only the options this build actually uses.
routes["GET /config"] = function()
	local started = os.clock()
	local config = api.config(currentBuild())
	config.engineError = engineError()
	config.buildMs = math.floor((os.clock() - started) * 1000 + 0.5)
	return 200, config
end

--- What flipping one configuration option would do, without doing it.
routes["GET /config/whatif"] = function(_, query)
	local started = os.clock()
	local value = query.value
	if value == "true" then value = true elseif value == "false" then value = false
	elseif value ~= nil and tonumber(value) then value = tonumber(value) end
	local result = api.configWhatIf(currentBuild(), query.var, value)
	result.buildMs = math.floor((os.clock() - started) * 1000 + 0.5)
	return 200, result
end

--- The same for a socket group.
routes["GET /skills/whatif"] = function(_, query)
	local started = os.clock()
	local result = api.socketGroupWhatIf(currentBuild(), query.group)
	result.buildMs = math.floor((os.clock() - started) * 1000 + 0.5)
	return 200, result
end

routes["POST /action"] = function(payload)
	if type(payload) ~= "table" or not payload.action then
		return 400, { error = "expected { action = ..., value = ... }" }
	end
	local build = currentBuild()
	if not build then
		return 409, { error = "no build open" }
	end

	local ok, err = api.apply(build, payload.action, payload.value)
	if not ok then
		return 400, { error = tostring(err), state = api.snapshot(build) }
	end
	settle(2)
	return 200, api.snapshot(currentBuild())
end

routes["POST /build/new"] = function()
	newBuild()
	settle(2)
	return 200, api.snapshot(currentBuild())
end

routes["POST /build/open"] = function(payload)
	local path = type(payload) == "table" and payload.path
	if not path then
		return 400, { error = "expected { path = ... }" }
	end
	local file, ferr = io.open(path, "r")
	if not file then
		return 400, { error = "cannot open: " .. tostring(ferr) }
	end
	local xml = file:read("*a")
	file:close()

	local name = tostring(path):match("([^/\\]+)%.xml$") or "Imported build"
	-- "~~temp~~" is reserved: Build.lua:345 deletes the file behind a build
	-- with that name, and without a real dbFileName os.remove gets a
	-- boolean and the build mode dies inside PoB's own error handler.
	if name == "~~temp~~" then
		name = "Imported build"
	end
	-- SetMode directly rather than HeadlessWrapper's loadBuildFromXML,
	-- which passes `false` for the file name. A build loaded that way has
	-- its contents but no file behind it, so Save has nothing to write to
	-- and the build list cannot tell which of its entries is the open one.
	-- The path is what makes this an opened file rather than pasted text.
	__mainObject__.main:SetMode("BUILD", path, name, xml)
	runCallback("OnFrame")
	settle(3)
	return 200, api.snapshot(currentBuild())
end

--- The current build against the active comparison, stat by stat.
routes["GET /compare"] = function()
	local started = os.clock()
	local compare = api.compare(currentBuild())
	compare.buildMs = math.floor((os.clock() - started) * 1000 + 0.5)
	return 200, compare
end

--- The builds folder, as PoB's own scanner sees it.
routes["GET /builds"] = function(_, query)
	local started = os.clock()
	local builds = api.builds(currentBuild(), query.sort)
	builds.buildMs = math.floor((os.clock() - started) * 1000 + 0.5)
	return 200, builds
end

--- Where PoB keeps the user's builds, so the UI can offer something real to
--- open without the path being hardcoded on the web side.
--- What a build code contains, without importing it. Decode only: a link
--- pasted here has its code read out of it, never fetched.
routes["GET /code/inspect"] = function(_, query)
	return 200, api.inspectCode(query.code)
end

--- The current build as a code, exactly as the desktop app's Export does.
routes["GET /code"] = function()
	return 200, api.buildCode(currentBuild())
end

--- Replace the open build with one decoded from a code.
routes["POST /code/import"] = function(payload)
	local code = type(payload) == "table" and payload.code
	local detail = api.inspectCode(code)
	if not detail.valid then
		return 400, { error = detail.error or "that code is not valid" }
	end

	local xml, err = api.decodeCode(code)
	if not xml then
		return 400, { error = tostring(err) }
	end

	-- Named for what it is, since a code carries no file name and
	-- "Imported build" tells you nothing once you have two of them.
	local name = detail.ascendancy or detail.class or "Imported build"
	loadBuildFromXML(xml, name)
	settle(4)
	return 200, api.snapshot(currentBuild())
end

--- Import a character from the game's API response.
---
--- The response arrives either pasted by hand or from the dev server's
--- /poe/character, and in both cases it is whatever GGG sent, which wraps
--- the character in a `character` key. PoB's own import path unwraps that
--- (`ImportTab.lua:811`, `fullCharData = fullCharData.character`) but
--- HeadlessWrapper's loadBuildFromJSON does not: it hands the top level
--- straight to the importers, which want `.equipment` and `.passives` on it.
--- Fed the envelope, the import dies on a nil index and reports only that
--- the JSON was not understood.
---
--- So the envelope is opened here if it is there. An already-unwrapped
--- object is passed through untouched rather than re-encoded, which keeps
--- the path that already worked byte-for-byte what it was.
routes["POST /code/character"] = function(payload)
	local json = type(payload) == "table" and payload.json
	if type(json) ~= "string" or json:match("^%s*$") then
		return 400, { error = "expected { json = ... }" }
	end

	local dkjson = require("dkjson")
	local decoded = dkjson.decode(json)
	if type(decoded) == "table" and type(decoded.character) == "table" then
		json = dkjson.encode(decoded.character)
	end

	local ok, err = pcall(loadBuildFromJSON, json)
	if not ok then
		return 400, { error = "that is not a character export PoB understands: " .. tostring(err) }
	end
	settle(4)
	return 200, api.snapshot(currentBuild())
end

routes["GET /paths"] = function()
	return 200, {
		buildPath = main and main.buildPath or nil,
		userPath = main and main.userPath or nil,
		scriptPath = GetScriptPath and GetScriptPath() or nil,
	}
end

--- Percent-decoding, because item names carry spaces and apostrophes.
local function urlDecode(text)
	return (tostring(text or ""):gsub("+", " "):gsub("%%(%x%x)", function(hex)
		return string.char(tonumber(hex, 16))
	end))
end

local function handler(method, path, payload)
	local route, rest = path:match("^([^?]*)%??(.*)$")
	local fn = routes[method .. " " .. (route or path)]
	if not fn then
		return 404, { error = "no route for " .. method .. " " .. path }
	end
	local query = {}
	for key, value in tostring(rest or ""):gmatch("([^&=?]+)=([^&]*)") do
		query[urlDecode(key)] = urlDecode(value)
	end
	return fn(payload, query)
end

------------------------------------------------------------- love callbacks

function love.load()
	local ok, err = pcall(boot)
	booted, bootErr = ok, err
	if not ok then
		log("boot FAILED: %s", tostring(err))
	else
		log("PoB booted headless")
	end

	-- HeadlessWrapper stubs Deflate and Inflate to return "", with a TODO
	-- asking for FFI bindings to the zlib PoB already ships. Build codes
	-- are base64 of deflated XML, so without these, importing one produces
	-- an empty document and a build that silently does not load.
	--
	-- Installed here rather than by editing the stub, so src/ stays
	-- untouched. Only a stub is replaced: a host that provides real ones
	-- keeps them.
	local stubbed = type(Inflate) == "function" and Inflate("probe") == ""
	local zlib, zerr = dofile(POB_BRIDGE .. "zlib.lua").install(POB_RUNTIME, stubbed)
	if zlib then
		log("zlib %s bound%s", zlib.version, stubbed and " over the headless stubs" or "")
	else
		log("zlib NOT available (%s); build codes will not work", tostring(zerr))
	end

	-- The filesystem is stubbed too, and unlike zlib it is read during
	-- startup: main:Init asks GetUserPath() for where the builds live, and
	-- gets "". So the real calls go in and then PoB is told to redo that
	-- decision through its own ChangeUserPath, which creates the folders
	-- and reloads settings from them.
	--
	-- ignoreBuild, because the build already open is not what this is
	-- about and reloading settings should not disturb it.
	local fsStubbed = type(NewFileSearch) == "function" and NewFileSearch("*") == nil
	local okFs, fs = pcall(function()
		return dofile(POB_BRIDGE .. "fs.lua").install(fsStubbed)
	end)
	if okFs and fs then
		local userPath = fs.userPath()
		if userPath and main and main.ChangeUserPath then
			local target = userPath .. "/Path of Building (PoE2)/"
			local okPath, perr = pcall(main.ChangeUserPath, main, target, true)
			if okPath then
				log("builds at %s", main.buildPath)
			else
				log("could not set the user path: %s", tostring(perr))
			end
		end
	else
		log("filesystem NOT available (%s); the build list will be empty", tostring(fs))
	end

	api = dofile(POB_BRIDGE .. "api.lua")

	local Server = dofile(POB_BRIDGE .. "server.lua")
	local srv, serr = Server.new({ ports = PORTS, handler = handler, log = log })
	if not srv then
		log("server FAILED: %s", tostring(serr))
		love.event.quit(1)
		return
	end
	server = srv
	log("listening on http://127.0.0.1:%d", server.port)
	log("  GET /health /state /stats /calcs /paths")
	log("  GET /tree /tree/alloc   GET /items /item /items/search")
	log("  GET /skills /skills/group /gem /gems/search   GET /config")
	log("  GET /config/whatif /skills/whatif")
	log("  GET /code /code/inspect   POST /code/import /code/character")
	log("  GET /builds /compare")
	log("  POST /action  POST /build/new  POST /build/open")
end

-- LOVE's default run loop assumes a window. This one does not.
function love.run()
	if love.load then love.load() end
	if love.timer then love.timer.step() end

	return function()
		if love.event then
			love.event.pump()
			for name, a in love.event.poll() do
				if name == "quit" then
					if server then server:close() end
					return a or 0
				end
			end
		end

		if booted then
			-- A frame of PoB, then a chance to answer anyone waiting.
			runCallback("OnFrame")
			frameCount = frameCount + 1
		end
		if server then
			server:poll()
		end

		if love.timer then love.timer.sleep(TICK) end
	end
end
