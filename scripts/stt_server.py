"""Local speech-to-text HTTP server for Jarvis: Whisper (faster-whisper) or Moonshine (ONNX), on the CPU or a GPU.

POST /transcribe takes raw 16 kHz mono 16-bit little-endian PCM (content type audio/s16le) or a recorded clip in any
container (webm/opus, ogg, wav, mp4), and answers {"text": ...}. An optional x-prompt header (percent-encoded) carries
the words heard just before, which Whisper uses as context. GET /health reports what is running; POST /shutdown stops
the server, so the app can restart it with other settings on any OS.
"""
import argparse
import importlib.util
import io
import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / 'voices' / 'stt'
MAX_BODY = 50 * 1024 * 1024
SAMPLE_RATE = 16000
PROTOCOL = 2
# Useful Sensors' Moonshine models (their Hugging Face organisation is now called moonshine-ai; the old name redirects).
MOONSHINE_REPO = 'UsefulSensors/moonshine'
WHISPER_MODELS = ('tiny.en', 'base.en', 'small.en')
MOONSHINE_MODELS = ('tiny', 'base', 'tiny-quantized', 'base-quantized')
DEFAULT_MODELS = {'whisper': 'base.en', 'moonshine': 'base'}
# Consecutive GPU failures after which the GPU is given up for the rest of the run.
GPU_GIVE_UP = 3


def log(message: str) -> None:
    print(f'[stt] {message}', file=sys.stderr, flush=True)


def add_dll_directories() -> None:
    """Windows: Python does not search PATH for the DLLs of native modules, so the NVIDIA folders are added here."""
    if sys.platform != 'win32' or not hasattr(os, 'add_dll_directory'):
        return
    for folder in os.environ.get('JARVIS_DLL_DIRS', '').split(os.pathsep):
        if folder and os.path.isdir(folder):
            os.add_dll_directory(folder)


