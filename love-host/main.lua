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

-- Returns r, g, b and the escape's LENGTH IN CHARACTERS: `^7` is 2,
-- `^xRRGGBB` is 8. Getting these off by one eats the first character of
-- every string, while StripEscapes (used for measurement) stays correct --
-- so the layout looks right and only the glyphs are wrong.
local function parseEscape(str)
	local c = str:match("^%^(%d)")
	if c then
		local e = escapeColors[c]
		return e[1], e[2], e[3], 2
	end
	local hex = str:match("^%^[xX](%x%x%x%x%x%x)")
	if hex then
		return tonumber(hex:sub(1, 2), 16) / 255,
		       tonumber(hex:sub(3, 4), 16) / 255,
		       tonumber(hex:sub(5, 6), 16) / 255, 8
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
-- PoB's `VAR` is Liberation Sans (see runtime/SimpleGraphic/Fonts). Arial is
-- metric-compatible with it, so advance widths match and PoB's own layout
-- lands where it was designed to. Swapping in a face with different metrics
-- -- Segoe UI, say -- looks more modern but pushes right-aligned labels off
-- the left edge of the side panel, because they anchor at a fixed x.
local WINF = "C:/Windows/Fonts/"
local fontFiles = {
	["VAR"] = WINF .. "arial.ttf",
	["VAR BOLD"] = WINF .. "arialbd.ttf",
	["FIXED"] = WINF .. "consola.ttf",
	["FONTIN"] = WINF .. "arial.ttf",
	["FONTIN ITALIC"] = WINF .. "ariali.ttf",
	["FONTIN SC"] = WINF .. "arial.ttf",
	["FONTIN SC ITALIC"] = WINF .. "ariali.ttf",
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
		local fd = getFontData(name) or getFontData("VAR")
		local function make(px)
			local ok, res
			if fd then ok, res = pcall(love.graphics.newFont, fd, px) end
			if not ok then ok, res = pcall(love.graphics.newFont, px) end
			return ok and res or nil
		end
		f = make(height)
		-- PoB's `height` is the pixel height of the bitmap atlas it used to
		-- get. LOVE sizes a font by em, so asking for N gives a line height
		-- noticeably taller than N -- every string comes out oversized, and
		-- right-aligned labels anchored at a fixed x run off the panel edge.
		-- Re-ask at a corrected size so getHeight() lands on what PoB expects.
		if f and f:getHeight() > height then
			local adj = math.max(6, math.floor(height * height / f:getHeight() + 0.5))
			f = make(adj) or f
		end
		f = f or love.graphics.getFont()
		fontCache[key] = f
	end
	return f
end

------------------------------------------------------- layered command buffer

-- SimpleGraphic sorts draws by layer; LOVE is immediate-mode. Record every
-- op with its layer and emission order, then replay sorted at end of frame.
--
-- Everything here is pooled. The first version allocated a closure, a colour
-- table and a fresh Quad or Mesh per draw call; the passive tree issues
-- thousands per frame, and the resulting GC churn took the process to 1.4 GB
-- and "Not Responding". Commands are now plain reused tables dispatched by a
-- type tag, Quads are cached by their texture-coordinate tuple, and Meshes
-- come from a pool.
local cmdPool = {}
local active = {}
local nCmds = 0
local curLayer, curSubLayer = 0, 0
local viewportStack = nil
local blendMode = "ALPHA"

local function nextCmd(kind)
	nCmds = nCmds + 1
	local c = cmdPool[nCmds]
	if not c then
		c = {}
		cmdPool[nCmds] = c
	end
	c.kind = kind
	c.layer = curLayer or 0
	c.sub = curSubLayer or 0
	c.seq = nCmds
	c.vp = viewportStack
	c.blend = blendMode
	c.r, c.g, c.b, c.a = curColor[1], curColor[2], curColor[3], curColor[4]
	active[nCmds] = c
	return c
end

local quadCache = {}

local function cachedQuad(tex, l, t, r, b)
	local w, h = tex:getWidth(), tex:getHeight()
	local key = w .. ":" .. h .. ":" .. l .. ":" .. t .. ":" .. r .. ":" .. b
	local q = quadCache[key]
	if not q then
		q = love.graphics.newQuad(l * w, t * h, (r - l) * w, (b - t) * h, w, h)
		quadCache[key] = q
	end
	return q
end

local meshPool = {}

local function pooledMesh(i)
	local m = meshPool[i]
	if not m then
		m = love.graphics.newMesh(4, "fan", "stream")
		meshPool[i] = m
	end
	return m
end

local drawText -- forward declaration; defined with the font helpers below

local function cmpCmd(a, b)
	if a.layer ~= b.layer then return a.layer < b.layer end
	if a.sub ~= b.sub then return a.sub < b.sub end
	return a.seq < b.seq
end

local function flush()
	for i = nCmds + 1, #active do
		active[i] = nil
	end
	table.sort(active, cmpCmd)
	local lastBlend = nil
	for i = 1, nCmds do
		local c = active[i]
		if c.vp then
			love.graphics.setScissor(c.vp[1], c.vp[2], c.vp[3], c.vp[4])
		else
			love.graphics.setScissor()
		end
		if c.blend ~= lastBlend then
			love.graphics.setBlendMode(c.blend == "ADDITIVE" and "add" or "alpha",
				c.blend == "PREALPHA" and "premultiplied" or "alphamultiply")
			lastBlend = c.blend
		end
		love.graphics.setColor(c.r, c.g, c.b, c.a)
		local k = c.kind
		if k == "rect" then
			love.graphics.rectangle("fill", c.x, c.y, c.w, c.h)
		elseif k == "img" then
			local q = cachedQuad(c.tex, c.tcL, c.tcT, c.tcR, c.tcB)
			local _, _, qw, qh = q:getViewport()
			love.graphics.draw(c.tex, q, c.x, c.y, 0,
				qw ~= 0 and c.w / qw or 0, qh ~= 0 and c.h / qh or 0)
		elseif k == "poly" then
			love.graphics.polygon("fill", c.x1, c.y1, c.x2, c.y2, c.x3, c.y3, c.x4, c.y4)
		elseif k == "mesh" then
			local m = pooledMesh(i)
			m:setVertex(1, c.x1, c.y1, c.s1, c.t1, 1, 1, 1, 1)
			m:setVertex(2, c.x2, c.y2, c.s2, c.t2, 1, 1, 1, 1)
			m:setVertex(3, c.x3, c.y3, c.s3, c.t3, 1, 1, 1, 1)
			m:setVertex(4, c.x4, c.y4, c.s4, c.t4, 1, 1, 1, 1)
			m:setTexture(c.tex)
			love.graphics.draw(m)
		elseif k == "text" then
			drawText(c)
		end
	end
	love.graphics.setScissor()
	love.graphics.setBlendMode("alpha")
	nCmds = 0
end

------------------------------------------------------------ image handles

-- The passive tree ships as .dds.zst: Zstandard-compressed DDS holding BC1
-- and BC7 block-compressed textures. LOVE can upload those (newCompressedData
-- handles DDS/BC7) but cannot decompress zstd -- love.data only does
-- zlib/gzip/deflate/lz4. PoB's own runtime ships zstd.dll, and LOVE is
-- LuaJIT, so reach it through the FFI rather than vendoring a decoder.
local zstd
local zstdTried = false

local function zstdDecompress(bytes)
	if not zstdTried then
		zstdTried = true
		local ok = pcall(function()
			local ffi = require("ffi")
			ffi.cdef [[
				size_t ZSTD_decompress(void* dst, size_t dstCapacity,
				                       const void* src, size_t compressedSize);
				unsigned long long ZSTD_getFrameContentSize(const void* src, size_t srcSize);
				unsigned ZSTD_isError(size_t code);
			]]
			zstd = { lib = ffi.load(POB_RUNTIME .. "zstd.dll"), ffi = ffi }
		end)
		if not ok then
			zstd = nil
			log("[shim] zstd.dll unavailable; .dds.zst textures will not load")
		end
	end
	if not zstd then return nil end
	local ffi = zstd.ffi
	local srcLen = #bytes
	local outLen = zstd.lib.ZSTD_getFrameContentSize(bytes, srcLen)
	outLen = tonumber(outLen)
	-- ZSTD_CONTENTSIZE_UNKNOWN / _ERROR come back as huge sentinels.
	if not outLen or outLen <= 0 or outLen > 512 * 1024 * 1024 then
		return nil
	end
	local buf = ffi.new("uint8_t[?]", outLen)
	local got = zstd.lib.ZSTD_decompress(buf, outLen, bytes, srcLen)
	if zstd.lib.ZSTD_isError(got) ~= 0 then return nil end
	return ffi.string(buf, tonumber(got))
end

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

	local name = fileName
	if name:match("%.zst$") then
		local raw = zstdDecompress(data)
		if not raw then
			log("[shim] zstd decode failed: %s", path)
			self.valid = false
			return
		end
		data = raw
		name = name:gsub("%.zst$", "")
	end
	local compressed = name:match("%.dds$") ~= nil

	local ok, img = pcall(function()
		local fd = love.filesystem.newFileData(data, name)
		if compressed then
			return love.graphics.newImage(love.image.newCompressedData(fd))
		end
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

-- A nil handle is the deliberate solid-rect primitive PoB uses for all its
-- chrome. A handle that exists but has no texture is a failed load, and must
-- draw nothing -- otherwise every missing asset paints an opaque white block.
function DrawImage(handle, left, top, width, height, a1, a2, a3, a4)
	if handle and not handle.tex then return end
	local tex = handle and handle.tex
	if not tex then
		local c = nextCmd("rect")
		c.x, c.y, c.w, c.h = left, top, width, height
		return
	end
	local c = nextCmd("img")
	c.tex, c.x, c.y, c.w, c.h = tex, left, top, width, height
	if type(a1) == "number" and type(a4) == "number" then
		c.tcL, c.tcT, c.tcR, c.tcB = a1, a2, a3, a4
	else
		c.tcL, c.tcT, c.tcR, c.tcB = 0, 0, 1, 1
	end
end

function DrawImageQuad(handle, x1, y1, x2, y2, x3, y3, x4, y4,
                       s1, t1, s2, t2, s3, t3, s4, t4)
	if handle and not handle.tex then return end
	local tex = handle and handle.tex
	if not tex or type(s1) ~= "number" then
		local c = nextCmd("poly")
		c.x1, c.y1, c.x2, c.y2 = x1, y1, x2, y2
		c.x3, c.y3, c.x4, c.y4 = x3, y3, x4, y4
		return
	end
	local c = nextCmd("mesh")
	c.tex = tex
	c.x1, c.y1, c.x2, c.y2 = x1, y1, x2, y2
	c.x3, c.y3, c.x4, c.y4 = x3, y3, x4, y4
	c.s1, c.t1, c.s2, c.t2 = s1, t1, s2, t2
	c.s3, c.t3, c.s4, c.t4 = s3, t3, s4, t4
end

-- Renders PoB's inline ^7 / ^xRRGGBB colour escapes as coloured runs. Only
-- splits when an escape is actually present; most strings have none, and the
-- fast path keeps text off the allocation treadmill too.
drawText = function(c)
	local text, font = c.text, c.font
	if not text:find("^", 1, true) then
		love.graphics.print(text, font, c.x, c.y)
		return
	end
	local r, g, b, a = c.r, c.g, c.b, c.a
	local cx, i, start = c.x, 1, 1
	while i <= #text do
		if text:byte(i) == 94 then -- '^'
			local er, eg, eb, len = parseEscape(text:sub(i))
			if er then
				if i > start then
					local seg = text:sub(start, i - 1)
					love.graphics.setColor(r, g, b, a)
					love.graphics.print(seg, font, cx, c.y)
					cx = cx + font:getWidth(seg)
				end
				r, g, b = er, eg, eb
				i = i + len
				start = i
			else
				i = i + 1
			end
		else
			i = i + 1
		end
	end
	if start <= #text then
		local seg = text:sub(start)
		love.graphics.setColor(r, g, b, a)
		love.graphics.print(seg, font, cx, c.y)
	end
end

function DrawString(left, top, align, height, fontName, text)
	if text == nil then return end
	text = tostring(text)
	local font = getFont(fontName, height)
	local x = left
	if align and align ~= "LEFT" then
		local w = font:getWidth(StripEscapes(text))
		if align == "CENTER" or align == "CENTER_X" then
			x = left - w / 2
		elseif align == "RIGHT" or align == "RIGHT_X" then
			x = left - w
		end
	end
	local c = nextCmd("text")
	c.text, c.font, c.x, c.y = text, font, x, top
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
local SHOT_PATH = "C:/dev/pob-love/shot.png"
local shotPending = false

function TakeScreenshot()
	shotPending = true
end

-- Called at the end of love.draw, where captureScreenshot is legal.
local function servicePendingShot()
	if not shotPending then return end
	shotPending = false
	love.graphics.captureScreenshot(function(imgData)
		local ok, err = pcall(function()
			local png = imgData:encode("png")
			local f = io.open(SHOT_PATH, "wb")
			if not f then error("cannot open " .. SHOT_PATH) end
			f:write(png:getString())
			f:close()
		end)
		log(ok and ("[screenshot] " .. SHOT_PATH) or ("[screenshot FAILED] " .. tostring(err)))
	end)
end
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

	-- PoB's runtime ships its own C modules (lua-utf8 etc). They're LuaJIT
	-- 5.1 ABI, same as LOVE's, so they can load directly.
	package.cpath = POB_RUNTIME .. "?.dll;" .. package.cpath

	local realRequire = require
	_G.require = function(n)
		if n == "lcurl.safe" or n == "lcurl" then return nil end
		local ok, res = pcall(realRequire, n)
		if ok then return res end
		warnOnce("require(" .. n .. ") -> " .. tostring(res))
		return nil
	end

	love.graphics.setBackgroundColor(0, 0, 0)
	love.keyboard.setKeyRepeat(true)

	local fmts = {}
	for name, supported in pairs(love.graphics.getImageFormats()) do
		if supported then fmts[#fmts + 1] = name end
	end
	table.sort(fmts)
	log("[gpu] image formats: %s", table.concat(fmts, " "))

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
-- Frame counter and a one-shot capture trigger, so a headless run can leave
-- a PNG behind to look at without anyone touching the window.
frameNo = 0
shotAtFrame = nil

-- PoB reports load failures by setting launch.promptMsg and drawing its own
-- error panel, with nothing on the console. Surface it.
local promptLogged = false
local function logPrompt()
	if promptLogged or not mainObject then return end
	local msg = mainObject.promptMsg
	if msg and msg ~= "" then
		promptLogged = true
		log("[pob prompt] %s", tostring(msg))
	end
end

local function tryAutoBuild()
	logPrompt()
	if autoBuildDone or not _G.main or not _G.main.SetMode then return end
	autoBuildDone = true
	local ok, err = pcall(function()
		_G.main:SetMode("BUILD", false, "Unnamed build")
	end)
	log(ok and "[autobuild OK]" or ("[autobuild FAILED] " .. tostring(err)))
	shotAtFrame = frameNo + 180 -- ~3s at 60fps, enough for async tree art
end

function love.draw()
	if not booted then
		love.graphics.setColor(1, 0.4, 0.4)
		love.graphics.printf("PoB failed to boot:\n\n" .. tostring(bootErr),
			20, 20, love.graphics.getWidth() - 40)
		return
	end
	curLayer, curSubLayer = 0, 0
	local ok, err = pcall(runCallback, "OnFrame")
	tryAutoBuild()
	flush()
	frameNo = frameNo + 1
	if shotAtFrame and frameNo >= shotAtFrame then
		shotAtFrame = nil
		TakeScreenshot()
	end
	servicePendingShot()
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
