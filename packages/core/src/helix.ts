// Helix and Spiral (SolidWorks: Insert > Curve > Helix/Spiral): a curve step made from a sketched circle. The circle's
// centre and normal set the axis, its diameter the start diameter, and the curve starts on it. The exact curve as a
// function of the revolutions turned, shared by the CAD kernel (which builds it as B-spline edges) and the view
// (which draws it), so both see the same curve.

import type { Feature, Sketch, SketchProfile, Vec3 } from './index';
import { sketchFrameOf, type SketchFrame } from './reference';
import { resolvedSketch } from './derived';

/** What the curve is defined by (SolidWorks' Defined By); spiral is a flat spiral in the sketch plane. */
export type HelixDefinedBy = 'pitchRevolution' | 'heightRevolution' | 'heightPitch' | 'spiral';

/**
 * A row of the variable pitch table (SolidWorks' region parameters). The first row is the start: at revolution 0
 * and height 0 on the circle, so only its pitch counts. A later row gives two of pitch, revolutions and height as
 * Defined by says (pitch and revolution: P and Rev; height and revolution: H and Rev; height and pitch: H and P),
 * and the third is worked out: the pitch changes evenly with the revolutions from one row to the next.
 * Revolutions and height count from the start.
 */
export interface HelixRow {
    pitch?: number;
    revolutions?: number;
    height?: number;
    /** Diameter at this row (absent: the row before's); the curve passes through it smoothly. */
    diameter?: number;
}

/** The settings of a helix or spiral step (the circle comes from its sketch). */
export interface HelixOptions {
    definedBy: HelixDefinedBy;
    /**
     * Constant pitch: two of pitch, revolutions and height by definedBy (spiral: pitch, the radial distance between
     * turns, and revolutions).
     */
    pitch?: number;
    revolutions?: number;
    height?: number;
    /** Variable pitch (helix only): the table, two rows or more. */
    variablePitch?: HelixRow[];
    /** Helix: runs the other way, against the sketch normal. Spiral: runs inward. */
    reverse?: boolean;
    /** Where the first turn starts on the circle: degrees from the sketch's horizontal (u) axis, counterclockwise. */
    startAngle?: number;
    /**
     * Turns clockwise as seen looking at the sketch (its normal towards the viewer); absent: counterclockwise, which
     * is a right-hand helix when it runs along the normal.
     */
    clockwise?: boolean;
    /** Taper helix (constant pitch helix only): degrees between the axis and the cone the helix lies on. */
    taper?: number;
    /** The taper widens the helix along its height (absent: it narrows). */
    taperOutward?: boolean;
}

export type HelixStep = Extract<Feature, { op: 'helix' }>;

/**
 * One stretch of the curve between revolutions t0 and t1, with radius and height polynomials in tau = t - t0:
 * r = r[0] + r[1] tau + r[2] tau^2 + r[3] tau^3, z = z[0] + z[1] tau + z[2] tau^2.
 */
export interface HelixPiece {
    t0: number;
    t1: number;
    r: [number, number, number, number];
    z: [number, number, number];
}

/** A row of the table as worked out: all four values. */
export interface HelixRowValues {
    revolutions: number;
    height: number;
    pitch: number;
    diameter: number;
}

/** The curve: point(t) = centre + r(t) (cos a u + sin a v) + z(t) axis, a = start + omega t, for t in 0..revolutions. */
export interface HelixShape {
    centre: Vec3;
    u: Vec3;
    v: Vec3;
    /** Unit direction the helix rises in (the sketch normal, or against it when reversed); a spiral's plane normal. */
    axis: Vec3;
    /** Angle at the start, radians from u towards v. */
    start: number;
    /** Radians per revolution: 2 pi counterclockwise, -2 pi clockwise. */
    omega: number;
    pieces: HelixPiece[];
    spiral: boolean;
    revolutions: number;
    /** Along the axis from start to end (0 for a spiral). */
    height: number;
    /** The pitch of a constant pitch curve. */
    pitch: number | null;
    startDiameter: number;
    endDiameter: number;
    /** Variable pitch: the table as worked out, one entry per row. */
    rows: HelixRowValues[] | null;
}

