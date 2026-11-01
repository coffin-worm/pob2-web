-- SimpleGraphic -> LOVE 2D shim
--
-- Implements the ~68-function host API that Path of Building's Lua expects,
-- on top of love.graphics, so PoB's application code runs unmodified inside
-- LOVE. The point of the exercise: LOVE gives TrueType fonts, shaders and
-- canvases, none of which SimpleGraphic exposes.
--
-- Run:  "C:\Program Files\LOVE\love.exe" C:\dev\pob-love

local POB_SRC = "C:/dev/pob2/src/"
local POB_RUNTIME = "C:/dev/pob2/runtime/"

--------------------------------------------------------------------- logging

local logFile = io.open("C:/dev/pob-love/shim.log", "w")
local function log(fmt, ...)
	local ok, line = pcall(string.format, fmt, ...)
	line = ok and line or tostring(fmt)
	if logFile then
		logFile:write(line, "\n")
		logFile:flush()
	end
	print(line)
end

local warned = {}
local function warnOnce(name)
	if not warned[name] then
		warned[name] = true
		log("[shim] unimplemented: %s", name)
	end
end

--------------------------------------------------------------- path handling

local workDir = POB_SRC

local function resolve(path)
	if not path then return path end
	path = path:gsub("\\", "/")
	if path:match("^%a:/") or path:match("^/") then
		return path
	end
	return workDir .. path
end

-- SimpleGraphic's SetWorkDir changes the real process CWD, and PoB leans on
-- that with bare relative io.open calls. LOVE can't chdir, so route the stdlib
-- file entry points through resolve() instead.
local realOpen, realLines, realRemove, realRename = io.open, io.lines, os.remove, os.rename
io.open = function(path, ...) return realOpen(resolve(path), ...) end
io.lines = function(path, ...)
	if path then return realLines(resolve(path), ...) end
	return realLines(...)
end
os.remove = function(path) return realRemove(resolve(path)) end
os.rename = function(a, b) return realRename(resolve(a), resolve(b)) end

--------------------------------------------------------------------- colours

local escapeColors = {
	["0"] = { 0, 0, 0 },        ["1"] = { 1, 0, 0 },
	["2"] = { 0, 1, 0 },        ["3"] = { 0, 0, 1 },
	["4"] = { 1, 1, 0 },        ["5"] = { 1, 0, 1 },
	["6"] = { 0, 1, 1 },        ["7"] = { 1, 1, 1 },
	["8"] = { 0.7, 0.7, 0.7 },  ["9"] = { 0.4, 0.4, 0.4 },
}

local curColor = { 1, 1, 1, 1 }

local function parseEscape(str)
	local c = str:match("^%^(%d)")
	if c then
		local e = escapeColors[c]
		return e[1], e[2], e[3], 3
	end
	local hex = str:match("^%^[xX](%x%x%x%x%x%x)")
	if hex then
		return tonumber(hex:sub(1, 2), 16) / 255,
		       tonumber(hex:sub(3, 4), 16) / 255,
		       tonumber(hex:sub(5, 6), 16) / 255, 9
	end
end

function StripEscapes(text)
	if type(text) ~= "string" then return text end
	text = text:gsub("%^[xX]%x%x%x%x%x%x", "")
	text = text:gsub("%^%d", "")
	return text
end

--------------------------------------------------------------------- fonts

-- The headline upgrade over SimpleGraphic: real TTF at any size, instead of
-- pre-rendered bitmap atlases locked to 16 fixed heights.
local fontCache = {}
local fontData = {}

-- SimpleGraphic ships pre-rendered bitmap atlases at 16 fixed heights per
-- face. LOVE rasterises TrueType at any size, so point the same font names
-- at real system faces. PoB measures its own layout with DrawStringWidth,
-- so swapping metrics reflows rather than overlapping.
local WINF = "C:/Windows/Fonts/"
local fontFiles = {
	["VAR"] = WINF .. "segoeui.ttf",
	["VAR BOLD"] = WINF .. "segoeuib.ttf",
	["FIXED"] = WINF .. "consola.ttf",
	["FONTIN"] = WINF .. "segoeui.ttf",
	["FONTIN ITALIC"] = WINF .. "segoeuii.ttf",
	["FONTIN SC"] = WINF .. "segoeui.ttf",
	["FONTIN SC ITALIC"] = WINF .. "segoeuii.ttf",
}

