import { create } from 'zustand';
import { partsAtTimeline } from '@jarvis/core';
import type { ActivityEntry, AgentStatus, ClientMessage, ImageAttachment, MeshStatus, Project, ProjectEntry, ServerMessage, ViewAction } from '@jarvis/core';
import { enqueue, onSpeech, silence, unlockAudio } from './audio';
import { captureViewport } from './capture';
import { withFollowed } from './followedRefs';
import { togglePick, type PickedEntity } from './picking';
import { CAPTURED, captureCall, type Preview } from './preview';
import { setKernelActivity } from './kernelActivity';
import { undefinedSketchRefusal } from './sketchUseDefined';

export { captureToolCalls } from './preview';

interface StudioState {
    /** The project as shown: hidden parts left out. */
    project: Project | null;
    /** The full project, with every step of the history. */
    history: Project | null;
    /** Real geometry status per part from the CAD kernel. */
    meshes: MeshStatus;
    quality: 'fast' | 'best';
    activity: ActivityEntry[];
    /** Text placed in the prompt field from elsewhere, e.g. a past command; `n` makes repeats distinct. */
    draft: { text: string; n: number } | null;
    /** Part selected in the viewport or tree, for the toolbar. Local to this browser. */
    selected: string | null;
    /** Viewport interaction mode: picking parts, or drawing in the sketcher. */
    mode: 'select' | 'sketch';
    /**
     * CAD workspace. part: edit one part's history (sketches and features) in isolation;
     * assembly: place, fasten, pattern and explode parts. Local to this browser.
     */
    workspace: 'part' | 'assembly';
    /** The part being edited in the part workspace. */
    activePart: string | null;
    /**
     * How the part workspace shows the active part (see partView.ts). isolated: the part alone (Edit part);
     * inContext: the other parts of the assembly drawn faintly around it (Edit in place). The toolbar's
     * "Show other parts" switches this too.
     */
    partView: 'isolated' | 'inContext';
    /**
     * A request to edit one history item of a part: its base body (featureId null) or one feature. The browser
     * panel sets it; the toolbar/sketcher opens the matching editor prefilled and clears it when done.
     */
    editing: { partId: string; featureId: string | null } | null;
    /**
     * Faces and edges picked on the active part in the part workspace, by ordinal in its current kernel mesh.
     * Ordinals change when the part rebuilds, so the list is cleared then. Local to this browser.
     */
    picked: PickedEntity[];
    /** Client-only visual aids. */
    grid: boolean;
    edges: boolean;
    /**
     * Whether the view is drawn with perspective: in the 3D workspaces, and while a sketch is drawn (flat by default,
     * as sketches are dimensioned). Local to this browser.
     */
    perspective: { model: boolean; sketch: boolean };
    /** World point under the cursor in mm: on a part surface, else on the ground plane. */
    cursor: {
        point: [number, number, number];
        onPart: boolean;
        /** The part under the cursor and the surface normal there, in world space (when onPart). */
        partId?: string;
        normal?: [number, number, number];
    } | null;
    /**
     * Decal placement: while set, a click on a part (in the viewport, mode 'select') is reported as `decalHit`
     * instead of selecting, and the decal tools place the image there.
     */
    placingDecal: { image: string; size: [number, number] } | null;
    /** The click that places a decal: part, world point and world surface normal. Consumed by the decal tools. */
    decalHit: { partId: string; point: [number, number, number]; normal: [number, number, number] } | null;
    /** Bumped to re-frame the camera (and re-apply the view angles) even when the view did not change. */
    refit: number;
    projects: ProjectEntry[];
    current: string;
    connected: boolean;
    status: AgentStatus;
    detail: string | null;
    speaking: boolean;
    subtitle: string;
    model: string;
    voice: string | null;
    ears: boolean;
    error: string | null;
    /**
     * What the open tool form would do, drawn by the 3D view only (the tree and HUD show the real project):
     * changed and new parts, their mesh keys, and why the preview failed if it did.
     */
    preview: Preview | null;
}

