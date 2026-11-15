// The Sketch Picture PropertyManager in the left panel (SolidWorks page 1): insert a picture on the sketch plane (its
// lower left corner at the origin, 1 pixel to 1 mm), then its origin, angle, width and height (aspect ratio locked or
// not), flips, transparency (none, from the file, the full image, or one colour) and the scale tool: click two points
// on the picture and type the real distance between them; in the view, a drag moves the picture and a drag on a
// corner sizes it. Changes show at once; Cancel puts the pictures back.

import { useEffect, useRef, useState } from 'react';
import type { SketchGeometry, SketchPicture } from '@jarvis/core';
import type { Field, PopupApi, Result, ToolDef, Values } from './toolDefs';
import { setTool, setViewPicker, useSketcher } from './sketcher';
import { setPressHook } from './sketchMoreTools';
import { PicturePicker } from './DecalPanel';
import { useSketchExtras } from './sketchExtrasState';
import { valueText } from './numberText';
import './sketchExtras.css';

/** One empty list: a store selector must not build a new array on every call. */
const NO_PICTURES: SketchPicture[] = [];

type Pt = [number, number];
const fmt = valueText;
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

const ok = (error: string | null): Result => ({ text: error ?? '', isError: !!error });

/** A picture the server can store: PNG, JPEG and WebP as they are, anything else the browser reads as PNG. */
async function storable(file: Blob): Promise<{ blob: Blob; pixels: Pt }> {
    const bitmap = await createImageBitmap(file);
    const pixels: Pt = [bitmap.width, bitmap.height];
    if (UPLOAD_TYPES.includes(file.type)) {
        bitmap.close();
        return { blob: file, pixels };
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) {
        throw new Error('The picture could not be read.');
    }
    return { blob, pixels };
}

async function upload(file: Blob): Promise<{ asset: string; pixels: Pt }> {
    let made: { blob: Blob; pixels: Pt };
    try {
        made = await storable(file);
    } catch {
        throw new Error('This picture cannot be read here: use PNG, JPEG, WebP, GIF, BMP or SVG.');
    }
    const response = await fetch('/api/assets', { method: 'POST', headers: { 'content-type': made.blob.type }, body: made.blob });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.id !== 'string') {
        throw new Error(body.error ?? 'The picture could not be uploaded.');
    }
    return { asset: body.id, pixels: made.pixels };
}

// ---- Values ------------------------------------------------------------------------------------------------------

function valuesOf(p: SketchPicture | undefined): Values {
    if (!p) {
        return { pid: '' };
    }
    return {
        pid: p.id, atX: fmt(p.at[0]), atY: fmt(p.at[1]), angle: fmt(p.angle), width: fmt(p.width), height: fmt(p.height),
        lock: p.lockAspect !== false, flipH: !!p.flipH, flipV: !!p.flipV, transparency: p.transparency ?? 'none',
        amount: fmt(p.amount ?? 0.5), colour: p.colour ?? '#ffffff', tolerance: fmt(p.tolerance ?? 0.1), shown: !p.hidden, real: '',
    };
}

const num = (v: Values, key: string): number | null => {
    const raw = v[key];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
};

/** The picture with the form's values, or null while a value is not a number yet. */
function pictureOf(p: SketchPicture, v: Values): SketchPicture | null {
    const [x, y, angle, width, height, amount, tolerance] = ['atX', 'atY', 'angle', 'width', 'height', 'amount', 'tolerance'].map((k) => num(v, k));
    if (x === null || y === null || angle === null || !(width && width > 0) || !(height && height > 0)) {
        return null;
    }
    const mode = (v.transparency as SketchPicture['transparency']) ?? 'none';
    return {
        ...p, at: [x, y], angle, width, height, lockAspect: !!v.lock,
        ...(v.flipH ? { flipH: true } : { flipH: undefined }), ...(v.flipV ? { flipV: true } : { flipV: undefined }),
        transparency: mode, amount: Math.min(1, Math.max(0, amount ?? 0.5)), colour: String(v.colour ?? '#ffffff'),
        tolerance: Math.min(1, Math.max(0, tolerance ?? 0.1)), hidden: v.shown ? undefined : true,
    };
}

