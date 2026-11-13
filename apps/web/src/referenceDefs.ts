// Reference geometry forms (Plane, Axis, Point): form values <-> plane and axis definitions, and what a plane, axis
// or point clicked in the view fills in the open form. Pure, so it is tested without the UI.

import type { AxisDefinition, AxisRef, Feature, PlaneDefinition, PlaneRef, PointRef, Vec3 } from '@jarvis/core';
import { resolveAxis, resolvePlane } from '@jarvis/core/reference';
import { revolveAxisKey } from './revolveAxis';

export type RefValues = Record<string, string | boolean | string[]>;

const fmt = (n: number): string => String(Math.round(n * 100) / 100);
const NAMED = ['top', 'front', 'right'];

function num(v: RefValues, key: string, label: string): number {
    const raw = v[key];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
        throw new Error(`${label} must be a number.`);
    }
    return n;
}

const vec = (v: RefValues, key: string, label: string): Vec3 =>
    [0, 1, 2].map((i) => num(v, `${key}${i}`, `${label} ${'XYZ'[i]}`)) as Vec3;

const vecValues = (key: string, p: Vec3): RefValues => Object.fromEntries(p.map((c, i) => [`${key}${i}`, fmt(c)]));

// ---- References as select values ------------------------------------------------------------------------------

/** Plane selects: 'top', 'front', 'right' or a plane step id. */
export const planeValue = (ref: PlaneRef): string => (typeof ref === 'string' ? ref : ref.planeRef);

export function planeFrom(value: unknown, label: string): PlaneRef {
    const v = typeof value === 'string' ? value : '';
    if (!v) {
        throw new Error(`Pick the ${label}.`);
    }
    return NAMED.includes(v) ? (v as PlaneRef) : { planeRef: v };
}

/** Axis selects: 'x', 'y', 'z' or 'axis:<step id>' (plane angles also 'u' and 'v'). */
export const axisRefValue = (ref: AxisRef | 'u' | 'v'): string => (typeof ref === 'string' ? ref : `axis:${ref.axisRef}`);

export function axisRefFrom(value: unknown, label: string): AxisRef {
    const v = typeof value === 'string' ? value : '';
    if (v.startsWith('axis:')) {
        return { axisRef: v.slice(5) };
    }
    if (v === 'x' || v === 'y' || v === 'z') {
        return v;
    }
    throw new Error(`Pick the ${label}.`);
}

/** A point field: its source select (`<key>src`: 'xyz' or a point step id) and coordinates (`<key>0..2`). */
function pointFrom(v: RefValues, key: string, label: string): PointRef {
    const src = v[`${key}src`];
    return typeof src === 'string' && src && src !== 'xyz' ? { pointRef: src } : vec(v, key, label);
}

function pointValues(key: string, p: PointRef | undefined, fallback: Vec3 = [0, 0, 0]): RefValues {
    return Array.isArray(p) || !p
        ? { [`${key}src`]: 'xyz', ...vecValues(key, (p as Vec3 | undefined) ?? fallback) }
        : { [`${key}src`]: p.pointRef, ...vecValues(key, fallback) };
}

// ---- Plane ------------------------------------------------------------------------------------------------------

export const PLANE_KINDS: [PlaneDefinition['kind'], string][] = [
    ['offset', 'Offset distance'], ['angle', 'At angle'], ['midplane', 'Mid plane'], ['parallel', 'Parallel through a point'],
    ['threePoints', 'Through three points'], ['normal', 'Normal to an axis'],
];

export function planeDefaults(): RefValues {
    return {
        kind: 'offset', base: 'top', distance: '10', flip: false, count: '1', about: 'u', angle: '45', a: 'top', b: '', axis: 'y',
        ...pointValues('p1', undefined), ...pointValues('p2', undefined, [10, 0, 0]), ...pointValues('p3', undefined, [0, 0, -10]),
        npsrc: 'axis', ...vecValues('np', [0, 0, 0]), ...vecValues('normal', [0, 1, 0]), refTurn: false,
    };
}

