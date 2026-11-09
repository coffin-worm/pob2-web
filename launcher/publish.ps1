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

.PARAMETER FrameworkDependent
  Leave .NET out of the executable, which takes it from 103 MB to 297 KB
  and requires the .NET 10 Desktop Runtime on the target. Next to src/ the
  103 MB is a rounding error, so self-contained is the default and this is
  for when the target is your own machine.

.PARAMETER IncludeLove
  Copy the installed LOVE beside the launcher, so the engine runs on a
  machine that has never heard of it. About eleven megabytes.

.PARAMETER Zip
  Also write <Output>.zip, which is the thing you actually hand over.
  Slow, because it is half a gigabyte of mostly-incompressible game data.
#>
[CmdletBinding()]
param(
    [string] $Output = "$PSScriptRoot\..\dist-app",
    [switch] $FrameworkDependent,
    [switch] $IncludeLove,
    [switch] $Zip
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

# libcurl is PoB's network layer, and the headless engine does not have
# one: HeadlessWrapper stubs `require("lcurl.safe")` outright, with a
# comment saying it does not really need it. Verified by running the
# published build without the file, which works.
#
# It is skipped because Windows Defender flags a fresh copy of it as
# Trojan:Win32/Posilod.CA!cl and quarantines it mid-archive, which breaks
# the zip. The same bytes already in the checkout are left alone, so this
# is a heuristic about new files at unknown paths rather than a judgement
# about the file. Either way, carrying a DLL the engine never loads just
# to trip somebody's scanner is the wrong trade. Drop the /XF to ship it,
# and expect to need a Defender exclusion.
$skip = @('libcurl.dll')

# robocopy, because these are tens of thousands of files and Copy-Item is
# not in a hurry about it. Exit codes below 8 are success.
foreach ($pair in @(
    @{ From = "$root\bridge";   To = "$Output\bridge" }
    @{ From = "$root\src";      To = "$Output\src" }
    @{ From = "$root\runtime";  To = "$Output\runtime" }
    @{ From = "$root\web\dist"; To = "$Output\web\dist" }
)) {
    Step "  $($pair.From)"
    robocopy $pair.From $pair.To /MIR /XF $skip /NFL /NDL /NJH /NJS /NP | Out-Null
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

# Whoever opens the zip gets no context from this repository, so the one
# paragraph they need travels with it.
$note = @"
Path of Building 2, as a window.

Double-click PathOfBuilding2Web.exe. There is nothing to install: the
first start takes a few seconds while the engine reads the game data.

It needs the Microsoft Edge WebView2 runtime, which ships with Edge and
is therefore already on any current Windows. If it is somehow missing,
the window will say so.

Everything beside the executable is the application. bridge/ and src/ are
Path of Building itself, runtime/ holds the libraries it loads, web/ is
the interface$(if ($IncludeLove) { ", and love/ runs the engine" }).
Moving or deleting any of them stops it working.
"@
Set-Content -Path "$Output\README.txt" -Value $note -Encoding utf8

$size = (Get-ChildItem $Output -Recurse -File | Measure-Object Length -Sum).Sum / 1GB
Step ("Done. {0} is {1:N2} GB." -f $Output, $size)
if (-not $IncludeLove) {
    Write-Host '    LOVE was not included, so the target machine needs it installed.'
}

if ($Zip) {
    $archive = "$Output.zip"
    Step "Zipping to $archive"
    Remove-Item $archive -Force -ErrorAction SilentlyContinue
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    # Optimal rather than Fastest: this is written once and downloaded
    # many times, and most of what it holds is already compressed anyway,
    # so the difference in time costs less than the difference in size.
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $Output, $archive, [System.IO.Compression.CompressionLevel]::Optimal, $false)
    $zipped = (Get-Item $archive).Length / 1GB
    Step ("Done. {0} is {1:N2} GB." -f $archive, $zipped)
}

# robocopy says 1 for "files were copied", which is a success it reports as
# a non-zero code. Left alone it becomes this script's exit code and every
# caller reads the run as failed.
exit 0