/** Most revolutions a curve may have (each turn is an edge of the kernel's curve). */
export const MAX_REVOLUTIONS = 1000;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const ok = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
const rad = (deg: number): number => (deg * Math.PI) / 180;

function positive(n: number | undefined, what: string): number {
    if (!ok(n) || !(n > 0)) {
        throw new Error(`${what} must be greater than 0`);
    }
    return n;
}

/** The circle a helix starts on: the one circle of its sketch (a construction circle when it has no other). */
export function helixCircle(sketch: Pick<Sketch, 'profiles' | 'open' | 'geometry'>): { centre: [number, number]; radius: number } {
    const profiles = sketch.profiles ?? [];
    const circles = profiles.filter((p): p is Extract<SketchProfile, { kind: 'circle' }> => p.kind === 'circle');
    if (circles.length > 1) {
        throw new Error(`the sketch has ${circles.length} circles; a helix needs exactly one`);
    }
    if (profiles.length > circles.length || (sketch.open?.length ?? 0) > 0) {
        throw new Error('the sketch has more than a circle; a helix sketch holds only its circle');
    }
    if (circles.length === 1) {
        return { centre: circles[0].center, radius: positive(circles[0].radius, 'the circle\'s radius') };
    }
    const g = sketch.geometry;
    const drawn = g?.curves.filter((c) => c.kind === 'circle') ?? [];
    if (drawn.length === 1 && drawn[0].kind === 'circle') {
        const id = drawn[0].center;
        const p = id === 'origin' ? { u: 0, v: 0 } : g!.points.find((q) => q.id === id);
        if (p) {
            return { centre: [p.u, p.v], radius: positive(drawn[0].radius, 'the circle\'s radius') };
        }
    }
    throw new Error(drawn.length > 1 ? `the sketch has ${drawn.length} circles; a helix needs exactly one`
        : 'the sketch needs a circle: its centre and diameter set the helix');
}

/** Slopes of the shape-preserving cubic through (t, r) (PCHIP): smooth, and never beyond the values it joins. */
function pchipSlopes(t: number[], r: number[]): number[] {
    const n = t.length;
    const h = t.slice(1).map((x, i) => x - t[i]);
    const d = h.map((hi, i) => (r[i + 1] - r[i]) / hi);
    if (n === 2) {
        return [d[0], d[0]];
    }
    const m = new Array<number>(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
        if (d[i - 1] * d[i] > 0) {
            const w1 = 2 * h[i] + h[i - 1];
            const w2 = h[i] + 2 * h[i - 1];
            m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
        }
    }
    // Ends: three-point estimate, kept in the shape of the data (as MATLAB's pchip).
    const end = (h0: number, h1: number, d0: number, d1: number): number => {
        let s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
        if (Math.sign(s) !== Math.sign(d0)) {
            s = 0;
        } else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(s) > Math.abs(3 * d0)) {
            s = 3 * d0;
        }
        return s;
    };
    m[0] = end(h[0], h[1], d[0], d[1]);
    m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
    return m;
}

/** The variable pitch table worked out by Defined by: every row's revolutions, height, pitch and diameter. */
export function helixRows(definedBy: HelixDefinedBy, rows: readonly HelixRow[], startDiameter: number): HelixRowValues[] {
    if (rows.length < 2) {
        throw new Error('a variable pitch helix needs at least two rows');
    }
    const out: HelixRowValues[] = [{ revolutions: 0, height: 0, pitch: positive(rows[0].pitch, 'the pitch of row 1'), diameter: startDiameter }];
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const prev = out[i - 1];
        const where = `row ${i + 1}`;
        let { revolutions, height, pitch } = row;
        if (definedBy === 'pitchRevolution') {
            pitch = positive(pitch, `the pitch of ${where}`);
            revolutions = positive(revolutions, `the revolutions of ${where}`);
            if (!(revolutions > prev.revolutions)) {
                throw new Error(`the revolutions of ${where} must be more than the row before's`);
            }
            height = prev.height + ((prev.pitch + pitch) / 2) * (revolutions - prev.revolutions);
        } else if (definedBy === 'heightRevolution') {
            height = positive(height, `the height of ${where}`);
            revolutions = positive(revolutions, `the revolutions of ${where}`);
            if (!(revolutions > prev.revolutions) || !(height > prev.height)) {
                throw new Error(`the revolutions and height of ${where} must be more than the row before's`);
            }
            pitch = (2 * (height - prev.height)) / (revolutions - prev.revolutions) - prev.pitch;
            if (!(pitch > 0)) {
                throw new Error(`the pitch worked out for ${where} is not above 0: more height or fewer revolutions`);
            }
        } else if (definedBy === 'heightPitch') {
            height = positive(height, `the height of ${where}`);
            pitch = positive(pitch, `the pitch of ${where}`);
            if (!(height > prev.height)) {
                throw new Error(`the height of ${where} must be more than the row before's`);
            }
            revolutions = prev.revolutions + (2 * (height - prev.height)) / (prev.pitch + pitch);
        } else {
            throw new Error('variable pitch is for a helix, not a spiral');
        }
        const diameter = row.diameter === undefined ? prev.diameter : positive(row.diameter, `the diameter of ${where}`);
        out.push({ revolutions, height, pitch, diameter });
    }
    return out;
}