const PERSPECTIVE_KEY = 'jarvis.view.perspective';

function storedPerspective(): StudioState['perspective'] {
    try {
        const saved = JSON.parse(localStorage.getItem(PERSPECTIVE_KEY) ?? 'null') as { model?: unknown; sketch?: unknown } | null;
        return { model: saved?.model !== false, sketch: saved?.sketch === true };
    } catch {
        return { model: true, sketch: false };
    }
}

/** Perspective on or off for the sketch view or the 3D view; remembered in this browser. */
export function setPerspective(view: 'model' | 'sketch', on: boolean): void {
    const perspective = { ...useStudio.getState().perspective, [view]: on };
    useStudio.setState({ perspective });
    try {
        localStorage.setItem(PERSPECTIVE_KEY, JSON.stringify(perspective));
    } catch {
        // No storage (private mode): the choice lasts for this session.
    }
}

export const useStudio = create<StudioState>(() => ({
    project: null,
    history: null,
    meshes: { keys: {}, errors: {} },
    quality: 'fast',
    activity: [],
    draft: null,
    selected: null,
    mode: 'select',
    workspace: 'assembly',
    activePart: null,
    partView: 'isolated',
    editing: null,
    picked: [],
    grid: true,
    edges: true,
    perspective: storedPerspective(),
    cursor: null,
    placingDecal: null,
    decalHit: null,
    refit: 0,
    projects: [],
    current: '',
    connected: false,
    status: 'idle',
    detail: null,
    speaking: false,
    subtitle: '',
    model: '',
    voice: null,
    ears: false,
    error: null,
    preview: null,
}));

let socket: WebSocket | null = null;
const toolCalls = new Map<string, (result: { text: string; isError: boolean }) => void>();
let nextToolCall = 1;
let stoppedTurn = 0;
let subtitleTimer: number | undefined;

function send(message: ClientMessage): void {
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
    }
}

function handle(message: ServerMessage): void {
    switch (message.type) {
        case 'state': {
            // Reference steps taken from the model where the kernel last found them (followedRefs.ts).
            const project = withFollowed(message.project, useStudio.getState().meshes.followed);
            useStudio.setState({
                history: project,
                project: {
                    ...project,
                    parts: partsAtTimeline(project).filter((p) => !project.view.hidden?.includes(p.id)),
                },
            });
            break;
        }
        case 'toolResult':
            toolCalls.get(message.id)?.(message);
            toolCalls.delete(message.id);
            break;
        case 'activity':
            useStudio.setState({ activity: message.entries });
            break;
        case 'meshes': {
            const { history, project } = useStudio.getState();
            const followed = message.followed;
            useStudio.setState({
                meshes: { keys: message.keys, errors: message.errors, ...(followed ? { followed } : {}) },
                ...(followed && history ? { history: withFollowed(history, followed) } : {}),
                ...(followed && project ? { project: withFollowed(project, followed) } : {}),
            });
            break;
        }
        case 'status':
            useStudio.setState({ status: message.status, detail: message.detail ?? null });
            break;
        case 'info':
            useStudio.setState({ model: message.model, voice: message.voice, ears: message.ears, quality: message.quality });
            break;
        case 'say':
            if (message.turn > stoppedTurn) {
                enqueue(message.text, message.audio, message.muted ?? false);
            }
            break;
        case 'stop':
            stoppedTurn = Math.max(stoppedTurn, message.turn);
            silence();
            break;
        case 'projects':
            useStudio.setState({ projects: message.projects, current: message.current });
            break;
        case 'capture': {
            const { id } = message;
            captureViewport(useStudio.getState().project?.view.explode ?? 0)
                .catch(() => null)
                .then((image) => send({ type: 'capture', id, image }));
            break;
        }
        case 'download': {
            const link = document.createElement('a');
            link.href = message.url;
            link.download = message.filename;
            link.click();
            break;
        }
        case 'error':
            useStudio.setState({ error: message.message });
            window.setTimeout(() => useStudio.setState({ error: null }), 8000);
            break;
        case 'cad':
            setKernelActivity(message);
            break;
    }
}

