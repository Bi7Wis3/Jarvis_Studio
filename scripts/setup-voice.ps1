# Installs Piper into .venv and downloads the British male voice used by Jarvis, on Windows (Linux and macOS use
# setup-voice.sh). Run it through npm: npm run setup:voice
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$Voice = if ($env:JARVIS_VOICE) { $env:JARVIS_VOICE } else { 'en_GB-alan-medium' }

function Invoke-Step([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not (Test-Path .venv)) {
    if (Get-Command py -ErrorAction SilentlyContinue) { Invoke-Step 'py' @('-3', '-m', 'venv', '.venv') }
    else { Invoke-Step 'python' @('-m', 'venv', '.venv') }
}
$Py = Join-Path '.venv' 'Scripts\python.exe'
Invoke-Step $Py @('-m', 'pip', 'install', '-q', 'piper-tts[http]')
Invoke-Step $Py @('-m', 'piper.download_voices', '--download-dir', 'voices', $Voice)
Write-Output "Voice ready: voices\$Voice.onnx"