/**
 * The curve of a helix or spiral step on its circle (centre and radius in the sketch, on `frame`). Throws a plain
 * message when the settings cannot make a curve.
 */
export function helixShape(o: HelixOptions, circle: { centre: [number, number]; radius: number }, frame: SketchFrame): HelixShape {
    const R = positive(circle.radius, 'the circle\'s radius');
    const spiral = o.definedBy === 'spiral';
    if (!['pitchRevolution', 'heightRevolution', 'heightPitch', 'spiral'].includes(o.definedBy)) {
        throw new Error('defined by must be pitchRevolution, heightRevolution, heightPitch or spiral');
    }
    const startAngle = o.startAngle ?? 0;
    if (!ok(startAngle)) {
        throw new Error('the start angle must be a number');
    }
    const variable = o.variablePitch && o.variablePitch.length > 0 ? o.variablePitch : null;
    const taper = o.taper ?? 0;
    if (!ok(taper) || taper < 0 || taper >= 90) {
        throw new Error('the taper angle must be from 0 up to 90 degrees');
    }
    if (taper > 0 && (spiral || variable)) {
        throw new Error('a taper is only for a constant pitch helix');
    }
    const centre = add(frame.origin, add(scale(frame.u, circle.centre[0]), scale(frame.v, circle.centre[1])));
    const shape = {
        centre, u: frame.u, v: frame.v, axis: scale(frame.normal, o.reverse && !spiral ? -1 : 1),
        start: rad(startAngle), omega: (o.clockwise ? -2 : 2) * Math.PI, spiral, startDiameter: 2 * R,
    };
    const limit = (n: number): number => {
        if (n > MAX_REVOLUTIONS) {
            throw new Error(`a helix may have up to ${MAX_REVOLUTIONS} revolutions`);
        }
        return n;
    };

    if (variable) {
        const rows = helixRows(o.definedBy, variable, 2 * R);
        const t = rows.map((r) => r.revolutions);
        const radii = rows.map((r) => r.diameter / 2);
        const slopes = pchipSlopes(t, radii);
        const pieces = rows.slice(1).map((row, k): HelixPiece => {
            const a = rows[k];
            const h = row.revolutions - a.revolutions;
            const d = (radii[k + 1] - radii[k]) / h;
            return {
                t0: a.revolutions, t1: row.revolutions,
                r: [radii[k], slopes[k], (3 * d - 2 * slopes[k] - slopes[k + 1]) / h, (slopes[k] + slopes[k + 1] - 2 * d) / (h * h)],
                z: [a.height, a.pitch, (row.pitch - a.pitch) / (2 * h)],
            };
        });
        const last = rows[rows.length - 1];
        limit(last.revolutions);
        return { ...shape, pieces, revolutions: last.revolutions, height: last.height, pitch: null, endDiameter: last.diameter, rows };
    }

    let pitch: number;
    let revolutions: number;
    if (o.definedBy === 'heightRevolution') {
        revolutions = positive(o.revolutions, 'revolutions');
        pitch = positive(o.height, 'the height') / revolutions;
    } else if (o.definedBy === 'heightPitch') {
        pitch = positive(o.pitch, 'the pitch');
        revolutions = positive(o.height, 'the height') / pitch;
    } else {
        pitch = positive(o.pitch, 'the pitch');
        revolutions = positive(o.revolutions, 'revolutions');
    }
    limit(revolutions);
    if (spiral) {
        const grow = o.reverse ? -pitch : pitch;
        const end = R + grow * revolutions;
        if (!(end > 1e-6)) {
            throw new Error('the spiral runs into its centre: fewer revolutions or a smaller pitch');
        }
        return {
            ...shape, pieces: [{ t0: 0, t1: revolutions, r: [R, grow, 0, 0], z: [0, 0, 0] }], revolutions, height: 0, pitch,
            endDiameter: 2 * end, rows: null,
        };
    }
    const height = pitch * revolutions;
    const grow = (o.taperOutward ? 1 : -1) * Math.tan(rad(taper)) * pitch;
    const end = R + grow * revolutions;
    if (!(end > 1e-6)) {
        throw new Error('the taper closes the helix before its end: a smaller taper angle or less height');
    }
    return {
        ...shape, pieces: [{ t0: 0, t1: revolutions, r: [R, grow, 0, 0], z: [0, pitch, 0] }], revolutions, height, pitch,
        endDiameter: 2 * end, rows: null,
    };
}

