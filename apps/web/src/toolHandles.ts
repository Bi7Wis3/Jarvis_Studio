// Drag handles in the 3D view for the open tool form: which handles each tool shows (a pure description built
// from the form values), the shapes to pick them by, and the maths that turns a pointer ray into new values.
// Manipulators.tsx draws them and runs the drags.

import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import type { Feature, Part, SketchPlane, SketchRegion, Vec3 } from '@jarvis/core';
import { pickedRegions } from './regionPick';
import { planeFrame, profilePoints, type Pt } from './sketchMath';
import type { Ctx, Values } from './toolDefs';

export type Handle =
    /** An arrow from `origin` along `direction` with its tip at `value` (symmetric: at value / 2, mirrored). */
    | { kind: 'distance'; key: string; origin: Vec3; direction: Vec3; value: number; min?: number; max?: number; step?: number;
        label?: string; symmetric?: boolean }
    /** Three world-axis arrows and three plane squares; dragging adds to the values of `keys`. */
    | { kind: 'translate'; keys: [string, string, string]; position: Vec3; step?: number }
    /** Three rings for Euler XYZ angles (deg), as gimbals: ring i turns about the axis that angle i turns about. */
    | { kind: 'rotate'; keys: [string, string, string]; position: Vec3; rotation: Vec3; step?: number }
    /** An arc about `axis` through `origin`, from `start` (unit, perpendicular to the axis) to `value` degrees. */
    | { kind: 'angle'; key: string; origin: Vec3; axis: Vec3; start: Vec3; radius: number; value: number; min?: number; max?: number;
        step?: number };

/** What a handle function cannot read from the values. */
export interface HandleEnv {
    /** Picked sketch regions, as (u, v) points, and the sketch they belong to ("partId/stepId"; null: the open sketch). */
    picks: Pt[];
    pickKey: string | null;
    /** The open sketch (Exit sketch form). */
    sketch?: { plane: SketchPlane; offset: number; context: Feature[]; regions: SketchRegion[]; points: Pt[]; part: Part | null } | null;
}

type HandleFn = (values: Values, ctx: Ctx, env: HandleEnv) => Handle[];

export const AXIS_COLORS = ['#ff4d5e', '#3ddc84', '#4d8dff'];
export const DEFAULT_STEP = { length: 0.5, position: 1, angle: 5 };

/** Same text format as the form fields (toolDefs `fmt`). */
export const fmt = (n: number): string => String(Math.round(n * 100) / 100);

// ---- Small vector helpers --------------------------------------------------------------------------------

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => scale(a, 1 / (len(a) || 1));
export const vec3 = { add, sub, scale, dot, cross, len, unit };

/** Two unit vectors perpendicular to `n` and to each other (e1 × e2 = n). */
export function basisOf(n: Vec3): [Vec3, Vec3] {
    const a: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const e1 = unit(sub(a, scale(n, dot(a, n))));
    return [e1, cross(n, e1)];
}

/** Rotates `v` about the unit `axis` by `deg` degrees, right-handed. */
export function rotateAbout(v: Vec3, axis: Vec3, deg: number): Vec3 {
    const q = new Quaternion().setFromAxisAngle(new Vector3(...axis), MathUtils.degToRad(deg));
    return new Vector3(...v).applyQuaternion(q).toArray() as Vec3;
}

/** World matrix of a part frame (as Scene draws it, without the explode offset). */
export function partMatrix(part: Pick<Part, 'position' | 'rotation'> | null): Matrix4 {
    if (!part) {
        return new Matrix4();
    }
    const q = new Quaternion().setFromEuler(new Euler(...(part.rotation.map(MathUtils.degToRad) as Vec3), 'XYZ'));
    return new Matrix4().compose(new Vector3(...part.position), q, new Vector3(1, 1, 1));
}

