"""Self-check of the speech engines: every installed engine on every device it can use, timed, and the HTTP server
taking raw PCM and a compressed clip. Run it with the app's Python:

    .venv/bin/python scripts/stt_selfcheck.py            (Linux, macOS)
    .venv\\Scripts\\python.exe scripts\\stt_selfcheck.py   (Windows)

Options: --port (for the HTTP check, default 4732), --skip-http. Exits non-zero when an engine fails on the CPU.
"""
import argparse
import importlib.util
import io
import json
import os
import subprocess
import sys
import time
import urllib.request
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SENTENCE = 'Extrude the sketch twelve millimetres and fillet the top edges by two millimetres.'
# Both engines hear Piper's "fillet" as "fill it", so that word is not checked.
KEYWORDS = ('extrude', 'sketch', 'top', 'edges')


def nvidia_dirs() -> list[str]:
    try:
        import nvidia
    except ImportError:
        return []
    folder = list(nvidia.__path__)[0]
    sub = 'bin' if sys.platform == 'win32' else 'lib'
    return [str(Path(folder) / n / sub) for n in sorted(os.listdir(folder)) if (Path(folder) / n / sub).is_dir()]


def with_gpu_libraries() -> None:
    """The NVIDIA libraries pip installed must be on the library path before the process starts (Linux), or added as
    DLL folders (Windows); the app does this for its speech server, and this script does it for itself."""
    dirs = nvidia_dirs()
    if not dirs:
        return
    if sys.platform == 'win32':
        os.environ['JARVIS_DLL_DIRS'] = os.pathsep.join(dirs)
        for d in dirs:
            os.add_dll_directory(d)
    elif sys.platform.startswith('linux') and not set(dirs) <= set(os.environ.get('LD_LIBRARY_PATH', '').split(':')):
        env = dict(os.environ, LD_LIBRARY_PATH=':'.join(dirs + [p for p in [os.environ.get('LD_LIBRARY_PATH')] if p]))
        sys.exit(subprocess.call([sys.executable, *sys.argv], env=env))


