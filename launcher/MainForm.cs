using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PoB2Web;

/// <summary>
/// The window: a WebView2 showing the built UI, with the engine behind it.
/// </summary>
/// <remarks>
/// <para>
/// There is no local web server here, which is the main thing worth knowing
/// about this file. The UI is served straight off disk by WebView2's own
/// virtual host mapping, and the one path the UI asks for over HTTP, its
/// <c>/bridge</c> mount, is intercepted in process and forwarded to the
/// engine. So nothing listens on a port except the engine itself.
/// </para>
/// <para>
/// That is worth the slightly unusual shape. A second listening socket
/// would mean a second port to collide, a URL ACL to negotiate with
/// http.sys, and a window in which anything on the machine can talk to the
/// UI's origin. Interception has none of those, and it keeps the origin
/// fixed at <c>https://pob.local</c>, so whatever the page stores in local
/// storage is still there next time rather than being scoped to whichever
/// port it happened to get.
/// </para>
/// </remarks>
sealed class MainForm : Form
{
    /// <summary>
    /// The origin the UI runs on. Fixed, invented, and never resolved: the
    /// mapping below answers for it before DNS is ever consulted.
    /// </summary>
    const string Origin = "https://pob.local";
    const string Mount = "/bridge";
    /// <summary>
    /// The other mount: signing in to pathofexile.com and listing
    /// characters, which the dev server serves from a Vite plugin and this
    /// window serves from <see cref="PoeAccount"/>.
    /// </summary>
    const string Account = "/poe";

    readonly Engine _engine;
    readonly PoeAccount _poe;
    readonly string _dist;
    readonly WebView2 _view = new() { Dock = DockStyle.Fill, Visible = false };
    readonly Splash _splash = new() { Dock = DockStyle.Fill };
    readonly HttpClient _client = new()
    {
        // A first calculation on a large build is slow, and a timeout here
        // would surface as "the engine stopped answering" when it had not.
        Timeout = TimeSpan.FromMinutes(5),
    };

    public MainForm(Engine engine, string root, string dist)
    {
        _engine = engine;
        _poe = new PoeAccount(root, Trace);
        _dist = dist;

        Text = "Path of Building 2";
        // WinForms does not take the application icon for the window by
        // itself, so the title bar and the taskbar would keep the default
        // one while the file on disk had ours.
        try
        {
            if (Environment.ProcessPath is { } exe) Icon = Icon.ExtractAssociatedIcon(exe);
        }
        catch
        {
            // Not worth refusing to open over.
        }
        MinimumSize = new Size(980, 640);
        StartPosition = FormStartPosition.Manual;
        Restore(Geometry.Load());

        // The view goes in first so it ends up underneath: the splash is
        // what the window shows until there is something behind it.
        Controls.Add(_view);
        Controls.Add(_splash);
        _splash.BringToFront();
    }

