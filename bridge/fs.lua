-- The filesystem the headless engine does not have.
--
-- `src/_SimpleGraphic.def.lua` stubs NewFileSearch, GetUserPath, MakeDir,
-- RemoveDir and the working-directory pair, because the renderer normally
-- provides them. Nothing needed them until the build list: PoB's own
-- Modules/BuildListHelpers scans the builds folder entirely through
-- NewFileSearch, so with the stub in place it finds nothing and reports an
-- empty folder rather than an error.
--
-- Supplied from the bridge rather than by editing the stub, so `src/` stays
-- untouched, the same arrangement as bridge/zlib.lua.
--
-- Windows only, which the dev host already is: it is started through a
-- Windows path to lovec.exe and stopped with taskkill. A different host
-- would implement this against dirent and stat, or simply keep the real
-- SimpleGraphic implementations.

local ffi = require("ffi")

ffi.cdef([[
	typedef struct { uint32_t dwLowDateTime; uint32_t dwHighDateTime; } FILETIME_;
	typedef struct {
		uint32_t dwFileAttributes;
		FILETIME_ ftCreationTime;
		FILETIME_ ftLastAccessTime;
		FILETIME_ ftLastWriteTime;
		uint32_t nFileSizeHigh;
		uint32_t nFileSizeLow;
		uint32_t dwReserved0;
		uint32_t dwReserved1;
		char cFileName[260];
		char cAlternateFileName[14];
	} WIN32_FIND_DATAA_;

	void *FindFirstFileA(const char *lpFileName, WIN32_FIND_DATAA_ *lpFindFileData);
	int FindNextFileA(void *hFindFile, WIN32_FIND_DATAA_ *lpFindFileData);
	int FindClose(void *hFindFile);
	int CreateDirectoryA(const char *lpPathName, void *lpSecurityAttributes);
	int RemoveDirectoryA(const char *lpPathName);
	uint32_t GetCurrentDirectoryA(uint32_t nBufferLength, char *lpBuffer);
	int SetCurrentDirectoryA(const char *lpPathName);
	uint32_t GetLastError(void);
]])

local FILE_ATTRIBUTE_DIRECTORY = 0x10
local ERROR_ALREADY_EXISTS = 183

-- FILETIME counts 100-nanosecond intervals from 1601; Unix time counts
-- seconds from 1970.
local FILETIME_PER_SECOND = 10000000
local SECONDS_1601_TO_1970 = 11644473600

local fs = {}

local function isInvalid(handle)
	-- INVALID_HANDLE_VALUE is (HANDLE)-1 rather than NULL.
	return handle == nil or tonumber(ffi.cast("intptr_t", handle)) == -1
end

local function modifiedTime(data)
	local ticks = data.ftLastWriteTime.dwHighDateTime * 4294967296 + data.ftLastWriteTime.dwLowDateTime
	return math.floor(ticks / FILETIME_PER_SECOND - SECONDS_1601_TO_1970)
end

--- Everything matching a glob, as plain Lua tables.
---
--- Enumerated eagerly rather than lazily: the caller holds the result
--- across arbitrary work (PoB's scanner recurses into subfolders while
--- iterating), and an OS search handle left open across that is a good way
--- to end up holding a directory the user is trying to rename.
local function enumerate(spec, wantDirectories)
	local data = ffi.new("WIN32_FIND_DATAA_[1]")
	local handle = ffi.C.FindFirstFileA(spec, data)
	if isInvalid(handle) then
		return {}
	end

	local found = {}
	repeat
		local name = ffi.string(data[0].cFileName)
		local isDirectory = bit.band(data[0].dwFileAttributes, FILE_ATTRIBUTE_DIRECTORY) ~= 0
		if name ~= "." and name ~= ".." and isDirectory == wantDirectories then
			found[#found + 1] = {
				name = name,
				size = data[0].nFileSizeHigh * 4294967296 + data[0].nFileSizeLow,
				modified = modifiedTime(data[0]),
			}
		end
	until ffi.C.FindNextFileA(handle, data) == 0
	ffi.C.FindClose(handle)

	return found
end

fs.enumerate = enumerate

--- The handle shape PoB expects: a cursor with GetFileName, GetFileSize,
--- GetFileModifiedTime and NextFile, and nil when nothing matched.
local function newFileSearch(spec, findDirectories)
	local entries = enumerate(tostring(spec or ""), findDirectories and true or false)
	if #entries == 0 then
		return nil
	end

	local index = 1
	return {
		GetFileName = function() return entries[index].name end,
		GetFileSize = function() return entries[index].size end,
		GetFileModifiedTime = function() return entries[index].modified end,
		NextFile = function()
			index = index + 1
			return entries[index] ~= nil
		end,
		Close = function() end,
	}
end

--- Where PoB keeps the user's data.
---
--- The real host returns the Documents folder, and PoB appends
--- "Path of Building (PoE2)/" to it, so this points at the same builds
--- folder the desktop app uses, and the two see each other's builds.
--- POB_USER_PATH overrides it.
function fs.userPath()
	local override = os.getenv("POB_USER_PATH")
	if override and override ~= "" then
		return (override:gsub("\\", "/"):gsub("/$", ""))
	end
	-- USERPROFILE rather than SHGetFolderPath: one less library to bind,
	-- and a redirected Documents folder is handled by the override above.
	local home = os.getenv("USERPROFILE") or os.getenv("HOME")
	if not home then
		return nil
	end
	return (home:gsub("\\", "/")) .. "/Documents"
end

function fs.makeDir(path)
	if ffi.C.CreateDirectoryA(tostring(path), nil) ~= 0 then
		return true
	end
	if ffi.C.GetLastError() == ERROR_ALREADY_EXISTS then
		return true
	end
	return false, "could not create " .. tostring(path)
end

function fs.removeDir(path)
	if ffi.C.RemoveDirectoryA(tostring(path)) ~= 0 then
		return true
	end
	return false, "could not remove " .. tostring(path)
end

function fs.workDir()
	local buffer = ffi.new("char[?]", 4096)
	local length = ffi.C.GetCurrentDirectoryA(4096, buffer)
	if length == 0 then
		return ""
	end
	return (ffi.string(buffer, length):gsub("\\", "/"))
end

--- Put them where PoB looks for them, replacing only the stubs.
function fs.install(isStub)
	if isStub == false then
		return fs
	end
	_G.NewFileSearch = newFileSearch
	_G.GetUserPath = fs.userPath
	_G.MakeDir = fs.makeDir
	_G.RemoveDir = fs.removeDir
	_G.GetWorkDir = fs.workDir
	_G.SetWorkDir = function(path)
		return ffi.C.SetCurrentDirectoryA(tostring(path)) ~= 0
	end
	return fs
end

return fs