def installed(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


# ---- Audio ---------------------------------------------------------------------------------------------------------

def pcm_samples(body: bytes) -> np.ndarray:
    """Raw 16-bit little-endian mono PCM to float32 samples."""
    usable = len(body) - len(body) % 2
    return np.frombuffer(body[:usable], '<i2').astype(np.float32) / 32768.0


class DecodeError(Exception):
    pass


def decode_with_pyav(audio: bytes) -> np.ndarray:
    import av
    resampler = av.AudioResampler(format='s16', layout='mono', rate=SAMPLE_RATE)
    blocks = []
    with av.open(io.BytesIO(audio)) as container:
        for frame in container.decode(audio=0):
            blocks += [out.to_ndarray().reshape(-1) for out in resampler.resample(frame)]
    blocks += [out.to_ndarray().reshape(-1) for out in resampler.resample(None)]
    return np.concatenate(blocks).astype(np.float32) / 32768.0 if blocks else np.zeros(0, np.float32)


def decode_clip(audio: bytes) -> np.ndarray:
    """A recorded clip in any container, decoded to 16 kHz mono: with PyAV (FFmpeg's libraries, installed with
    faster-whisper) when it can, else with the ffmpeg program."""
    if installed('av'):
        try:
            return decode_with_pyav(audio)
        except Exception as e:
            if not shutil.which('ffmpeg'):
                raise
            log(f'PyAV could not decode the clip ({first_line(e)}); trying ffmpeg')
    ffmpeg = shutil.which('ffmpeg')
    if not ffmpeg:
        raise DecodeError('This browser sends compressed audio, and decoding it needs ffmpeg, which is not installed. '
                          'Install ffmpeg, or use a browser with Web Audio (any current Chrome, Edge, Firefox or Safari).')
    command = [ffmpeg, '-nostdin', '-loglevel', 'error', '-i', 'pipe:0',
               '-f', 's16le', '-ac', '1', '-ar', str(SAMPLE_RATE), 'pipe:1']
    result = subprocess.run(command, input=audio, capture_output=True, check=True)
    return pcm_samples(result.stdout)


# ---- Engines -------------------------------------------------------------------------------------------------------

def cpu_threads() -> int:
    return max(1, min(os.cpu_count() or 4, 8))


class WhisperEngine:
    """faster-whisper (CTranslate2): int8 on the CPU; float16 on a GPU that has it, else float32."""
    name = 'whisper'

    def __init__(self, model: str, device: str) -> None:
        from faster_whisper import WhisperModel
        self.model_name = model
        self.device = device
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        if device == 'gpu':
            import ctranslate2
            types = ctranslate2.get_supported_compute_types('cuda')
            compute = 'float16' if 'float16' in types else 'float32'
            self.model = WhisperModel(model, device='cuda', compute_type=compute, download_root=str(MODELS_DIR))
        else:
            self.model = WhisperModel(model, device='cpu', compute_type='int8', cpu_threads=cpu_threads(),
                                      download_root=str(MODELS_DIR))
        self.english_only = model.endswith('.en')

    def transcribe(self, samples: np.ndarray, prompt: str = '', vad: bool = True) -> str:
        segments, _ = self.model.transcribe(
            samples, language='en', beam_size=1, vad_filter=vad, without_timestamps=True,
            condition_on_previous_text=False, initial_prompt=prompt or None)
        return ''.join(segment.text for segment in segments).strip()


def speech_span(samples: np.ndarray) -> np.ndarray | None:
    """The samples from the first speech to the last (Silero VAD, from faster-whisper when it is installed); None when
    there is no speech at all. Without the VAD the samples are returned as they are."""
    if not installed('faster_whisper'):
        return samples
    from faster_whisper.vad import VadOptions, get_speech_timestamps
    spans = get_speech_timestamps(samples, VadOptions(min_silence_duration_ms=300, speech_pad_ms=200))
    if not spans:
        return None
    return samples[spans[0]['start']:spans[-1]['end']]


def moonshine_files(model: str) -> tuple[Path, Path]:
    """The encoder and decoder of a Moonshine model, downloaded into voices/stt/moonshine the first time."""
    name, _, precision = model.partition('-')
    precision = precision or 'float'
    if name not in ('tiny', 'base') or precision not in ('float', 'quantized'):
        raise ValueError(f'unknown Moonshine model {model}')
    local = MODELS_DIR / 'moonshine'
    paths = [f'onnx/merged/{name}/{precision}/{x}.onnx' for x in ('encoder_model', 'decoder_model_merged')]
    if not all((local / p).exists() for p in paths):
        from huggingface_hub import hf_hub_download
        log(f'downloading Moonshine {model} into {local}')
        for p in paths:
            hf_hub_download(MOONSHINE_REPO, p, local_dir=str(local))
    return local / paths[0], local / paths[1]


def onnx_providers(device: str) -> list[str]:
    """The onnxruntime providers for a device: CUDA (onnxruntime-gpu) or Core ML (macOS) for the GPU when this
    onnxruntime has them."""
    import onnxruntime
    available = onnxruntime.get_available_providers()
    if device == 'gpu':
        for provider in ('CUDAExecutionProvider', 'CoreMLExecutionProvider'):
            if provider in available:
                return [provider, 'CPUExecutionProvider']
        raise RuntimeError('this onnxruntime has no GPU provider')
    return ['CPUExecutionProvider']


class MoonshineEngine:
    """Moonshine (Useful Sensors) on onnxruntime: its work grows with the length of the audio, unlike Whisper's fixed
    30-second window, so short commands are fast."""
    name = 'moonshine'

    def __init__(self, model: str, device: str) -> None:
        import onnxruntime
        from moonshine_onnx import MoonshineOnnxModel, load_tokenizer
        self.model_name = model
        self.device = device
        encoder, decoder = moonshine_files(model)
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = cpu_threads()
        providers = onnx_providers(device)
        # The package's model class loads its sessions itself, with default options; here they are made with the
        # chosen providers and threads, and its generate() (greedy decoding with the merged decoder) is used as it is.
        self.model = MoonshineOnnxModel.__new__(MoonshineOnnxModel)
        self.model.encoder = onnxruntime.InferenceSession(str(encoder), options, providers=providers)
        self.model.decoder = onnxruntime.InferenceSession(str(decoder), options, providers=providers)
        self.model.encoder_input_names = [x.name for x in self.model.encoder.get_inputs()]
        self.model.decoder_input_names = [x.name for x in self.model.decoder.get_inputs()]
        cache = [x for x in self.model.decoder.get_inputs() if x.name.startswith('past_key_values.') and x.name.endswith('.decoder.key')]
        self.model.num_layers = len(cache)
        self.model.num_key_value_heads = cache[0].shape[1]
        self.model.head_dim = cache[0].shape[3]
        self.model.decoder_start_token_id = 1
        self.model.eos_token_id = 2
        self.tokenizer = load_tokenizer()

    def transcribe(self, samples: np.ndarray, prompt: str = '', vad: bool = True) -> str:
        if vad:
            # Moonshine makes up words for noise alone, so only the part with speech is given to it.
            speech = speech_span(samples)
            if speech is None:
                return ''
            samples = speech
        seconds = len(samples) / SAMPLE_RATE
        if seconds < 0.1:
            return ''
        if seconds > 60:
            samples = samples[:60 * SAMPLE_RATE]
            seconds = 60
        # About six tokens a second of speech at most; a cap stops a rare repeating loop early.
        tokens = self.model.generate(samples[None, :].astype(np.float32), max_len=int(seconds * 6.5) + 10)
        return self.tokenizer.decode_batch(tokens)[0].strip()


ENGINES = {'whisper': WhisperEngine, 'moonshine': MoonshineEngine}


def gpu_key(engine: str) -> str:
    """What a GPU test result depends on: the engine's runtime version and the NVIDIA libraries installed."""
    parts = [engine, sys.platform]
    try:
        if engine == 'whisper':
            import ctranslate2
            parts.append(ctranslate2.__version__)
        else:
            import onnxruntime
            parts += [onnxruntime.__version__, *onnxruntime.get_available_providers()]
        import nvidia
        folder = list(nvidia.__path__)[0]
        parts += sorted(n for n in os.listdir(folder) if not n.startswith('_') and os.path.isdir(os.path.join(folder, n)))
    except Exception:
        pass
    return ' '.join(parts)


GPU_CHECK = MODELS_DIR / 'gpu-check.json'


def gpu_checks() -> dict:
    try:
        return json.loads(GPU_CHECK.read_text())
    except Exception:
        return {}


def known_gpu_failure(engine: str) -> str:
    """The error of the last GPU test of this engine, if nothing it depends on has changed since."""
    check = gpu_checks().get(engine) or {}
    return check.get('error', '') if check.get('key') == gpu_key(engine) and not check.get('ok') else ''


def remember_gpu_test(engine: str, error: str) -> None:
    checks = gpu_checks()
    checks[engine] = {'key': gpu_key(engine), 'ok': not error, 'error': error}
    try:
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        GPU_CHECK.write_text(json.dumps(checks, indent=1))
    except OSError:
        pass


def has_gpu_runtime(engine: str) -> bool:
    """A GPU runtime is there for the engine: CUDA devices for CTranslate2 (not on macOS), a GPU provider for
    onnxruntime. Whether the GPU can run the model is only known from a test transcription."""
    try:
        if engine == 'whisper':
            if sys.platform == 'darwin':
                return False
            import ctranslate2
            return ctranslate2.get_cuda_device_count() > 0
        onnx_providers('gpu')
        return True
    except Exception:
        return False


def test_signal() -> np.ndarray:
    """A second of faint noise: enough to run every layer once."""
    return (np.random.default_rng(0).standard_normal(SAMPLE_RATE) * 0.003).astype(np.float32)


class Recogniser:
    """The engine in use, with auto falling back to the CPU when the GPU fails at start-up or later."""

    def __init__(self, engine: str, model: str, device: str, test_gpu: bool = True) -> None:
        self.engine_name = engine
        self.model_name = model
        self.requested = device
        self.gpu_error = ''
        self.gpu_failures = 0
        self.warned = False
        self.cpu = None
        self.gpu = None
        if device in ('auto', 'gpu'):
            known = known_gpu_failure(engine) if device == 'auto' else ''
            if not has_gpu_runtime(engine):
                if device == 'gpu':
                    self.gpu_error = 'no GPU runtime for this engine here'
                    log(f'{engine} has no GPU runtime here; using the CPU')
            elif known:
                # auto does not retry a GPU that failed its test until something it depends on changes.
                self.gpu_error = known
                log(f'the GPU failed its test before ({known}); using the CPU')
            else:
                try:
                    self.gpu = ENGINES[engine](model, 'gpu')
                    if test_gpu:
                        self.gpu.transcribe(test_signal(), vad=False)
                        remember_gpu_test(engine, '')
                    log(f'{engine} {model} on the GPU')
                except Exception as e:
                    self.gpu = None
                    self.gpu_error = first_line(e)
                    if test_gpu:
                        remember_gpu_test(engine, self.gpu_error)
                    log(f'the GPU could not run {engine} ({self.gpu_error}); using the CPU')
        if self.gpu is None:
            self.cpu = ENGINES[engine](model, 'cpu')
            log(f'{engine} {model} on the CPU')

    @property
    def device(self) -> str:
        return 'gpu' if self.gpu is not None else 'cpu'

    def transcribe(self, samples: np.ndarray, prompt: str = '', vad: bool = True) -> str:
        if self.gpu is not None:
            try:
                text = self.gpu.transcribe(samples, prompt, vad)
                self.gpu_failures = 0
                return text
            except Exception as e:
                self.gpu_failures += 1
                self.gpu_error = first_line(e)
                if not self.warned:
                    log(f'the GPU failed ({self.gpu_error}); this request runs on the CPU')
                    self.warned = True
                if self.gpu_failures >= GPU_GIVE_UP:
                    log('the GPU failed again; using the CPU from now on')
                    self.gpu = None
        if self.cpu is None:
            self.cpu = ENGINES[self.engine_name](self.model_name, 'cpu')
        return self.cpu.transcribe(samples, prompt, vad)


def first_line(error: BaseException) -> str:
    text = str(error).strip().splitlines()
    return (text[0] if text else type(error).__name__)[:300]


# ---- Capabilities --------------------------------------------------------------------------------------------------

def downloaded_models() -> dict:
    """The models already in voices/stt, per engine."""
    whisper = []
    for folder in MODELS_DIR.glob('models--Systran--faster-whisper-*'):
        if any(folder.glob('snapshots/*/model.bin')):
            whisper.append(folder.name.split('faster-whisper-', 1)[1])
    moonshine = []
    for folder in (MODELS_DIR / 'moonshine' / 'onnx' / 'merged').glob('*/*'):
        if (folder / 'encoder_model.onnx').exists() and (folder / 'decoder_model_merged.onnx').exists():
            moonshine.append(folder.parent.name + ('' if folder.name == 'float' else f'-{folder.name}'))
    return {'whisper': sorted(whisper), 'moonshine': sorted(moonshine)}


def probe() -> dict:
    """What this Python can run: engines installed, GPU runtimes found (not yet tested)."""
    out = {
        'protocol': PROTOCOL,
        'platform': sys.platform,
        'machine': platform.machine(),
        'engines': {'whisper': installed('faster_whisper'), 'moonshine': installed('moonshine_onnx') and installed('onnxruntime')},
        'cudaDevices': 0,
        'onnxProviders': [],
        'decoder': 'pyav' if installed('av') else 'ffmpeg' if shutil.which('ffmpeg') else '',
    }
    if out['engines']['whisper']:
        try:
            import ctranslate2
            out['cudaDevices'] = ctranslate2.get_cuda_device_count()
        except Exception:
            pass
    if installed('onnxruntime'):
        try:
            import onnxruntime
            out['onnxProviders'] = onnxruntime.get_available_providers()
        except Exception:
            pass
    out['downloaded'] = downloaded_models()
    out['gpu'] = {}
    for engine, ok in out['engines'].items():
        if ok:
            try:
                out['gpu'][engine] = {'runtime': has_gpu_runtime(engine), 'failed': known_gpu_failure(engine)}
            except Exception as e:
                out['gpu'][engine] = {'runtime': False, 'failed': first_line(e)}
    return out


# ---- HTTP ----------------------------------------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    recogniser: Recogniser
    lock = threading.Lock()
    server_ref: ThreadingHTTPServer

    def do_GET(self) -> None:
        if self.path == '/health':
            r = self.recogniser
            self.send_json(200, {
                'ok': True, 'protocol': PROTOCOL, 'engine': r.engine_name, 'model': r.model_name,
                'requested': r.requested, 'device': r.device, 'gpuError': r.gpu_error,
            })
        else:
            self.send_json(404, {'error': 'not found'})

    def do_POST(self) -> None:
        if self.path == '/shutdown':
            self.send_json(200, {'ok': True})
            threading.Thread(target=self.server_ref.shutdown, daemon=True).start()
            return
        if self.path != '/transcribe':
            self.send_json(404, {'error': 'not found'})
            return
        length = int(self.headers.get('content-length') or 0)
        if length <= 0 or length > MAX_BODY:
            self.send_json(400, {'error': 'expected an audio body'})
            return
        audio = self.rfile.read(length)
        kind = (self.headers.get('content-type') or '').lower()
        prompt = unquote(self.headers.get('x-prompt') or '')[-600:]
        started = time.perf_counter()
        try:
            if kind.startswith('audio/s16le'):
                if 'rate=' in kind and f'rate={SAMPLE_RATE}' not in kind.replace(' ', ''):
                    self.send_json(415, {'error': f'raw audio must be {SAMPLE_RATE} Hz'})
                    return
                samples = pcm_samples(audio)
            else:
                samples = decode_clip(audio)
        except DecodeError as e:
            self.send_json(415, {'error': str(e)})
            return
        except Exception as e:
            log(f'could not decode the audio: {first_line(e)}')
            self.send_json(422, {'error': 'could not decode the audio'})
            return
        decoded = time.perf_counter()
        try:
            with self.lock:
                text = self.recogniser.transcribe(samples, prompt)
        except Exception as e:
            log(f'transcription failed: {first_line(e)}')
            self.send_json(422, {'error': 'could not transcribe audio'})
            return
        done = time.perf_counter()
        self.send_json(200, {
            'text': text, 'device': self.recogniser.device, 'seconds': round(len(samples) / SAMPLE_RATE, 3),
            'decodeMs': round(1000 * (decoded - started)), 'ms': round(1000 * (done - decoded)),
        })

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args) -> None:
        pass


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second server take a port that is in use, so it is left off there.
    allow_reuse_address = sys.platform != 'win32'
    daemon_threads = True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=4722)
    parser.add_argument('--engine', choices=sorted(ENGINES), default='whisper')
    parser.add_argument('--model', default='')
    parser.add_argument('--device', choices=('auto', 'cpu', 'gpu'), default='auto')
    parser.add_argument('--download-only', action='store_true', help='fetch the model and exit')
    parser.add_argument('--probe', action='store_true', help='print what this Python can run, as JSON, and exit')
    args = parser.parse_args()
    add_dll_directories()
    if args.probe:
        print(json.dumps(probe()))
        return
    model = args.model or (os.environ.get('JARVIS_STT_MODEL', '') if args.engine == 'whisper' else '') or DEFAULT_MODELS[args.engine]
    if args.download_only:
        ENGINES[args.engine](model, 'cpu')
        print(f'Speech model ready: {args.engine} {model} in {MODELS_DIR}')
        return
    recogniser = Recogniser(args.engine, model, args.device, test_gpu=os.environ.get('JARVIS_STT_SKIP_GPU_TEST') != '1')
    server = Server(('127.0.0.1', args.port), Handler)
    Handler.recogniser = recogniser
    Handler.server_ref = server
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
