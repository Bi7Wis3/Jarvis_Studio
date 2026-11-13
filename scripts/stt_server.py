"""Local speech-to-text HTTP server for Jarvis, backed by faster-whisper on the CPU."""
import argparse
import json
import os
import shutil
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

import numpy as np
from faster_whisper import WhisperModel

ROOT = Path(__file__).resolve().parent.parent
MODEL_NAME = os.environ.get('JARVIS_STT_MODEL', 'base.en')
DOWNLOAD_ROOT = ROOT / 'voices' / 'stt'
MAX_BODY = 50 * 1024 * 1024
SAMPLE_RATE = 16000
FFMPEG = shutil.which('ffmpeg') or ''


def decode(audio: bytes) -> np.ndarray:
    """Decodes any container ffmpeg understands (webm/opus, ogg, wav, mp4) to 16 kHz mono float32."""
    command = [FFMPEG, '-nostdin', '-loglevel', 'error', '-i', 'pipe:0',
               '-f', 's16le', '-ac', '1', '-ar', str(SAMPLE_RATE), 'pipe:1']
    result = subprocess.run(command, input=audio, capture_output=True, check=True)
    return np.frombuffer(result.stdout, np.int16).astype(np.float32) / 32768.0


def load_model() -> WhisperModel:
    DOWNLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    return WhisperModel(MODEL_NAME, device='cpu', compute_type='int8', download_root=str(DOWNLOAD_ROOT))


class Handler(BaseHTTPRequestHandler):
    model: WhisperModel
    lock = Lock()

    def do_GET(self) -> None:
        if self.path == '/health':
            self.send_json(200, {'ok': True, 'model': MODEL_NAME})
        else:
            self.send_json(404, {'error': 'not found'})

    def do_POST(self) -> None:
        if self.path != '/transcribe':
            self.send_json(404, {'error': 'not found'})
            return
        length = int(self.headers.get('content-length') or 0)
        if length <= 0 or length > MAX_BODY:
            self.send_json(400, {'error': 'expected an audio body'})
            return
        audio = self.rfile.read(length)
        try:
            samples = decode(audio)
            with self.lock:
                segments, _ = self.model.transcribe(samples, language='en', vad_filter=True, beam_size=1)
                text = ''.join(segment.text for segment in segments).strip()
        except Exception as e:
            print(f'[stt] transcription failed: {e}', file=sys.stderr)
            self.send_json(422, {'error': 'could not transcribe audio'})
            return
        self.send_json(200, {'text': text})

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=4722)
    parser.add_argument('--download-only', action='store_true', help='fetch the model and exit')
    args = parser.parse_args()
    if not FFMPEG:
        sys.exit('[stt] ffmpeg is required to decode browser audio')
    model = load_model()
    if args.download_only:
        print(f'Speech model ready: {MODEL_NAME} in {DOWNLOAD_ROOT}')
        return
    Handler.model = model
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
