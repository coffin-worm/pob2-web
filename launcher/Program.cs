using System.Diagnostics;
using System.Runtime.InteropServices;

namespace PoB2Web;

/// <summary>
/// Path of Building 2, as a window rather than a terminal.
/// </summary>
/// <remarks>
/// <para>
/// What this replaces is <c>npm run dev</c>: a Node toolchain, a Vite
/// server on whichever of ten ports was free, a browser tab, and a console
/// window you have to leave open. All of that exists to do two things that
/// do not need Node at all, which are serving a folder of built files and
/// starting the engine beside it. This does those two things.
/// </para>
/// <para>
/// It is deliberately not a port of the dev server. The plugin is still
/// what you want while working on the UI, because it has hot reload and
/// this does not. This is what you want when you just want to use it.
/// </para>
/// </remarks>
static class Program
{
    /// <summary>
    /// Machine-wide, because two copies would each start an engine and the
    /// second one's would be the one the window talked to while the first
    /// sat there holding a build nobody could see.
    /// </summary>
    const string InstanceName = @"Local\PathOfBuilding2Web.instance";

    [STAThread]
    static void Main()
    {
        using var instance = new Mutex(initiallyOwned: true, InstanceName, out var only);
        if (!only)
        {
            FocusTheOtherOne();
            return;
        }

        ApplicationConfiguration.Initialize();

        string root, dist;
        try
        {
            root = Paths.FindRoot();
            dist = Paths.FindDist(root);
        }
        catch (LaunchFailure failure)
        {
            // Before there is a window to put it in, so this one is a box.
            MessageBox.Show(
                failure.Message, "Path of Building 2",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        using var engine = new Engine(root);
        Application.Run(new MainForm(engine, root, dist));
    }

    /// <summary>
    /// Bring the copy that is already running to the front, so a second
    /// double-click does something rather than nothing.
    /// </summary>
    static void FocusTheOtherOne()
    {
        var mine = Process.GetCurrentProcess();
        foreach (var other in Process.GetProcessesByName(mine.ProcessName))
        {
            if (other.Id == mine.Id || other.MainWindowHandle == IntPtr.Zero) continue;
            ShowWindow(other.MainWindowHandle, ShowRestore);
            SetForegroundWindow(other.MainWindowHandle);
            return;
        }
    }

    const int ShowRestore = 9;

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool ShowWindow(IntPtr window, int command);
}
