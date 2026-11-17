// Options > Speech: which recogniser turns the Talk button's audio into words, which of its models, and where it runs.
// Kept apart from the other categories (settings.ts only lists it) so it can grow without touching them.

export type SpeechEngine = 'whisper' | 'moonshine';
export const SPEECH_ENGINES: SpeechEngine[] = ['whisper', 'moonshine'];

/** auto: the GPU when it passes a test transcription at start-up, else the CPU. */
export type SpeechDevice = 'auto' | 'cpu' | 'gpu';
export const SPEECH_DEVICES: SpeechDevice[] = ['auto', 'cpu', 'gpu'];

export interface SpeechModelInfo {
    id: string;
    label: string;
    /** Download size, for the note that a model not yet on this machine is fetched the first time it is used. */
    size: string;
}

/** The models offered per engine, smallest first. */
export const SPEECH_MODELS: Record<SpeechEngine, SpeechModelInfo[]> = {
    whisper: [
        { id: 'tiny.en', label: 'tiny.en (fastest, least accurate)', size: '75 MB' },
        { id: 'base.en', label: 'base.en', size: '140 MB' },
        { id: 'small.en', label: 'small.en (slow on a CPU, most accurate)', size: '480 MB' },
    ],
    moonshine: [
        { id: 'tiny-quantized', label: 'tiny, 8-bit (fastest)', size: '28 MB' },
        { id: 'tiny', label: 'tiny', size: '110 MB' },
        { id: 'base-quantized', label: 'base, 8-bit', size: '63 MB' },
        { id: 'base', label: 'base (most accurate)', size: '250 MB' },
    ],
};

export interface SpeechSettings {
    engine: SpeechEngine;
    /** The model of each engine, kept while the other engine is chosen. */
    whisperModel: string;
    moonshineModel: string;
    device: SpeechDevice;
}

export const DEFAULT_SPEECH: SpeechSettings = { engine: 'moonshine', whisperModel: 'base.en', moonshineModel: 'base', device: 'auto' };

const isModel = (engine: SpeechEngine, v: unknown): v is string => SPEECH_MODELS[engine].some((m) => m.id === v);

/** Valid speech settings from anything: missing or unknown values take the fallback's (old settings files have none). */
export function normaliseSpeech(raw: unknown, fallback: SpeechSettings = DEFAULT_SPEECH): SpeechSettings {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    return {
        engine: SPEECH_ENGINES.includes(r.engine as SpeechEngine) ? r.engine as SpeechEngine : fallback.engine,
        whisperModel: isModel('whisper', r.whisperModel) ? r.whisperModel : fallback.whisperModel,
        moonshineModel: isModel('moonshine', r.moonshineModel) ? r.moonshineModel : fallback.moonshineModel,
        device: SPEECH_DEVICES.includes(r.device as SpeechDevice) ? r.device as SpeechDevice : fallback.device,
    };
}

/** What the speech server is started with; it restarts only when this changes. */
export interface SpeechRuntime {
    engine: SpeechEngine;
    model: string;
    device: SpeechDevice;
}

export function speechRuntime(s: SpeechSettings): SpeechRuntime {
    return { engine: s.engine, model: s.engine === 'whisper' ? s.whisperModel : s.moonshineModel, device: s.device };
}

export const sameRuntime = (a: SpeechRuntime, b: SpeechRuntime): boolean =>
    a.engine === b.engine && a.model === b.model && a.device === b.device;