/** The piece the revolution t lies in (the first or last outside the range). */
function pieceAt(s: HelixShape, t: number): HelixPiece {
    for (const p of s.pieces) {
        if (t <= p.t1) {
            return p;
        }
    }
    return s.pieces[s.pieces.length - 1];
}

/** r, r', r'', r''' of a piece at tau. */
function radiusDerivatives(p: HelixPiece, tau: number): [number, number, number, number] {
    const [a0, a1, a2, a3] = p.r;
    return [a0 + tau * (a1 + tau * (a2 + tau * a3)), a1 + tau * (2 * a2 + 3 * a3 * tau), 2 * a2 + 6 * a3 * tau, 6 * a3];
}

const binomial = (n: number, k: number): number => {
    let b = 1;
    for (let i = 1; i <= k; i++) {
        b = (b * (n - k + i)) / i;
    }
    return b;
};

/**
 * The point at revolution t and its derivatives by t up to `order`: [point, d/dt, d2/dt2, ...]. On a row of a
 * variable pitch table, `piece` chooses the side (the piece before or after it).
 */
export function helixDerivatives(s: HelixShape, t: number, order = 0, piece: HelixPiece = pieceAt(s, t)): Vec3[] {
    const tau = t - piece.t0;
    const r = radiusDerivatives(piece, tau);
    const [b0, b1, b2] = piece.z;
    const z = [b0 + tau * (b1 + tau * b2), b1 + 2 * b2 * tau, 2 * b2];
    const angle = s.start + s.omega * t;
    const out: Vec3[] = [];
    for (let k = 0; k <= order; k++) {
        // d^k/dt^k of r e(a) = sum_j C(k, j) r^(j) omega^(k-j) e(a + (k - j) pi / 2), with e(a) = cos a u + sin a v.
        let cu = 0;
        let cv = 0;
        for (let j = 0; j <= Math.min(k, 3); j++) {
            const w = binomial(k, j) * r[j] * s.omega ** (k - j);
            const a = angle + ((k - j) * Math.PI) / 2;
            cu += w * Math.cos(a);
            cv += w * Math.sin(a);
        }
        const zk = k < 3 ? z[k] : 0;
        const p: Vec3 = [
            s.u[0] * cu + s.v[0] * cv + s.axis[0] * zk,
            s.u[1] * cu + s.v[1] * cv + s.axis[1] * zk,
            s.u[2] * cu + s.v[2] * cv + s.axis[2] * zk,
        ];
        out.push(k === 0 ? add(p, s.centre) : p);
    }
    return out;
}

/** The point at revolution t. */
export function helixPoint(s: HelixShape, t: number): Vec3 {
    return helixDerivatives(s, t)[0];
}

/** Speed |d point / dt| at tau within a piece: the radial, turning and rising parts are at right angles. */
function speed(s: HelixShape, p: HelixPiece, tau: number): number {
    const [r, r1] = radiusDerivatives(p, tau);
    const z1 = p.z[1] + 2 * p.z[2] * tau;
    return Math.sqrt(r1 * r1 + r * r * s.omega * s.omega + z1 * z1);
}

