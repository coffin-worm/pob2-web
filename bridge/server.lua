-- A small HTTP server for the bridge.
--
-- Host-agnostic, like api.lua: it needs LuaSocket and nothing else, and it
-- never blocks the caller's loop. The host calls poll() once a tick; any
-- connection waiting is served and closed before poll() returns.
--
-- HTTP with polling rather than a WebSocket, deliberately. The handshake
-- needs SHA-1 and base64 and both ship in runtime/lua, so the upgrade is
-- open, but request/response is the simpler thing that proves the stack,
-- and the header's state is small enough that polling it costs nothing.
--
-- Bound to 127.0.0.1 explicitly. This serves a live engine with filesystem
-- access; it has no business being reachable from the network.

local socket = require("socket")
local json = require("dkjson")

local Server = {}
Server.__index = Server

local CORS = {
	-- The dev UI is served by Vite on another port, so every request here is
	-- cross-origin. Allowed openly because the listener is loopback-only; a
	-- shipping build serves the UI from the same origin and drops this.
	["Access-Control-Allow-Origin"] = "*",
	["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS",
	["Access-Control-Allow-Headers"] = "Content-Type",
}

local REASON = {
	[200] = "OK",
	[400] = "Bad Request",
	[404] = "Not Found",
	[409] = "Conflict",
	[500] = "Internal Server Error",
}

function Server.new(opts)
	local self = setmetatable({}, Server)
	self.handler = opts.handler
	self.log = opts.log or function() end

	local sock = socket.tcp4 and socket.tcp4() or socket.tcp()
	sock:setoption("reuseaddr", true)

	local bound, lastErr
	for _, port in ipairs(opts.ports or { 49090 }) do
		local ok, err = sock:bind("127.0.0.1", port)
		lastErr = err
		if ok then
			bound = port
			break
		end
	end
	if not bound then
		sock:close()
		return nil, "could not bind any candidate port: " .. tostring(lastErr)
	end

	local ok, err = sock:listen(8)
	if not ok then
		sock:close()
		return nil, "listen failed: " .. tostring(err)
	end

	-- Non-blocking accept: poll() must return immediately when idle.
	sock:settimeout(0)
	self.sock = sock
	self.port = bound
	return self
end

local function send(client, status, body)
	local payload = body and json.encode(body) or ""
	local head = {
		string.format("HTTP/1.1 %d %s", status, REASON[status] or "OK"),
		"Content-Type: application/json; charset=utf-8",
		"Content-Length: " .. #payload,
		"Connection: close",
	}
	for k, v in pairs(CORS) do head[#head + 1] = k .. ": " .. v end
	client:send(table.concat(head, "\r\n") .. "\r\n\r\n" .. payload)
end

--- Read one request off a connected socket. A short blocking read costs a few
--- milliseconds at most on loopback.
local function readRequest(client)
	local line, err = client:receive("*l")
	if not line then return nil, err end

	local method, path = line:match("^(%u+)%s+(%S+)")
	if not method then return nil, "malformed request line" end

	local length = 0
	while true do
		local header = client:receive("*l")
		if not header or header == "" then break end
		local n = header:match("^[Cc]ontent%-[Ll]ength:%s*(%d+)")
		if n then length = tonumber(n) end
	end

	return { method = method, path = path, body = length > 0 and client:receive(length) or nil }
end

--- Returns status, body for one parsed request.
local function respondTo(self, req)
	if req.method == "OPTIONS" then
		return 200, {}
	end

	local payload
	if req.body and #req.body > 0 then
		local decoded, _, derr = json.decode(req.body)
		if derr then
			return 400, { error = "bad JSON: " .. tostring(derr) }
		end
		payload = decoded
	end

	-- The handler runs engine code. If it throws, answer 500 and keep serving
	-- rather than taking the host down with it.
	local ok, status, body = pcall(self.handler, req.method, req.path, payload)
	if not ok then
		self.log("handler error: %s", tostring(status))
		return 500, { error = tostring(status) }
	end
	return status or 200, body
end

function Server:poll()
	while true do
		local client = self.sock:accept()
		if not client then return end

		client:settimeout(2)
		local req, err = readRequest(client)
		if req then
			send(client, respondTo(self, req))
		else
			self.log("bad request: %s", tostring(err))
			send(client, 400, { error = tostring(err) })
		end
		client:close()
	end
end

function Server:close()
	if self.sock then self.sock:close() end
end

return Server