local function getFontData(name)
	if fontData[name] ~= nil then return fontData[name] or nil end
	local path = fontFiles[name]
	local fh = path and io.open(path, "rb")
	if not fh then
		fontData[name] = false
		return nil
	end
	local bytes = fh:read("*a")
	fh:close()
	local ok, fd = pcall(love.filesystem.newFileData, bytes, "font.ttf")
	fontData[name] = ok and fd or false
	return ok and fd or nil
end

local function getFont(name, height)
	height = math.max(math.floor(tonumber(height) or 14), 6)
	name = name or "VAR"
	local key = name .. ":" .. height
	local f = fontCache[key]
	if not f then
		local ok, res = false, nil
		local fd = getFontData(name) or getFontData("VAR")
		if fd then
			ok, res = pcall(love.graphics.newFont, fd, height)
		end
		if not ok then
			ok, res = pcall(love.graphics.newFont, height)
		end
		f = ok and res or love.graphics.getFont()
		fontCache[key] = f
	end
	return f
end

------------------------------------------------------- layered command buffer

-- SimpleGraphic sorts draws by layer; LOVE is immediate-mode. Record every
-- op with its layer and emission order, then replay sorted at end of frame.
local cmds = {}
local nCmds = 0
local curLayer, curSubLayer = 0, 0
local seq = 0
local viewportStack = nil
local blendMode = "ALPHA"

local function push(fn)
	nCmds = nCmds + 1
	seq = seq + 1
	cmds[nCmds] = {
		layer = curLayer or 0,
		sub = curSubLayer or 0,
		seq = seq,
		fn = fn,
		vp = viewportStack,
		blend = blendMode,
	}
end

local function flush()
	table.sort(cmds, function(a, b)
		if a.layer ~= b.layer then return a.layer < b.layer end
		if a.sub ~= b.sub then return a.sub < b.sub end
		return a.seq < b.seq
	end)
	for i = 1, nCmds do
		local c = cmds[i]
		if c.vp then
			love.graphics.setScissor(c.vp[1], c.vp[2], c.vp[3], c.vp[4])
		else
			love.graphics.setScissor()
		end
		love.graphics.setBlendMode(c.blend == "ADDITIVE" and "add" or "alpha",
			c.blend == "PREALPHA" and "premultiplied" or "alphamultiply")
		c.fn()
		cmds[i] = nil
	end
	love.graphics.setScissor()
	love.graphics.setBlendMode("alpha")
	nCmds = 0
	seq = 0
end

------------------------------------------------------------ image handles

local imageHandle = {}
imageHandle.__index = imageHandle

function imageHandle:Load(fileName, ...)
	local path = resolve(fileName)
	local fh = io.open(path, "rb")
	if not fh then
		log("[shim] image not found: %s", path)
		self.valid = false
		return
	end
	local data = fh:read("*a")
	fh:close()
	local ok, img = pcall(function()
		local fd = love.filesystem.newFileData(data, fileName)
		return love.graphics.newImage(love.image.newImageData(fd))
	end)
	if ok then
		self.tex = img
		self.valid = true
		for _, flag in ipairs({ ... }) do
			if flag == "CLAMP" then img:setWrap("clamp", "clamp") end
		end
		img:setFilter("linear", "linear")
	else
		log("[shim] image decode failed: %s (%s)", path, tostring(img))
		self.valid = false
	end
end

function imageHandle:Unload() self.tex, self.valid = nil, false end
function imageHandle:IsValid() return self.valid == true end
function imageHandle:IsLoading() return false end
function imageHandle:SetLoadingPriority() end
function imageHandle:ImageSize()
	if self.tex then return self.tex:getWidth(), self.tex:getHeight() end
	return 0, 0