const GAUSS = [
    [0, 128 / 225],
    [Math.sqrt(5 - 2 * Math.sqrt(10 / 7)) / 3, (322 + 13 * Math.sqrt(70)) / 900],
    [-Math.sqrt(5 - 2 * Math.sqrt(10 / 7)) / 3, (322 + 13 * Math.sqrt(70)) / 900],
    [Math.sqrt(5 + 2 * Math.sqrt(10 / 7)) / 3, (322 - 13 * Math.sqrt(70)) / 900],
    [-Math.sqrt(5 + 2 * Math.sqrt(10 / 7)) / 3, (322 - 13 * Math.sqrt(70)) / 900],
];

/** Length of the curve, mm (Gauss-Legendre over sixteenths of a turn: exact to rounding). */
export function helixLength(s: HelixShape): number {
    let total = 0;
    for (const p of s.pieces) {
        const span = p.t1 - p.t0;
        const n = Math.max(1, Math.ceil(span * 16));
        const h = span / n;
        for (let i = 0; i < n; i++) {
            const mid = (i + 0.5) * h;
            for (const [x, w] of GAUSS) {
                total += (w * h * speed(s, p, mid + (x * h) / 2)) / 2;
            }
        }
    }
    return total;
}

/** Points along the curve for drawing: `perTurn` a revolution (fewer on very long curves), ends included. */
export function helixPoints(s: HelixShape, perTurn = 72, most = 20000): Vec3[] {
    const count = Math.max(8, Math.min(most, Math.ceil(s.revolutions * perTurn)));
    const out: Vec3[] = [];
    for (let i = 0; i <= count; i++) {
        out.push(helixPoint(s, (s.revolutions * i) / count));
    }
    return out;
}

/** The sketch a helix step is made from, resolved (derived sketches followed), and the steps before that sketch. */
export function helixSketchOf(step: HelixStep, before: readonly Feature[]): { sketch: Sketch; earlier: Feature[] } {
    if (step.sketchRef !== undefined) {
        const at = before.findIndex((f) => f.id === step.sketchRef);
        const found = at >= 0 ? before[at] : undefined;
        if (!found || found.op !== 'sketch') {
            throw new Error(`sketch "${step.sketchRef}" not found (it must be an earlier sketch step of this part)`);
        }
        return { sketch: resolvedSketch(before, at) ?? found.sketch, earlier: before.slice(0, at) };
    }
    if (!step.sketch) {
        throw new Error('needs a sketch or a sketchRef');
    }
    return { sketch: step.sketch, earlier: [...before] };
}

/** The curve of a helix step, its sketch resolved against the steps before it. */
export function helixOfStep(step: HelixStep, before: readonly Feature[]): HelixShape {
    const { sketch, earlier } = helixSketchOf(step, before);
    return helixShape(step, helixCircle(sketch), sketchFrameOf(sketch, earlier));
}

const num = (n: number): string => String(Math.round(n * 1e6) / 1e6);

/** One line about the curve for the history: "Helix · pitch 4 · 10 revolutions · height 40 · clockwise". */
export function helixSummary(o: HelixOptions): string {
    const spiral = o.definedBy === 'spiral';
    const parts: string[] = [spiral ? 'Spiral' : o.taper ? `Tapered helix ${num(o.taper)}°${o.taperOutward ? ' outward' : ''}` : 'Helix'];
    if (o.variablePitch?.length) {
        parts.push(`variable pitch, ${o.variablePitch.length} rows`);
    } else {
        const show = {
            pitchRevolution: ['pitch', 'revolutions'], heightRevolution: ['height', 'revolutions'],
            heightPitch: ['height', 'pitch'], spiral: ['pitch', 'revolutions'],
        }[o.definedBy] ?? [];
        for (const key of show) {
            const value = o[key as 'pitch' | 'revolutions' | 'height'];
            if (ok(value)) {
                parts.push(key === 'revolutions' ? `${num(value)} revolutions` : `${key} ${num(value)}`);
            }
        }
    }
    if (o.reverse) {
        parts.push(spiral ? 'inward' : 'reversed');
    }
    if (o.startAngle) {
        parts.push(`start ${num(o.startAngle)}°`);
    }
    parts.push(o.clockwise ? 'clockwise' : 'counterclockwise');
    return parts.join(' · ');
}