export function connect(): void {
    onSpeech(({ speaking, text }) => {
        window.clearTimeout(subtitleTimer);
        useStudio.setState({ speaking, subtitle: text });
        if (!speaking) {
            subtitleTimer = window.setTimeout(() => useStudio.setState({ subtitle: '' }), 5000);
        }
    });
    const open = () => {
        const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
        socket = new WebSocket(`${protocol}://${location.host}/ws`);
        socket.onopen = () => {
            useStudio.setState({ connected: true });
            if (document.hasFocus()) {
                send({ type: 'active', soft: true });
            }
        };
        socket.onmessage = (event) => handle(JSON.parse(event.data));
        socket.onclose = () => {
            useStudio.setState({ connected: false, status: 'idle' });
            window.setTimeout(open, 1500);
        };
    };
    open();
    // Claims the voice for this tab, so only the browser in use speaks.
    const claim = () => send({ type: 'active' });
    window.addEventListener('pointerdown', claim);
    window.addEventListener('keydown', claim);
    window.addEventListener('focus', claim);
}

export function ask(text: string, images: ImageAttachment[] = []): void {
    unlockAudio();
    silence();
    send({ type: 'prompt', text, images });
}

export function stop(): void {
    silence();
    send({ type: 'stop' });
}

export function openProject(slug: string): void {
    silence();
    send({ type: 'open', slug });
}

/** Highlights one part and frames it; null shows the whole model again. */
export function focusPart(id: string | null): void {
    send({ type: 'focus', id });
}

/** Applies a viewport control directly on the server; Jarvis is not involved. */
export function act(action: ViewAction): void {
    send({ type: 'action', action });
}

export function createProject(name: string): void {
    silence();
    send({ type: 'create', name });
}

/** Moves a project to the trash folder on the server. */
export function deleteProject(slug: string): void {
    send({ type: 'delete', slug });
}

export function setHidden(partId: string, hidden: boolean): void {
    send({ type: 'hide', partId, hidden });
}

export function setSuppressed(partId: string, featureId: string, suppressed: boolean): void {
    send({ type: 'suppress', partId, featureId, suppressed });
}

/** fast: quick answers. best: Opus at high effort, slower but a much better designer. */
export function setQuality(quality: 'fast' | 'best'): void {
    send({ type: 'quality', quality });
}

/** Puts text in the prompt field for the user to edit or send. */
export function draftPrompt(text: string): void {
    useStudio.setState((s) => ({ draft: { text, n: (s.draft?.n ?? 0) + 1 } }));
}

/**
 * Runs a studio tool on the server, exactly as Jarvis would (same names and arguments as its tools:
 * parts_add, parts_update, parts_remove, features_add, view_set, export_stl, ...).
 */
export function runTool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    if (captureCall(name, args)) {
        return Promise.resolve({ ...CAPTURED });
    }
    // Sketch settings: Use fully defined sketches.
    const refusal = undefinedSketchRefusal(name, args, useStudio.getState().history);
    if (refusal) {
        return Promise.resolve({ text: refusal, isError: true });
    }
    const id = `t${nextToolCall++}`;
    return new Promise((resolve) => {
        if (socket?.readyState !== WebSocket.OPEN) {
            resolve({ text: 'Not connected to the server.', isError: true });
            return;
        }
        toolCalls.set(id, resolve);
        send({ type: 'tool', id, name, args });
        window.setTimeout(() => {
            if (toolCalls.delete(id)) {
                resolve({ text: 'The server did not answer in time.', isError: true });
            }
        }, 120_000);
    });
}