const point = (m: Matrix4, p: Vec3): Vec3 => new Vector3(...p).applyMatrix4(m).toArray() as Vec3;
const direction = (m: Matrix4, d: Vec3): Vec3 => new Vector3(...d).transformDirection(m).toArray() as Vec3;

function numberOf(v: Values, key: string): number | null {
    const raw = v[key];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
}

function vecOf(v: Values, key: string): Vec3 | null {
    const out = [0, 1, 2].map((i) => numberOf(v, `${key}${i}`));
    return out.every((n) => n !== null) ? (out as Vec3) : null;
}

// ---- Where a sketch's profile is --------------------------------------------------------------------------

function polygonCentroid(points: Pt[]): { at: Pt; area: number } {
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < points.length; i++) {
        const [x0, y0] = points[i];
        const [x1, y1] = points[(i + 1) % points.length];
        const c = x0 * y1 - x1 * y0;
        a += c;
        cx += (x0 + x1) * c;
        cy += (y0 + y1) * c;
    }
    if (Math.abs(a) < 1e-9) {
        const n = points.length || 1;
        return { at: [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n], area: 0 };
    }
    return { at: [cx / (3 * a), cy / (3 * a)], area: Math.abs(a / 2) };
}

/**
 * Sketch (u, v) centre of what a feature uses: the picked regions, else all regions (area-weighted centres of
 * their outlines), else the bounding-box centre of `fallback`.
 */
export function profileCentre(regions: SketchRegion[], picks: Pt[], fallback: Pt[]): Pt {
    const used = picks.length ? pickedRegions(regions, picks).map((i) => regions[i]) : regions;
    const centres = used.filter((r) => r.loops.length).map((r) => polygonCentroid(profilePoints(r.loops[0])));
    if (centres.length) {
        const total = centres.reduce((s, c) => s + c.area, 0);
        if (total > 1e-9) {
            return [centres.reduce((s, c) => s + c.at[0] * c.area, 0) / total, centres.reduce((s, c) => s + c.at[1] * c.area, 0) / total];
        }
        return [centres.reduce((s, c) => s + c.at[0], 0) / centres.length, centres.reduce((s, c) => s + c.at[1], 0) / centres.length];
    }
    if (!fallback.length) {
        return [0, 0];
    }
    const us = fallback.map((p) => p[0]);
    const vs = fallback.map((p) => p[1]);
    return [(Math.min(...us) + Math.max(...us)) / 2, (Math.min(...vs) + Math.max(...vs)) / 2];
}

interface SketchPlace {
    /** Part-frame to world. */
    matrix: Matrix4;
    plane: SketchPlane;
    offset: number;
    before: Feature[];
    centre: Pt;
}

/** The distance arrow of an extrude or cut: at the profile centre, along the plane normal (or against it). */
function extrudeHandle(place: SketchPlace, values: Values, label: string): Handle[] {
    const distance = numberOf(values, 'distance');
    if (distance === null) {
        return [];
    }
    const f = planeFrame(place.plane, place.offset, place.before);
    const local = add(f.origin, add(scale(f.u, place.centre[0]), scale(f.v, place.centre[1])));
    const n = unit(direction(place.matrix, f.n));
    const dir = values.direction;
    return [{
        kind: 'distance', key: 'distance', origin: point(place.matrix, local), direction: dir === 'reverse' ? scale(n, -1) : n,
        value: distance, min: 0, step: DEFAULT_STEP.length, label, symmetric: dir === 'symmetric',
    }];
}

