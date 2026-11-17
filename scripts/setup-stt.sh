#!/usr/bin/env bash
# Installs speech recognition into .venv (Linux and macOS; Windows uses setup-stt.ps1): faster-whisper and its Whisper
# model, and with options:
#   --gpu        NVIDIA's cuBLAS for CUDA 12, so Whisper can run on an NVIDIA GPU (Linux; macOS has no CUDA)
#   --moonshine  Moonshine, the fast English recogniser from Useful Sensors, and its model
# Run it through npm: npm run setup:stt -- --gpu --moonshine
set -euo pipefail
cd "$(dirname "$0")/.."
MODEL="${JARVIS_STT_MODEL:-base.en}"
MOONSHINE_MODEL="${JARVIS_STT_MOONSHINE_MODEL:-base}"
GPU=0
MOONSHINE=0
for arg in "$@"; do
    case "$arg" in
        --gpu) GPU=1 ;;
        --moonshine) MOONSHINE=1 ;;
        *) echo "Unknown option $arg (use --gpu, --moonshine)" >&2; exit 2 ;;
    esac
done
[ -d .venv ] || python3 -m venv .venv
PY=.venv/bin/python
"$PY" -m pip install -q faster-whisper
JARVIS_STT_MODEL="$MODEL" "$PY" scripts/stt_server.py --engine whisper --download-only
if [ "$GPU" = 1 ]; then
    if [ "$(uname -s)" = Darwin ]; then
        echo "macOS has no CUDA, so there are no GPU libraries to install: speech recognition runs on the CPU."
    else
        # CTranslate2 (under faster-whisper) loads cuBLAS for CUDA 12 itself; since 4.6.3 it needs no cuDNN. The GPU
        # must be one CTranslate2's wheel has kernels for (4.9: compute capability 5.3 or newer).
        "$PY" -m pip install -q 'nvidia-cublas-cu12>=12.4,<13'
        echo "GPU libraries installed; Options > Speech > Device: auto uses the GPU when it passes a test at start-up."
    fi
fi
if [ "$MOONSHINE" = 1 ]; then
    # Without its declared extras (librosa, numba): they only read audio files, which the app never asks it to do. Its
    # runtime (onnxruntime, tokenizers, huggingface-hub) comes with faster-whisper.
    "$PY" -m pip install -q --no-deps 'useful-moonshine-onnx==20251121'
    "$PY" scripts/stt_server.py --engine moonshine --model "$MOONSHINE_MODEL" --download-only
fi