const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as T;

function putPicture(g: SketchGeometry, p: SketchPicture): SketchGeometry {
    return { ...g, pictures: (g.pictures ?? []).map((q) => (q.id === p.id ? clean(p) : q)) };
}

// ---- Live editing, with Cancel putting it back -------------------------------------------------------------------

/** The pictures when the form opened, and whether OK closed it (else closing puts them back). */
let session: { before: SketchGeometry['pictures']; undoPushed: boolean; applied: boolean } | null = null;

function livePictures(next: SketchGeometry): void {
    const s = useSketcher.getState();
    if (session && !session.undoPushed) {
        session.undoPushed = true;
        useSketcher.setState({ undo: [...s.undo.slice(-80), s.geometry], redo: [] });
    }
    useSketcher.setState({ geometry: next });
}

function PictureSession({ api }: { api: PopupApi }) {
    useEffect(() => {
        session = { before: useSketcher.getState().geometry.pictures, undoPushed: false, applied: false };
        return () => {
            const s = session;
            session = null;
            setViewPicker(null);
            useSketchExtras.setState({ picture: null, scale: null });
            if (s && !s.applied && s.undoPushed) {
                const g = useSketcher.getState().geometry;
                const { pictures: _, ...rest } = g;
                useSketcher.setState({ geometry: s.before ? { ...rest, pictures: s.before } : rest, undo: useSketcher.getState().undo.slice(0, -1) });
            }
        };
    }, []);
    useEffect(() => {
        useSketchExtras.setState({ picture: String(api.values.pid || '') || null });
    }, [api.values.pid]);
    return null;
}

