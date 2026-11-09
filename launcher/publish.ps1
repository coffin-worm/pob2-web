<#
.SYNOPSIS
  Assemble a folder you can zip and hand to somebody.

.DESCRIPTION
  Builds the web UI, publishes the launcher, and copies the four things the
  launcher needs to find beside it: bridge/, src/, runtime/ and web/dist/.
  The result runs with nothing installed except the WebView2 runtime, which
  ships with Edge and is therefore already on any current Windows.

  It is large, because Path of Building is large: src/ alone is most of a
  gigabyte once the tree art and the game data are counted. Nothing here
  makes that smaller and nothing here should pretend to.

.PARAMETER SelfContained
  Carry .NET inside the executable, so the machine needs no runtime at all.
  Costs about seventy megabytes, which next to src/ is a rounding error, so
  this is on unless you are building for yourself.

.PARAMETER IncludeLove
  Copy the installed LOVE beside the launcher, so the engine runs on a
  machine that has never heard of it. About twelve megabytes.
#>
[CmdletBinding()]
param(
    [string] $Output = "$PSScriptRoot\..\dist-app",
    [switch] $FrameworkDependent,
    [switch] $IncludeLove
)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot\.."

function Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }

Step 'Building the web UI'
Push-Location "$root\web"
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
}
finally { Pop-Location }

Step 'Publishing the launcher'
# Lower-cased deliberately: PowerShell renders $true as "True" and the
# dotnet CLI wants the switch spelled the way a shell would spell it.
$selfContained = if ($FrameworkDependent) { 'false' } else { 'true' }
$staging = "$PSScriptRoot\bin\publish"
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
# No symbols: a shipped folder has no use for them and the file beside the
# executable only invites the question.
dotnet publish "$PSScriptRoot\PathOfBuilding2Web.csproj" `
    -c Release -r win-x64 --self-contained $selfContained `
    -p:DebugType=none -p:DebugSymbols=false `
    -o $staging
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }

Step "Assembling $Output"
New-Item -ItemType Directory -Force -Path $Output | Out-Null
# The loose files go first. Copy-Item adds and overwrites but never
# removes, so a file this script used to produce and no longer does would
# sit in the output forever, which is how an earlier run left a stray
# debug symbol and a megabyte of API documentation in a shipped folder.
# The directories below are robocopy /MIR and mirror themselves.
Get-ChildItem $Output -File | Remove-Item -Force
Copy-Item "$staging\*" $Output -Recurse -Force

# robocopy, because these are tens of thousands of files and Copy-Item is
# not in a hurry about it. Exit codes below 8 are success.
foreach ($pair in @(
    @{ From = "$root\bridge";   To = "$Output\bridge" }
    @{ From = "$root\src";      To = "$Output\src" }
    @{ From = "$root\runtime";  To = "$Output\runtime" }
    @{ From = "$root\web\dist"; To = "$Output\web\dist" }
)) {
    Step "  $($pair.From)"
    robocopy $pair.From $pair.To /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $($pair.From)" }
}

if ($IncludeLove) {
    $love = @(
        'C:\Program Files\LOVE'
        'C:\Program Files (x86)\LOVE'
    ) | Where-Object { Test-Path "$_\lovec.exe" } | Select-Object -First 1

    if (-not $love) { throw 'LOVE is not installed, so there is nothing to copy.' }
    Step "  $love"
    robocopy $love "$Output\love" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'robocopy failed for LOVE' }
}

$size = (Get-ChildItem $Output -Recurse -File | Measure-Object Length -Sum).Sum / 1GB
Step ("Done. {0} is {1:N2} GB." -f $Output, $size)
if (-not $IncludeLove) {
    Write-Host '    LOVE was not included, so the target machine needs it installed.'
}

# robocopy says 1 for "files were copied", which is a success it reports as
# a non-zero code. Left alone it becomes this script's exit code and every
# caller reads the run as failed.
exit 0
