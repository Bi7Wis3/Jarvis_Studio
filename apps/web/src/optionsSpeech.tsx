// Options > Speech: the recogniser behind the Talk button, its model, and the device it runs on, with what this machine
// can run. (SolidWorks has no speech input, so the page is plain.) Only devices an engine can use here are offered;
// for the others the page says why.

import { useEffect, useState } from 'react';
import { SPEECH_MODELS, type SpeechDevice, type SpeechEngine, type SpeechSettings } from '@jarvis/core/settings';
import { Note, Section, type PageProps } from './optionsPages';

/** What the server reports (GET /api/stt/status; stt.ts SpeechStatus). */
export interface SpeechStatus {
    available: boolean;
    platform: string;
    installed: Record<SpeechEngine, boolean>;
    gpuLibraries: boolean;
    probe: {
        cudaDevices: number;
        onnxProviders: string[];
        decoder: string;
        downloaded?: Partial<Record<SpeechEngine, string[]>>;
        gpu: Partial<Record<SpeechEngine, { runtime: boolean; failed: string }>>;
    } | null;
    wanted: { engine: SpeechEngine; model: string; device: SpeechDevice };
    running: { engine: SpeechEngine; model: string; requested: SpeechDevice; device: SpeechDevice; gpuError: string } | null;
}

async function fetchStatus(): Promise<SpeechStatus | null> {
    try {
        const response = await fetch('/api/stt/status');
        return response.ok ? await response.json() as SpeechStatus : null;
    } catch {
        return null;
    }
}

const ENGINE_NAMES: Record<SpeechEngine, string> = { whisper: 'Whisper (faster-whisper)', moonshine: 'Moonshine (Useful Sensors)' };
const DEVICE_NAMES: Record<SpeechDevice, string> = { auto: 'Auto: the GPU if it works, else the CPU', cpu: 'CPU', gpu: 'GPU' };

/** Whether the engine can use a GPU on this machine, and why not when it cannot. */
export function gpuChoice(status: SpeechStatus | null, engine: SpeechEngine): { offered: boolean; why: string } {
    if (!status?.probe) {
        return { offered: false, why: '' };
    }
    const gpu = status.probe.gpu[engine];
    if (engine === 'whisper') {
        if (status.platform === 'darwin') {
            return { offered: false, why: 'macOS has no CUDA, so Whisper runs on the CPU.' };
        }
        if (status.probe.cudaDevices === 0) {
            return { offered: false, why: 'No NVIDIA GPU was found, so Whisper runs on the CPU.' };
        }
        if (!status.gpuLibraries) {
            return { offered: false, why: 'The NVIDIA libraries are not installed: run "npm run setup:stt -- --gpu" to use the GPU.' };
        }
        if (gpu?.failed) {
            return {
                offered: false,
                why: `The GPU failed its test transcription (${gpu.failed}), so Whisper runs on the CPU. CTranslate2's current wheels `
                    + 'have GPU code only for compute capability 5.3 and newer.',
            };
        }
        return { offered: true, why: '' };
    }
    if (!gpu?.runtime) {
        return { offered: false, why: 'Moonshine runs on the CPU here: this onnxruntime has no GPU provider (CUDA needs onnxruntime-gpu).' };
    }
    if (gpu.failed) {
        return { offered: false, why: `The GPU failed its test transcription (${gpu.failed}), so Moonshine runs on the CPU.` };
    }
    return { offered: true, why: '' };
}

function Select<T extends string>(props: { label: string; value: T; options: { value: T; text: string; disabled?: boolean }[]; onChange: (v: T) => void }) {
    const { label, value, options, onChange } = props;
    return (
        <label className="tb-field">
            <span>{label}</span>
            <span className="tb-input">
                <select value={value} onChange={(e) => onChange(e.target.value as T)}>
                    {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.text}</option>)}
                </select>
            </span>
        </label>
    );
}

