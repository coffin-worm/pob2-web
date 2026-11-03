describe("TestLayout", function()
	it("derives the top bar's parts from its height", function()
		-- The bar splits as fill + edge, and one row of controls centres in
		-- the fill. These three were separate literals until the chrome and
		-- its controls drifted apart once too often.
		assert.are.equals(46, uiLayout.barHeight)
		assert.are.equals(42, uiLayout.barFill())
		assert.are.equals(9, uiLayout.barPadY())
		assert.are.equals(uiLayout.barFill() + uiLayout.edge, uiLayout.barHeight)
		assert.are.equals(uiLayout.barFill() - uiLayout.rowHeight,
			uiLayout.barPadY() * 2)
	end)

	it("stacks rows on one pitch", function()
		assert.are.equals(32, uiLayout.rowPitch())
		assert.are.equals(0, uiLayout.row(0))
		assert.are.equals(32, uiLayout.row(1))
		assert.are.equals(64, uiLayout.row(2))
		assert.are.equals(96, uiLayout.row(3))
	end)

	it("fits the side bar's content inside its own edge", function()
		assert.are.equals(300, uiLayout.sideBarContent())
		assert.are.equals(uiLayout.sideBarWidth,
			uiLayout.sideBarContent() + uiLayout.edge + uiLayout.pad * 2)
		assert.are.equals(50, uiLayout.sideBarTop(0))
		assert.are.equals(82, uiLayout.sideBarTop(1))
	end)

	it("moves every dependent measurement when the bar height changes", function()
		-- This is the whole point of the module: one token, and the fill, the
		-- edge position, the control row's centring and the side bar's origin
		-- all follow. Before, each was its own literal and a change left two
		-- or three behind, visible only in a screenshot.
		local was = uiLayout.barHeight
		finally(function() uiLayout.barHeight = was end)

		uiLayout.barHeight = 64
		assert.are.equals(60, uiLayout.barFill())
		assert.are.equals(18, uiLayout.barPadY())
		assert.are.equals(68, uiLayout.sideBarTop(0))
		-- The row rhythm is independent of the bar, so it must not move.
		assert.are.equals(32, uiLayout.rowPitch())
	end)

	it("snaps font sizes onto the atlas ladder", function()
		-- Only these pixel heights exist under runtime/SimpleGraphic/Fonts.
		-- Anything else is served by scaling a neighbour, which is how the
		-- stat bar's 11px label was quietly blurry.
		for _, size in ipairs({ 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 56, 64 }) do
			assert.are.equals(size, SnapFontSize(size))
		end
		assert.are.equals(12, SnapFontSize(11)) -- ties go to the larger size
		assert.are.equals(14, SnapFontSize(13))
		assert.are.equals(28, SnapFontSize(29))
		assert.are.equals(32, SnapFontSize(31))
		assert.are.equals(10, SnapFontSize(4)) -- below the ladder
		assert.are.equals(64, SnapFontSize(200)) -- above it
	end)

	it("keeps control labels on the ladder and under the cap", function()
		assert.are.equals(16, ControlFontSize(24))
		assert.are.equals(16, ControlFontSize(64))
		assert.are.equals(16, ControlFontSize(22))
		assert.are.equals(10, ControlFontSize(14))
	end)
end)