/** The angle arc of a revolve: about the sketch u or v axis, starting at the profile centre. */
function revolveHandle(place: SketchPlace, values: Values): Handle[] {
    const angle = numberOf(values, 'angle');
    if (angle === null) {
        return [];
    }
    const f = planeFrame(place.plane, place.offset, place.before);
    const axisLocal = values.axis === 'u' ? f.u : f.v;
    const centre = add(f.origin, add(scale(f.u, place.centre[0]), scale(f.v, place.centre[1])));
    const along = dot(sub(centre, f.origin), axisLocal);
    const foot = add(f.origin, scale(axisLocal, along));
    const out = sub(centre, foot);
    // A profile centred on the axis: start along the other sketch axis.
    const startLocal = len(out) > 1e-6 ? unit(out) : values.axis === 'u' ? f.v : f.u;
    return [{
        kind: 'angle', key: 'angle', origin: point(place.matrix, foot), axis: unit(direction(place.matrix, axisLocal)),
        start: unit(direction(place.matrix, startLocal)), radius: len(out), value: angle, min: 0, max: 360, step: DEFAULT_STEP.angle,
    }];
}

/** The sketch step a part-workspace Extrude / Cut / Revolve uses, placed in the world. */
function stepPlace(values: Values, ctx: Ctx, env: HandleEnv): SketchPlace | null {
    const part = ctx.part;
    const features = part?.features ?? [];
    const index = features.findIndex((f) => f.id === values.sketch && f.op === 'sketch');
    const step = features[index];
    if (!part || !step || step.op !== 'sketch') {
        return null;
    }
    const sketch = step.sketch;
    const picks = env.pickKey === `${part.id}/${step.id}` ? env.picks : [];
    return {
        matrix: partMatrix(part), plane: sketch.plane, offset: sketch.offset ?? 0, before: features.slice(0, index),
        centre: profileCentre(sketch.regions ?? [], picks, sketch.profiles.flatMap(profilePoints)),
    };
}

function sketcherPlace(env: HandleEnv): SketchPlace | null {
    const s = env.sketch;
    if (!s) {
        return null;
    }
    return {
        matrix: partMatrix(s.part), plane: s.plane, offset: s.offset, before: s.context,
        centre: profileCentre(s.regions, env.pickKey === null ? env.picks : [], s.points),
    };
}

const FACE_NORMALS: Record<string, Vec3> = {
    top: [0, 1, 0], bottom: [0, -1, 0], front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0],
};

export const TOOL_HANDLES: Record<string, HandleFn> = {
    extrude: (values, ctx, env) => {
        const place = stepPlace(values, ctx, env);
        return place && !(values.mode === 'cut' && values.through) ? extrudeHandle(place, values, 'Distance') : [];
    },
    cut: (values, ctx, env) => {
        const place = stepPlace(values, ctx, env);
        return place && !(values.mode === 'cut' && values.through) ? extrudeHandle(place, values, 'Depth') : [];
    },
    revolve: (values, ctx, env) => {
        const place = stepPlace(values, ctx, env);
        return place ? revolveHandle(place, values) : [];
    },
    'sk-finish': (values, _ctx, env) => {
        const place = sketcherPlace(env);
        if (!place) {
            return [];
        }
        if (values.op === 'extrude' || (values.op === 'cut' && !values.through)) {
            return extrudeHandle(place, values, values.op === 'cut' ? 'Depth' : 'Distance');
        }
        return values.op === 'revolve' ? revolveHandle(place, values) : [];
    },
    move: (values) => {
        const position = vecOf(values, 'pos');
        return position ? [{ kind: 'translate', keys: ['pos0', 'pos1', 'pos2'], position, step: DEFAULT_STEP.position }] : [];
    },
    rotate: (values, ctx) => {
        const rotation = vecOf(values, 'rot');
        return ctx.part && rotation
            ? [{ kind: 'rotate', keys: ['rot0', 'rot1', 'rot2'], position: [...ctx.part.position] as Vec3, rotation, step: DEFAULT_STEP.angle }]
            : [];
    },
    duplicate: (values, ctx) => {
        const off = vecOf(values, 'off');
        return ctx.part && off
            ? [{ kind: 'translate', keys: ['off0', 'off1', 'off2'], position: add(ctx.part.position, off), step: DEFAULT_STEP.position }]
            : [];
    },
    hole: (values, ctx) => {
        const pos = vecOf(values, 'pos');
        const depth = numberOf(values, 'depth');
        const n = FACE_NORMALS[values.face as string];
        if (!ctx.part || !pos || depth === null || !n || values.through) {
            return [];
        }
        const m = partMatrix(ctx.part);
        return [{
            kind: 'distance', key: 'depth', origin: point(m, pos), direction: unit(direction(m, scale(n, -1))), value: depth, min: 0,
            step: DEFAULT_STEP.length, label: 'Depth',
        }];
    },
};

