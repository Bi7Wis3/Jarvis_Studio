// Decals section of the part history: list, edit and place pictures on the part's surface.

import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { explodeOffsets, shapeHalfExtents, type Decal, type Part, type Vec3 } from '@jarvis/core';
import { assetUrl, partGeometry } from './Decals';
import { defaultDecalSize, surfaceExtent } from './decalMath';
import { mm } from './historyText';
import { showError, tool } from './menus';
import { useStudio } from './state';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

async function upload(file: Blob): Promise<string> {
    if (!IMAGE_TYPES.includes(file.type)) {
        throw new Error('Use a PNG, JPEG or WebP picture.');
    }
    const response = await fetch('/api/assets', { method: 'POST', headers: { 'content-type': file.type }, body: file });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.id !== 'string') {
        throw new Error(body.error ?? 'The picture could not be uploaded.');
    }
    return body.id;
}

async function imageAspect(file: Blob): Promise<number> {
    try {
        const bitmap = await createImageBitmap(file);
        const aspect = bitmap.width / Math.max(1, bitmap.height);
        bitmap.close();
        return aspect;
    } catch {
        return 1;
    }
}

/** Default decal size: the picture's aspect fitted into half the part's largest dimension. */
function fitSize(part: Part, aspect: number): [number, number] {
    const largest = Math.max(...shapeHalfExtents(part.shape)) * 2 || 40;
    const target = largest / 2;
    const round = (v: number) => Math.round(v * 10) / 10;
    return aspect >= 1 ? [round(target), round(target / aspect)] : [round(target * aspect), round(target)];
}

/** World point and normal to the part frame (first instance of a pattern, current explode). */
function toPartFrame(part: Part, point: Vec3, normal: Vec3): { position: Vec3; normal: Vec3 } {
    const project = useStudio.getState().history;
    const explode = project?.view.explode ?? 0;
    const offset = project ? explodeOffsets(project)[part.id] ?? [0, 0, 0] : [0, 0, 0];
    const rotation = new Quaternion().setFromEuler(new Euler(...part.rotation.map((d) => (d * Math.PI) / 180) as Vec3, 'XYZ'));
    const origin = new Vector3(...part.position).add(new Vector3(...offset).multiplyScalar(explode));
    const inverse = new Matrix4().compose(origin, rotation, new Vector3(1, 1, 1)).invert();
    const p = new Vector3(...point).applyMatrix4(inverse);
    const n = new Vector3(...normal).applyQuaternion(rotation.clone().invert()).normalize();
    const round = (v: number) => Math.round(v * 100) / 100;
    return { position: [round(p.x), round(p.y), round(p.z)], normal: [round(n.x), round(n.y), round(n.z)] };
}

// ---- Placement: works from any workspace, whether or not this panel is showing ------------------------------

/** The decal being moved by the current placement, or null when placing a new picture. */
let moving: { partId: string; decalId: string } | null = null;

export function cancelPlacing(): void {
    moving = null;
    useStudio.setState({ placingDecal: null, decalHit: null });
}

export function startPlacing(placing: { image: string; size: [number, number] }, move: typeof moving): void {
    moving = move;
    useStudio.setState({ placingDecal: placing, decalHit: null });
}

function placeAt(hit: NonNullable<ReturnType<typeof useStudio.getState>['decalHit']>, placing: { image: string; size: [number, number] }): void {
    const move = moving;
    cancelPlacing();
    const target = useStudio.getState().history?.parts.find((p) => p.id === hit.partId);
    if (!target) {
        return;
    }
    if (move && move.partId !== target.id) {
        showError('Click on the same part to move its picture.');
        return;
    }
    const frame = toPartFrame(target, hit.point, hit.normal);
    if (move) {
        void tool('decals_update', { partId: target.id, updates: [{ id: move.decalId, ...frame }] });
        return;
    }
    const surface = partGeometry(target.id);
    const aspect = placing.size[0] / Math.max(1e-6, placing.size[1]);
    const size = surface ? defaultDecalSize(surface, frame.position, frame.normal, aspect) : placing.size;
    void tool('decals_add', { partId: target.id, decals: [{ image: placing.image, size, ...frame }] });
}