export function setPreview(preview: Preview): void {
    useStudio.setState({ preview });
}

export function clearPreview(): void {
    if (useStudio.getState().preview) {
        useStudio.setState({ preview: null });
    }
}

/** Picks a face or edge; `additive` (Shift) adds it to the picks, or removes it if it is already picked. */
export function pickEntity(entity: PickedEntity, additive: boolean): void {
    useStudio.setState((s) => ({ picked: togglePick(s.picked, entity, additive) }));
}

export function clearPicked(): void {
    if (useStudio.getState().picked.length) {
        useStudio.setState({ picked: [] });
    }
}

// Picks are ordinals into one mesh of the active part: drop them when that mesh, the active part or the workspace changes.
useStudio.subscribe((s, prev) => {
    if (s.picked.length === 0) {
        return;
    }
    const meshChanged = s.picked.some((p) => s.meshes.keys[p.partId] !== prev.meshes.keys[p.partId]);
    if (meshChanged || s.activePart !== prev.activePart || s.workspace !== 'part') {
        useStudio.setState({ picked: [] });
    }
});

const selectWatchers = new Set<(id: string | null) => void>();

/** Calls `watch` on every select(), also when the part stays the same (a click on empty space). Returns the unsubscribe. */
export function onSelect(watch: (id: string | null) => void): () => void {
    selectWatchers.add(watch);
    return () => {
        selectWatchers.delete(watch);
    };
}

export function select(id: string | null): void {
    useStudio.setState({ selected: id });
    selectWatchers.forEach((watch) => watch(id));
}

/** Frames the whole view again, re-applying the stored camera angles. */
export function refit(): void {
    useStudio.setState((s) => ({ refit: s.refit + 1 }));
}

/** Switches workspace. Entering the part workspace edits `partId`, else the selected part, else the first. */
export function setWorkspace(
    workspace: 'part' | 'assembly',
    partId?: string,
    partView?: 'isolated' | 'inContext',
): void {
    useStudio.setState((s) => {
        const parts = s.history?.parts ?? [];
        const active = workspace === 'part'
            ? partId ?? s.activePart ?? s.selected ?? parts[0]?.id ?? null
            : s.activePart;
        // An instance is edited through its source part, which every instance shares.
        const source = active ? s.history?.parts.find((p) => p.id === active)?.instanceOf ?? active : active;
        return {
            workspace,
            activePart: source,
            partView: partView ?? s.partView,
            selected: workspace === 'part' ? source : s.selected,
            editing: null,
        };
    });
}

/** Opens the editor for a history item: the base body (featureId null) or a feature of `partId`. */
export function editItem(partId: string, featureId: string | null): void {
    useStudio.setState({ workspace: 'part', activePart: partId, selected: partId, editing: { partId, featureId } });
}

export function clearEditing(): void {
    useStudio.setState({ editing: null });
}

/** Part-workspace rollback: build only the first `count` features of the part; null shows all. Shared via the server. */
export function setRollback(partId: string, count: number | null): void {
    send({ type: 'rollback', partId, count });
}

export function renameProject(name: string): void {
    send({ type: 'rename', name });
}

/** Saves a copy of the open project under a new name and opens the copy. */
export function saveProjectAs(name: string): void {
    send({ type: 'saveAs', name });
}

/**
 * Shows or hides one sketch, reference or thread step in the viewport (shared via the server). A hidden thread is drawn
 * plainly with cosmetic marks; an absorbed sketch is hidden until shown (see @jarvis/core/visibility).
 */
export function setSketchHidden(partId: string, featureId: string, hidden: boolean): void {
    send({ type: 'hideSketch', partId, featureId, hidden });
}

/** Hides or shows a solid body, or makes it see-through or opaque (stored with the view, shared via the server). */
export function setBodyView(partId: string, body: string, change: { hidden?: boolean; seeThrough?: boolean }): void {
    send({ type: 'bodyView', partId, body, ...change });
}