function runningText(status: SpeechStatus | null): string {
    if (!status) {
        return 'The server is not answering.';
    }
    if (!status.available) {
        return 'No speech recogniser is installed: run "npm run setup:stt -- --moonshine".';
    }
    const r = status.running;
    if (!r) {
        return 'Starting…';
    }
    const where = r.device === 'gpu' ? 'the GPU' : 'the CPU';
    const changing = r.engine !== status.wanted.engine || r.model !== status.wanted.model || r.requested !== status.wanted.device;
    return `${changing ? 'Still running' : 'Running'}: ${ENGINE_NAMES[r.engine]} ${r.model} on ${where}${changing ? ' (restarting with the new settings…)' : ''}.`;
}

export function SpeechPage({ draft, setDraft }: PageProps) {
    const speech = draft.settings.speech;
    const set = (patch: Partial<SpeechSettings>) => setDraft({ ...draft, settings: { ...draft.settings, speech: { ...speech, ...patch } } });
    const [status, setStatus] = useState<SpeechStatus | null>(null);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let alive = true;
        const refresh = async () => {
            const next = await fetchStatus();
            if (alive) {
                setStatus(next);
                setLoaded(true);
            }
        };
        void refresh();
        // The speech server restarts after Apply; the line above the settings follows it.
        const timer = window.setInterval(() => void refresh(), 2000);
        return () => {
            alive = false;
            window.clearInterval(timer);
        };
    }, []);

    const engine = speech.engine;
    const model = engine === 'whisper' ? speech.whisperModel : speech.moonshineModel;
    const installed = status?.installed ?? { whisper: true, moonshine: true };
    const gpu = gpuChoice(status, engine);
    const devices: { value: SpeechDevice; text: string; disabled?: boolean }[] = [
        { value: 'auto', text: DEVICE_NAMES.auto },
        { value: 'cpu', text: DEVICE_NAMES.cpu },
        ...(gpu.offered ? [{ value: 'gpu' as const, text: DEVICE_NAMES.gpu }]
            : speech.device === 'gpu' ? [{ value: 'gpu' as const, text: 'GPU (not available here)', disabled: true }] : []),
    ];
    const downloaded = status?.probe?.downloaded?.[engine];
    const info = SPEECH_MODELS[engine].find((m) => m.id === model);
    const fallback = status?.running && status.running.requested !== 'cpu' && status.running.device === 'cpu' && status.running.gpuError;

    return (
        <>
            <Section title="Recogniser">
                <p className="op-note">{loaded ? runningText(status) : 'Asking the server…'}</p>
                {fallback && gpu.offered && <Note>The GPU did not work at start-up ({status?.running?.gpuError}), so it runs on the CPU.</Note>}
                <Select
                    label="Engine"
                    value={engine}
                    options={(['moonshine', 'whisper'] as SpeechEngine[]).map((e) => ({
                        value: e, text: installed[e] ? ENGINE_NAMES[e] : `${ENGINE_NAMES[e]}: not installed`, disabled: !installed[e] && e !== engine,
                    }))}
                    onChange={(e) => set({ engine: e })}
                />
                {!installed[engine] && (
                    <Note>
                        {engine === 'moonshine' ? 'Moonshine is not installed: run "npm run setup:stt -- --moonshine".'
                            : 'Whisper is not installed: run "npm run setup:stt".'} Until then the other engine is used.
                    </Note>
                )}
                <Select
                    label="Model"
                    value={model}
                    options={SPEECH_MODELS[engine].map((m) => ({ value: m.id, text: m.label }))}
                    onChange={(m) => set(engine === 'whisper' ? { whisperModel: m } : { moonshineModel: m })}
                />
                {downloaded && info && !downloaded.includes(model) && (
                    <Note>{info.id} is not on this computer yet: it is downloaded ({info.size}) when the settings are applied, before Talk works.</Note>
                )}
                <Select label="Device" value={speech.device} options={devices} onChange={(d) => set({ device: d })} />
                {gpu.why && <Note>{gpu.why}</Note>}
                <Note>
                    Moonshine's work grows with the length of what was said, so short commands are quick on a CPU; Whisper always works on a
                    30-second window, so it is slower on a CPU and suits a GPU. On a two-core laptop CPU, a 7-second command took about
                    0.9 s with Moonshine base and 1.9 s with Whisper base.en, with Moonshine making fewer mistakes; said in phrases, about
                    0.4 s is left after Talk is released with Moonshine. The 8-bit models were slower there, not faster.
                </Note>
            </Section>
        </>
    );
}