/** Form values of a stored plane definition. */
export function planeValues(d: PlaneDefinition): RefValues {
    const v = { ...planeDefaults(), kind: d.kind };
    switch (d.kind) {
        case 'offset':
            return { ...v, base: planeValue(d.base), distance: fmt(Math.abs(d.distance)), flip: d.distance < 0 };
        case 'angle':
            return { ...v, base: planeValue(d.base), about: axisRefValue(d.about), angle: fmt(Math.abs(d.angle)), flip: d.angle < 0 };
        case 'midplane':
            return { ...v, a: planeValue(d.a), b: planeValue(d.b) };
        case 'parallel':
            return { ...v, base: planeValue(d.base), ...pointValues('p1', d.point) };
        case 'threePoints':
            return { ...v, ...pointValues('p1', d.points[0]), ...pointValues('p2', d.points[1]), ...pointValues('p3', d.points[2]) };
        case 'normal':
            return {
                ...v, axis: axisRefValue(d.axis),
                ...(d.point ? { ...pointValues('np', d.point), npsrc: Array.isArray(d.point) ? 'xyz' : d.point.pointRef } : { npsrc: 'axis' }),
            };
        case 'pointNormal':
            return { ...v, ...pointValues('p1', d.point), ...vecValues('normal', d.normal) };
    }
}

/** The plane definition in the form; `index` makes the n-th of several offset or angle planes (1 = the first). */
export function planeDefinition(v: RefValues, index = 1): PlaneDefinition {
    const sign = v.flip ? -1 : 1;
    switch (v.kind) {
        case 'offset':
            return { kind: 'offset', base: planeFrom(v.base, 'plane to offset from'), distance: sign * num(v, 'distance', 'Distance') * index };
        case 'angle': {
            const about = v.about === 'u' || v.about === 'v' ? v.about : axisRefFrom(v.about, 'axis to turn about');
            return { kind: 'angle', base: planeFrom(v.base, 'plane to turn'), about, angle: sign * num(v, 'angle', 'Angle') * index };
        }
        case 'midplane':
            return { kind: 'midplane', a: planeFrom(v.a, 'first plane'), b: planeFrom(v.b, 'second plane') };
        case 'parallel':
            return { kind: 'parallel', base: planeFrom(v.base, 'plane to be parallel to'), point: pointFrom(v, 'p1', 'Point') };
        case 'threePoints':
            return { kind: 'threePoints', points: [pointFrom(v, 'p1', 'Point 1'), pointFrom(v, 'p2', 'Point 2'), pointFrom(v, 'p3', 'Point 3')] };
        case 'normal':
            return {
                kind: 'normal', axis: axisRefFrom(v.axis, 'axis'),
                ...(v.npsrc === 'axis' ? {} : { point: pointFrom(v, 'np', 'Point') }),
            };
        case 'pointNormal':
            return { kind: 'pointNormal', point: pointFrom(v, 'p1', 'Point'), normal: vec(v, 'normal', 'Normal') };
        default:
            throw new Error('Pick how the plane is defined.');
    }
}

// ---- Axis -------------------------------------------------------------------------------------------------------

export const AXIS_KINDS: [AxisDefinition['kind'], string][] = [
    ['sketchLine', 'Line or centreline'], ['planeIntersection', 'Two planes'], ['twoPoints', 'Two points'], ['pointPlane', 'Point and plane'],
];

/** The line field of the Axis form for one sketch step (each sketch has its own lines). */
export const lineKey = (sketchId: unknown): string => `line_${String(sketchId ?? '')}`;

export function axisDefaults(): RefValues {
    return {
        kind: 'sketchLine', sketch: '', a: 'top', b: 'front', plane: 'top',
        ...pointValues('p1', undefined), ...pointValues('p2', undefined, [0, 10, 0]), ...vecValues('direction', [0, 1, 0]), refTurn: false,
    };
}

export function axisValues(d: AxisDefinition): RefValues {
    const v = { ...axisDefaults(), kind: d.kind };
    switch (d.kind) {
        case 'sketchLine':
            return { ...v, sketch: d.sketchRef, [lineKey(d.sketchRef)]: d.line };
        case 'planeIntersection':
            return { ...v, a: planeValue(d.a), b: planeValue(d.b) };
        case 'twoPoints':
            return { ...v, ...pointValues('p1', d.a), ...pointValues('p2', d.b) };
        case 'pointPlane':
            return { ...v, ...pointValues('p1', d.point), plane: planeValue(d.plane) };
        case 'pointDirection':
            return { ...v, ...pointValues('p1', d.point), ...vecValues('direction', d.direction) };
    }
}