    protected override async void OnLoad(EventArgs e)
    {
        base.OnLoad(e);

        try
        {
            // PoB parses its whole data set on boot, which takes seconds,
            // and a window that is blank for those seconds looks broken.
            _splash.Say("Starting the engine...");
            await _engine.EnsureAsync(CancellationToken.None);
            _splash.Say("Opening Path of Building...");
        }
        catch (LaunchFailure failure)
        {
            _splash.Fail("Path of Building could not start.", failure.Message);
            return;
        }
        catch (Exception failure)
        {
            _splash.Fail("Path of Building could not start.",
                failure.Message + "\r\n\r\n" + _engine.Log);
            return;
        }

        var environment = await CoreWebView2Environment.CreateAsync(
            userDataFolder: Path.Combine(Paths.UserData(), "WebView2"));
        await _view.EnsureCoreWebView2Async(environment);

        var core = _view.CoreWebView2;

        // Every request on this origin is answered here: the built files
        // straight off disk, and anything under the mount from the engine.
        //
        // The obvious shape was SetVirtualHostNameToFolderMapping for the
        // files plus a filter for the mount, and it does not work. A mapped
        // host is served entirely by the mapping and WebResourceRequested
        // never fires for it, so the mount returned a file-not-found and
        // the UI reported the engine unreachable while it was running
        // perfectly. Serving both halves here is one code path and no
        // precedence to get wrong.
        core.AddWebResourceRequestedFilter($"{Origin}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += OnRequest;

        // A build note or a wiki link should open where links open, not in a
        // second chromeless window with no address bar and no way back.
        core.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            // The sign-in is an ordinary link on this origin, and this
            // origin exists only inside this window: handed to the system
            // browser it resolves to nothing, which is exactly what the
            // import panel's sign-in button used to do. So the sign-in
            // starts here and what the browser is given is GGG's own URL.
            if (IsSignIn(args.Uri)) StartSignIn();
            else OpenExternally(args.Uri);
        };

        core.DocumentTitleChanged += (_, _) =>
            Text = string.IsNullOrWhiteSpace(core.DocumentTitle)
                ? "Path of Building 2"
                : core.DocumentTitle;

        // Swapped at the last possible moment, so there is never a frame of
        // empty white between the splash and the page.
        core.NavigationCompleted += (_, done) =>
        {
            if (!done.IsSuccess)
            {
                _splash.Fail("The interface would not load.",
                    $"WebView2 reported {done.WebErrorStatus} for {Origin}/index.html.\r\n\r\n" +
                    $"The built files were read from {_dist}.");
                return;
            }
            _view.Visible = true;
            _splash.Visible = false;
        };

        core.Navigate($"{Origin}/index.html");
    }

    /// <summary>
    /// One request on the UI's origin: a built file, or the engine.
    /// </summary>
    async void OnRequest(object? sender, CoreWebView2WebResourceRequestedEventArgs args)
    {
        // Taken before the first await, which is the contract: the event
        // args stop being valid the moment this method yields without one.
        var deferral = args.GetDeferral();
        try
        {
            var core = _view.CoreWebView2;
            var uri = new Uri(args.Request.Uri);
            if (Environment.GetEnvironmentVariable("POB_TRACE") == "1")
            {
                Trace($"{args.Request.Method} {uri.PathAndQuery}");
            }

            if (uri.AbsolutePath.StartsWith(Mount + "/", StringComparison.Ordinal))
            {
                args.Response = await FromEngine(
                    core, args.Request, uri.PathAndQuery[Mount.Length..]);
            }
            else if (uri.AbsolutePath.StartsWith(Account + "/", StringComparison.Ordinal))
            {
                args.Response = await FromAccount(
                    core, args.Request.Method, uri.PathAndQuery[Account.Length..]);
            }
            else
            {
                args.Response = FromDisk(core, uri.AbsolutePath);
            }
        }
        catch (Exception failure)
        {
            // A handler that throws leaves no response and the page sees a
            // bare network error, which says nothing about what happened.
            Trace($"{args.Request.Uri}: {failure}");
        }
        finally
        {
            deferral.Complete();
        }
    }

    /// <summary>
    /// Forwarded to the engine, and answered.
    /// </summary>
    /// <remarks>
    /// The shape of the reply follows the dev server's plugin exactly, down
    /// to answering JSON on failure as well as success: the UI's own
    /// <c>request()</c> reads <c>{ error }</c> out of the body and shows it,
    /// and a transport-shaped failure that arrives as HTML surfaces as a
    /// parse error instead of as the thing that went wrong.
    /// </remarks>
    async Task<CoreWebView2WebResourceResponse> FromEngine(
        CoreWebView2 core, CoreWebView2WebResourceRequest request, string path)
    {
        try
        {
            await _engine.EnsureAsync(CancellationToken.None);
            var upstream = await Forward(request, path);
            return core.Environment.CreateWebResourceResponse(
                new MemoryStream(await upstream.Content.ReadAsByteArrayAsync()),
                (int)upstream.StatusCode,
                upstream.ReasonPhrase ?? "OK",
                Json);
        }
        catch (Exception failure)
        {
            Trace($"{path}: {failure}");
            return core.Environment.CreateWebResourceResponse(
                new MemoryStream(JsonSerializer.SerializeToUtf8Bytes(
                    new { error = $"the engine stopped answering: {failure.Message}" })),
                502, "Bad Gateway", Json);
        }
    }

