-- Real Deflate and Inflate for the headless engine.
--
-- `src/_SimpleGraphic.def.lua` stubs both to return "" and leaves a TODO
-- asking for FFI bindings to runtime/zlib1.dll, because the renderer
-- normally provides them. Nothing needed them until now: build codes are
-- base64 of a deflated XML document, so importing or exporting one without
-- these produces an empty string and a build that silently does not load.
--
-- This supplies them from the bridge rather than by editing the stub, so
-- `src/` stays untouched. The DLL is the one PoB already ships and already
-- loads for its own zip handling, and LuaJIT's FFI is the same FFI the
-- engine is running on.

local ffi = require("ffi")

ffi.cdef([[
	unsigned long compressBound(unsigned long sourceLen);
	int compress2(uint8_t *dest, unsigned long *destLen,
	              const uint8_t *source, unsigned long sourceLen, int level);
	int uncompress(uint8_t *dest, unsigned long *destLen,
	               const uint8_t *source, unsigned long sourceLen);
	const char *zlibVersion(void);
]])

local Z_OK = 0
local Z_BUF_ERROR = -5

-- zlib never says how big the decompressed data is, so the buffer is
-- guessed and grown on Z_BUF_ERROR. Build codes run to a few hundred kB of
-- XML from a few tens of kB of code, so 8x usually lands first time; the
-- cap is there so a malformed code cannot be asked to allocate forever.
local FIRST_GUESS = 8
local MAX_OUTPUT = 64 * 1024 * 1024

local zlib = {}

--- Load zlib1.dll from a directory. Returns the module, or nil and why.
function zlib.open(runtimeDir)
	local ok, lib = pcall(ffi.load, (runtimeDir or "") .. "zlib1")
	if not ok then
		-- Without a directory, let the OS search; a system zlib is fine.
		ok, lib = pcall(ffi.load, "zlib1")
	end
	if not ok then
		return nil, tostring(lib)
	end

	local version = ffi.string(lib.zlibVersion())

	--- Compress, with a zlib header. Matches what SimpleGraphic's Deflate
	--- produces, which is what PoB's own build codes are.
	local function deflate(data, level)
		data = tostring(data or "")
		local bound = lib.compressBound(#data)
		local out = ffi.new("uint8_t[?]", bound)
		local size = ffi.new("unsigned long[1]", bound)
		local code = lib.compress2(out, size, data, #data, level or 9)
		if code ~= Z_OK then
			return nil, "deflate failed with zlib code " .. code
		end
		return ffi.string(out, size[0])
	end

	--- Decompress zlib-wrapped data.
	---
	--- Gzip is not handled: `uncompress` only reads the zlib wrapper, and
	--- build codes are always zlib. Saying so beats appearing to support a
	--- format that would come back as a length error.
	local function inflate(data)
		data = tostring(data or "")
		if #data == 0 then
			return nil, "nothing to inflate"
		end
		local capacity = math.max(1024, #data * FIRST_GUESS)
		while capacity <= MAX_OUTPUT do
			local out = ffi.new("uint8_t[?]", capacity)
			local size = ffi.new("unsigned long[1]", capacity)
			local code = lib.uncompress(out, size, data, #data)
			if code == Z_OK then
				return ffi.string(out, size[0])
			elseif code ~= Z_BUF_ERROR then
				return nil, "inflate failed with zlib code " .. code
			end
			capacity = capacity * 4
		end
		return nil, "inflated data is larger than " .. MAX_OUTPUT .. " bytes"
	end

	zlib.deflate, zlib.inflate, zlib.version = deflate, inflate, version
	return zlib
end

--- Put them where PoB looks for them.
---
--- The engine calls the globals, so overriding them is what makes every
--- existing code path (import, export, the update check) work. Only the
--- stubs are replaced; if a real host already provided them, they stay.
function zlib.install(runtimeDir, isStub)
	local lib, err = zlib.open(runtimeDir)
	if not lib then
		return nil, err
	end
	if isStub == nil or isStub then
		_G.Deflate = function(data, gzip)
			if gzip then
				return nil, "gzip output is not supported by this binding"
			end
			return lib.deflate(data)
		end
		_G.Inflate = function(data)
			return lib.inflate(data)
		end
	end
	return lib
end

return zlib
