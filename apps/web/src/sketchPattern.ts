// Linear and circular sketch patterns that stay tied to the original, as in SolidWorks: construction lines join the
// instances (the pattern's skeleton) with one spacing dimension and one angle, and each instance is held to the
// original by relations (equal, parallel), so the instances follow every change to the original and a fully
// defined original gives a fully defined pattern.

import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { AXIS_U, ORIGIN, curveOf, pointOf } from './solver';
import { addConstraint, newId, type NewConstraint } from './sketchGeometry';
import { curvePoints, type EditResult } from './sketchEdit';
import { dist, type Pt } from './sketchMath';

const SAME = 1e-6;

const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : [0, 0];
};

/** Builds up the new geometry: points, curves and relations. */
class Builder {
    constructor(public g: SketchGeometry) {}

    point(at: Pt): string {
        const id = newId('p', this.g);
        this.g = { ...this.g, points: [...this.g.points, { id, u: at[0], v: at[1] }] };
        return id;
    }

    curve(curve: SketchCurve): string {
        this.g = { ...this.g, curves: [...this.g.curves, curve] };
        return curve.id;
    }

    /** A construction line between two existing points. */
    line(a: string, b: string): string {
        return this.curve({ id: newId('c', this.g), kind: 'line', a, b, construction: true });
    }

    add(...list: NewConstraint[]): void {
        for (const c of list) {
            this.g = addConstraint(this.g, c).g;
        }
    }
}

/** How one instance is held to the original: by translation (linear) or by turning about a centre (circular). */
interface Ties {
    /** q is reached along line L from a point already held: L's copy matches L. */
    byLine(b: Builder, lineCopy: string, line: string, q: string, qCopy: string): void;
    /** q held by its offset from the instance's anchor. */
    rigid(b: Builder, q: string, qCopy: string): void;
    /** An arc's last free point: one relation, as the arc already keeps it on its circle. */
    arcEnd(b: Builder, arc: SketchCurve & { kind: 'arc' }, arcCopy: string, q: string, qCopy: string): void;
}

/**
 * Copies the curves to the instance (already placed by `place`) and holds every point of the copy to the original:
 * through lines where it can (each line's copy matches it), else by `ties`. The anchor of the copy is held already.
 */
function instance(b: Builder, seed: SketchGeometry, curves: SketchCurve[], anchor: string, anchorCopy: string,
    place: (p: Pt) => Pt, ties: Ties): string[] {
    const map = new Map<string, string>([[anchor, anchorCopy]]);
    const image = (id: string) => {
        let to = map.get(id);
        if (!to) {
            to = b.point(place(P(seed, id)));
            map.set(id, to);
        }
        return to;
    };
    const created: string[] = [];
    const copyOf = new Map<string, string>();
    for (const c of curves) {
        const id = newId('c', b.g);
        const copy: SketchCurve = c.kind === 'line' ? { ...c, id, a: image(c.a), b: image(c.b) }
            : c.kind === 'circle' ? { ...c, id, center: image(c.center) }
                : { ...c, id, center: image(c.center), start: image(c.start), end: image(c.end) };
        b.curve(copy);
        copyOf.set(c.id, id);
        created.push(id);
    }
    const held = new Set([anchor]);
    const points = [...new Set(curves.flatMap(curvePoints))];
    for (let guard = 0; guard < points.length + 2 && held.size < points.length; guard++) {
        // Along lines from held points.
        let grew = true;
        while (grew) {
            grew = false;
            for (const c of curves) {
                if (c.kind !== 'line' || held.has(c.a) === held.has(c.b)) {
                    continue;
                }
                const q = held.has(c.a) ? c.b : c.a;
                ties.byLine(b, copyOf.get(c.id)!, c.id, q, map.get(q)!);
                held.add(q);
                grew = true;
            }
            for (const c of curves) {
                if (c.kind !== 'arc') {
                    continue;
                }
                const free = [c.center, c.start, c.end].filter((p) => !held.has(p));
                if (free.length === 1 && free[0] === c.center) {
                    // Both ends held: the same radius finds the centre.
                    b.add({ kind: 'equal', a: copyOf.get(c.id)!, b: c.id });
                    held.add(c.center);
                    grew = true;
                } else if (free.length === 1) {
                    ties.arcEnd(b, c, copyOf.get(c.id)!, free[0], map.get(free[0])!);
                    held.add(free[0]);
                    grew = true;
                }
            }
        }
        // A point nothing reaches (another curve's centre, a separate piece): held by its offset from the anchor.
        const next = points.find((p) => !held.has(p));
        if (next) {
            ties.rigid(b, next, map.get(next)!);
            held.add(next);
        }
    }
    for (const c of curves) {
        if (c.kind === 'circle') {
            b.add({ kind: 'equal', a: copyOf.get(c.id)!, b: c.id });
        }
    }
    return created;
}