/** The handles of the open tool, or none (unknown tool, values being typed, nothing to anchor them to). */
export function handlesFor(toolId: string | null, values: Values, ctx: Ctx | null, env: HandleEnv): Handle[] {
    const fn = toolId ? TOOL_HANDLES[toolId] : undefined;
    if (!fn || !ctx) {
        return [];
    }
    try {
        return fn(values, ctx, env);
    } catch {
        return [];
    }
}

// ---- Shapes to draw and pick --------------------------------------------------------------------------------

/** On-screen sizes, in pixels. */
export const PX = { arrowHead: 16, arrowHeadRadius: 5.5, shaft: 1.6, triad: 92, triadGap: 14, square: [0.26, 0.5], ring: 74, knob: 6, pick: 9 };

/** A grip: one draggable part of a handle. */
export type Grip =
    | { kind: 'tip'; sign: 1 | -1 }
    | { kind: 'axis'; axis: 0 | 1 | 2 }
    | { kind: 'plane'; normal: 0 | 1 | 2 }
    | { kind: 'ring'; axis: 0 | 1 | 2 }
    | { kind: 'arc' };

export const gripId = (g: Grip): string => (g.kind === 'tip' ? `tip${g.sign}` : g.kind === 'arc' ? 'arc' : `${g.kind}${g.kind === 'plane' ? g.normal : g.axis}`);

/** World shape of a grip to pick it by: a polyline (closed: a loop), or a filled polygon. */
export interface GripShape {
    grip: Grip;
    points: Vec3[];
    fill?: boolean;
    closed?: boolean;
}

const AXES: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/** Unit axes of the three rotate rings: X in the world, Y after X, Z after X and Y (Euler XYZ as gimbals). */
export function gimbalAxes(rotation: Vec3): [Vec3, Vec3, Vec3] {
    const [a, b] = rotation.map(MathUtils.degToRad);
    const rx = new Matrix4().makeRotationX(a);
    const ry = new Matrix4().makeRotationY(b);
    return [
        [1, 0, 0],
        new Vector3(0, 1, 0).applyMatrix4(rx).toArray() as Vec3,
        new Vector3(0, 0, 1).applyMatrix4(ry).applyMatrix4(rx).toArray() as Vec3,
    ];
}

/** World radius of an angle arc: a constant size on screen (the profile's own radius is often off screen or zero). */
export function arcRadius(perPx: number): number {
    return PX.ring * perPx;
}

export function ringPoints(centre: Vec3, axis: Vec3, radius: number, from = 0, to = 360, n = 64): Vec3[] {
    const [e1, e2] = basisOf(axis);
    const out: Vec3[] = [];
    for (let i = 0; i <= n; i++) {
        const t = MathUtils.degToRad(from + ((to - from) * i) / n);
        out.push(add(centre, add(scale(e1, radius * Math.cos(t)), scale(e2, radius * Math.sin(t)))));
    }
    return out;
}

/** Tip of a distance arrow (sign -1: the mirrored tip of a symmetric one). */
export function tipOf(h: Extract<Handle, { kind: 'distance' }>, sign: 1 | -1 = 1): Vec3 {
    return add(h.origin, scale(h.direction, (h.symmetric ? h.value / 2 : h.value) * sign));
}

