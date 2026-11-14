using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PoB2Web;

/// <summary>
/// Keeps one refresh token across restarts, encrypted to the Windows user.
/// </summary>
/// <remarks>
/// <para>
/// The other half of <c>web/plugins/token-store.ts</c>, down to the file it
/// reads. Both halves keep the same token in the same place, so a sign-in
/// in the dev server is a sign-in in the window and the other way round:
/// one account on one machine should not have to prove itself twice. That
/// is why this is the one piece of state not under
/// <see cref="Paths.UserData"/>, which is this program's own folder and
/// nobody else's.
/// </para>
/// <para>
/// What is being saved is an OAuth refresh token that can read somebody's
/// account, so the question is not whether to store it but what storing it
/// costs. PoB upstream answers that by writing <c>lastToken</c> and
/// <c>lastRefreshToken</c> into Settings.xml in the clear
/// (<c>Main.lua:789</c>), where anything running as that user, and anything
/// that reads that folder, can have them. This does the same job through
/// DPAPI instead: the ciphertext is bound to the Windows account that wrote
/// it, so a copy taken off the machine, or read by another user, is so much
/// noise.
/// </para>
/// <para>
/// The format is PowerShell's, because the dev server's half is PowerShell.
/// <c>ConvertFrom-SecureString</c> with no key argument is
/// <c>CryptProtectData</c> at <c>CurrentUser</c> scope over the string's
/// UTF-16 bytes, printed as hex, which is exactly what
/// <see cref="ProtectedData"/> produces here. The dev server pays a spawn
/// for it because the alternative in node is a native module with a
/// compiler in it; this process is already .NET and calls it directly.
/// Neither half can tell the other's file from its own.
/// </para>
/// <para>
/// Only the refresh token is kept. The access token beside it lasts
/// minutes, so saving it would buy nothing and widen what a stolen file is
/// worth. Startup therefore always spends the refresh grant, which has the
/// useful side effect of proving the saved sign-in still works before the
/// UI claims to be signed in.
/// </para>
/// <para>
/// Every failure here is "not signed in" rather than an error. A file from
/// another Windows account, a file from before a profile reset, a truncated
/// write: none of them are worth refusing to start over, and all of them
/// are indistinguishable from never having signed in, which is a state the
/// UI already handles.
/// </para>
/// </remarks>
sealed class TokenStore
{
    /// <summary>Bumped if the file's shape changes, so a change is not a mystery.</summary>
    const int Format = 1;

    /// <summary>What the file holds. The names are the dev server's.</summary>
    sealed class Saved
    {
        public int Version { get; set; }

        /// <summary>DPAPI ciphertext, as the hex string PowerShell hands back.</summary>
        public string? RefreshToken { get; set; }

        /// <summary>Epoch ms, for a log line and nothing else.</summary>
        public long SavedAt { get; set; }
    }

    static readonly JsonSerializerOptions Shape = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    readonly Action<string> _trace;

    public TokenStore(Action<string> trace)
    {
        _trace = trace;
        Location = Where();
    }

    /// <summary>
    /// Where the file lives, for a log line. Never its contents.
    /// </summary>
    /// <remarks>
    /// LocalAppData rather than Documents, because this is machine state and
    /// not a document: Documents follows the user into OneDrive, and a token
    /// that syncs to another machine is a token on two machines. Rather than
    /// TEMP, which is the opposite mistake: the port file in <c>bridge/</c>
    /// belongs there because it describes a process and should not survive a
    /// reboot, and this is the one thing here that should.
    /// </remarks>
    public string Location { get; }

    static string Where()
    {
        var configured = Environment.GetEnvironmentVariable("POB_TOKEN_STORE");
        if (!string.IsNullOrEmpty(configured)) return configured;
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "pob2-web",
            "poe-token.json");
    }

    /// <summary>The saved refresh token, or null if there is not one to be had.</summary>
    public string? Load()
    {
        Saved? saved;
        try
        {
            saved = JsonSerializer.Deserialize<Saved>(File.ReadAllText(Location), Shape);
        }
        catch
        {
            // No file is the ordinary case, every day, and says nothing.
            return null;
        }

        if (saved is null || saved.Version != Format || string.IsNullOrEmpty(saved.RefreshToken))
        {
            _trace("the saved sign-in is in a format this does not read; ignoring it");
            return null;
        }

        try
        {
            var plain = ProtectedData.Unprotect(
                Convert.FromHexString(saved.RefreshToken),
                optionalEntropy: null,
                DataProtectionScope.CurrentUser);
            return Encoding.Unicode.GetString(plain);
        }
        catch
        {
            // Decryption fails when the file came from another Windows
            // account or another machine, which is the case it exists for.
            _trace("the saved sign-in could not be decrypted on this account; ignoring it");
            return null;
        }
    }

    public void Save(string refreshToken)
    {
        try
        {
            var cipher = ProtectedData.Protect(
                Encoding.Unicode.GetBytes(refreshToken),
                optionalEntropy: null,
                DataProtectionScope.CurrentUser);

            var body = JsonSerializer.Serialize(
                new Saved
                {
                    Version = Format,
                    RefreshToken = Convert.ToHexStringLower(cipher),
                    SavedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                },
                Shape);

            var folder = Path.GetDirectoryName(Location);
            if (!string.IsNullOrEmpty(folder)) Directory.CreateDirectory(folder);
            File.WriteAllText(Location, body);
        }
        catch (Exception failure)
        {
            // Being unable to save is a worse sign-in, not a failed one, so
            // the token in memory stands and the next start asks again.
            _trace($"could not save the sign-in: {failure.Message}");
        }
    }

    public void Forget()
    {
        try
        {
            File.Delete(Location);
        }
        catch
        {
            // Already gone is the outcome being asked for.
        }
    }
}
