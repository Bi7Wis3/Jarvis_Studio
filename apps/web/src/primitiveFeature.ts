// Primitives as part steps (the pulldown next to Sketch): box, cylinder, sphere, cone, torus, tube, wedge and capsule.
// Each is placed by a point, an axis direction and a turn about that axis, and joined to the part, cut from it, or made
// a new body. Pure: form values to the add / cut step and back, so the round trips can be tested.

import type { Shape, Vec3 } from '@jarvis/core';
import { valueText } from './numberText';

export type PrimitiveKind = 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus' | 'tube' | 'wedge' | 'capsule';
export const PRIMITIVE_KINDS: PrimitiveKind[] = ['box', 'cylinder', 'sphere', 'cone', 'torus', 'tube', 'wedge', 'capsule'];

/** Form values as the primitive forms read and write them. */
export type PrimitiveValues = Record<string, unknown>;
type Out = Record<string, string | boolean>;

export interface SizeField {
    key: string;
    label: string;
    kind?: 'check';
    /** Shown only when this check is on. */
    when?: string;
    /** May be 0 (a sharp edge); otherwise the value must be above 0. */
    zero?: boolean;
}

export const PRIMITIVE_LABELS: Record<PrimitiveKind, string> = {
    box: 'Box', cylinder: 'Cylinder', sphere: 'Sphere', cone: 'Cone', torus: 'Torus', tube: 'Tube', wedge: 'Wedge', capsule: 'Capsule',
};

/** The size fields of each primitive; "height" runs along the primitive's axis. */
export const SIZE_FIELDS: Record<PrimitiveKind, SizeField[]> = {
    box: [
        { key: 'w', label: 'Width' }, { key: 'h', label: 'Height' }, { key: 'd', label: 'Depth' },
        { key: 'r', label: 'Edge round', zero: true },
    ],
    cylinder: [
        { key: 'dia', label: 'Diameter' }, { key: 'h', label: 'Height' },
        { key: 'taper', label: 'Taper', kind: 'check' }, { key: 'top', label: 'Top diameter', when: 'taper', zero: true },
        { key: 'bevel', label: 'Edge bevel', zero: true },
    ],
    sphere: [{ key: 'dia', label: 'Diameter' }],
    cone: [{ key: 'dia', label: 'Base diameter' }, { key: 'h', label: 'Height' }],
    torus: [{ key: 'ring', label: 'Ring diameter' }, { key: 'tube', label: 'Tube diameter' }],
    tube: [
        { key: 'od', label: 'Outer diameter' }, { key: 'id', label: 'Inner diameter' }, { key: 'h', label: 'Height' },
        { key: 'bevel', label: 'Edge bevel', zero: true },
    ],
    wedge: [{ key: 'w', label: 'Width' }, { key: 'h', label: 'Height' }, { key: 'd', label: 'Depth' }],
    capsule: [{ key: 'dia', label: 'Diameter' }, { key: 'len', label: 'Straight length', zero: true }],
};

export const SIZE_DEFAULTS: Record<PrimitiveKind, Out> = {
    box: { w: '40', h: '20', d: '30', r: '0' },
    cylinder: { dia: '20', h: '30', taper: false, top: '10', bevel: '0' },
    sphere: { dia: '20' },
    cone: { dia: '20', h: '30' },
    torus: { ring: '40', tube: '8' },
    tube: { od: '30', id: '24', h: '30', bevel: '0' },
    wedge: { w: '40', h: '20', d: '30' },
    capsule: { dia: '10', len: '30' },
};

const text = valueText;

function read(v: PrimitiveValues, field: Pick<SizeField, 'key' | 'label' | 'zero'>): number {
    const raw = v[field.key];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
        throw new Error(`${field.label} must be a number.`);
    }
    if (field.zero ? n < 0 : n <= 0) {
        throw new Error(`${field.label} must be ${field.zero ? 'at least 0' : 'greater than 0'}.`);
    }
    return n;
}

const size = (kind: PrimitiveKind, key: string): SizeField => SIZE_FIELDS[kind].find((f) => f.key === key)!;

/** The step's shape from the form; throws a message naming the field that is wrong. */
export function primitiveShape(kind: PrimitiveKind, v: PrimitiveValues): Shape {
    const n = (key: string) => read(v, size(kind, key));
    switch (kind) {
        case 'box':
            return { kind: 'box', size: [n('w'), n('h'), n('d')], radius: n('r') };
        case 'cylinder': {
            const radius = n('dia') / 2;
            return { kind: 'cylinder', radius, height: n('h'), ...(v.taper ? { radiusTop: n('top') / 2 } : {}), bevel: n('bevel') };
        }
        case 'sphere':
            return { kind: 'sphere', radius: n('dia') / 2 };
        case 'cone':
            return { kind: 'cone', radius: n('dia') / 2, height: n('h') };
        case 'torus': {
            const radius = n('ring') / 2;
            const tube = n('tube') / 2;
            if (tube >= radius) {
                throw new Error('The tube diameter must be smaller than the ring diameter.');
            }
            return { kind: 'torus', radius, tube };
        }
        case 'tube': {
            const outerRadius = n('od') / 2;
            const innerRadius = n('id') / 2;
            if (innerRadius >= outerRadius) {
                throw new Error('The inner diameter must be smaller than the outer diameter.');
            }
            return { kind: 'tube', outerRadius, innerRadius, height: n('h'), bevel: n('bevel') };
        }
        case 'wedge':
            return { kind: 'wedge', size: [n('w'), n('h'), n('d')] };
        case 'capsule':
            return { kind: 'capsule', radius: n('dia') / 2, length: n('len') };
    }
}