function seedOf(g: SketchGeometry, curveIds: string[]): { curves: SketchCurve[]; anchor: string } | { error: string } {
    const curves = curveIds.map((id) => curveOf(g, id)).filter((c): c is SketchCurve => !!c);
    if (!curves.length) {
        return { error: 'Select the curves to pattern first.' };
    }
    return { curves, anchor: curvePoints(curves[0])[0] };
}

// ---- Linear -------------------------------------------------------------------------------------------

export interface LinearPatternOptions {
    /** Number of instances along direction 1, the original included. */
    count: number;
    spacing: number;
    /** Direction 1, degrees from the u axis (reverse: add 180). */
    angle: number;
    /** Dimension X spacing: a driving dimension on the spacing (else the spacing is free). */
    dimension?: boolean;
    /** Fix X-axis direction: hold the direction (else it is free to turn). */
    fixDirection?: boolean;
    /** Direction 2: instances (1 = none), spacing and angle in degrees from the u axis. */
    count2?: number;
    spacing2?: number;
    angle2?: number;
    dimension2?: boolean;
    /** Dimension angle between axes (else direction 2 is held at its own angle like direction 1). */
    dimensionAngle?: boolean;
    /** Instances to skip, as [i, j] (i along direction 1, j along direction 2; the original is [0, 0]). */
    skip?: [number, number][];
}

/** Holds a line of the skeleton at a fixed direction from the u axis: horizontal, vertical or an angle dimension. */
function holdDirection(b: Builder, line: string, angle: number): void {
    const a = ((angle % 180) + 180) % 180;
    if (Math.abs(a) < 1e-9 || Math.abs(a - 180) < 1e-9) {
        b.add({ kind: 'horizontal', line });
    } else if (Math.abs(a - 90) < 1e-9) {
        b.add({ kind: 'vertical', line });
    } else {
        b.add({ kind: 'angle', a: AXIS_U, b: line, value: a });
    }
}

/**
 * Linear sketch pattern: `count` instances along direction 1 and `count2` along direction 2. The anchors of the
 * instances (the first point of the first curve) are joined by construction lines: the first of each direction
 * carries the spacing dimension and the direction, the others are parallel and equal to it. Each instance is held
 * to the original by equal and parallel relations.
 */
