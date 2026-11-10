using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PoB2Web;

/// <summary>
/// Signing in to pathofexile.com and listing characters, for the window.
/// </summary>
/// <remarks>
/// <para>
/// This is the same six endpoints the dev server serves from
/// <c>web/plugins/poe-account.ts</c>, under the same <c>/poe</c> mount and
/// with the same bodies, because the UI is the same build either way and
/// knows only the contract. In the browser those routes are Vite
/// middleware; here there is no Vite, and before this file there was
/// nothing: a request for <c>/poe/status</c> fell through to the static
/// file handler, came back as <c>404 Not found</c> in <c>text/plain</c>,
/// and the import panel reported that it did not return JSON.
/// </para>
/// <para>
/// Two implementations of one contract is a real cost, and it is the lesser
/// one. The engine cannot do this itself: PoB's own OAuth lives in
/// <c>PoEAPI.lua</c> and runs on <c>LaunchSubScript</c> and
/// <c>launch:DownloadPage</c>, both of which are empty stubs in the
/// headless host, so the transport has to live wherever there is TLS and a
/// socket library. In the browser build that is node; in the window it is
/// this process.
/// </para>
/// <para>
/// What does not move is the import. The character JSON goes to the
/// bridge's <c>POST /code/character</c> untouched, which calls PoB's own
/// <c>ImportItemsAndSkills</c> and <c>ImportPassiveTreeAndJewels</c>. This
/// file fetches bytes and holds a token; the engine decides what they mean.
/// </para>
/// <para>
/// Three details are copied rather than invented, because getting them
/// wrong fails in ways that look like something else: the client id is
/// <c>pob</c>, PoB's registered public client, which a fork cannot mint its
/// own of; the redirect ports are 49082, 49083 and 49084 with no path,
/// which are the origins GGG has registered, so a tidier
/// <c>/callback</c> earns <c>redirect_uri_mismatch</c>; and the User-Agent
/// is <c>Path of Building/&lt;version&gt;</c> from <c>manifest.xml</c>.
/// </para>
/// <para>
/// Tokens live in this object and nowhere else. They are not written to
/// disk, not given to the page, and not traced; closing the window means
/// signing in again. That is the right trade for a refresh token that can
/// read someone's account, and it is why the page only ever sees
/// <c>authenticated: true</c>.
/// </para>
/// </remarks>
sealed class PoeAccount : IDisposable
{
    const string ClientId = "pob";
    const string AuthHost = "https://www.pathofexile.com";
    const string ApiHost = "https://api.pathofexile.com";
    /// <summary>Always poe2 here; PoEAPI.lua takes it as an argument and says the same.</summary>
    const string Realm = "poe2";

    static readonly string[] Scopes =
        ["account:profile", "account:leagues", "account:characters", "account:trade"];

    /// <summary>Registered with the OAuth client. Not ours to choose.</summary>
    static readonly int[] RedirectPorts = [49082, 49083, 49084];

    /// <summary>
    /// How long the redirect listener waits.
    /// </summary>
    /// <remarks>
    /// PoB allows 60 seconds, which assumes an already-signed-in browser
    /// and one click. In practice there can be a login, a password manager
    /// and a Cloudflare challenge in the way, and a listener that gives up
    /// mid-challenge fails as "timed out" long after the person has stopped
    /// being able to tell what went wrong. An idle socket costs nothing.
    /// </remarks>
    static readonly TimeSpan SignInWindow = TimeSpan.FromMinutes(10);

    const string Json = "application/json; charset=utf-8";
    const string Html = "text/html; charset=utf-8";

    /// <summary>One answer, as the caller should put it on the wire.</summary>
    public readonly record struct Reply(int Status, string Body, string ContentType);

    sealed class Token
    {
        public required string Access { get; init; }
        public string? Refresh { get; init; }
        public DateTimeOffset ExpiresAt { get; init; }
    }

    sealed class Pending : IDisposable
    {
        public required string Verifier { get; init; }
        public required string State { get; init; }
        public required string RedirectUri { get; init; }
        public required TcpListener Listener { get; init; }
        public required CancellationTokenSource Cancel { get; init; }