function PictureList({ api }: { api: PopupApi }) {
    const pictures = useSketcher((s) => s.geometry.pictures) ?? NO_PICTURES;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const add = (blob: Blob) => {
        setBusy(true);
        setError(null);
        void upload(blob).then(({ asset, pixels }) => {
            const g = useSketcher.getState().geometry;
            const id = `pic${Date.now().toString(36)}`;
            // SolidWorks: the picture's (0, 0) at the sketch origin, 1 pixel to 1 mm, aspect ratio locked.
            const p: SketchPicture = { id, asset, at: [0, 0], width: pixels[0], height: pixels[1], angle: 0, pixels, lockAspect: true, transparency: 'none' };
            livePictures({ ...g, pictures: [...(g.pictures ?? []), p] });
            api.set(valuesOf(p));
            useSketcher.setState((s) => ({ look: s.look + 1, fitToSketch: true }));
        }).catch((e) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
    };
    return (
        <>
            {pictures.length > 0 && (
                <div className="tb-field">
                    <span>Pictures of this sketch</span>
                    <ul className="sx-list" aria-label="Pictures of this sketch">
                        {pictures.map((p, i) => (
                            <li key={p.id} className={api.values.pid === p.id ? 'on' : ''} onClick={() => api.set(valuesOf(p))}>
                                <span>Picture {i + 1}{p.hidden ? ' (hidden)' : ''}</span>
                                <em>{fmt(p.width)} × {fmt(p.height)} mm</em>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            <PicturePicker busy={busy} onPicture={add} onDone={() => undefined} />
            {error && <p className="tb-note sx-warn">{error}</p>}
        </>
    );
}

/** The scale tool: two points clicked on the picture and the real distance between them. */
function ScaleTool({ api }: { api: PopupApi }) {
    const scale = useSketchExtras((s) => s.scale);
    const latest = useRef(api);
    latest.current = api;
    const pid = String(api.values.pid || '');
    const on = !!scale && scale.picture === pid;
    useEffect(() => {
        if (!on) {
            return;
        }
        setViewPicker({
            click: (raw) => {
                const now = useSketchExtras.getState().scale;
                if (!now) {
                    return false;
                }
                const picks = now.picks.length >= 2 ? [raw] : [...now.picks, raw];
                useSketchExtras.setState({ scale: { ...now, picks } });
                if (picks.length === 2) {
                    latest.current.set({ real: fmt(Math.hypot(picks[1][0] - picks[0][0], picks[1][1] - picks[0][1])) });
                }
                return true;
            },
            move: (raw) => {
                const now = useSketchExtras.getState().scale;
                if (now) {
                    useSketchExtras.setState({ scale: { ...now, cursor: raw } });
                }
            },
        });
        return () => setViewPicker(null);
    }, [on]);
    if (!pid) {
        return null;
    }
    const picks = on ? scale!.picks : [];
    const apply = () => {
        const g = useSketcher.getState().geometry;
        const p = g.pictures?.find((q) => q.id === pid);
        const real = num(api.values, 'real');
        if (!p || picks.length !== 2 || !(real && real > 0)) {
            return;
        }
        const measured = Math.hypot(picks[1][0] - picks[0][0], picks[1][1] - picks[0][1]);
        if (!(measured > 0)) {
            return;
        }
        // Scaled about the first point, which stays where it is on the plane.
        const k = real / measured;
        const [o] = picks;
        const next: SketchPicture = { ...p, at: [o[0] + (p.at[0] - o[0]) * k, o[1] + (p.at[1] - o[1]) * k], width: p.width * k, height: p.height * k };
        livePictures(putPicture(g, next));
        useSketchExtras.setState({ scale: { picture: pid, picks: [o, [o[0] + (picks[1][0] - o[0]) * k, o[1] + (picks[1][1] - o[1]) * k]], cursor: null } });
        api.set({ ...valuesOf(next), real: fmt(real) });
    };
    return (
        <div className="tb-field">
            <span>Scale tool</span>
            <div className="sx-row">
                <button type="button" className={`sx-small ${on ? 'on' : ''}`}
                    onClick={() => useSketchExtras.setState({ scale: on ? null : { picture: pid, picks: [], cursor: null } })}>
                    {on ? (picks.length < 2 ? `Click point ${picks.length + 1} on the picture…` : 'Scale tool on') : 'Enable scale tool'}
                </button>
            </div>
            {on && picks.length === 2 && (
                <div className="sx-row">
                    <label className="tb-field">
                        <span>Real distance between the points</span>
                        <input type="number" value={String(api.values.real ?? '')} onChange={(e) => api.set({ real: e.target.value })}
                            onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    apply();
                                }
                            }}
                        />
                        <em>mm</em>
                    </label>
                    <button type="button" className="sx-small" onClick={apply}>Scale picture</button>
                </div>
            )}
        </div>
    );
}

// ---- Dragging in the view ------------------------------------------------------------------------------------------

/** What a press on the picture takes: the whole picture (to move it) or one of its corners (to size it). */
export type PictureGrip = 'move' | 0 | 1 | 2 | 3;

const toLocal = (p: SketchPicture, q: Pt): Pt => {
    const r = (p.angle * Math.PI) / 180;
    const [dx, dy] = [q[0] - p.at[0], q[1] - p.at[1]];
    return [dx * Math.cos(r) + dy * Math.sin(r), -dx * Math.sin(r) + dy * Math.cos(r)];
};

const toPlane = (p: SketchPicture, q: Pt): Pt => {
    const r = (p.angle * Math.PI) / 180;
    return [p.at[0] + q[0] * Math.cos(r) - q[1] * Math.sin(r) + 0, p.at[1] + q[0] * Math.sin(r) + q[1] * Math.cos(r) + 0];
};

const CORNERS = (p: SketchPicture): Pt[] => [[0, 0], [p.width, 0], [p.width, p.height], [0, p.height]];

/** The grip under the pointer: a corner within `tolerance`, else inside the picture; null outside it. */
export function pictureGrip(p: SketchPicture, raw: Pt, tolerance: number): PictureGrip | null {
    const q = toLocal(p, raw);
    const corner = CORNERS(p).findIndex((c) => Math.hypot(c[0] - q[0], c[1] - q[1]) <= tolerance * 1.5);
    if (corner >= 0) {
        return corner as 0 | 1 | 2 | 3;
    }
    return q[0] >= 0 && q[0] <= p.width && q[1] >= 0 && q[1] <= p.height ? 'move' : null;
}

/**
 * The picture after a drag from `from` to `to`: moved, or sized by a corner with the opposite corner staying where it
 * is (with Lock aspect ratio the ratio stays).
 */
export function draggedPicture(p: SketchPicture, grip: PictureGrip, from: Pt, to: Pt): SketchPicture {
    if (grip === 'move') {
        return { ...p, at: [p.at[0] + to[0] - from[0] + 0, p.at[1] + to[1] - from[1] + 0] };
    }
    const fixed = CORNERS(p)[(grip + 2) % 4];
    const q = toLocal(p, to);
    let [w, h] = [Math.abs(q[0] - fixed[0]), Math.abs(q[1] - fixed[1])];
    if (p.lockAspect !== false) {
        const k = Math.max(w / p.width, h / p.height);
        [w, h] = [p.width * k, p.height * k];
    }
    if (!(w > 1e-9) || !(h > 1e-9)) {
        return p;
    }
    const sx = q[0] >= fixed[0] ? 1 : -1;
    const sy = q[1] >= fixed[1] ? 1 : -1;
    const low: Pt = [Math.min(fixed[0], fixed[0] + sx * w), Math.min(fixed[1], fixed[1] + sy * h)];
    return { ...p, at: toPlane(p, low), width: w, height: h };
}

/** While the form shows a picture, a press on it drags it (inside: moves it; at a corner: sizes it). */
function PictureDrag({ api }: { api: PopupApi }) {
    const latest = useRef(api);
    latest.current = api;
    const pid = String(api.values.pid || '');
    useEffect(() => {
        if (!pid) {
            return;
        }
        if (useSketcher.getState().tool !== 'select') {
            setTool('select');
        }
        setPressHook((raw, tolerance) => {
            const p = useSketcher.getState().geometry.pictures?.find((q) => q.id === pid);
            const grip = p && !p.hidden ? pictureGrip(p, raw, tolerance) : null;
            if (!p || grip === null) {
                return null;
            }
            // A press that hardly moves stays a click (the scale tool takes clicks on the picture).
            let moved = false;
            return {
                move: (to) => {
                    moved ||= Math.hypot(to[0] - raw[0], to[1] - raw[1]) > tolerance * 0.4;
                    if (!moved) {
                        return;
                    }
                    const next = draggedPicture(p, grip, raw, to);
                    livePictures(putPicture(useSketcher.getState().geometry, next));
                    latest.current.set({ ...valuesOf(next), real: latest.current.values.real ?? '' });
                },
                up: () => undefined,
            };
        });
        return () => setPressHook(null);
    }, [pid]);
    return null;
}

// ---- The tool --------------------------------------------------------------------------------------------------

const picked = (v: Values) => !!v.pid;
const section = 'Properties';

export const sketchPictureTool: ToolDef = {
    id: 'sk-picture',
    label: 'Sketch picture',
    icon: 'sketch-picture',
    hint: 'a picture on the sketch plane to trace over',
    panel: true,
    width: 300,
    fields: () => [
        { key: 'atX', label: 'Origin X', kind: 'number', unit: 'mm', section, show: picked },
        { key: 'atY', label: 'Origin Y', kind: 'number', unit: 'mm', section, show: picked },
        { key: 'angle', label: 'Angle', kind: 'number', unit: 'deg', section, show: picked },
        { key: 'width', label: 'Width', kind: 'number', unit: 'mm', min: 0, section, show: picked },
        { key: 'height', label: 'Height', kind: 'number', unit: 'mm', min: 0, section, show: picked },
        { key: 'lock', label: 'Lock aspect ratio', kind: 'check', section, show: picked },
        { key: 'flipH', label: 'Flip horizontally', kind: 'check', section, show: picked },
        { key: 'flipV', label: 'Flip vertically', kind: 'check', section, show: picked },
        { key: 'shown', label: 'Show picture', kind: 'check', section, show: picked },
        { key: 'transparency', label: 'Transparency', kind: 'select', section: 'Transparency', show: picked,
            options: [{ value: 'none', label: 'None' }, { value: 'file', label: 'From file' }, { value: 'full', label: 'Full image' }, { value: 'colour', label: 'User defined (one colour)' }] },
        { key: 'colour', label: 'Colour', kind: 'color', section: 'Transparency', show: (v) => picked(v) && v.transparency === 'colour' },
        { key: 'tolerance', label: 'Colour tolerance', kind: 'range', min: 0, max: 1, step: 0.01, section: 'Transparency', show: (v) => picked(v) && v.transparency === 'colour' },
        { key: 'amount', label: 'Transparency', kind: 'range', min: 0, max: 1, step: 0.01, section: 'Transparency',
            show: (v) => picked(v) && (v.transparency === 'full' || v.transparency === 'colour') },
    ] satisfies Field[],
    defaults: () => {
        const pictures = useSketcher.getState().geometry.pictures ?? [];
        return valuesOf(pictures[pictures.length - 1]);
    },
    onChange: (key, v) => {
        const g = useSketcher.getState().geometry;
        const p = g.pictures?.find((q) => q.id === v.pid);
        if (!p || key === 'pid' || key === 'real') {
            return;
        }
        const patch: Values = {};
        // A value that cannot be used is refused with a message; one left from an earlier edit goes back to what the
        // picture has, so the next edit (the angle, say) still applies.
        const stored: Record<string, number> = { atX: p.at[0], atY: p.at[1], angle: p.angle, width: p.width, height: p.height };
        const usable = (k: string) => {
            const n = num(v, k);
            return n !== null && (k === 'width' || k === 'height' ? n > 0 : true);
        };
        for (const k of Object.keys(stored)) {
            if (usable(k)) {
                continue;
            }
            if (k === key) {
                useSketcher.setState({ message: k === 'width' || k === 'height' ? `The ${k} must be a number above zero.` : 'Type a number.' });
                return patch;
            }
            patch[k] = fmt(stored[k]);
        }
        // Lock aspect ratio: the other side follows.
        if (v.lock && (key === 'width' || key === 'height')) {
            const ratio = p.height / p.width;
            const w = num(v, 'width');
            const h = num(v, 'height');
            if (key === 'width' && w && w > 0) {
                patch.height = fmt(w * ratio);
            } else if (key === 'height' && h && h > 0) {
                patch.width = fmt(h / ratio);
            }
        }
        const next = pictureOf(p, { ...v, ...patch });
        if (next) {
            livePictures(putPicture(g, next));
        }
        return patch;
    },
    top: (api) => (
        <>
            <PictureSession api={api} />
            <PictureDrag api={api} />
            <PictureList api={api} />
        </>
    ),
    extra: (api) => (
        <>
            <ScaleTool api={api} />
            {api.values.pid && (
                <div className="sx-row">
                    <button type="button" className="sx-small danger" onClick={() => {
                        const g = useSketcher.getState().geometry;
                        const pictures = (g.pictures ?? []).filter((q) => q.id !== api.values.pid);
                        livePictures({ ...g, pictures });
                        api.set(valuesOf(pictures[pictures.length - 1]));
                    }}>
                        Delete picture
                    </button>
                </div>
            )}
            <p className="tb-note">Drag the picture in the view to move it, or a corner to size it. A picture is a backdrop to trace over: it is never part of a profile, and there is
                no snapping to it.</p>
        </>
    ),
    apply: async () => {
        if (session) {
            session.applied = true;
        }
        return ok(null);
    },
};
