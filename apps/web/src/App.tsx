import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ErrorBoundary } from './ErrorBoundary';
import { Labels } from './Labels';
import { Activity } from './Activity';
import { Orb } from './Orb';
import { Scene } from './Scene';
import { micSupported, startRecording, stopRecording } from './mic';
import { act, ask, setQuality, stop, useStudio } from './state';
import type { ViewAction } from '@jarvis/core';
import { imageFiles, readImage } from './attachments';
import { Browser } from './Browser';
import { FileMenu } from './FileMenu';
import { Toolbar } from './Toolbar';
import { Hud } from './Hud';
import { ViewMenu } from './viewMenu';
import { OptionsPage } from './OptionsPage';
import { useOptions } from './options';

const QUICK_ACTIONS: { label: string; action: ViewAction }[] = [
    { label: 'Explode', action: 'explode' },
    { label: 'Assemble', action: 'assemble' },
    { label: 'Spin', action: 'spin' },
    { label: 'Undo', action: 'undo' },
];

function StatusChip() {
    const { connected, model, voice, status, detail, quality } = useStudio();
    // Options > AI assistant: the model and effort behind each choice.
    const ai = useOptions((s) => s.settings.ai);
    const activity = status === 'working' && detail ? detail.replace(/_/g, ' ') : status;
    return (
        <div className="chip status">
            <span className={`dot ${connected ? 'up' : 'down'}`} />
            <span>{model || 'Claude'}</span>
            <span className="muted">{voice ? 'Piper voice' : 'browser voice'}</span>
            <span className="muted">{connected ? activity : 'reconnecting'}</span>
            <span className="quality" role="group" aria-label="Design quality">
                {(['fast', 'best'] as const).map((q) => (
                    <button
                        key={q}
                        type="button"
                        className={quality === q ? 'on' : ''}
                        onClick={() => setQuality(q)}
                        title={q === 'fast' ? `${ai.fast.model} at ${ai.fast.effort} effort: quick`
                            : `${ai.best.model} at ${ai.best.effort} effort: slower, better designs`}
                    >
                        {q === 'fast' ? 'Fast' : 'Best'}
                    </button>
                ))}
            </span>
        </div>
    );
}

/** Push-to-talk: hold to record, release to send what was heard to Jarvis. */
function MicButton() {
    const [phase, setPhase] = useState<'idle' | 'listening' | 'transcribing'>('idle');

    const note = (message: string) => {
        useStudio.setState({ error: message });
        window.setTimeout(() => useStudio.setState({ error: null }), 8000);
    };
    const begin = () => {
        if (phase !== 'idle') {
            return;
        }
        stop();
        setPhase('listening');
        startRecording().catch(() => {
            setPhase('idle');
            note('The microphone is not available.');
        });
    };
    const end = async () => {
        if (phase !== 'listening') {
            return;
        }
        setPhase('transcribing');
        let text: string | null = null;
        try {
            text = await stopRecording();
        } catch (e) {
            console.error('Could not transcribe recording', e);
            note('Speech recognition is not answering, so nothing was sent to Jarvis.');
        }
        setPhase('idle');
        if (text) {
            ask(text);
        } else if (text === '') {
            note('No words were heard. Hold the button while you speak.');
        }
    };

    return (
        <button
            type="button"
            className={`action mic ${phase}`}
            onPointerDown={begin}
            onPointerUp={end}
            onPointerLeave={end}
            title="Hold to talk"
            aria-label="Hold to talk"
        >
            {phase === 'listening' ? 'Listening' : phase === 'transcribing' ? '…' : 'Talk'}
        </button>
    );
}

const MAX_ATTACHMENTS = 4;

type Attachment = Awaited<ReturnType<typeof readImage>>;

function PromptBar() {
    const [text, setText] = useState('');
    const [images, setImages] = useState<Attachment[]>([]);
    const [dragging, setDragging] = useState(false);
    const draft = useStudio((s) => s.draft);
    const field = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (draft) {
            setText(draft.text);
            field.current?.focus();
        }
    }, [draft]);

    const attach = async (files: File[]) => {
        const read = await Promise.all(files.slice(0, MAX_ATTACHMENTS).map((file) => readImage(file).catch(() => null)));
        setImages((current) => [...current, ...read.filter((i): i is Attachment => i !== null)].slice(0, MAX_ATTACHMENTS));
    };

    useEffect(() => {
        // Pasting a picture anywhere in the app attaches it, not only when the prompt field has focus.
        const onPaste = (event: ClipboardEvent) => {
            const files = imageFiles(event.clipboardData);
            if (files.length) {
                event.preventDefault();
                void attach(files);
            }
        };
        window.addEventListener('paste', onPaste);
        return () => window.removeEventListener('paste', onPaste);
    }, []);
    const busy = useStudio((s) => s.status !== 'idle' || s.speaking);
    const ears = useStudio((s) => s.ears);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                stop();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (text.trim() || images.length) {
            ask(text.trim(), images.map(({ data, mimeType }) => ({ data, mimeType })));
            setText('');
            setImages([]);
        }
    };

    return (
        <form
            className={`prompt ${dragging ? 'dragging' : ''}`}
            onSubmit={submit}
            onDragOver={(event) => {
                if ([...event.dataTransfer.items].some((item) => item.type.startsWith('image/'))) {
                    event.preventDefault();
                    setDragging(true);
                }
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
                setDragging(false);
                const files = imageFiles(event.dataTransfer);
                if (files.length) {
                    event.preventDefault();
                    void attach(files);
                }
            }}
        >
            {images.map((image, i) => (
                <span key={i} className="attachment">
                    <img src={image.preview} alt={`Attached picture ${i + 1}`} />
                    <button
                        type="button"
                        onClick={() => setImages(images.filter((_, j) => j !== i))}
                        aria-label={`Remove picture ${i + 1}`}
                    >
                        ×
                    </button>
                </span>
            ))}
            <input
                ref={field}
                autoFocus
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={images.length ? 'What should Jarvis do with it? (Enter: "build this")'
                    : 'Ask Jarvis · "build me a desk lamp" · paste a picture'}
                aria-label="Ask Jarvis"
            />
            {ears && micSupported() && <MicButton />}
            {QUICK_ACTIONS.map(({ label, action }) => (
                <button
                    key={label}
                    type="button"
                    className="action"
                    onClick={() => act(action)}
                    disabled={busy && action === 'undo'}
                >
                    {label}
                </button>
            ))}
            {busy && (
                <button type="button" className="action stop" onClick={stop} title="Stop (Esc)">
                    Stop
                </button>
            )}
        </form>
    );
}

export function App() {
    const project = useStudio((s) => s.project);
    const subtitle = useStudio((s) => s.subtitle);
    const error = useStudio((s) => s.error);

    return (
        <main>
            <ErrorBoundary>{project && <Scene project={project} />}</ErrorBoundary>
            <div className="vignette" />
            {project && <Labels project={project} />}
            <header>
                <FileMenu />
            </header>
            <Browser />
            <Orb />
            <StatusChip />
            <Activity />
            {project && <Toolbar />}
            {project && <Hud />}
            <ViewMenu />
            <OptionsPage />
            <footer>
                {error && <div className="bubble error">{error}</div>}
                {subtitle && !error && <div className="bubble">{subtitle}</div>}
                <PromptBar />
            </footer>
        </main>
    );
}
