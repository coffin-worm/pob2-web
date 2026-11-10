using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PoB2Web;

/// <summary>
/// Sharing a build to pobb.in and the rest, and importing one back, for the
/// window.
/// </summary>
/// <remarks>
/// <para>
/// This is the same four routes the dev server serves from
/// <c>web/plugins/build-sites.ts</c>, under the same <c>/sites</c> mount and
/// with the same bodies, for the reason <see cref="PoeAccount"/> gives: the
/// UI is the same build either way and knows only the contract.
/// </para>
/// <para>
/// PoB does this in <c>BuildSiteTools.lua</c>, through
/// <c>LaunchSubScript</c> and <c>launch:DownloadPage</c>, which are empty
/// stubs in the headless host. So the Share button does nothing and an
/// import from a link waits forever, and the transport has to live where
/// there is TLS: node in the browser build, this process in the window.
/// </para>
/// <para>
/// Nothing is decoded here. What comes back from a site is a build code,
/// which the engine's own <c>/code/import</c> already takes. This fetches
/// bytes and hands them over.
/// </para>
/// <para>
/// The site table is the third copy of PoB's, after the Lua one and the
/// TypeScript one. It is here rather than read from either because this
/// class must decide where it is allowed to send a request, and a table it
/// was handed would not be a decision it had made.
/// </para>
/// </remarks>
sealed class BuildSites : IDisposable
{
    const string Json = "application/json; charset=utf-8";

    /// <summary>One answer, as the caller should put it on the wire.</summary>
    public readonly record struct Reply(int Status, string Body, string ContentType);

    /// <summary>
    /// A site, as PoB's table has it.
    /// </summary>
    /// <param name="Id">The name the page uses for it.</param>
    /// <param name="Label">The name a person sees.</param>
    /// <param name="Match">Capture group 1 is the build's id on that site.</param>
    /// <param name="Raw">The URL that serves the bare code for an id.</param>
    /// <param name="Post">Absent on a site that only serves builds.</param>
    /// <param name="Field">Prepended to the code in the body, which is how PoB names its field.</param>
    /// <param name="CodeOut">Prepended to the response to make the shareable link.</param>
    sealed record Site(
        string Id,
        string Label,
        Regex Match,
        Func<string, string> Raw,
        string? Post = null,
        string Field = "",
        string CodeOut = "");

    // JavaScript's `.` excludes four line terminators and .NET's only \n, and
    // JavaScript's `\s` is a different set from .NET's. These are spelled out
    // so a pasted link matches the same here as it does in the dev server.
    const string Dot = @"[^\n\r\u2028\u2029]";
    const string Space = @"[ \f\n\r\t\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]";
    static readonly char[] Spaces =
        " \f\n\r\t\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
            .ToCharArray();

    /// <summary>
    /// ECMAScript so that <c>\w</c> is ASCII, as it is in the TypeScript this
    /// is copied from. Without it a Unicode letter would be a valid id.
    /// </summary>
    static Regex Pattern(string text) => new(text, RegexOptions.ECMAScript);