end
function imageHandle:LoadArtRectangle() warnOnce("LoadArtRectangle") end
function imageHandle:LoadArtArcBand() warnOnce("LoadArtArcBand") end

function NewImageHandle()
	return setmetatable({ valid = false }, imageHandle)
end

function NewArtHandle() warnOnce("NewArtHandle") return nil end

Texture = {
	new = function()
		warnOnce("Texture.new")
		return { Allocate = function() return false end, Load = function() return false end,
		         Save = function() return false end, Info = function() return {} end,
		         IsValid = function() return false end, StackTextures = function() return false end }
	end,
}

------------------------------------------------------------------- drawing

function SetDrawColor(r, g, b, a)
	if type(r) == "string" then
		local er, eg, eb = parseEscape(r)
		if er then curColor = { er, eg, eb, 1 } end
		return
	end
	curColor = { r or 1, g or 1, b or 1, a or 1 }
end

function GetDrawColor()
	return curColor[1], curColor[2], curColor[3], curColor[4]
end

function SetDrawLayer(layer, subLayer)
	if layer ~= nil then curLayer = layer end
	curSubLayer = subLayer or 0
end

function GetDrawLayer() return curLayer end

function SetViewport(x, y, width, height)
	if not x then
		viewportStack = nil
	else
		viewportStack = { x, y, width, height }
	end
end

function SetBlendMode(mode) blendMode = mode or "ALPHA" end
function SetClearColor(r, g, b, a) love.graphics.setBackgroundColor(r, g, b, a or 1) end

local function quadFor(tex, l, t, r, b)
	local w, h = tex:getWidth(), tex:getHeight()
	return love.graphics.newQuad(l * w, t * h, (r - l) * w, (b - t) * h, w, h)
end

function DrawImage(handle, left, top, width, height, a1, a2, a3, a4)
	local col = { curColor[1], curColor[2], curColor[3], curColor[4] }
	local tex = handle and handle.tex
	if not tex then
		push(function()
			love.graphics.setColor(col)
			love.graphics.rectangle("fill", left, top, width, height)
		end)
		return
	end
	local tcL, tcT, tcR, tcB = a1, a2, a3, a4
	if type(tcL) ~= "number" or type(tcB) ~= "number" then
		tcL, tcT, tcR, tcB = 0, 0, 1, 1
	end
	push(function()
		love.graphics.setColor(col)
		local q = quadFor(tex, tcL, tcT, tcR, tcB)
		local _, _, qw, qh = q:getViewport()
		love.graphics.draw(tex, q, left, top, 0,
			qw ~= 0 and width / qw or 0, qh ~= 0 and height / qh or 0)
	end)
end

function DrawImageQuad(handle, x1, y1, x2, y2, x3, y3, x4, y4,
                       s1, t1, s2, t2, s3, t3, s4, t4)
	local col = { curColor[1], curColor[2], curColor[3], curColor[4] }
	local tex = handle and handle.tex
	if not tex or type(s1) ~= "number" then
		push(function()
			love.graphics.setColor(col)
			love.graphics.polygon("fill", x1, y1, x2, y2, x3, y3, x4, y4)
		end)
		return
	end
	push(function()
		love.graphics.setColor(col)
		local mesh = love.graphics.newMesh({
			{ x1, y1, s1, t1, 1, 1, 1, 1 },
			{ x2, y2, s2, t2, 1, 1, 1, 1 },
			{ x3, y3, s3, t3, 1, 1, 1, 1 },
			{ x4, y4, s4, t4, 1, 1, 1, 1 },
		}, "fan", "stream")
		mesh:setTexture(tex)
		love.graphics.draw(mesh)
	end)
end

