<#
.SYNOPSIS
  Builds the GigaAM ASR sidecar as a standalone Windows x64 executable and
  bundles ffmpeg.exe / ffprobe.exe next to it.

.DESCRIPTION
  Windows counterpart of scripts/build-gigaam-sidecar-macos-arm64.sh.

  Produces:
    openwhispr/resources/bin/gigatype-sidecar-win-x64.exe
    openwhispr/resources/bin/ffmpeg.exe
    openwhispr/resources/bin/ffprobe.exe

  Requirements on the build host:
    - Python >= 3.10 on PATH (or pass -PythonBin)
    - Node.js on PATH (used to resolve the ffmpeg-static / @ffprobe-installer
      binary paths from openwhispr/node_modules; run `npm install` first)

.PARAMETER PythonBin
  Path to the Python interpreter to build with. Defaults to `python`.

.PARAMETER NodeBin
  Path to the Node.js executable. Defaults to `node`.
#>
[CmdletBinding()]
param(
    [string]$PythonBin = $env:PYTHON_BIN,
    [string]$NodeBin = $env:NODE_BIN
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($PythonBin)) { $PythonBin = "python" }
if ([string]::IsNullOrWhiteSpace($NodeBin)) { $NodeBin = "node" }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$SidecarDir = Join-Path $RootDir "gigaam-sidecar"
$OpenWhisprDir = Join-Path $RootDir "openwhispr"
$BuildRoot = Join-Path $RootDir ".build\gigaam-sidecar-win-x64"
$VenvDir = Join-Path $BuildRoot ".venv"
$WorkDir = Join-Path $BuildRoot "work"
$OutputDir = Join-Path $OpenWhisprDir "resources\bin"
$OutputBin = Join-Path $OutputDir "gigatype-sidecar-win-x64.exe"
$SpecFile = Join-Path $SidecarDir "gigatype-sidecar-win-x64.spec"

$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

function Assert-CommandExists {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "'$Name' was not found on PATH."
    }
}

# --- Validate host -----------------------------------------------------------
Assert-CommandExists $PythonBin
Assert-CommandExists $NodeBin

$pyVersionOk = & $PythonBin -c "import sys; print(int(sys.version_info >= (3, 10)))"
if ($pyVersionOk.Trim() -ne "1") {
    & $PythonBin --version
    throw "Python >= 3.10 is required. Set -PythonBin (or `$env:PYTHON_BIN) to a newer interpreter."
}

# --- Fresh build tree --------------------------------------------------------
if (Test-Path $BuildRoot) { Remove-Item -Recurse -Force $BuildRoot }
New-Item -ItemType Directory -Force -Path $VenvDir, $WorkDir, $OutputDir | Out-Null

# --- Isolated venv + deps ----------------------------------------------------
& $PythonBin -m venv $VenvDir
& $VenvPython -m pip install --upgrade pip wheel setuptools
& $VenvPython -m pip install -r (Join-Path $SidecarDir "requirements.txt") pyinstaller

# --- Build the onefile executable from the committed spec --------------------
Push-Location $SidecarDir
try {
    & $VenvPython -m PyInstaller `
        --clean `
        --noconfirm `
        --distpath $OutputDir `
        --workpath $WorkDir `
        $SpecFile
} finally {
    Pop-Location
}

if (-not (Test-Path $OutputBin)) {
    throw "Expected output binary not found: $OutputBin"
}

# --- Bundle ffmpeg / ffprobe -------------------------------------------------
# Binary sources:
# - ffmpeg: npm dependency "ffmpeg-static" from openwhispr/package.json.
# - ffprobe: npm dependency "@ffprobe-installer/ffprobe" from openwhispr/package.json.
# Keep their upstream license notices when preparing wider distribution.
Push-Location $OpenWhisprDir
try {
    $FfmpegSrc = (& $NodeBin -e "process.stdout.write(require('ffmpeg-static'))").Trim()
    $FfprobeSrc = (& $NodeBin -e "process.stdout.write(require('@ffprobe-installer/ffprobe').path)").Trim()
} finally {
    Pop-Location
}

if ([string]::IsNullOrWhiteSpace($FfmpegSrc) -or -not (Test-Path $FfmpegSrc)) {
    throw "Could not resolve ffmpeg-static binary. Did you run 'npm install' in openwhispr?"
}
if ([string]::IsNullOrWhiteSpace($FfprobeSrc) -or -not (Test-Path $FfprobeSrc)) {
    throw "Could not resolve @ffprobe-installer/ffprobe binary. Did you run 'npm install' in openwhispr?"
}

Copy-Item -Force $FfmpegSrc (Join-Path $OutputDir "ffmpeg.exe")
Copy-Item -Force $FfprobeSrc (Join-Path $OutputDir "ffprobe.exe")

Write-Host "Built $OutputBin"
Write-Host "Bundled $(Join-Path $OutputDir 'ffmpeg.exe')"
Write-Host "Bundled $(Join-Path $OutputDir 'ffprobe.exe')"