    /// <summary>
    /// Answered by the account transport, which never touches the engine.
    /// </summary>
    /// <remarks>
    /// Shaped like the engine mount above and for the same reason: the UI's
    /// own reader pulls <c>{ error }</c> out of the body, so a failure that
    /// arrives as anything but JSON surfaces as a parse error rather than
    /// as the thing that went wrong. That is not hypothetical. Before this
    /// mount existed these requests fell through to the static files and
    /// came back as <c>404 Not found</c> in plain text, and the panel said
    /// the route did not return JSON.
    /// </remarks>
    async Task<CoreWebView2WebResourceResponse> FromAccount(
        CoreWebView2 core, string method, string pathAndQuery)
    {
        var reply = await _poe.HandleAsync(method, pathAndQuery);
        return core.Environment.CreateWebResourceResponse(
            new MemoryStream(Encoding.UTF8.GetBytes(reply.Body)),
            reply.Status, Reason(reply.Status),
            $"Content-Type: {reply.ContentType}\r\nCache-Control: no-store");
    }

    /// <summary>
    /// The reason phrase, for the statuses the transport answers with.
    /// </summary>
    static string Reason(int status) => status switch
    {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        _ => "Error",
    };

    /// <summary>Whether a link is the import panel's sign-in.</summary>
    static bool IsSignIn(string uri) =>
        Uri.TryCreate(uri, UriKind.Absolute, out var parsed)
        && parsed.GetLeftPart(UriPartial.Authority) == Origin
        && parsed.AbsolutePath.TrimEnd('/') == Account + "/signin";

    /// <summary>
    /// Start a sign-in and send the browser to GGG.
    /// </summary>
    /// <remarks>
    /// Nothing is awaited by the caller: a link click has nobody to hand an
    /// exception to. <see cref="PoeAccount.BeginSignInAsync"/> records what
    /// went wrong, and the panel's status poll is where it shows up.
    /// </remarks>
    async void StartSignIn()
    {
        try
        {
            OpenExternally(await _poe.BeginSignInAsync());
        }
        catch (Exception failure)
        {
            Trace($"sign-in: {failure}");
        }
    }

    /// <summary>
    /// One of the built files, read off disk.
    /// </summary>
    CoreWebView2WebResourceResponse FromDisk(CoreWebView2 core, string absolutePath)
    {
        var relative = Uri.UnescapeDataString(absolutePath).TrimStart('/');
        if (relative.Length == 0) relative = "index.html";

        // The page cannot reach outside the built folder, however the path
        // is spelled. This origin is ours, but the content on it is a web
        // app and a web app is never trusted with a file path.
        var full = Path.GetFullPath(Path.Combine(_dist, relative.Replace('/', Path.DirectorySeparatorChar)));
        var root = Path.GetFullPath(_dist) + Path.DirectorySeparatorChar;

        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
        {
            return core.Environment.CreateWebResourceResponse(
                new MemoryStream("Not found"u8.ToArray()),
                404, "Not Found", "Content-Type: text/plain; charset=utf-8");
        }

        // No caching: the whole point of serving from a folder rather than
        // embedding is that rebuilding the UI is enough to see the change.
        return core.Environment.CreateWebResourceResponse(
            File.OpenRead(full), 200, "OK",
            $"Content-Type: {ContentType(full)}\r\nCache-Control: no-cache");
    }

    const string Json = "Content-Type: application/json; charset=utf-8";