export function axisDefinition(v: RefValues): AxisDefinition {
    switch (v.kind) {
        case 'sketchLine': {
            const sketch = typeof v.sketch === 'string' ? v.sketch : '';
            const line = v[lineKey(sketch)];
            if (!sketch || typeof line !== 'string' || !line) {
                throw new Error('Pick a sketch and one of its lines.');
            }
            return { kind: 'sketchLine', sketchRef: sketch, line };
        }
        case 'planeIntersection':
            return { kind: 'planeIntersection', a: planeFrom(v.a, 'first plane'), b: planeFrom(v.b, 'second plane') };
        case 'twoPoints':
            return { kind: 'twoPoints', a: pointFrom(v, 'p1', 'Point 1'), b: pointFrom(v, 'p2', 'Point 2') };
        case 'pointPlane':
            return { kind: 'pointPlane', point: pointFrom(v, 'p1', 'Point'), plane: planeFrom(v.plane, 'plane') };
        case 'pointDirection':
            return { kind: 'pointDirection', point: pointFrom(v, 'p1', 'Point'), direction: vec(v, 'direction', 'Direction') };
        default:
            throw new Error('Pick how the axis is defined.');
    }
}

/** Checks a definition against the steps before it, as the kernel will (the same resolver), with a plain message. */
export function checkReference(op: 'plane' | 'axis', definition: PlaneDefinition | AxisDefinition, steps: Feature[]): void {
    const probe = { id: '__new', op, definition } as Feature;
    const all = [...steps, probe];
    try {
        if (op === 'plane') {
            resolvePlane({ planeRef: '__new' }, all, 'plane');
        } else {
            resolveAxis({ axisRef: '__new' }, all, 'axis');
        }
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(message.replace(/^(plane|axis): /, '').replace(/^./, (c) => c.toUpperCase()));
    }
}

// ---- Picks in the view ------------------------------------------------------------------------------------------

/**
 * The form values a plane, axis or point step clicked in the view sets in the open tool, or null when that tool has
 * no use for it. Where a form takes two or three of a kind, clicks fill them in turn.
 */
export function refPickPatch(toolId: string | null, v: RefValues, op: Feature['op'], id: string): RefValues | null {
    const turn = !!v.refTurn;
    if (toolId === 'revolve' && op === 'axis') {
        return { [revolveAxisKey(v.sketch)]: `axis:${id}` };
    }
    if (toolId === 'plane') {
        if (op === 'plane') {
            if (v.kind === 'midplane') {
                return turn ? { b: id, refTurn: false } : { a: id, refTurn: true };
            }
            return v.kind === 'offset' || v.kind === 'angle' || v.kind === 'parallel' ? { base: id } : null;
        }
        if (op === 'axis') {
            return v.kind === 'angle' ? { about: `axis:${id}` } : v.kind === 'normal' ? { axis: `axis:${id}` } : null;
        }
        if (op === 'point') {
            if (v.kind === 'threePoints') {
                const n = Number(v.refCount ?? 0) % 3;
                return { [`p${n + 1}src`]: id, refCount: String(n + 1) };
            }
            return v.kind === 'parallel' || v.kind === 'pointNormal' ? { p1src: id } : v.kind === 'normal' ? { npsrc: id } : null;
        }
    }
    if (toolId === 'axis') {
        if (op === 'plane') {
            if (v.kind === 'planeIntersection') {
                return turn ? { b: id, refTurn: false } : { a: id, refTurn: true };
            }
            return v.kind === 'pointPlane' ? { plane: id } : null;
        }
        if (op === 'point') {
            if (v.kind === 'twoPoints') {
                return turn ? { p2src: id, refTurn: false } : { p1src: id, refTurn: true };
            }
            return v.kind === 'pointPlane' || v.kind === 'pointDirection' ? { p1src: id } : null;
        }
    }
    return null;
}

/**
 * Lines of a sketch step that a click in the view can pick for the open tool: the Revolve axis or the Axis tool's
 * line. Returns the sketch, the form key and the value prefix, or null.
 */
export function linePickTarget(toolId: string | null, v: RefValues): { sketch: string; key: string; prefix: string } | null {
    const sketch = typeof v.sketch === 'string' ? v.sketch : '';
    if (!sketch) {
        return null;
    }
    if (toolId === 'revolve') {
        return { sketch, key: revolveAxisKey(sketch), prefix: 'line:' };
    }
    if (toolId === 'axis' && v.kind === 'sketchLine') {
        return { sketch, key: lineKey(sketch), prefix: '' };
    }
    return null;
}