export function linearSketchPattern(g: SketchGeometry, curveIds: string[], o: LinearPatternOptions): EditResult & { created?: string[] } {
    const seed = seedOf(g, curveIds);
    if ('error' in seed) {
        return seed;
    }
    const n1 = Math.round(o.count);
    const n2 = Math.max(1, Math.round(o.count2 ?? 1));
    if (!(n1 >= 1) || n1 * n2 < 2) {
        return { error: 'The number of instances must be 2 or more.' };
    }
    if ((n1 > 1 && !(Math.abs(o.spacing) > 1e-9)) || (n2 > 1 && !(Math.abs(o.spacing2 ?? 0) > 1e-9))) {
        return { error: 'The spacing cannot be zero.' };
    }
    const rad = (d: number) => (d * Math.PI) / 180;
    const d1: Pt = [Math.cos(rad(o.angle)) * o.spacing, Math.sin(rad(o.angle)) * o.spacing];
    const d2: Pt = [Math.cos(rad(o.angle2 ?? 90)) * (o.spacing2 ?? 0), Math.sin(rad(o.angle2 ?? 90)) * (o.spacing2 ?? 0)];
    if (n2 > 1 && Math.abs(d1[0] * d2[1] - d1[1] * d2[0]) < 1e-9 * Math.hypot(...d1) * Math.hypot(...d2)) {
        return { error: 'The two directions cannot be parallel.' };
    }
    const b = new Builder(g);
    const { curves, anchor } = seed;
    const a0 = P(g, anchor);
    const skip = new Set((o.skip ?? []).map(([i, j]) => `${i},${j}`));
    // Skeleton: anchor points of every instance (skipped ones too, so the spacing chain stays whole).
    const anchors: string[][] = [];
    for (let j = 0; j < n2; j++) {
        anchors.push([]);
        for (let i = 0; i < n1; i++) {
            anchors[j].push(i === 0 && j === 0 ? anchor : b.point([a0[0] + d1[0] * i + d2[0] * j, a0[1] + d1[1] * i + d2[1] * j]));
        }
    }
    let first1: string | null = null;
    let first2: string | null = null;
    if (n1 > 1) {
        first1 = b.line(anchors[0][0], anchors[0][1]);
        if (o.dimension !== false) {
            b.add({ kind: 'length', line: first1, value: Math.abs(o.spacing) });
        }
        if (o.fixDirection !== false) {
            holdDirection(b, first1, o.angle);
        }
    }
    if (n2 > 1) {
        first2 = b.line(anchors[0][0], anchors[1][0]);
        if (o.dimension2 !== false) {
            b.add({ kind: 'length', line: first2, value: Math.abs(o.spacing2!) });
        }
        if (first1 && o.dimensionAngle !== false) {
            const between = Math.abs((((o.angle2 ?? 90) - o.angle) % 180 + 180) % 180);
            b.add(Math.abs(between - 90) < 1e-9 ? { kind: 'perpendicular', a: first1, b: first2 } : { kind: 'angle', a: first1, b: first2, value: between });
        } else if (o.fixDirection !== false) {
            holdDirection(b, first2, o.angle2 ?? 90);
        }
    }
    for (let j = 0; j < n2; j++) {
        for (let i = 0; i < n1; i++) {
            if ((i === 0 && j === 0) || (i === 1 && j === 0) || (i === 0 && j === 1)) {
                continue;
            }
            // Down the first column along direction 2, then along each row in direction 1.
            const [from, ref] = i === 0 ? [anchors[j - 1][0], first2!] : [anchors[j][i - 1], first1!];
            const step = b.line(from, anchors[j][i]);
            b.add({ kind: 'parallel', a: step, b: ref }, { kind: 'equal', a: step, b: ref });
        }
    }
    const rigid = new Map<string, string>();
    const ties = (anchorCopy: string): Ties => ({
        byLine: (bb, lineCopy, line) => bb.add({ kind: 'parallel', a: lineCopy, b: line }, { kind: 'equal', a: lineCopy, b: line }),
        rigid: (bb, q, qCopy) => {
            if (dist(P(g, q), a0) < SAME) {
                bb.add({ kind: 'coincident', a: qCopy, b: anchorCopy });
                return;
            }
            const ref = rigid.get(q) ?? bb.line(anchor, q);
            rigid.set(q, ref);
            const tie = bb.line(anchorCopy, qCopy);
            bb.add({ kind: 'parallel', a: tie, b: ref }, { kind: 'equal', a: tie, b: ref });
        },
        arcEnd: (bb, arc, arcCopy, q, qCopy) => {
            // The direction from the arc's centre to the end, as on the original.
            const key = `${arc.id}:${q}`;
            const ref = rigid.get(key) ?? bb.line(arc.center, q);
            rigid.set(key, ref);
            const copy = curveOf(bb.g, arcCopy) as SketchCurve & { kind: 'arc' };
            bb.add({ kind: 'parallel', a: bb.line(copy.center, qCopy), b: ref });
        },
    });
    const created: string[] = [];
    for (let j = 0; j < n2; j++) {
        for (let i = 0; i < n1; i++) {
            if ((i === 0 && j === 0) || skip.has(`${i},${j}`)) {
                continue;
            }
            const by: Pt = [d1[0] * i + d2[0] * j, d1[1] * i + d2[1] * j];
            created.push(...instance(b, g, curves, anchor, anchors[j][i], (p) => [p[0] + by[0], p[1] + by[1]], ties(anchors[j][i])));
        }
    }
    return { g: b.g, created };
}