/** Which primitive form edits a stored shape, or null when none does (outlines, lathes, fasteners, scripts). */
export function primitiveKindOf(shape: Shape): PrimitiveKind | null {
    return (PRIMITIVE_KINDS as string[]).includes(shape.kind) ? shape.kind as PrimitiveKind : null;
}

/** The size values of a stored shape. Missing edge rounds read as 0 (the form makes exact, sharp shapes). */
export function primitiveSizeValues(shape: Shape): Out | null {
    switch (shape.kind) {
        case 'box':
            return { w: text(shape.size[0]), h: text(shape.size[1]), d: text(shape.size[2]), r: text(shape.radius ?? 0) };
        case 'cylinder':
            return {
                dia: text(shape.radius * 2), h: text(shape.height), taper: shape.radiusTop !== undefined && shape.radiusTop !== shape.radius,
                top: text((shape.radiusTop ?? shape.radius) * 2), bevel: text(shape.bevel ?? 0),
            };
        case 'sphere':
            return { dia: text(shape.radius * 2) };
        case 'cone':
            return { dia: text(shape.radius * 2), h: text(shape.height) };
        case 'torus':
            return { ring: text(shape.radius * 2), tube: text(shape.tube * 2) };
        case 'tube':
            return { od: text(shape.outerRadius * 2), id: text(shape.innerRadius * 2), h: text(shape.height), bevel: text(shape.bevel ?? 0) };
        case 'wedge':
            return { w: text(shape.size[0]), h: text(shape.size[1]), d: text(shape.size[2]) };
        case 'capsule':
            return { dia: text(shape.radius * 2), len: text(shape.length) };
        default:
            return null;
    }
}

/** How far the shape reaches along its own axis (local +Y) from its centre: where its base is. */
export function halfAxis(shape: Shape): number {
    switch (shape.kind) {
        case 'box':
        case 'wedge':
            return shape.size[1] / 2;
        case 'cylinder':
        case 'cone':
        case 'tube':
            return shape.height / 2;
        case 'sphere':
            return shape.radius;
        case 'torus':
            return shape.tube;
        case 'capsule':
            return shape.length / 2 + shape.radius;
        default:
            return 0;
    }
}

// ---- Orientation -----------------------------------------------------------------------------------------------

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(...a));
const DEG = 180 / Math.PI;

/** Drops float noise far below the app's 0.000001 mm (and degree) resolution: 89.99999999999999 is 90, -0 is 0. */
export function tidy(x: number): number {
    const r = Math.round(x * 1e9) / 1e9;
    return (Math.abs(r - x) < 1e-11 ? r : x) + 0;
}

/** Where spin 0 points the shape's local X for an axis `n`: world X in the plane square to `n` (world Z near X). */
export function spinReference(n: Vec3): Vec3 {
    const helper: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    return unit(sub(helper, scale(n, dot(helper, n))));
}

/** The shape's local axes in the part: Y along `axis`, X turned `spin` degrees about it from spinReference. */
export function primitiveFrame(axis: Vec3, spin: number): { x: Vec3; y: Vec3; z: Vec3 } {
    const y = unit(axis);
    const x0 = spinReference(y);
    const a = spin / DEG;
    const x = add(scale(x0, Math.cos(a)), scale(cross(y, x0), Math.sin(a)));
    return { x, y, z: cross(x, y) };
}

/**
 * Euler angles (degrees) of a frame as steps store rotation: three.js XYZ order, R = Rx * Ry * Rz (Z is applied
 * first), the frame's axes being R's columns.
 */
export function eulerOf(f: { x: Vec3; y: Vec3; z: Vec3 }): Vec3 {
    // R[row][col]: column 0 = x, 1 = y, 2 = z.
    const r = (row: number, col: number) => [f.x, f.y, f.z][col][row];
    const sb = Math.max(-1, Math.min(1, r(0, 2)));
    const b = Math.asin(sb);
    let a: number;
    let c: number;
    if (Math.abs(Math.cos(b)) > 1e-9) {
        a = Math.atan2(-r(1, 2), r(2, 2));
        c = Math.atan2(-r(0, 1), r(0, 0));
    } else {
        // Gimbal lock: only a + c (or a - c) is fixed; put it all in a.
        a = Math.atan2(r(2, 1), r(1, 1));
        c = 0;
    }
    return [tidy(a * DEG), tidy(b * DEG), tidy(c * DEG)];
}

