function love.conf(t)
	t.identity = "pob-love"
	t.window.title = "Path of Building (LOVE host)"
	t.window.width = 1480
	t.window.height = 900
	t.window.resizable = true
	-- Open on the second monitor (1-based). Set to 1 for the primary.
	t.window.display = 2
	t.window.vsync = 1
	t.console = false
	t.modules.physics = false
	t.modules.joystick = false
	t.modules.video = false
end