    static readonly Site[] Sites =
    [
        new("Maxroll", "Maxroll",
            Pattern($@"^https:\/\/maxroll\.gg\/poe2\/pob\/({Dot}+?){Space}*$"),
            id => $"https://maxroll.gg/poe2/api/pob/{id}",
            Post: "https://maxroll.gg/poe2/api/pob",
            Field: "pobCode=",
            CodeOut: "https://maxroll.gg/poe2/pob/"),
        new("POBBin", "pobb.in",
            Pattern($@"^https:\/\/pobb\.in\/({Dot}+?){Space}*$"),
            id => $"https://pobb.in/pob/{id}",
            Post: "https://pobb.in/pob/",
            Field: "",
            CodeOut: "https://pobb.in/"),
        // PoB's own pattern allows poe.ninja/poe2/pob/ and poe2.ninja/pob/.
        new("PoeNinja", "poe.ninja",
            Pattern($@"^https:\/\/poe2?\.ninja\/(?:poe2\/)?pob\/({Dot}+?){Space}*$"),
            id => $"https://poe.ninja/poe2/pob/raw/{id}",
            Post: "https://poe.ninja/poe2/pob/api/upload",
            Field: "code=",
            // Empty in PoB too, which means the response body is already the URL.
            CodeOut: ""),
        new("PoE2DB", "poe2db.tw",
            Pattern($@"^https:\/\/poe2db\.tw\/pob\/({Dot}+?){Space}*$"),
            id => $"https://poe2db.tw/pob/{id}/raw",
            Post: "https://poe2db.tw/pob/api/gen",
            Field: "",
            CodeOut: ""),
        new("pastebin", "Pastebin.com",
            Pattern(@"^https:\/\/pastebin\.com\/(\w+)"),
            id => $"https://pastebin.com/raw/{id}"),
        new("pastebinProxy", "PastebinP.com",
            Pattern(@"^https:\/\/pastebinp\.com\/(\w+)"),
            id => $"https://pastebinp.com/raw/{id}"),
        // Unanchored in PoB as well, so a rentry link pasted with no scheme
        // still matches.
        new("rentry", "Rentry.co",
            Pattern(@"rentry\.co\/(\w+)"),
            id => $"https://rentry.co/paste/{id}/raw"),
    ];

    readonly HttpClient _client = new() { Timeout = TimeSpan.FromSeconds(30) };
    readonly Action<string> _trace;

    public BuildSites(string root, Action<string> trace)
    {
        _trace = trace;
        _client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", UserAgent(root));
    }

    /// <summary><c>Path of Building/0.23.1</c>, the string the desktop app sends.</summary>
    static string UserAgent(string root)
    {
        var version = "0.0.0";
        try
        {
            var manifest = File.ReadAllText(Path.Combine(root, "manifest.xml"));
            var match = Regex.Match(manifest, "<Version number=\"([^\"]+)\"");
            if (match.Success) version = match.Groups[1].Value;
        }
        catch
        {
            // A missing manifest is not worth refusing to talk to a site over.
        }
        return $"Path of Building/{version}";
    }

    /// <summary>The site a link belongs to, and the build's id on it.</summary>
    static (Site Site, string Id)? Recognise(string link)
    {
        var text = link.Trim(Spaces);
        foreach (var site in Sites)
        {
            var found = site.Match.Match(text);
            if (found.Success && found.Groups[1].Value.Length > 0)
            {
                return (site, found.Groups[1].Value);
            }
        }
        return null;
    }

    /* ------------------------------------------------------------- routing */

    /// <summary>
    /// One request under the mount, with the mount already taken off.
    /// </summary>
    /// <remarks>
    /// Takes the body as well as the path, which <see cref="PoeAccount"/>
    /// has no need of: <c>POST /share</c> carries the build code in JSON.
    /// </remarks>
    public async Task<Reply> HandleAsync(string method, string pathAndQuery, string body)
    {
        var split = pathAndQuery.IndexOf('?');
        var path = (split < 0 ? pathAndQuery : pathAndQuery[..split]).TrimEnd('/');
        if (path.Length == 0) path = "/";
        var query = Query(split < 0 ? "" : pathAndQuery[(split + 1)..]);

        try
        {
            switch ($"{method} {path}")
            {
                case "GET /list":
                    return Ok(new
                    {
                        sites = Sites.Select(site => new
                        {
                            id = site.Id,
                            label = site.Label,
                            uploads = !string.IsNullOrEmpty(site.Post),
                        }).ToList(),
                    });

                case "GET /recognise":
                {
                    // No label on a miss, as the dev server sends none.
                    if (Recognise(query.GetValueOrDefault("url") ?? "") is not { } hit)
                    {
                        return Ok(new { site = (string?)null });
                    }
                    return Ok(new { site = hit.Site.Id, label = hit.Site.Label });
                }

                case "GET /fetch":
                    return Ok(new { code = await FetchBuildAsync(query.GetValueOrDefault("url") ?? "") });

                case "POST /share":
                {
                    using var parsed = JsonDocument.Parse(string.IsNullOrEmpty(body) ? "{}" : body);
                    if (parsed.RootElement.ValueKind != JsonValueKind.Object)
                    {
                        throw new InvalidOperationException("expected a JSON object");
                    }
                    var asked = parsed.RootElement.TryGetProperty("site", out var siteName)
                        && siteName.ValueKind == JsonValueKind.String
                            ? siteName.GetString()
                            : null;
                    var site = Sites.FirstOrDefault(entry => entry.Id == asked);
                    if (site is null)
                    {
                        return Error(400, $"no build site called {asked ?? "(none)"}");
                    }
                    var code = parsed.RootElement.TryGetProperty("code", out var codeText)
                        && codeText.ValueKind == JsonValueKind.String
                            ? codeText.GetString()
                            : null;
                    if (string.IsNullOrEmpty(code))
                    {
                        return Error(400, "expected a build code to share");
                    }
                    return Ok(new { url = await ShareAsync(site, code) });
                }

                default:
                    return Error(404, $"no route {method} {path}");
            }
        }
        catch (Exception failure)
        {
            // The message goes to the page and nothing else does: the code
            // is the person's build and is not worth writing to a log.
            _trace($"sites {method} {path}: {failure.Message}");
            return Error(502, failure.Message);
        }
    }