    static string ContentType(string file) => Path.GetExtension(file).ToLowerInvariant() switch
    {
        ".html" => "text/html; charset=utf-8",
        ".js" or ".mjs" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".json" or ".map" => "application/json; charset=utf-8",
        ".svg" => "image/svg+xml",
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        ".ico" => "image/x-icon",
        ".woff2" => "font/woff2",
        ".woff" => "font/woff",
        ".ttf" => "font/ttf",
        ".txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    };

    async Task<HttpResponseMessage> Forward(CoreWebView2WebResourceRequest request, string path)
    {
        using var forwarded = new HttpRequestMessage(
            new HttpMethod(request.Method), $"http://127.0.0.1:{_engine.Port}{path}");

        if (request.Content is { } content && request.Method is not ("GET" or "HEAD"))
        {
            var buffer = new MemoryStream();
            await content.CopyToAsync(buffer);
            buffer.Position = 0;
            forwarded.Content = new StreamContent(buffer);
            forwarded.Content.Headers.TryAddWithoutValidation("Content-Type", "application/json");
        }

        return await _client.SendAsync(forwarded);
    }

    static void Trace(string line)
    {
        try
        {
            File.AppendAllText(
                Path.Combine(Paths.UserData(), "trace.log"),
                $"{DateTime.Now:HH:mm:ss.fff} {line}{Environment.NewLine}");
        }
        catch
        {
            // Diagnostics are never worth a crash.
        }
    }

    static void OpenExternally(string uri)
    {
        // Only the two schemes a link in a build note could sensibly use.
        // Handing an arbitrary string to the shell is how a page gets to
        // run a program.
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) return;
        if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) return;

        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(parsed.AbsoluteUri)
        {
            UseShellExecute = true,
        });
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        Geometry.Save(CaptureGeometry());
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            // The account token is held in memory and nowhere else, so
            // closing the window is what signs you out.
            _poe.Dispose();
            _client.Dispose();
            _view.Dispose();
        }
        base.Dispose(disposing);
    }

    // ----------------------------------------------------------- geometry

    void Restore(Geometry? saved)
    {
        var bounds = saved?.Bounds();
        // A window remembered on a monitor that is no longer there opens
        // off-screen, where it looks exactly like a program that failed to
        // start. So the saved rectangle has to still be somewhere visible.
        if (bounds is { } rect && Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(rect)))
        {
            Bounds = rect;
            WindowState = saved!.Maximised ? FormWindowState.Maximized : FormWindowState.Normal;
            return;
        }

        var working = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 800);
        Size = new Size(
            Math.Max(MinimumSize.Width, (int)(working.Width * 0.85)),
            Math.Max(MinimumSize.Height, (int)(working.Height * 0.85)));
        Location = new Point(
            working.X + (working.Width - Width) / 2,
            working.Y + (working.Height - Height) / 2);
    }

    Geometry CaptureGeometry()
    {
        // RestoreBounds rather than Bounds, so maximising and closing does
        // not remember the maximised rectangle as the restored one.
        var rect = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
        return new Geometry(rect.X, rect.Y, rect.Width, rect.Height,
            WindowState == FormWindowState.Maximized);
    }
}

/// <summary>Where the window was last time, if anyone can still see it.</summary>
sealed record Geometry(int X, int Y, int Width, int Height, bool Maximised)
{
    static string File => Path.Combine(Paths.UserData(), "window.json");

    public Rectangle Bounds() => new(X, Y, Width, Height);

    public static Geometry? Load()
    {
        try
        {
            return System.IO.File.Exists(File)
                ? JsonSerializer.Deserialize<Geometry>(System.IO.File.ReadAllText(File))
                : null;
        }
        catch
        {
            // A corrupt or unreadable file is not worth refusing to open over.
            return null;
        }
    }

    public static void Save(Geometry geometry)
    {
        try
        {
            System.IO.File.WriteAllText(File, JsonSerializer.Serialize(geometry));
        }
        catch
        {
            // Likewise: losing the window position is not worth a dialog.
        }
    }
}