-- Renders PoB's inline ^7 / ^xRRGGBB colour escapes as coloured runs.
local function drawSegments(x, y, font, text, col)
	local segs, r, g, b = {}, col[1], col[2], col[3]
	local i, buf = 1, {}
	while i <= #text do
		local esc = text:sub(i)
		local er, eg, eb, len = parseEscape(esc)
		if er then
			if #buf > 0 then
				segs[#segs + 1] = { table.concat(buf), r, g, b }
				buf = {}
			end
			r, g, b = er, eg, eb
			i = i + len
		else
			buf[#buf + 1] = text:sub(i, i)
			i = i + 1
		end
	end
	if #buf > 0 then segs[#segs + 1] = { table.concat(buf), r, g, b } end
	local cx = x
	for _, s in ipairs(segs) do
		love.graphics.setColor(s[2], s[3], s[4], col[4])
		love.graphics.print(s[1], font, cx, y)
		cx = cx + font:getWidth(s[1])
	end
	return cx - x
end

function DrawString(left, top, align, height, fontName, text)
	if text == nil then return end
	text = tostring(text)
	local col = { curColor[1], curColor[2], curColor[3], curColor[4] }
	local font = getFont(fontName, height)
	local plain = StripEscapes(text)
	local w = font:getWidth(plain)
	local x = left
	if align == "CENTER" then x = left - w / 2
	elseif align == "RIGHT" then x = left - w
	elseif align == "CENTER_X" then x = left - w / 2
	elseif align == "RIGHT_X" then x = left - w end
	push(function() drawSegments(x, top, font, text, col) end)
end

function DrawStringWidth(height, fontName, text)
	if text == nil then return 0 end
	return math.floor(getFont(fontName, height):getWidth(StripEscapes(tostring(text))))
end

function DrawStringCursorIndex(height, fontName, text, cursorX, cursorY)
	local font = getFont(fontName, height)
	local plain = StripEscapes(tostring(text or ""))
	for i = 1, #plain do
		if font:getWidth(plain:sub(1, i)) >= cursorX then return i end
	end
	return #plain + 1
end

--------------------------------------------------------------- screen / misc

local dpiPercent = 0

function GetScreenSize() return love.graphics.getDimensions() end

-- Undocumented in _SimpleGraphic.def.lua but called from Launch.lua:399;
-- HeadlessWrapper.lua stubs it too. This is the DPI-scaled layout space.
function GetVirtualScreenSize()
	local w, h = love.graphics.getDimensions()
	if dpiPercent and dpiPercent > 0 then
		local s = dpiPercent / 100
		return math.floor(w / s), math.floor(h / s)
	end
	return w, h
end
function GetScreenScale() return 1 end
function SetDPIScaleOverridePercent(p) dpiPercent = p or 0 end
function GetDPIScaleOverridePercent() return dpiPercent end
function RenderInit() end
function GetAsyncCount() return 0 end
function SetWindowTitle(t) love.window.setTitle(t or "Path of Building") end
function GetCursorPos() return love.mouse.getPosition() end
function SetCursorPos(x, y) love.mouse.setPosition(x, y) end
function ShowCursor(s) love.mouse.setVisible(s and true or false) end
function TakeScreenshot() warnOnce("TakeScreenshot") end
function SetForeground() end
function SetProfiling() end
function Restart() warnOnce("Restart") end
function Exit(msg) if msg then log("[exit] %s", msg) end love.event.quit() end
function OpenURL(url) love.system.openURL(url) end
function SpawnProcess() warnOnce("SpawnProcess") end
function Copy(text) love.system.setClipboardText(text or "") end
function Paste() return love.system.getClipboardText() end
function GetTime() return math.floor(love.timer.getTime() * 1000) end
function GetCloudProvider() return nil end

local keyMap = {
	escape = "ESCAPE", ["return"] = "RETURN", kpenter = "RETURN",
	backspace = "BACK", tab = "TAB", space = "SPACE", delete = "DELETE",
	home = "HOME", ["end"] = "END", pageup = "PAGEUP", pagedown = "PAGEDOWN",
	up = "UP", down = "DOWN", left = "LEFT", right = "RIGHT",
	lctrl = "CTRL", rctrl = "CTRL", lshift = "SHIFT", rshift = "SHIFT",
	lalt = "ALT", ralt = "ALT",
}
for i = 1, 12 do keyMap["f" .. i] = "F" .. i end

local function toPoBKey(k) return keyMap[k] or k:upper() end

function IsKeyDown(name)
	name = tostring(name):upper()
	if name == "LEFTBUTTON" then return love.mouse.isDown(1) end
	if name == "RIGHTBUTTON" then return love.mouse.isDown(2) end
	if name == "MIDDLEBUTTON" then return love.mouse.isDown(3) end
	if name == "CTRL" then return love.keyboard.isDown("lctrl", "rctrl") end
	if name == "SHIFT" then return love.keyboard.isDown("lshift", "rshift") end
	if name == "ALT" then return love.keyboard.isDown("lalt", "ralt") end
	local ok, down = pcall(love.keyboard.isDown, name:lower())
	return ok and down or false
end

function Deflate(data, isGzip)
	local ok, res = pcall(love.data.compress, "string", "zlib", data)
	if ok then return res end
	return nil, tostring(res)
end

function Inflate(data)
	local ok, res = pcall(love.data.decompress, "string", "zlib", data)
	if ok then return res end
	return nil, tostring(res)
end

----------------------------------------------------------------- filesystem

function GetScriptPath() return POB_SRC:gsub("/$", "") end
function GetRuntimePath() return POB_RUNTIME:gsub("/$", "") end
function GetUserPath() return os.getenv("APPDATA") or "C:/dev/pob-love" end
function GetWorkDir() return workDir:gsub("/$", "") end
function SetWorkDir(path) workDir = resolve(path):gsub("/?$", "/") end

function MakeDir(path)
	os.execute('mkdir "' .. resolve(path):gsub("/", "\\") .. '" 2>nul')
	return true
end

function RemoveDir(path, recurse)
	os.execute('rmdir ' .. (recurse and "/s /q " or "") .. '"'
		.. resolve(path):gsub("/", "\\") .. '" 2>nul')
	return true
end

local fileSearch = {}
fileSearch.__index = fileSearch
function fileSearch:NextFile()
	self.i = self.i + 1
	return self.files[self.i] ~= nil
end
function fileSearch:GetFileName() return self.files[self.i] end
function fileSearch:GetFileSize() return 0 end
function fileSearch:GetFileModifiedTime() return 0 end

function NewFileSearch(spec, findDirectories)
	spec = resolve(spec):gsub("/", "\\")
	local cmd = findDirectories and ('dir /b /ad "' .. spec .. '" 2>nul')
	                             or ('dir /b /a-d "' .. spec .. '" 2>nul')
	local files, p = {}, io.popen(cmd)
	if p then
		for line in p:lines() do
			if line ~= "" then files[#files + 1] = line end
		end
		p:close()
	end
	if #files == 0 then return nil end
	return setmetatable({ files = files, i = 0 }, fileSearch)
end

------------------------------------------------------------------- modules

function LoadModule(name, ...)
	local path = resolve(name)
	if not path:match("%.lua$") then path = path .. ".lua" end
	local chunk, err = loadfile(path)
	if not chunk then error("LoadModule(" .. tostring(name) .. "): " .. tostring(err), 2) end
	return chunk(...)
end

function PLoadModule(name, ...)
	local args = { ... }
	local ok, res = pcall(function() return LoadModule(name, unpack(args)) end)
	if ok then return nil, res end
	return tostring(res)
end

function PCall(func, ...)
	local args = { ... }
	local ok, res = pcall(function() return func(unpack(args)) end)
	if ok then return nil, res end
	return tostring(res)
end

------------------------------------------------------------------- console

function ConPrintf(fmt, ...)
	local ok, s = pcall(string.format, fmt, ...)
	log("[con] %s", ok and s or tostring(fmt))
end
function ConPrintTable() end
function ConExecute() end
function ConClear() end

------------------------------------------------------------------ callbacks

local callbackTable = {}
local mainObject = nil

function SetCallback(name, func)
	if func then callbackTable[name] = func else callbackTable[name] = nil end
end
function GetCallback(name) return callbackTable[name] end
function SetMainObject(object) mainObject = object end

function runCallback(name, ...)
	if callbackTable[name] then return callbackTable[name](...) end
	if mainObject and mainObject[name] then return mainObject[name](mainObject, ...) end
end

-- Subscripts drive update checks, trade queries and build imports. Stubbed
-- for the boot test; LOVE threads are the real mapping.
function LaunchSubScript() warnOnce("LaunchSubScript") return nil end
function AbortSubScript() end
function IsSubScriptRunning() return false end

------------------------------------------------------------- love callbacks

local booted, bootErr = false, nil

function love.load()
	package.path = table.concat({
		POB_RUNTIME .. "lua/?.lua",
		POB_RUNTIME .. "lua/?/init.lua",
		POB_SRC .. "?.lua",
		package.path,
	}, ";")

	local realRequire = require
	_G.require = function(n)
		if n == "lcurl.safe" or n == "lcurl" then return nil end
		local ok, res = pcall(realRequire, n)
		if ok then return res end
		warnOnce("require(" .. n .. ")")
		return nil
	end

	love.graphics.setBackgroundColor(0, 0, 0)
	love.keyboard.setKeyRepeat(true)

	local ok, err = pcall(function()
		local chunk, lerr = loadfile(POB_SRC .. "Launch.lua")
		if not chunk then error(tostring(lerr)) end
		chunk()
		runCallback("OnInit")
	end)
	booted, bootErr = ok, err
	if not ok then log("[boot FAILED] %s", tostring(err)) else log("[boot OK]") end

end

-- Stress the deep paths without a human clicking: open a build, which pulls
-- in ModCache, the passive tree renderer, item slots and calcs. Deferred to
-- the first frame -- SetMainObject receives `launch`, while `main` is its own
-- global created at Modules/Main.lua:50, which doesn't exist until PoB has
-- run a frame of its own.
local autoBuildDone = os.getenv("POBLOVE_AUTOBUILD") == "0"

local function tryAutoBuild()
	if autoBuildDone or not _G.main or not _G.main.SetMode then return end
	autoBuildDone = true
	local ok, err = pcall(function()
		_G.main:SetMode("BUILD", false, "Unnamed build")
	end)
	log(ok and "[autobuild OK]" or ("[autobuild FAILED] " .. tostring(err)))
end

function love.draw()
	if not booted then
		love.graphics.setColor(1, 0.4, 0.4)
		love.graphics.printf("PoB failed to boot:\n\n" .. tostring(bootErr),
			20, 20, love.graphics.getWidth() - 40)
		return
	end
	curLayer, curSubLayer, seq = 0, 0, 0
	local ok, err = pcall(runCallback, "OnFrame")
	tryAutoBuild()
	flush()
	if not ok then
		warnOnce("OnFrame: " .. tostring(err))
		love.graphics.setScissor()
		love.graphics.setColor(1, 0.4, 0.4)
		love.graphics.printf("OnFrame error:\n\n" .. tostring(err), 20, 20,
			love.graphics.getWidth() - 40)
	end
end

function love.keypressed(key)
	pcall(runCallback, "OnKeyDown", toPoBKey(key), false)
end
function love.keyreleased(key)
	pcall(runCallback, "OnKeyUp", toPoBKey(key))
end
function love.textinput(t)
	pcall(runCallback, "OnChar", t)
end
function love.mousepressed(_, _, button)
	local names = { "LEFTBUTTON", "RIGHTBUTTON", "MIDDLEBUTTON" }
	pcall(runCallback, "OnKeyDown", names[button] or "LEFTBUTTON", false)
end
function love.mousereleased(_, _, button)
	local names = { "LEFTBUTTON", "RIGHTBUTTON", "MIDDLEBUTTON" }
	pcall(runCallback, "OnKeyUp", names[button] or "LEFTBUTTON")
end
function love.wheelmoved(_, y)
	if y ~= 0 then
		local k = y > 0 and "WHEELUP" or "WHEELDOWN"
		pcall(runCallback, "OnKeyDown", k, false)
		pcall(runCallback, "OnKeyUp", k)
	end
end
function love.quit()
	local ok, canExit = pcall(runCallback, "CanExit")
	if ok and canExit == false then return true end
	pcall(runCallback, "OnExit")
	if logFile then logFile:close() end
	return false
end
