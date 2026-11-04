-- A headless LOVE host. No window, no graphics, no audio: PoB's drawing all
-- goes through _SimpleGraphic.def.lua's stubs, so nothing here ever needs a
-- GPU. LOVE is in use for one reason only: it is a LuaJIT 2.1 host that is
-- already installed and already proven to load PoB's native DLLs.
--
-- main.lua supplies its own love.run, so the default loop's dependence on an
-- open window never comes into it.
function love.conf(t)
	t.identity = "pob-bridge"
	t.console = false
	t.modules.window = false
	t.modules.graphics = false
	t.modules.audio = false
	t.modules.sound = false
	t.modules.physics = false
	t.modules.joystick = false
	t.modules.video = false
	t.modules.touch = false
	t.modules.mouse = false
end