    static Reply Ok(object body) =>
        new(200, JsonSerializer.Serialize(body), Json);

    static Reply Error(int status, string message) =>
        new(status, JsonSerializer.Serialize(new { error = message }), Json);

    static string Excerpt(string text) =>
        text.Length == 0 ? "nothing" : text[..Math.Min(200, text.Length)];

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

    /* ------------------------------------------------------------ the sites */

    /// <summary>
    /// Upload a code and return the link.
    /// </summary>
    /// <remarks>
    /// The body is <c>field + code</c>, which is what curl's POSTFIELDS does
    /// and therefore what these endpoints expect, with the form content type
    /// set. The code is not URL-encoded, also as PoB sends it, so this is
    /// deliberately not a <see cref="FormUrlEncodedContent"/>.
    /// </remarks>
    async Task<string> ShareAsync(Site site, string code)
    {
        if (string.IsNullOrEmpty(site.Post))
        {
            throw new InvalidOperationException($"{site.Label} does not take uploads");
        }

        using var content = new StringContent(site.Field + code, Encoding.UTF8);
        // Replaced rather than passed to the constructor, which would add a
        // charset parameter that curl does not send.
        content.Headers.ContentType = new MediaTypeHeaderValue("application/x-www-form-urlencoded");

        using var response = await _client.PostAsync(site.Post, content);
        var text = (await response.Content.ReadAsStringAsync()).Trim(Spaces);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"{site.Label} answered {(int)response.StatusCode}: {Excerpt(text)}");
        }
        if (text.Length == 0)
        {
            throw new InvalidOperationException($"{site.Label} accepted the build but returned no link");
        }

        // PoB uses the body verbatim, prefixed by CodeOut. Where CodeOut is
        // empty the body is expected to be the whole URL already.
        var link = site.CodeOut + text;
        if (!link.StartsWith("https://", StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"{site.Label} returned something that is not a link: {link[..Math.Min(200, link.Length)]}");
        }
        return link;
    }

    /// <summary>
    /// Fetch a build back, as a code.
    /// </summary>
    /// <remarks>
    /// Only ever the URL this class derived from a recognised link, never the
    /// one the page sent. That is the whole security boundary here: a page
    /// that could name the URL could use this to reach anything the machine
    /// can reach. What the page supplies is only a string to be recognised;
    /// the host the request goes to comes from the table above.
    /// </remarks>
    async Task<string> FetchBuildAsync(string link)
    {
        if (Recognise(link) is not { } known)
        {
            throw new InvalidOperationException("that link is not one of the build sites this knows");
        }

        using var response = await _client.GetAsync(known.Site.Raw(known.Id));
        var text = (await response.Content.ReadAsStringAsync()).Trim(Spaces);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                $"{known.Site.Label} answered {(int)response.StatusCode}: {Excerpt(text)}");
        }
        if (text.Length == 0)
        {
            throw new InvalidOperationException($"{known.Site.Label} returned an empty build");
        }
        return text;
    }

    public void Dispose() => _client.Dispose();
}