/** The frame of stored Euler angles (degrees, XYZ order). */
export function frameOfEuler(rotation: Vec3): { x: Vec3; y: Vec3; z: Vec3 } {
    const [a, b, c] = rotation.map((d) => d / DEG);
    const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
    const m = [
        [cb * cc, -cb * sc, sb],
        [ca * sc + sa * sb * cc, ca * cc - sa * sb * sc, -sa * cb],
        [sa * sc - ca * sb * cc, sa * cc + ca * sb * sc, ca * cb],
    ];
    const col = (j: number): Vec3 => [m[0][j], m[1][j], m[2][j]];
    return { x: col(0), y: col(1), z: col(2) };
}

/** The turn (degrees) of local X about the axis `y`, from spinReference. */
export function spinOf(y: Vec3, x: Vec3): number {
    const x0 = spinReference(y);
    return tidy(Math.atan2(dot(cross(x0, x), y), dot(x0, x)) * DEG);
}

// ---- Placement -------------------------------------------------------------------------------------------------

export type Anchor = 'base' | 'centre';

function readVec(v: PrimitiveValues, key: string, label: string): Vec3 {
    return [0, 1, 2].map((i) => {
        const raw = v[`${key}${i}`];
        const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
        if (!Number.isFinite(n)) {
            throw new Error(`${label} ${'XYZ'[i]} must be a number.`);
        }
        return n;
    }) as Vec3;
}

function readNumber(v: PrimitiveValues, key: string, label: string): number {
    const raw = v[key];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw === undefined ? 0 : NaN;
    if (!Number.isFinite(n)) {
        throw new Error(`${label} must be a number.`);
    }
    return n;
}

/** The axis the form asks for: its direction, reversed when Reverse direction is on. */
export function primitiveAxis(v: PrimitiveValues): Vec3 {
    const dir = readVec(v, 'dir', 'Axis direction');
    if (!(Math.hypot(...dir) > 1e-12)) {
        throw new Error('The axis direction must not be zero.');
    }
    return scale(unit(dir), v.flip ? -1 : 1);
}

/** The step's position (the shape's centre) and rotation from the form's point, anchor, axis and spin. */
export function primitivePlacement(v: PrimitiveValues, shape: Shape): { position: Vec3; rotation: Vec3 } {
    const point = readVec(v, 'pos', 'Position');
    const axis = primitiveAxis(v);
    const spin = readNumber(v, 'spin', 'Rotation about the axis');
    const centre = v.anchor === 'centre' ? point : add(point, scale(axis, halfAxis(shape)));
    return { position: centre.map(tidy) as Vec3, rotation: eulerOf(primitiveFrame(axis, spin)) };
}

/** A direction's values unrounded, so a stored turn comes back exactly as it was (positions use valueText). */
const exactDir = (d: Vec3): Out => ({ dir0: String(tidy(d[0])), dir1: String(tidy(d[1])), dir2: String(tidy(d[2])) });

/** Form values for a stored placement: the point at the anchor, the axis the shape stands on, its spin. */
export function placementValues(shape: Shape, position: Vec3 | undefined, rotation: Vec3 | undefined, anchor: Anchor): Out {
    const f = frameOfEuler(rotation ?? [0, 0, 0]);
    const centre = position ?? [0, 0, 0];
    const point = anchor === 'centre' ? centre : sub(centre, scale(f.y, halfAxis(shape)));
    return {
        pos0: text(tidy(point[0])), pos1: text(tidy(point[1])), pos2: text(tidy(point[2])),
        ...exactDir(f.y), flip: false, spin: String(spinOf(f.y, f.x)), anchor,
    };
}

/** Moves the point when the anchor changes, so the shape stays where it is. */
export function reanchor(v: PrimitiveValues, kind: PrimitiveKind, to: Anchor): Out {
    try {
        const shape = primitiveShape(kind, v);
        const { position, rotation } = primitivePlacement({ ...v, anchor: to === 'base' ? 'centre' : 'base' }, shape);
        const out = placementValues(shape, position, rotation, to);
        return { pos0: out.pos0, pos1: out.pos1, pos2: out.pos2 };
    } catch {
        return {};
    }
}

/** A placement read from a pick in the view: a point on a plane or face and the way it faces, or a circle's centre and axis. */
export interface PickedPlace {
    point: Vec3;
    normal: Vec3;
}

/** Values for a pick: the point, the axis along the outward normal; a cut goes into the face instead. */
export function pickedPlacement(place: PickedPlace, cut: boolean): Out {
    const n = unit(place.normal);
    return {
        pos0: text(tidy(place.point[0])), pos1: text(tidy(place.point[1])), pos2: text(tidy(place.point[2])),
        ...exactDir(n), flip: cut, anchor: 'base',
    };
}

/** The add or cut step for the form's values. */
export function primitiveStep(kind: PrimitiveKind, v: PrimitiveValues): { op: 'add' | 'cut'; shape: Shape; position: Vec3; rotation: Vec3 } {
    const shape = primitiveShape(kind, v);
    return { op: v.result === 'cut' ? 'cut' : 'add', shape, ...primitivePlacement(v, shape) };
}