        public void Dispose()
        {
            try { Cancel.Cancel(); } catch { /* already gone */ }
            try { Listener.Stop(); } catch { /* already gone */ }
            Cancel.Dispose();
        }
    }

    readonly HttpClient _client = new() { Timeout = TimeSpan.FromSeconds(30) };
    /// <summary>Guards the token and the pending sign-in, never a network call.</summary>
    readonly SemaphoreSlim _gate = new(1, 1);
    readonly Action<string> _trace;

    Token? _token;
    Pending? _pending;

    /// <summary>
    /// The last thing that went wrong.
    /// </summary>
    /// <remarks>
    /// Deliberately not cleared when it is read. The panel polls the status
    /// twice a second while a sign-in is open, so a message cleared on read
    /// is a message shown for one frame. It is cleared when the next
    /// sign-in starts, which is the only moment it stops being true.
    /// </remarks>
    string? _lastError;

    public PoeAccount(string root, Action<string> trace)
    {
        _trace = trace;
        _client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", UserAgent(root));
    }

    /// <summary>base64 in the URL alphabet with no padding, as PKCE wants.</summary>
    static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes)
        .Replace('+', '-')
        .Replace('/', '_')
        .TrimEnd('=');

    /// <summary><c>Path of Building/0.23.1</c>, the string the desktop app sends.</summary>
    static string UserAgent(string root)
    {
        var version = "0.0.0";
        try
        {
            var manifest = File.ReadAllText(Path.Combine(root, "manifest.xml"));
            var match = System.Text.RegularExpressions.Regex.Match(
                manifest, "<Version number=\"([^\"]+)\"");
            if (match.Success) version = match.Groups[1].Value;
        }
        catch
        {
            // A missing manifest is not worth refusing to talk to the API over.
        }
        return $"Path of Building/{version}";
    }

    /* ------------------------------------------------------------- routing */

    /// <summary>
    /// One request under the mount, with the mount already taken off.
    /// </summary>
    public async Task<Reply> HandleAsync(string method, string pathAndQuery)
    {
        var split = pathAndQuery.IndexOf('?');
        var path = (split < 0 ? pathAndQuery : pathAndQuery[..split]).TrimEnd('/');
        if (path.Length == 0) path = "/";
        var query = Query(split < 0 ? "" : pathAndQuery[(split + 1)..]);

        try
        {
            switch ($"{method} {path}")
            {
                case "GET /status":
                    return Ok(await StatusAsync());

                case "GET /signin":
                {
                    var authUrl = await BeginSignInAsync();
                    if (query.GetValueOrDefault("format") == "json")
                    {
                        return Ok(new { authUrl });
                    }
                    // Not a 302, which the dev server can afford and this
                    // cannot: a redirect here would navigate the app's own
                    // window to GGG and leave the person with no way back.
                    // The browser is the right place for a sign-in, so it
                    // is opened there and this says so.
                    return new Reply(200, Opened(authUrl), Html);
                }

                case "POST /signout":
                {
                    await _gate.WaitAsync();
                    try
                    {
                        _token = null;
                        _pending?.Dispose();
                        _pending = null;
                        _lastError = null;
                    }
                    finally { _gate.Release(); }
                    return Ok(new { authenticated = false });
                }

                case "GET /characters":
                {
                    var result = await ApiGetAsync($"/character/{Realm}");
                    if (result.Status != 200) return Failed(result, "could not list characters");

                    // Trimmed to what the list actually shows. The full
                    // object is large and the page has no use for the rest.
                    using var parsed = JsonDocument.Parse(result.Body);
                    var characters = new List<object>();
                    if (parsed.RootElement.TryGetProperty("characters", out var list)
                        && list.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var entry in list.EnumerateArray())
                        {
                            characters.Add(new
                            {
                                name = Text(entry, "name"),
                                @class = Text(entry, "class"),
                                level = Number(entry, "level"),
                                league = entry.TryGetProperty("league", out var league)
                                    && league.ValueKind == JsonValueKind.String
                                        ? league.GetString()
                                        : null,
                                current = Flag(entry, "current"),
                                expired = Flag(entry, "expired"),
                                deleted = Flag(entry, "deleted"),
                            });
                        }
                    }
                    return Ok(new { characters });
                }

                case "GET /character":
                {
                    var name = query.GetValueOrDefault("name");
                    if (string.IsNullOrEmpty(name)) return Error(400, "expected ?name=");

                    var result = await ApiGetAsync($"/character/{Realm}/{Uri.EscapeDataString(name)}");
                    if (result.Status != 200) return Failed(result, "could not fetch that character");

                    // Passed through exactly as GGG sent it. The envelope it
                    // comes in is the engine's business, not this file's:
                    // the bridge unwraps it, so one place knows the shape.
                    return new Reply(200, result.Body, Json);
                }

                default:
                    return Error(404, $"no route {method} {path}");
            }
        }
        catch (Exception failure)
        {
            return Error(500, failure.Message);
        }
    }

    async Task<object> StatusAsync()
    {
        await _gate.WaitAsync();
        try
        {
            return new
            {
                authenticated = _token is not null,
                signInPending = _pending is not null,
                expiresAt = _token is null
                    ? (long?)null
                    : _token.ExpiresAt.ToUnixTimeMilliseconds(),
                error = _lastError,
            };
        }
        finally { _gate.Release(); }
    }

    static Reply Ok(object body) =>
        new(200, JsonSerializer.Serialize(body), Json);

    static Reply Error(int status, string message) =>
        new(status, JsonSerializer.Serialize(new { error = message }), Json);

    /// <summary>An API failure, with GGG's own message where there is one.</summary>
    static Reply Failed(ApiResult result, string fallback)
    {
        var message = fallback;
        try
        {
            using var parsed = JsonDocument.Parse(result.Body);
            if (parsed.RootElement.TryGetProperty("error", out var error)
                && error.ValueKind == JsonValueKind.String)
            {
                message = error.GetString() ?? fallback;
            }
        }
        catch
        {
            // Not JSON, so the fallback is the better of the two anyway.
        }
        return new Reply(
            result.Status,
            JsonSerializer.Serialize(new { error = message, retryAfter = result.RetryAfter }),
            Json);
    }

    static string Text(JsonElement entry, string name) =>
        entry.TryGetProperty(name, out var found) && found.ValueKind == JsonValueKind.String
            ? found.GetString() ?? ""
            : "";

    static int Number(JsonElement entry, string name) =>
        entry.TryGetProperty(name, out var found) && found.ValueKind == JsonValueKind.Number
            ? found.GetInt32()
            : 0;

    static bool Flag(JsonElement entry, string name) =>
        entry.TryGetProperty(name, out var found) && found.ValueKind == JsonValueKind.True;

    /// <summary>A query string, as a map. Manual because it is this short.</summary>
    static Dictionary<string, string> Query(string raw)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in raw.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var at = pair.IndexOf('=');
            var key = Uri.UnescapeDataString((at < 0 ? pair : pair[..at]).Replace('+', ' '));
            var value = at < 0 ? "" : Uri.UnescapeDataString(pair[(at + 1)..].Replace('+', ' '));
            map[key] = value;
        }
        return map;
    }

    /* ---------------------------------------------------------- the sign-in */

    /// <summary>
    /// Start a sign-in and return the URL a browser should go to.
    /// </summary>
    /// <remarks>
    /// Nothing here opens a browser or submits anything. The credentials
    /// are typed on GGG's own page, which is the only place they should be.
    /// </remarks>
    public async Task<string> BeginSignInAsync()
    {
        await _gate.WaitAsync();
        try
        {
            _pending?.Dispose();
            _pending = null;
            _lastError = null;

            var verifier = Base64Url(RandomNumberGenerator.GetBytes(32));
            var challenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
            var state = Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant();

            var (listener, port) = Bind();
            var cancel = new CancellationTokenSource(SignInWindow);
            var pending = new Pending
            {
                Verifier = verifier,
                State = state,
                // No path, and localhost rather than 127.0.0.1: this exact
                // string is what GGG has registered.
                RedirectUri = $"http://localhost:{port}",
                Listener = listener,
                Cancel = cancel,
            };
            _pending = pending;

            _ = Task.Run(() => WaitForRedirectAsync(pending), CancellationToken.None);

            // Built by hand rather than with a query builder so the scopes
            // are %20-separated, matching PoEAPI.lua:97 exactly.
            return $"{AuthHost}/oauth/authorize?client_id={ClientId}" +
                "&response_type=code" +
                $"&scope={Uri.EscapeDataString(string.Join(' ', Scopes))}" +
                $"&state={state}" +
                $"&code_challenge={challenge}" +
                "&code_challenge_method=S256" +
                $"&redirect_uri={Uri.EscapeDataString(pending.RedirectUri)}";
        }
        catch (Exception failure)
        {
            // Recorded as well as thrown: the window starts a sign-in from
            // a link click, where there is nobody to hand an exception to,
            // and the status poll is how the panel finds out.
            _lastError = failure.Message;
            throw;
        }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// Bind the redirect listener to one of the registered ports.
    /// </summary>
    /// <remarks>
    /// Tried in order, as LaunchServer.lua does. A raw socket rather than
    /// HttpListener, which would want a URL reservation from http.sys; the
    /// exchange here is one GET and one page, which is less HTTP than
    /// negotiating for the right to listen.
    /// </remarks>
    static (TcpListener Listener, int Port) Bind()
    {
        foreach (var port in RedirectPorts)
        {
            // Explicitly IPv4: the redirect URI says localhost, and a
            // listener on ::1 alone does not catch a browser that resolves
            // it to 127.0.0.1.
            var listener = new TcpListener(IPAddress.Loopback, port);
            try
            {
                listener.Start();
                return (listener, port);
            }
            catch (SocketException)
            {
                listener.Dispose();
            }
        }

        throw new InvalidOperationException(
            $"ports {string.Join(", ", RedirectPorts)} are all in use. These are the " +
            "redirect ports registered with the OAuth client, so sign-in cannot use " +
            "another one. Close the desktop PoB if it is signing in.");
    }

    /// <summary>
    /// Wait for GGG to send the browser back, and spend the code.
    /// </summary>
    /// <remarks>
    /// Anything that is not the redirect is answered and ignored, and the
    /// listener keeps listening. LaunchServer.lua has the same patience,
    /// for the same reason: VPNs and OS services probe freshly opened
    /// ports, and giving up on the first stray connection loses the real
    /// one.
    /// </remarks>
    async Task WaitForRedirectAsync(Pending pending)
    {
        var cancel = pending.Cancel.Token;
        try
        {
            while (!cancel.IsCancellationRequested)
            {
                using var client = await pending.Listener.AcceptTcpClientAsync(cancel);
                if (await ServeRedirectAsync(client, pending, cancel)) return;
            }
            await Finish(pending, null, "sign-in timed out before the browser came back");
        }
        catch (OperationCanceledException)
        {
            await Finish(pending, null, "sign-in timed out before the browser came back");
        }
        catch (Exception failure)
        {
            _trace($"sign-in listener: {failure}");
            await Finish(pending, null, failure.Message);
        }
    }

    /// <summary>One connection. True when it was the redirect.</summary>
    async Task<bool> ServeRedirectAsync(
        TcpClient client, Pending pending, CancellationToken cancel)
    {
        using var stream = client.GetStream();

        // One read: a browser sends its whole request line in the first
        // segment, and nothing past the line is wanted. A stray connection
        // that sends nothing at all falls out as an empty request.
        var buffer = new byte[8192];
        var read = await stream.ReadAsync(buffer, cancel);
        var request = Encoding.ASCII.GetString(buffer, 0, read);
        var line = request.Split("\r\n", 2)[0].Split(' ');

        if (line.Length < 2)
        {
            await Respond(stream, 400, "Bad Request", "", cancel);
            return false;
        }
        if (line[0] != "GET")
        {
            await Respond(stream, 405, "Method Not Allowed", "", cancel);
            return false;
        }

        var target = line[1];
        var split = target.IndexOf('?');
        var query = Query(split < 0 ? "" : target[(split + 1)..]);
        var code = query.GetValueOrDefault("code");
        var error = query.GetValueOrDefault("error");

        if (string.IsNullOrEmpty(code) && string.IsNullOrEmpty(error))
        {
            await Respond(stream, 204, "No Content", "", cancel);
            return false;
        }

        Token? token = null;
        string? failure = null;

        if (!string.IsNullOrEmpty(error))
        {
            failure = $"{error}: {query.GetValueOrDefault("error_description") ?? "no description"}";
        }
        // The state check is the whole defence against a forged redirect,
        // so a mismatch throws the code away rather than spending it.
        else if (query.GetValueOrDefault("state") != pending.State)
        {
            failure = "OAuth state mismatch; the sign-in was not completed";
        }
        else
        {
            try
            {
                token = await PostTokenAsync(new Dictionary<string, string>
                {
                    ["client_id"] = ClientId,
                    ["grant_type"] = "authorization_code",
                    ["code"] = code!,
                    ["redirect_uri"] = pending.RedirectUri,
                    ["scope"] = string.Join(' ', Scopes),
                    ["code_verifier"] = pending.Verifier,
                });
            }
            catch (Exception caught)
            {
                failure = caught.Message;
            }
        }

        try
        {
            // Answered before the sign-in is put away, and that order is
            // the whole point: Finish cancels this connection's own
            // cancellation token, so writing the page afterwards wrote it
            // into a cancelled stream and the browser got an empty reply
            // on the way back from a sign-in that had just worked.
            await Respond(stream, 200, "OK", LandingPage(failure is null, failure), cancel);
        }
        finally
        {
            await Finish(pending, token, failure);
        }
        return true;
    }

    /// <summary>Put the sign-in away, with a token or with a reason.</summary>
    async Task Finish(Pending pending, Token? token, string? failure)
    {
        await _gate.WaitAsync();
        try
        {
            // Only if this is still the sign-in in progress: a second one
            // started since has already taken over, and finishing the first
            // would clear its listener out from under it.
            if (!ReferenceEquals(_pending, pending)) return;
            if (token is not null) _token = token;
            if (failure is not null) _lastError = failure;
            _pending.Dispose();
            _pending = null;
        }
        finally { _gate.Release(); }
    }

    static async Task Respond(
        NetworkStream stream, int status, string reason, string body, CancellationToken cancel)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        var head = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 {status} {reason}\r\n" +
            (body.Length == 0 ? "" : $"Content-Type: {Html}\r\n") +
            $"Content-Length: {bytes.Length}\r\n" +
            "Connection: close\r\n\r\n");
        await stream.WriteAsync(head, cancel);
        if (bytes.Length > 0) await stream.WriteAsync(bytes, cancel);
        await stream.FlushAsync(cancel);
    }

    /* --------------------------------------------------------------- tokens */

    /// <summary>POST to the token endpoint. Shared by the code and refresh grants.</summary>
    async Task<Token> PostTokenAsync(Dictionary<string, string> body)
    {
        using var response = await _client.PostAsync(
            $"{AuthHost}/oauth/token", new FormUrlEncodedContent(body));
        var text = await response.Content.ReadAsStringAsync();

        if (!response.IsSuccessStatusCode)
        {
            // GGG's error bodies are small and specific ("invalid_grant"),
            // and far more use than the status alone.
            throw new InvalidOperationException(
                $"token endpoint returned {(int)response.StatusCode}: " +
                text[..Math.Min(200, text.Length)]);
        }

        using var parsed = JsonDocument.Parse(text);
        var access = parsed.RootElement.TryGetProperty("access_token", out var found)
            ? found.GetString()
            : null;
        if (string.IsNullOrEmpty(access))
        {
            throw new InvalidOperationException("the token endpoint returned no access token");
        }

        return new Token
        {
            Access = access,
            Refresh = parsed.RootElement.TryGetProperty("refresh_token", out var refresh)
                ? refresh.GetString()
                : null,
            ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(
                parsed.RootElement.TryGetProperty("expires_in", out var expires)
                    ? expires.GetInt32()
                    : 600),
        };
    }

    /// <summary>A valid access token, refreshed if it is close to expiry.</summary>
    async Task<string?> ValidTokenAsync(bool force = false)
    {
        await _gate.WaitAsync();
        try
        {
            if (_token is null) return null;
            // Thirty seconds of slack: a token that expires mid-flight
            // reads as a mysterious 401 rather than as the clock.
            if (!force && _token.ExpiresAt > DateTimeOffset.UtcNow.AddSeconds(30))
            {
                return _token.Access;
            }
            if (_token.Refresh is not { } refresh)
            {
                _token = null;
                return null;
            }
            try
            {
                _token = await PostTokenAsync(new Dictionary<string, string>
                {
                    ["client_id"] = ClientId,
                    ["grant_type"] = "refresh_token",
                    ["refresh_token"] = refresh,
                });
                return _token.Access;
            }
            catch (Exception failure)
            {
                _lastError = $"could not refresh the token: {failure.Message}";
                _token = null;
                return null;
            }
        }
        finally { _gate.Release(); }
    }

    readonly record struct ApiResult(int Status, string Body, int? RetryAfter = null);

    /// <summary>
    /// GET an API endpoint with the bearer token, refreshing once on a 401.
    /// </summary>
    /// <remarks>
    /// 429 is passed back with GGG's own retry hint instead of being
    /// retried here: their limits are per-account and measured in minutes,
    /// so the only useful thing to do with one is say how long to wait.
    /// </remarks>
    async Task<ApiResult> ApiGetAsync(string endpoint, bool retried = false)
    {
        var access = await ValidTokenAsync(force: retried);
        if (access is null)
        {
            return new ApiResult(401, JsonSerializer.Serialize(new { error = "not signed in" }));
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, $"{ApiHost}{endpoint}");
        request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {access}");
        using var response = await _client.SendAsync(request);

        if (response.StatusCode == HttpStatusCode.Unauthorized && !retried)
        {
            // Force the refresh path and try once more, as
            // DownloadWithRefresh does.
            return await ApiGetAsync(endpoint, retried: true);
        }

        if (response.StatusCode == HttpStatusCode.TooManyRequests)
        {
            var hint = 60;
            if (response.Headers.TryGetValues("retry-after", out var values)
                && int.TryParse(values.FirstOrDefault(), out var parsed))
            {
                hint = parsed;
            }
            return new ApiResult(
                429, JsonSerializer.Serialize(new { error = "rate limited by the API" }), hint);
        }

        return new ApiResult((int)response.StatusCode, await response.Content.ReadAsStringAsync());
    }

    /* ---------------------------------------------------------------- pages */

    /// <summary>The page the browser lands on after GGG redirects back.</summary>
    static string LandingPage(bool ok, string? detail) => Page(
        ok ? "Signed in" : "Sign-in failed",
        ok ? "#7bc96f" : "#e06c75",
        ok
            ? "You can close this tab and go back to Path of Building."
            : $"<code>{Escape(detail ?? "unknown error")}</code>");

    /// <summary>What the window shows when a sign-in has gone to the browser.</summary>
    static string Opened(string authUrl) => Page(
        "Sign-in opened",
        "#7bc96f",
        "Your browser has been sent to pathofexile.com. Sign in there and come " +
        $"back; this window is already waiting.<br><br><code>{Escape(authUrl)}</code>");

    static string Page(string title, string colour, string body) => $$"""
        <!doctype html>
        <html lang="en"><head><meta charset="utf-8">
        <title>{{title}}</title>
        <style>
          :root { color-scheme: dark }
          body { margin:0; min-height:100vh; display:grid; place-items:center;
                 background:#121212; color:#e8e8e8;
                 font:16px/1.6 ui-sans-serif, system-ui, sans-serif }
          .card { max-width:30rem; padding:2rem; background:#1e1e1e;
                  border:1px solid #2e2e2e; border-radius:.75rem; text-align:center }
          h1 { margin:0 0 .5rem; font-size:1.25rem; color:{{colour}} }
          p { margin:0; color:#a8a8a8 }
          code { color:#e06c75; word-break:break-all }
        </style></head>
        <body><div class="card">
          <h1>{{title}}</h1>
          <p>{{body}}</p>
        </div></body></html>
        """;

    static string Escape(string text) => text
        .Replace("&", "&amp;")
        .Replace("<", "&lt;")
        .Replace(">", "&gt;");

    public void Dispose()
    {
        _pending?.Dispose();
        _pending = null;
        _token = null;
        _client.Dispose();
        _gate.Dispose();
    }
}
