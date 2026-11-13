#!/usr/bin/env bash
# Installs faster-whisper into .venv and downloads the speech recognition model used by Jarvis.
set -euo pipefail
cd "$(dirname "$0")/.."
MODEL="${JARVIS_STT_MODEL:-base.en}"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q faster-whisper
JARVIS_STT_MODEL="$MODEL" .venv/bin/python scripts/stt_server.py --download-only
