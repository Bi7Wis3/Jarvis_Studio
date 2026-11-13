#!/usr/bin/env bash
# Installs Piper into .venv and downloads the British male voice used by Jarvis.
set -euo pipefail
cd "$(dirname "$0")/.."
VOICE="${JARVIS_VOICE:-en_GB-alan-medium}"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q 'piper-tts[http]'
.venv/bin/python -m piper.download_voices --download-dir voices "$VOICE"
echo "Voice ready: voices/$VOICE.onnx"
