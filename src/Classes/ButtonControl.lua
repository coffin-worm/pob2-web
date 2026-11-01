-- Path of Building
--
-- Class: Button Control
-- Basic button control.
--
---@class ButtonControl: Control, TooltipHost
local ButtonClass = newClass("ButtonControl", "Control", "TooltipHost")

function ButtonClass:ButtonControl(anchor, rect, label, onClick, onHover, forceTooltip)
	self:Control(anchor, rect)
	self:TooltipHost()
	self.label = label
	self.onClick = onClick
	self.onHover = onHover
	self.forceTooltip = forceTooltip
	return self
end

function ButtonClass:Click()
	if self:IsShown() and self:IsEnabled() then
		self.onClick()
	end
end

function ButtonClass:SetImage(path)
	if path then
		self.image = NewImageHandle()
		self.image:Load(path)
	else
		self.image = nil
	end
end

function ButtonClass:IsMouseOver()
	if not self:IsShown() then
		return false
	end
	return self:IsMouseInBounds()
end

function ButtonClass:Draw(viewPort, noTooltip)
	local x, y = self:GetPos()
	local width, height = self:GetSize()
	local enabled = self:IsEnabled()
	local mOver = self:IsMouseOver()
	local locked = self:GetProperty("locked")
	-- nil = plain action button, false = unselected group member,
	-- true = the selected one. See restyle-tooling/apply_hierarchy.py.
	local inGroup = locked ~= nil
	if not enabled then
		SetUIColor("borderDisable")
	elseif locked then
		SetUIColor("borderActive")
	elseif mOver then
		SetUIColor("borderHover")
	elseif inGroup then
		SetUIColor("borderQuiet")
	else
		SetUIColor("border")
	end
	DrawRoundRect(x, y, width, height)
	if not enabled then
		SetUIColor("fillDisable")
	elseif self.clicked and mOver then
		SetUIColor("fillPressed")
	elseif locked then
		SetUIColor("fillSelected")
	elseif mOver then
		SetUIColor("fillHover")
	elseif inGroup then
		SetUIColor("fillQuiet")
	else
		SetUIColor("fill")
	end
	DrawRoundRect(x + 1, y + 1, width - 2, height - 2)
	if self.image then
		if enabled then
			SetDrawColor(1, 1, 1)
		else
			SetDrawColor(0.33, 0.33, 0.33)
		end
		DrawImage(self.image, x + 2, y + 2, width - 4, height - 4)
		if self.clicked and mOver then
			SetDrawColor(1, 1, 1, 0.5)
			DrawRoundRect(x + 1, y + 1, width - 2, height - 2)
		end
	end
	if not enabled then
		SetUIColor("textDisable")
	elseif locked or mOver then
		SetUIColor("textStrong")
	elseif inGroup then
		SetUIColor("textMuted")
	else
		SetUIColor("text")
	end
	local label = self:GetProperty("label")
	if label == "+" then
		DrawImage(nil, x + width * 0.2, y + height * 0.45, width * 0.6, height * 0.1)
		DrawImage(nil, x + width * 0.45, y + height * 0.2, width * 0.1, height * 0.6)
	elseif label == "-" then
		DrawImage(nil, x + width * 0.2, y + height * 0.45, width * 0.6, height * 0.1)
	elseif label == "x" then
		DrawImageQuad(nil, x + width * 0.2, y + height * 0.3, x + width * 0.3, y + height * 0.2, x + width * 0.8, y + height * 0.7, x + width * 0.7, y + height * 0.8)
		DrawImageQuad(nil, x + width * 0.7, y + height * 0.2, x + width * 0.8, y + height * 0.3, x + width * 0.3, y + height * 0.8, x + width * 0.2, y + height * 0.7)
	else
		local overSize = self.overSizeText or 0
		local labelSize = ControlFontSize(height) + overSize * 2
		DrawString(x + width / 2, y + (height - labelSize) / 2, "CENTER_X", labelSize, "VAR", label)
	end
	if mOver then
		if not noTooltip or self.forceTooltip then
			SetDrawLayer(nil, 100)
			self:DrawTooltip(x, y, width, height, viewPort)
			SetDrawLayer(nil, 0)
		end
		if self.onHover ~= nil then
			return self.onHover()
		end
	end
end

function ButtonClass:OnKeyDown(key)
	if not self:IsShown() or not self:IsEnabled() then
		return
	end
	if key == "LEFTBUTTON" then
		self.clicked = true
	elseif self.enterFunc then
		self.enterFunc()
	end
	return self
end

function ButtonClass:OnKeyUp(key)
	if not self:IsShown() or not self:IsEnabled() then
		return
	end
	if key == "LEFTBUTTON" and self.clicked then
		self.clicked = false
		if self:IsMouseOver() then
			return self.onClick()
		end
	end
	self.clicked = false
end