/** The grips of a handle and where they are, for `perPx` world units per pixel at the handle. */
export function gripShapes(h: Handle, perPx: number): GripShape[] {
    switch (h.kind) {
        case 'distance':
            return ([1, -1] as const).filter((sign) => sign === 1 || h.symmetric).map((sign) => {
                const tip = tipOf(h, sign);
                return { grip: { kind: 'tip', sign }, points: [h.origin, add(tip, scale(h.direction, sign * PX.arrowHead * perPx))] };
            });
        case 'translate': {
            const length = PX.triad * perPx;
            const [s0, s1] = PX.square.map((f) => f * length);
            return [
                ...AXES.map((a, axis) => ({
                    grip: { kind: 'axis', axis } as Grip,
                    points: [add(h.position, scale(a, PX.triadGap * perPx)), add(h.position, scale(a, length + PX.arrowHead * perPx))],
                })),
                ...AXES.map((_, normal) => {
                    const [i, j] = [(normal + 1) % 3, (normal + 2) % 3];
                    const corner = (p: number, q: number) => add(h.position, add(scale(AXES[i], p), scale(AXES[j], q)));
                    return { grip: { kind: 'plane', normal } as Grip, points: [corner(s0, s0), corner(s1, s0), corner(s1, s1), corner(s0, s1)], fill: true };
                }),
            ];
        }
        case 'rotate':
            return gimbalAxes(h.rotation).map((axis, i) => ({
                grip: { kind: 'ring', axis: i as 0 | 1 | 2 },
                points: ringPoints(h.position, axis, PX.ring * perPx * (1 - i * 0.04)),
                closed: true,
            }));
        case 'angle': {
            const r = arcRadius(perPx);
            const from = add(h.origin, scale(h.start, r));
            const n = Math.max(2, Math.ceil(Math.abs(h.value) / 6));
            const points = Array.from({ length: n + 1 }, (_, k) => add(h.origin, rotateAbout(sub(from, h.origin), h.axis, (h.value * k) / n)));
            return [{ grip: { kind: 'arc' }, points }];
        }
    }
}

