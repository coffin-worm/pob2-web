namespace PoB2Web;

/// <summary>
/// Where everything is.
/// </summary>
/// <remarks>
/// <para>
/// The launcher runs from two places and has to find the same four things
/// from both: a developer's checkout, where it sits several directories
/// deep under <c>launcher/bin</c>, and a shipped folder, where it sits
/// beside <c>bridge/</c> and <c>src/</c>. Rather than keep two layouts
/// straight it walks up from its own directory looking for the one pair of
/// files that identifies a PoB checkout, which covers both and also covers
/// whatever third layout somebody invents later.
/// </para>
/// <para>
/// Every lookup takes an environment override first, because the one thing
/// worse than a wrong guess is a wrong guess you cannot argue with.
/// </para>
/// </remarks>
static class Paths
{
    /// <summary>The checkout: the directory holding src/, runtime/ and bridge/.</summary>
    public static string FindRoot()
    {
        var configured = Environment.GetEnvironmentVariable("POB_ROOT");
        if (!string.IsNullOrWhiteSpace(configured))
        {
            if (!IsRoot(configured))
            {
                throw new LaunchFailure(
                    $"POB_ROOT is set to {configured}, which does not hold bridge/main.lua and src/.");
            }
            return Path.GetFullPath(configured);
        }

        var walk = AppContext.BaseDirectory;
        for (var i = 0; i < 8 && walk is not null; i++)
        {
            if (IsRoot(walk)) return Path.GetFullPath(walk);
            walk = Path.GetDirectoryName(walk.TrimEnd(Path.DirectorySeparatorChar));
        }

        throw new LaunchFailure(
            "No Path of Building checkout was found above " + AppContext.BaseDirectory +
            ". The launcher expects to sit beside bridge/ and src/, or inside the checkout. " +
            "Set POB_ROOT to point at it.");
    }

    static bool IsRoot(string candidate) =>
        File.Exists(Path.Combine(candidate, "bridge", "main.lua")) &&
        Directory.Exists(Path.Combine(candidate, "src"));

    /// <summary>The built web UI, which is what the window actually shows.</summary>
    public static string FindDist(string root)
    {
        var dist = Path.Combine(root, "web", "dist");
        if (!File.Exists(Path.Combine(dist, "index.html")))
        {
            throw new LaunchFailure(
                "The web UI has not been built. Run `npm run build` in web/, " +
                $"which writes {dist}.");
        }
        return dist;
    }

    /// <summary>
    /// LOVE, which is a LuaJIT host that happens to be installed.
    /// </summary>
    /// <remarks>
    /// A copy vendored beside the launcher wins, because that is the whole
    /// point of a shipped folder: a machine that has never heard of LOVE
    /// should still be able to open this. Then the environment override,
    /// then the places an installer puts it. The same list the dev server's
    /// plugin uses, with the vendored path on the front.
    /// </remarks>
    public static string FindLove(string root)
    {
        var configured = Environment.GetEnvironmentVariable("POB_LOVE");
        if (!string.IsNullOrWhiteSpace(configured))
        {
            if (!File.Exists(configured))
            {
                throw new LaunchFailure($"POB_LOVE is set to {configured}, which does not exist.");
            }
            return configured;
        }

        string[] candidates =
        [
            Path.Combine(AppContext.BaseDirectory, "love", "lovec.exe"),
            Path.Combine(root, "love", "lovec.exe"),
            @"C:\Program Files\LOVE\lovec.exe",
            @"C:\Program Files (x86)\LOVE\lovec.exe",
        ];

        foreach (var candidate in candidates)
        {
            if (File.Exists(candidate)) return candidate;
        }

        throw new LaunchFailure(
            "LOVE was not found. Install it from love2d.org, put a copy in a love/ " +
            "folder beside this program, or set POB_LOVE to lovec.exe.");
    }

    /// <summary>
    /// Where the browser keeps its profile, and where the window size is
    /// remembered. Beside the program would mean a read-only install cannot
    /// run, and a shared one cannot have two users.
    /// </summary>
    public static string UserData()
    {
        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "PathOfBuilding2Web");
        Directory.CreateDirectory(dir);
        return dir;
    }
}

/// <summary>
/// Something the user can fix, said in a sentence rather than a stack trace.
/// </summary>
sealed class LaunchFailure(string message) : Exception(message);