// ---- Circular -----------------------------------------------------------------------------------------

export interface CircularPatternOptions {
    count: number;
    /** Degrees, counter-clockwise (negative: reverse). With equal spacing the total angle, else the step. */
    angle: number;
    equal?: boolean;
    /** The centre: a point id, or a position (a new point is made there, dimensioned to the origin). */
    centre: string | Pt;
    /** Dimension radius: the distance from the centre to the original's anchor. */
    dimensionRadius?: boolean;
    /** Dimension angular spacing: an angle dimension between the first two instances (else free). */
    dimensionAngle?: boolean;
    /** Instances to skip (1 .. count-1; the original is 0). */
    skip?: number[];
}

/**
 * Circular sketch pattern about a centre. Construction spokes join the centre to each instance's anchor, all equal,
 * with equal chords between neighbours and one angle dimension between the first two, so the spacing is one value.
 * Each point of an instance keeps its distances from the centre and from the instance's anchor.
 */
export function circularSketchPattern(g: SketchGeometry, curveIds: string[], o: CircularPatternOptions): EditResult & { created?: string[] } {
    const seed = seedOf(g, curveIds);
    if ('error' in seed) {
        return seed;
    }
    const n = Math.round(o.count);
    if (!(n >= 2)) {
        return { error: 'The number of instances must be 2 or more.' };
    }
    if (Math.abs(o.angle) < 1e-9) {
        return { error: 'The angle cannot be zero.' };
    }
    const full = Math.abs(Math.abs(o.angle) - 360) < 1e-9;
    const equal = o.equal !== false;
    const stepDeg = equal ? o.angle / (full ? n : n - 1) : o.angle;
    const step = (stepDeg * Math.PI) / 180;
    const b = new Builder(g);
    let centre: string;
    if (typeof o.centre === 'string') {
        centre = o.centre;
    } else {
        const at = o.centre;
        const known = g.points.find((p) => dist([p.u, p.v], at) < SAME)?.id ?? (dist(at, [0, 0]) < SAME ? ORIGIN : null);
        if (known) {
            centre = known;
        } else {
            // A new centre point, placed by its distances along the axes from the origin.
            centre = b.point(at);
            for (const [axis, value] of [['u', at[0]], ['v', at[1]]] as const) {
                b.add(Math.abs(value) < SAME
                    ? { kind: 'pointOnCurve', point: centre, curve: axis === 'u' ? 'axis-v' : 'axis-u' }
                    : { kind: 'distance', a: ORIGIN, b: centre, value: Math.abs(value), axis });
            }
        }
    }
    const c = P(b.g, centre);
    const { curves, anchor } = seed;
    if (dist(P(g, anchor), c) < SAME) {
        return { error: 'The centre cannot be on the first point of the pattern.' };
    }
    const turn = (k: number) => (p: Pt): Pt => {
        const a = step * k;
        const [x, y] = [p[0] - c[0], p[1] - c[1]];
        return [c[0] + x * Math.cos(a) - y * Math.sin(a), c[1] + x * Math.sin(a) + y * Math.cos(a)];
    };
    const anchors = [anchor, ...Array.from({ length: n - 1 }, (_, k) => b.point(turn(k + 1)(P(g, anchor))))];
    const spokes = anchors.map((a) => b.line(centre, a));
    if (o.dimensionRadius) {
        b.add({ kind: 'length', line: spokes[0], value: dist(c, P(g, anchor)) });
    }
    const angleValue = Math.abs(stepDeg) % 360;
    if (o.dimensionAngle !== false) {
        const a = angleValue > 180 ? 360 - angleValue : angleValue;
        b.add({ kind: 'angle', a: spokes[0], b: spokes[1], value: a });
    }
    let chord: string | null = null;
    for (let k = 1; k < n; k++) {
        b.add({ kind: 'equal', a: spokes[k], b: spokes[0] });
        const link = b.line(anchors[k - 1], anchors[k]);
        if (chord) {
            b.add({ kind: 'equal', a: link, b: chord });
        }
        chord ??= link;
    }
    // Each instance turns with a frame: its spoke and a construction line square to it at the anchor, as long. A point
    // is held by its distances from two of the centre, the anchor and the frame's end (whichever two it is not in line
    // with), or from the point it is reached from along a line and one of those.
    const a0 = P(g, anchor);
    const across: Pt = [-(a0[1] - c[1]), a0[0] - c[0]];
    const frames = anchors.map((a, k) => {
        const f = b.point(turn(k)([a0[0] + across[0], a0[1] + across[1]]));
        const line = b.line(a, f);
        b.add({ kind: 'perpendicular', a: line, b: spokes[k] }, { kind: 'equal', a: line, b: spokes[0] });
        return f;
    });
    const seedLine = new Map<string, string>();
    /** q held at its original distance from the reference point (`ref` on the original, `refCopy` on the instance). */
    const distance = (ref: string, refCopy: string, q: string, qCopy: string) => {
        if (dist(P(b.g, ref), P(g, q)) < SAME) {
            b.add({ kind: 'coincident', a: qCopy, b: refCopy });
            return;
        }
        const key = `${ref}>${q}`;
        const original = seedLine.get(key) ?? b.line(ref, q);
        seedLine.set(key, original);
        b.add({ kind: 'equal', a: b.line(refCopy, qCopy), b: original });
    };
    /** How far q is from being in line with the two references (larger is better). */
    const spread = (q: Pt, x: Pt, y: Pt) => Math.abs((x[0] - q[0]) * (y[1] - q[1]) - (x[1] - q[1]) * (y[0] - q[0])) / ((dist(q, x) * dist(q, y)) || 1);
    const refs = (k: number) => [{ ref: centre, copy: centre }, { ref: anchor, copy: anchors[k] }, { ref: frames[0], copy: frames[k] }];
    /** q held by its distance from `held` (already done, unless null) and from the best other reference. */
    const hold = (k: number, held: string | null, q: string, qCopy: string) => {
        const at = P(g, q);
        const options = refs(k);
        if (held) {
            const best = options.reduce((x, y) => (spread(at, P(b.g, y.ref), P(g, held)) > spread(at, P(b.g, x.ref), P(g, held)) ? y : x));
            distance(best.ref, best.copy, q, qCopy);
            return;
        }
        const coincident = options.find((r) => dist(P(b.g, r.ref), at) < SAME);
        if (coincident) {
            b.add({ kind: 'coincident', a: qCopy, b: coincident.copy });
            return;
        }
        const pairs = [[0, 1], [0, 2], [1, 2]].map(([i, j]) => [options[i], options[j]]);
        const [x, y] = pairs.reduce((p, r) => (spread(at, P(b.g, r[0].ref), P(b.g, r[1].ref)) > spread(at, P(b.g, p[0].ref), P(b.g, p[1].ref)) ? r : p));
        distance(x.ref, x.copy, q, qCopy);
        distance(y.ref, y.copy, q, qCopy);
    };
    const skip = new Set(o.skip ?? []);
    const created: string[] = [];
    for (let k = 1; k < n; k++) {
        if (skip.has(k)) {
            continue;
        }
        const ties: Ties = {
            byLine: (bb, lineCopy, line, q, qCopy) => {
                bb.add({ kind: 'equal', a: lineCopy, b: line });
                const l = curveOf(g, line) as SketchCurve & { kind: 'line' };
                hold(k, l.a === q ? l.b : l.a, q, qCopy);
            },
            rigid: (_bb, q, qCopy) => hold(k, null, q, qCopy),
            // The arc keeps the end at its radius from its centre.
            arcEnd: (_bb, arc, _arcCopy, q, qCopy) => hold(k, arc.center, q, qCopy),
        };
        created.push(...instance(b, g, curves, anchor, anchors[k], turn(k), ties));
    }
    return { g: b.g, created };
}