/** Pixel distance from `p` to segment ab. */
function segmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function insidePolygon(p: [number, number], poly: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * The grip under the pointer: the nearest within `tolerance` pixels of its line, or a filled shape the pointer is
 * inside (lines win over fills). `project` maps a world point to screen pixels, null when behind the camera.
 */
export function pickGrip(shapes: GripShape[], project: (p: Vec3) => [number, number] | null, pointer: [number, number],
    tolerance = PX.pick): GripShape | null {
    let best: GripShape | null = null;
    let bestDistance = tolerance;
    let filled: GripShape | null = null;
    for (const shape of shapes) {
        const screen = shape.points.map(project);
        if (screen.some((s) => !s)) {
            continue;
        }
        const pts = screen as [number, number][];
        if (shape.fill) {
            if (!filled && insidePolygon(pointer, pts)) {
                filled = shape;
            }
            continue;
        }
        const count = shape.closed ? pts.length : pts.length - 1;
        for (let i = 0; i < count; i++) {
            const d = segmentDistance(pointer, pts[i], pts[(i + 1) % pts.length]);
            if (d < bestDistance) {
                bestDistance = d;
                best = shape;
            }
        }
    }
    return best ?? filled;
}

// ---- Dragging -------------------------------------------------------------------------------------------------

export interface Ray {
    origin: Vec3;
    direction: Vec3;
}

/** Parameter along the line `p + t d` (d unit) of its point closest to the ray; null when they are parallel. */
export function axisParam(ray: Ray, p: Vec3, d: Vec3): number | null {
    const r = unit(ray.direction);
    const w = sub(p, ray.origin);
    const b = dot(d, r);
    const denom = 1 - b * b;
    if (denom < 1e-6) {
        return null;
    }
    return (b * dot(w, r) - dot(w, d)) / denom;
}

/** Where the ray meets the plane through `p` with normal `n`; null when parallel or behind. */
export function planeHit(ray: Ray, p: Vec3, n: Vec3): Vec3 | null {
    const r = unit(ray.direction);
    const denom = dot(r, n);
    if (Math.abs(denom) < 1e-6) {
        return null;
    }
    const t = dot(sub(p, ray.origin), n) / denom;
    return t < 0 ? null : add(ray.origin, scale(r, t));
}

/** Angle (deg, right-handed about `axis`) from `ref` to where the ray meets the plane of the ring; null when edge-on. */
export function ringAngle(ray: Ray, centre: Vec3, axis: Vec3, ref: Vec3): number | null {
    const hit = planeHit(ray, centre, axis);
    if (!hit) {
        return null;
    }
    const v = sub(hit, centre);
    const flat = sub(v, scale(axis, dot(v, axis)));
    if (len(flat) < 1e-9) {
        return null;
    }
    return MathUtils.radToDeg(Math.atan2(dot(cross(ref, flat), axis), dot(ref, flat)));
}

export interface Modifiers {
    /** Free: no rounding. */
    alt?: boolean;
    /** Coarse: ten times the step. */
    shift?: boolean;
}

/** Rounds to the step (Shift: 10x; Alt: not at all, beyond the form's 0.01) and clamps. */
export function snapValue(value: number, step: number, mods: Modifiers = {}, min?: number, max?: number): number {
    const s = mods.shift ? step * 10 : step;
    let v = mods.alt || s <= 0 ? value : Math.round(value / s) * s;
    if (min !== undefined) {
        v = Math.max(min, v);
    }
    if (max !== undefined) {
        v = Math.min(max, v);
    }
    return Math.round(v * 100) / 100;
}

/** Wraps degrees into (-180, 180]. */
export const wrapDegrees = (d: number): number => {
    const w = ((((d + 180) % 360) + 360) % 360) - 180;
    return w === -180 ? 180 : w;
};

/** A drag in progress: what was grabbed, where, and the values it started from. */
export interface Drag {
    handle: Handle;
    grip: Grip;
    start: Values;
    /** Grab parameter (axis drags), point (plane drags) or angle (rings, arcs). */
    from: number | Vec3;
    /** Rings and arcs: the last angle seen and the angle turned so far, so turning past 180° keeps counting. */
    last: number;
    turned: number;
}

function ringOf(h: Handle, grip: Grip): { centre: Vec3; axis: Vec3; ref: Vec3 } | null {
    if (h.kind === 'rotate' && grip.kind === 'ring') {
        const axis = gimbalAxes(h.rotation)[grip.axis];
        return { centre: h.position, axis, ref: basisOf(axis)[0] };
    }
    if (h.kind === 'angle') {
        return { centre: h.origin, axis: h.axis, ref: h.start };
    }
    return null;
}

/** Axis of a line drag: the arrow (and which way its value grows), or a triad axis. */
function lineOf(h: Handle, grip: Grip): { p: Vec3; d: Vec3; gain: number } | null {
    if (h.kind === 'distance' && grip.kind === 'tip') {
        return { p: h.origin, d: h.direction, gain: (h.symmetric ? 2 : 1) * grip.sign };
    }
    if (h.kind === 'translate' && grip.kind === 'axis') {
        return { p: h.position, d: AXES[grip.axis], gain: 1 };
    }
    return null;
}

/** Starts a drag of `grip`; null when the ray gives nothing to measure from (e.g. looking straight down the axis). */
export function beginDrag(handle: Handle, grip: Grip, ray: Ray, values: Values): Drag | null {
    const line = lineOf(handle, grip);
    if (line) {
        const t = axisParam(ray, line.p, line.d);
        return t === null ? null : { handle, grip, start: values, from: t, last: 0, turned: 0 };
    }
    if (handle.kind === 'translate' && grip.kind === 'plane') {
        const hit = planeHit(ray, handle.position, AXES[grip.normal]);
        return hit ? { handle, grip, start: values, from: hit, last: 0, turned: 0 } : null;
    }
    const ring = ringOf(handle, grip);
    if (ring) {
        const a = ringAngle(ray, ring.centre, ring.axis, ring.ref);
        return a === null ? null : { handle, grip, start: values, from: a, last: a, turned: 0 };
    }
    return null;
}

const startNumber = (drag: Drag, key: string): number => numberOf(drag.start, key) ?? 0;

/** The values a drag gives for the pointer ray now; null when the ray gives nothing (keep the last values). */
export function dragValues(drag: Drag, ray: Ray, mods: Modifiers = {}): Values | null {
    const h = drag.handle;
    const line = lineOf(h, drag.grip);
    if (line) {
        const t = axisParam(ray, line.p, line.d);
        if (t === null) {
            return null;
        }
        const moved = (t - (drag.from as number)) * line.gain;
        if (h.kind === 'distance') {
            return { [h.key]: fmt(snapValue(startNumber(drag, h.key) + moved, h.step ?? DEFAULT_STEP.length, mods, h.min, h.max)) };
        }
        if (h.kind === 'translate' && drag.grip.kind === 'axis') {
            const key = h.keys[drag.grip.axis];
            return { [key]: fmt(snapValue(startNumber(drag, key) + moved, h.step ?? DEFAULT_STEP.position, mods)) };
        }
        return null;
    }
    if (h.kind === 'translate' && drag.grip.kind === 'plane') {
        const hit = planeHit(ray, h.position, AXES[drag.grip.normal]);
        if (!hit) {
            return null;
        }
        const delta = sub(hit, drag.from as Vec3);
        const out: Values = {};
        for (const i of [(drag.grip.normal + 1) % 3, (drag.grip.normal + 2) % 3]) {
            out[h.keys[i]] = fmt(snapValue(startNumber(drag, h.keys[i]) + delta[i], h.step ?? DEFAULT_STEP.position, mods));
        }
        return out;
    }
    const ring = ringOf(h, drag.grip);
    if (!ring) {
        return null;
    }
    const a = ringAngle(ray, ring.centre, ring.axis, ring.ref);
    if (a === null) {
        return null;
    }
    drag.turned += wrapDegrees(a - drag.last);
    drag.last = a;
    if (h.kind === 'rotate' && drag.grip.kind === 'ring') {
        const key = h.keys[drag.grip.axis];
        return { [key]: fmt(wrapDegrees(snapValue(startNumber(drag, key) + drag.turned, h.step ?? DEFAULT_STEP.angle, mods))) };
    }
    if (h.kind === 'angle') {
        return { [h.key]: fmt(snapValue(startNumber(drag, h.key) + drag.turned, h.step ?? DEFAULT_STEP.angle, mods, h.min, h.max)) };
    }
    return null;
}

/** The value text shown next to a handle while it is dragged. */
export function dragLabel(drag: Drag, values: Values): string {
    const h = drag.handle;
    const v = (key: string) => values[key] as string;
    switch (h.kind) {
        case 'distance':
            return `${h.label ? `${h.label} ` : ''}${v(h.key)} mm`;
        case 'translate':
            if (drag.grip.kind === 'axis') {
                return `${'XYZ'[drag.grip.axis]} ${v(h.keys[drag.grip.axis])} mm`;
            }
            if (drag.grip.kind === 'plane') {
                const [i, j] = [(drag.grip.normal + 1) % 3, (drag.grip.normal + 2) % 3].sort();
                return `${'XYZ'[i]} ${v(h.keys[i])} · ${'XYZ'[j]} ${v(h.keys[j])} mm`;
            }
            return '';
        case 'rotate':
            return drag.grip.kind === 'ring' ? `${'XYZ'[drag.grip.axis]} ${v(h.keys[drag.grip.axis])}°` : '';
        case 'angle':
            return `${v(h.key)}°`;
    }
}
