# Installs speech recognition into .venv on Windows (Linux and macOS use setup-stt.sh): faster-whisper and its Whisper
# model, and with options:
#   --gpu        NVIDIA's cuBLAS for CUDA 12, so Whisper can run on an NVIDIA GPU
#   --moonshine  Moonshine, the fast English recogniser from Useful Sensors, and its model
# Run it through npm: npm run setup:stt -- --gpu --moonshine
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$Gpu = $false
$Moonshine = $false
foreach ($a in $args) {
    switch ($a) {
        '--gpu' { $Gpu = $true }
        '--moonshine' { $Moonshine = $true }
        default { Write-Error "Unknown option $a (use --gpu, --moonshine)"; exit 2 }
    }
}
$Model = if ($env:JARVIS_STT_MODEL) { $env:JARVIS_STT_MODEL } else { 'base.en' }
$MoonshineModel = if ($env:JARVIS_STT_MOONSHINE_MODEL) { $env:JARVIS_STT_MOONSHINE_MODEL } else { 'base' }

function Invoke-Step([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

if (-not (Test-Path .venv)) {
    if (Get-Command py -ErrorAction SilentlyContinue) { Invoke-Step 'py' @('-3', '-m', 'venv', '.venv') }
    else { Invoke-Step 'python' @('-m', 'venv', '.venv') }
}
$Py = Join-Path '.venv' 'Scripts\python.exe'
Invoke-Step $Py @('-m', 'pip', 'install', '-q', 'faster-whisper')
$env:JARVIS_STT_MODEL = $Model
Invoke-Step $Py @('scripts\stt_server.py', '--engine', 'whisper', '--download-only')
if ($Gpu) {
    # CTranslate2 (under faster-whisper) loads cuBLAS for CUDA 12 itself; since 4.6.3 it needs no cuDNN. The app adds the
    # library's folder for the speech server. The GPU must be one CTranslate2's wheel has kernels for (4.9: compute
    # capability 5.3 or newer).
    Invoke-Step $Py @('-m', 'pip', 'install', '-q', 'nvidia-cublas-cu12>=12.4,<13')
    Write-Output 'GPU libraries installed; Options > Speech > Device: auto uses the GPU when it passes a test at start-up.'
}
if ($Moonshine) {
    # Without its declared extras (librosa, numba): they only read audio files, which the app never asks it to do. Its
    # runtime (onnxruntime, tokenizers, huggingface-hub) comes with faster-whisper.
    Invoke-Step $Py @('-m', 'pip', 'install', '-q', '--no-deps', 'useful-moonshine-onnx==20251121')
    Invoke-Step $Py @('scripts\stt_server.py', '--engine', 'moonshine', '--model', $MoonshineModel, '--download-only')
}
