-- The dev host for the bridge.
--
-- This is the throwaway file. LOVE is here only because lovec.exe is a
-- LuaJIT 2.1 host that is already installed and already proven to load PoB's
-- native DLLs; nothing about the bridge depends on it. api.lua and server.lua
-- have no idea it exists, so the shipping host (the existing exe, or Tauri
-- with mlua) replaces this file and keeps the other two.
--
-- Run it with the working directory set to src/, because HeadlessWrapper.lua
-- resolves _SimpleGraphic.def.lua and Launch.lua relative to the cwd:
--
--   cd C:\dev\pob2\src
--   "C:\Program Files\LOVE\lovec.exe" C:\dev\pob2\bridge

local POB_SRC = "C:/dev/pob2/src/"
local POB_RUNTIME = "C:/dev/pob2/runtime/"
local POB_BRIDGE = "C:/dev/pob2/bridge/"

local PORTS = { 49090, 49091, 49092 }
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

--- The Calcs tab. Much the most expensive route: it runs CheckFlag over a
--- thousand rows and formats every one that survives, so the UI fetches it
--- on demand rather than on the 1s poll the other two use.
routes["GET /calcs"] = function()
	local started = os.clock()
	local calcs = api.calcs(currentBuild())
	calcs.engineError = engineError()
	calcs.buildMs = math.floor((os.clock() - started) * 1000 + 0.5)
	return 200, calcs
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
	-- with that name, and on this path dbFileName is false, so os.remove gets
	-- a boolean and the build mode dies inside PoB's own error handler.
	if name == "~~temp~~" then
		name = "Imported build"
	end
	loadBuildFromXML(xml, name)
	settle(3)
	return 200, api.snapshot(currentBuild())
end

--- Where PoB keeps the user's builds, so the UI can offer something real to
--- open without the path being hardcoded on the web side.
routes["GET /paths"] = function()
	return 200, {
		buildPath = main and main.buildPath or nil,
		userPath = main and main.userPath or nil,
		scriptPath = GetScriptPath and GetScriptPath() or nil,
	}
end

local function handler(method, path, payload)
	-- Query strings are not used by any route; drop them before matching.
	local route = routes[method .. " " .. (path:match("^([^?]*)") or path)]
	if not route then
		return 404, { error = "no route for " .. method .. " " .. path }
	end
	return route(payload)
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
	log("  GET /health   GET /state   GET /stats   GET /calcs   GET /paths")
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