def load_server():
    spec = importlib.util.spec_from_file_location('stt_server', HERE / 'stt_server.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_audio(stt) -> tuple[np.ndarray, str, tuple[str, ...]]:
    """A spoken CAD command with Piper's voice when it is installed, else Moonshine's own test recording."""
    voice = ROOT / 'voices' / 'en_GB-alan-medium.onnx'
    if voice.exists() and stt.installed('piper'):
        from piper import PiperVoice
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as w:
            PiperVoice.load(str(voice)).synthesize_wav(SENTENCE, w)
        buffer.seek(0)
        with wave.open(buffer) as w:
            rate = w.getframerate()
            x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
        n = int(len(x) * 16000 / rate)
        return np.interp(np.arange(n) * rate / 16000, np.arange(len(x)), x).astype(np.float32), SENTENCE, KEYWORDS
    if stt.installed('moonshine_onnx'):
        import moonshine_onnx
        with wave.open(str(moonshine_onnx.ASSETS_DIR / 'beckett.wav')) as w:
            x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768.0
        return x, 'Ever tried. Ever failed. No matter. Try again. Fail again. Fail better.', ('tried', 'failed', 'again', 'better')
    sys.exit('Neither Piper nor Moonshine is installed, so there is no test recording.')


def check_engines(stt, audio, keywords) -> bool:
    ok = True
    probe = stt.probe()
    print(f'platform {probe["platform"]}, engines {probe["engines"]}, CUDA devices {probe["cudaDevices"]}, '
          f'onnxruntime providers {probe["onnxProviders"]}, clip decoder {probe["decoder"] or "none"}')
    for engine, present in probe['engines'].items():
        if not present:
            print(f'{engine}: not installed')
            continue
        model = stt.DEFAULT_MODELS[engine]
        for device in ('cpu', 'gpu'):
            if device == 'gpu' and not stt.has_gpu_runtime(engine):
                print(f'{engine} {model} gpu: no GPU runtime here')
                continue
            try:
                started = time.perf_counter()
                recogniser = stt.Recogniser(engine, model, device)
                loaded = time.perf_counter() - started
                if device == 'gpu' and recogniser.device != 'gpu':
                    print(f'{engine} {model} gpu: not usable ({recogniser.gpu_error})')
                    continue
                recogniser.transcribe(audio[:16000])
                started = time.perf_counter()
                text = recogniser.transcribe(audio)
                took = time.perf_counter() - started
                heard = all(k in text.lower() for k in keywords)
                print(f'{engine} {model} {device}: load {loaded * 1000:.0f} ms, {len(audio) / 16000:.1f} s of speech in '
                      f'{took * 1000:.0f} ms: "{text}" {"ok" if heard else "WRONG"}')
                ok = ok and (heard or device == 'gpu')
            except Exception as e:
                print(f'{engine} {model} {device}: FAILED: {stt.first_line(e)}')
                ok = ok and device == 'gpu'
        if engine == 'whisper' and stt.has_gpu_runtime(engine):
            # Run-time fallback: the GPU taken without its start-up test, then a failure on it retried on the CPU.
            try:
                recogniser = stt.Recogniser(engine, model, 'gpu', test_gpu=False)
                text = recogniser.transcribe(audio)
                print(f'{engine} gpu without the start-up test: now on the {recogniser.device}, "{text}"'
                      f'{" (fell back: " + recogniser.gpu_error + ")" if recogniser.gpu_error else ""}')
            except Exception as e:
                print(f'{engine} gpu without the start-up test: FAILED: {stt.first_line(e)}')
                ok = False
    return ok


def post(port: int, body: bytes, kind: str) -> dict:
    request = urllib.request.Request(f'http://127.0.0.1:{port}/transcribe', data=body, method='POST', headers={'content-type': kind})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as e:
        return {'status': e.code, **json.loads(e.read() or b'{}')}


def check_http(audio, keywords, port: int) -> bool:
    server = subprocess.Popen([sys.executable, str(HERE / 'stt_server.py'), '--port', str(port), '--device', 'cpu',
                               '--engine', 'moonshine' if load_server().installed('moonshine_onnx') else 'whisper'])
    try:
        for _ in range(240):
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=2) as response:
                    print('http health:', response.read().decode())
                    break
            except Exception:
                time.sleep(0.5)
        else:
            print('http: the server did not start')
            return False
        pcm = (np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes()
        answer = post(port, pcm, 'audio/s16le; rate=16000')
        print('http pcm:', answer)
        ok = all(k in answer.get('text', '').lower() for k in keywords)
        wrong_rate = post(port, pcm, 'audio/s16le; rate=48000')
        print('http pcm at 48 kHz (refused):', wrong_rate)
        ok = ok and wrong_rate.get('status') == 415
        wav = io.BytesIO()
        with wave.open(wav, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(pcm)
        answer = post(port, wav.getvalue(), 'audio/wav')
        print('http wav clip:', answer)
        ok = ok and all(k in answer.get('text', '').lower() for k in keywords)
        urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}/shutdown', method='POST'), timeout=5).read()
        server.wait(timeout=20)
        print('http: stopped by /shutdown')
        return ok
    finally:
        if server.poll() is None:
            server.terminate()
            server.wait(timeout=20)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=4732)
    parser.add_argument('--skip-http', action='store_true')
    args = parser.parse_args()
    with_gpu_libraries()
    stt = load_server()
    audio, sentence, keywords = test_audio(stt)
    print(f'test recording: "{sentence}"')
    ok = check_engines(stt, audio, keywords)
    if not args.skip_http:
        ok = check_http(audio, keywords, args.port) and ok
    print('all good' if ok else 'SOMETHING FAILED')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
