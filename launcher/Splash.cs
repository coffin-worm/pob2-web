namespace PoB2Web;

/// <summary>
/// What the window shows before the page is there, and instead of it when
/// something went wrong.
/// </summary>
/// <remarks>
/// A failure here is nearly always one of four things: LOVE is not
/// installed, the web UI has not been built, the engine crashed on boot, or
/// the checkout is not where the launcher thought. All four are fixable by
/// the person reading the message, so the message is the whole point of
/// this control, and the engine's own last words go in a box they can
/// select and paste rather than a dialog they can only dismiss.
/// </remarks>
sealed class Splash : Panel
{
    readonly Label _message = new()
    {
        AutoSize = false,
        Dock = DockStyle.Top,
        Height = 48,
        TextAlign = ContentAlignment.MiddleCenter,
        Font = new Font(SystemFonts.MessageBoxFont?.FontFamily ?? SystemFonts.DefaultFont.FontFamily, 12f),
    };

    readonly TextBox _detail = new()
    {
        Dock = DockStyle.Fill,
        Multiline = true,
        ReadOnly = true,
        ScrollBars = ScrollBars.Vertical,
        BorderStyle = BorderStyle.None,
        Visible = false,
        Font = new Font(FontFamily.GenericMonospace, 9f),
    };

    readonly Panel _body = new() { Dock = DockStyle.Fill, Padding = new Padding(48, 24, 48, 48) };

    public Splash()
    {
        // The app is dark, so a white splash is a flash in the face every
        // time it opens. These are the web UI's own base colours.
        BackColor = Color.FromArgb(0x14, 0x16, 0x1a);
        _message.ForeColor = Color.FromArgb(0xe6, 0xe8, 0xec);
        _detail.BackColor = BackColor;
        _detail.ForeColor = Color.FromArgb(0xa0, 0xa6, 0xb0);

        _body.Controls.Add(_detail);
        Controls.Add(_body);
        Controls.Add(_message);
        _message.BringToFront();
    }

    public void Say(string message)
    {
        _message.Text = message;
        _detail.Visible = false;
    }

    public void Fail(string message, string detail)
    {
        _message.Text = message;
        _message.ForeColor = Color.FromArgb(0xe0, 0x57, 0x4b);
        _detail.Text = detail.ReplaceLineEndings();
        _detail.Visible = true;
        Visible = true;
        BringToFront();
    }
}