useStudio.subscribe((state, previous) => {
    if (state.decalHit && state.decalHit !== previous.decalHit && state.placingDecal) {
        placeAt(state.decalHit, state.placingDecal);
    }
});

if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && useStudio.getState().placingDecal) {
            cancelPlacing();
        }
    });
}

/** Sizes and centres a decal to cover all of the surface that faces it (stretching the picture). */
function fillSurface(part: Part, decal: Decal): void {
    const surface = partGeometry(part.id);
    const extent = surface && surfaceExtent(surface, decal.position, decal.normal, decal.rotation ?? 0);
    if (!extent) {
        showError('The part\'s surface is not ready yet.');
        return;
    }
    const round = (x: number) => Math.round(x * 100) / 100;
    void tool('decals_update', {
        partId: part.id,
        updates: [{ id: decal.id, size: extent.size.map(round), position: extent.center.map(round) }],
    });
}

export function DecalPanel({ part }: { part: Part }) {
    const placing = useStudio((s) => s.placingDecal);
    const [busy, setBusy] = useState(false);
    const [dragging, setDragging] = useState(false);
    const file = useRef<HTMLInputElement>(null);
    const decals = part.decals ?? [];

    const start = async (blob: Blob | null | undefined) => {
        if (!blob) {
            return;
        }
        setBusy(true);
        try {
            const [image, aspect] = await Promise.all([upload(blob), imageAspect(blob)]);
            startPlacing({ image, size: fitSize(part, aspect) }, null);
        } catch (e) {
            showError(e instanceof Error ? e.message : 'The picture could not be uploaded.');
        } finally {
            setBusy(false);
        }
    };

    const fromTransfer = (data: DataTransfer | null) => [...(data?.files ?? [])].find((f) => f.type.startsWith('image/'));

    const onPaste = (event: ClipboardEvent<HTMLElement>) => {
        const image = fromTransfer(event.clipboardData);
        if (image) {
            // Keep the prompt bar's own paste handler from attaching it as well.
            event.preventDefault();
            event.stopPropagation();
            void start(image);
        }
    };
    const onDrop = (event: DragEvent<HTMLElement>) => {
        setDragging(false);
        const image = fromTransfer(event.dataTransfer);
        if (image) {
            event.preventDefault();
            void start(image);
        }
    };

    const update = (decal: Decal, fields: Partial<Decal>) =>
        void tool('decals_update', { partId: part.id, updates: [{ id: decal.id, ...fields }] });

    return (
        <section
            className={`br-decals ${dragging ? 'dragging' : ''}`}
            tabIndex={0}
            onPaste={onPaste}
            onDragOver={(event) => {
                if ([...event.dataTransfer.items].some((i) => i.type.startsWith('image/'))) {
                    event.preventDefault();
                    setDragging(true);
                }
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            aria-label="Decals"
        >
            <div className="br-decals-head">
                <span className="br-title">Decals</span>
                {decals.length > 0 && <span className="br-count">{decals.length}</span>}
                <button type="button" className="br-add" onClick={() => file.current?.click()} disabled={busy}>
                    {busy ? 'Uploading…' : 'Add picture…'}
                </button>
                <input
                    ref={file}
                    type="file"
                    accept={IMAGE_TYPES.join(',')}
                    hidden
                    onChange={(event) => {
                        void start(event.target.files?.[0]);
                        event.target.value = '';
                    }}
                />
            </div>
            {placing && (
                <div className="br-placing">
                    <span>Click the surface to place the picture · Esc cancels</span>
                    <button type="button" onClick={cancelPlacing}>Cancel</button>
                </div>
            )}
            {decals.length === 0 && !placing && (
                <p className="br-empty">Choose, paste (Ctrl+V here) or drop a picture to put it on the surface.</p>
            )}
            <ul>
                {decals.map((decal) => (
                    <li key={decal.id} className="br-decal">
                        <img src={assetUrl(decal.image)} alt="" />
                        <div className="br-decal-body">
                            <div className="br-decal-top">
                                <span className="br-sum">{mm(decal.size[0])} × {mm(decal.size[1])} mm</span>
                                <button
                                    type="button"
                                    onClick={() => startPlacing({ image: decal.image, size: decal.size }, { partId: part.id, decalId: decal.id })}
                                    title="Click the surface to move this picture"
                                >
                                    Move
                                </button>
                                <button
                                    type="button"
                                    onClick={() => fillSurface(part, decal)}
                                    title="Stretch the picture over the whole surface it faces"
                                >
                                    Fill surface
                                </button>
                                <button
                                    type="button"
                                    className="danger"
                                    onClick={() => void tool('decals_remove', { partId: part.id, ids: [decal.id] })}
                                    title="Remove this picture"
                                    aria-label="Remove picture"
                                >
                                    ×
                                </button>
                            </div>
                            <label className="br-wrap">
                                <span>Wrap</span>
                                <select
                                    value={decal.mode ?? 'planar'}
                                    onChange={(e) => update(decal, { mode: e.target.value as 'planar' | 'box' })}
                                    title="Planar: covers all surface facing the picture. Box: only within the depth"
                                >
                                    <option value="planar">Planar</option>
                                    <option value="box">Box</option>
                                </select>
                                {decal.mode === 'box' && (
                                    <input
                                        type="number"
                                        min="0.5"
                                        step="0.5"
                                        defaultValue={mm(decal.depth ?? Math.max(...decal.size) / 10)}
                                        key={decal.depth ?? 'auto'}
                                        onBlur={(e) => {
                                            const depth = parseFloat(e.target.value);
                                            if (depth > 0 && depth !== decal.depth) {
                                                update(decal, { depth });
                                            }
                                        }}
                                        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                                        aria-label="Wrap depth in mm"
                                        title="Depth in mm"
                                    />
                                )}
                            </label>
                            <Slider
                                label="Size"
                                value={decal.size[0]}
                                min={1}
                                max={Math.max(200, decal.size[0] * 2)}
                                step={0.5}
                                unit="mm"
                                onCommit={(w) => update(decal, { size: [w, (decal.size[1] * w) / decal.size[0]] })}
                            />
                            <Slider
                                label="Turn"
                                value={decal.rotation ?? 0}
                                min={-180}
                                max={180}
                                step={1}
                                unit="°"
                                onCommit={(rotation) => update(decal, { rotation })}
                            />
                            <Slider
                                label="Opacity"
                                value={Math.round((decal.opacity ?? 1) * 100)}
                                min={0}
                                max={100}
                                step={1}
                                unit="%"
                                onCommit={(v) => update(decal, { opacity: v / 100 })}
                            />
                        </div>
                    </li>
                ))}
            </ul>
        </section>
    );
}

/** Range input that shows its value live and sends it when released. */
function Slider(props: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    unit: string;
    onCommit: (value: number) => void;
}) {
    const { label, value, min, max, step, unit, onCommit } = props;
    const [draft, setDraft] = useState<number | null>(null);
    const commit = () => {
        if (draft !== null && draft !== value) {
            onCommit(draft);
        }
        setDraft(null);
    };
    const shown = draft ?? value;
    return (
        <label className="br-slider">
            <span>{label}</span>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={shown}
                onChange={(event) => setDraft(Number(event.target.value))}
                onPointerUp={commit}
                onKeyUp={commit}
                onBlur={commit}
            />
            <span className="val">{mm(shown)}{unit}</span>
        </label>
    );
}
