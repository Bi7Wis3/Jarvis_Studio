// Pure sketch geometry: entities drawn in the sketcher, their conversion to and from the core `Sketch`,
// closed-profile detection and the plane mapping. All coordinates are sketch (u, v) in mm.

import type { Feature, Sketch, SketchPlane, SketchPlaneName, SketchProfile, SketchSegment, Vec3 } from '@jarvis/core';
import { resolvePlane } from '@jarvis/core/reference';
import { ellipseAxes, ellipsePoints, reverseSegment, segmentMiddle, segmentPoints } from '@jarvis/core/curves';

export type Pt = [number, number];

export type Entity =
    | { id: string; kind: 'line'; a: Pt; b: Pt }
    | { id: string; kind: 'arc'; a: Pt; b: Pt; m: Pt }
    | { id: string; kind: 'rect'; a: Pt; b: Pt; radius?: number }
    | { id: string; kind: 'circle'; c: Pt; r: number }
    | { id: string; kind: 'slot'; a: Pt; b: Pt; r: number }
    | { id: string; kind: 'polygon'; points: Pt[] }
    /** Ellipse: centre, the end of one axis and the other radius. */
    | { id: string; kind: 'ellipse'; c: Pt; major: Pt; minor: number }
    /** Partial ellipse, spline, parabola or conic from a to b: `seg` is its exact path segment, `m` a point halfway. */
    | { id: string; kind: 'curve'; a: Pt; b: Pt; m: Pt; seg: SketchSegment };

/** An entity before it gets its id. */
export type NewEntity = Entity extends infer E ? (E extends Entity ? Omit<E, 'id'> : never) : never;

const EPS = 1e-3;

export const dist = (p: Pt, q: Pt): number => Math.hypot(q[0] - p[0], q[1] - p[1]);
export const mid = (p: Pt, q: Pt): Pt => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
export const same = (p: Pt, q: Pt): boolean => dist(p, q) < EPS;
/** Rounds to a step (default 0.000001 mm). Decimal steps divide by a whole number, so 12.3 stays 12.3 as text. */
export const round = (n: number, step = 1e-6): number => {
    const per = Math.round(1 / step);
    return (per >= 1 && Math.abs(per * step - 1) < 1e-9 ? Math.round(n * per) / per : Math.round(n / step) * step) + 0;
};
/** Rounding for values read off the drawn model (its mesh is good to about this). */
export const PICKED = 1e-4;

// ---- Planes -------------------------------------------------------------------------------------------

/** Axes of a named sketch plane in the part frame: u, v and the normal (u × v), per the core documentation. */
export function planeAxes(plane: SketchPlaneName): { u: Vec3; v: Vec3; n: Vec3 } {
    switch (plane) {
        case 'top':
            return { u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] };
        case 'front':
            return { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
        case 'right':
            return { u: [0, 0, -1], v: [0, 1, 0], n: [1, 0, 0] };
    }
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
function unit(a: Vec3): Vec3 {
    const l = Math.hypot(...a) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
}
const clean = (a: Vec3): Vec3 => a.map((x) => round(x, 1e-6)) as Vec3;

/**
 * Full frame of any sketch plane in the part frame: origin (offset applied), u, v and normal, with v = normal × u.
 * Custom planes have their xDir made perpendicular to the normal.
 */
export function planeFrame(plane: SketchPlane, offset = 0, features: Feature[] = []): { origin: Vec3; u: Vec3; v: Vec3; n: Vec3 } {
    if (typeof plane === 'string') {
        const a = planeAxes(plane);
        return { origin: scale(a.n, offset), ...a };
    }
    if ('planeRef' in plane) {
        // A construction plane step of the part: resolved against the steps before the sketch.
        try {
            return planeFrame(resolvePlane(plane, features), offset);
        } catch {
            return planeFrame('top', offset);
        }
    }
    const n = unit(plane.normal);
    const u = unit(add(plane.xDir, scale(n, -dot(plane.xDir, n))));
    return { origin: add(plane.origin, scale(n, offset)), u, v: cross(n, u), n };
}

/** Part-frame point of sketch point (u, v) on a plane at `offset`. */
export function toPartFrame(plane: SketchPlane, offset: number, [u, v]: Pt, features: Feature[] = []): Vec3 {
    const f = planeFrame(plane, offset, features);
    return [0, 1, 2].map((i) => f.origin[i] + f.u[i] * u + f.v[i] * v) as Vec3;
}

/** A sensible sketch x direction for a face normal: horizontal (so the sketch's v is "up") unless the face is level. */
export function xDirFor(normal: Vec3): Vec3 {
    const n = unit(normal);
    if (Math.abs(n[1]) < 0.9) {
        return clean(unit(cross([0, 1, 0], n)));
    }
    // Level faces: the part's +X projected onto the plane.
    return clean(unit(add([1, 0, 0], scale(n, -n[0]))));
}

const ALIGNED = Math.cos((0.5 * Math.PI) / 180);

/**
 * The sketch plane for a face with part-frame `normal` through part-frame `point`. Faces parallel to top/front/right
 * keep the named plane with an offset; any other angle gets a custom plane through the projected part origin.
 * `tangent` (curved faces): a custom plane through the clicked point itself.
 */
export function planeForFace(normal: Vec3, point: Vec3, tangent = false): { plane: SketchPlane; offset: number } {
    const n = unit(normal);
    if (!tangent) {
        const [x, y, z] = n.map(Math.abs);
        if (y >= ALIGNED) {
            return { plane: 'top', offset: round(point[1], PICKED) };
        }
        if (z >= ALIGNED) {
            return { plane: 'front', offset: round(point[2], PICKED) };
        }
        if (x >= ALIGNED) {
            return { plane: 'right', offset: round(point[0], PICKED) };
        }
    }
    // Through the part origin's projection (planar faces) so dimensions to the sketch origin mean something.
    const origin = tangent ? point : scale(n, dot(n, point));
    return { plane: { origin: clean(origin), normal: clean(n), xDir: xDirFor(n) }, offset: 0 };
}

/** Rotates vector x about unit axis k by `deg` degrees (Rodrigues). */
function rotate(x: Vec3, k: Vec3, deg: number): Vec3 {
    const t = (deg * Math.PI) / 180;
    return add(add(scale(x, Math.cos(t)), scale(cross(k, x), Math.sin(t))), scale(k, dot(k, x) * (1 - Math.cos(t))));
}

/** A construction plane: a named plane turned about its own u or v axis by `angle` degrees. */
export function angledPlane(base: SketchPlaneName, axis: 'u' | 'v', angle: number): SketchPlane {
    if (Math.abs(angle % 360) < 1e-9) {
        return base;
    }
    const a = planeAxes(base);
    const k = axis === 'u' ? a.u : a.v;
    return { origin: [0, 0, 0], normal: clean(rotate(a.n, k, angle)), xDir: clean(axis === 'u' ? a.u : rotate(a.u, k, angle)) };
}

/** Short name of a plane for labels: top, front, right, or "plane". */
export function planeLabel(plane: SketchPlane): string {
    return typeof plane === 'string' ? plane : 'planeRef' in plane ? plane.planeRef : 'plane';
}

// ---- Arcs ---------------------------------------------------------------------------------------------

/** Circle through three points, or null when they are (nearly) collinear. */
export function circleThrough(a: Pt, m: Pt, b: Pt): { c: Pt; r: number } | null {
    const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
    if (Math.abs(d) < 1e-9) {
        return null;
    }
    const a2 = a[0] ** 2 + a[1] ** 2;
    const m2 = m[0] ** 2 + m[1] ** 2;
    const b2 = b[0] ** 2 + b[1] ** 2;
    const c: Pt = [
        (a2 * (m[1] - b[1]) + m2 * (b[1] - a[1]) + b2 * (a[1] - m[1])) / d,
        (a2 * (b[0] - m[0]) + m2 * (a[0] - b[0]) + b2 * (m[0] - a[0])) / d,
    ];
    return { c, r: dist(c, a) };
}

/** Points along the arc from a through m to b (a straight line when collinear). */
export function arcPoints(a: Pt, m: Pt, b: Pt, steps = 48): Pt[] {
    const circle = circleThrough(a, m, b);
    if (!circle) {
        return [a, b];
    }
    const { c, r } = circle;
    const angle = (p: Pt) => Math.atan2(p[1] - c[1], p[0] - c[0]);
    const start = angle(a);
    const norm = (t: number) => ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    let sweep = norm(angle(b) - start);
    // Counter-clockwise from a to b unless m lies outside that sweep.
    if (norm(angle(m) - start) > sweep) {
        sweep -= 2 * Math.PI;
    }
    const out: Pt[] = [];
    for (let i = 0; i <= steps; i++) {
        const t = start + (sweep * i) / steps;
        out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
    }
    return out;
}

/** A point on the arc halfway between its ends, used as the `through` point. */
export function arcMidpoint(a: Pt, m: Pt, b: Pt): Pt {
    const points = arcPoints(a, m, b, 2);
    return points[1];
}

// ---- Entities -----------------------------------------------------------------------------------------

function circlePoints(c: Pt, r: number, steps = 64): Pt[] {
    return Array.from({ length: steps + 1 }, (_, i) => {
        const t = (i / steps) * 2 * Math.PI;
        return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as Pt;
    });
}

function slotPoints(a: Pt, b: Pt, r: number): Pt[] {
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const out: Pt[] = [];
    const cap = (c: Pt, from: number) => {
        for (let i = 0; i <= 24; i++) {
            const t = from + (i / 24) * Math.PI;
            out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
        }
    };
    cap(b, angle - Math.PI / 2);
    cap(a, angle + Math.PI / 2);
    out.push(out[0]);
    return out;
}

export function rectCorners(a: Pt, b: Pt): Pt[] {
    return [a, [b[0], a[1]], b, [a[0], b[1]]];
}

/** Polyline to draw an entity with. */
export function entityPoints(e: Entity): Pt[] {
    switch (e.kind) {
        case 'line':
            return [e.a, e.b];
        case 'arc':
            return arcPoints(e.a, e.m, e.b);
        case 'rect': {
            const corners = rectCorners(e.a, e.b);
            return [...corners, corners[0]];
        }
        case 'circle':
            return circlePoints(e.c, e.r);
        case 'slot':
            return slotPoints(e.a, e.b, e.r);
        case 'polygon':
            return [...e.points, e.points[0]];
        case 'ellipse':
            return ellipsePoints(ellipseAxes(e.c, e.major, e.minor));
        case 'curve':
            return [e.a, ...segmentPoints(e.a, e.seg, 64)];
    }
}

/** A curve entity from its exact segment. */
export function curveEntity(id: string, a: Pt, seg: SketchSegment): Extract<Entity, { kind: 'curve' }> {
    return { id, kind: 'curve', a, b: seg.to, m: segmentMiddle(a, seg), seg };
}

function segmentDistance(p: Pt, a: Pt, b: Pt): number {
    const l2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l2));
    return dist(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
}

/** Distance from a point to an entity's outline, for picking. */
export function entityDistance(e: Entity, p: Pt): number {
    if (e.kind === 'circle') {
        return Math.abs(dist(p, e.c) - e.r);
    }
    const points = entityPoints(e);
    let best = Infinity;
    for (let i = 1; i < points.length; i++) {
        best = Math.min(best, segmentDistance(p, points[i - 1], points[i]));
    }
    return best;
}

/** Regular polygon around `c` with one vertex at `vertex`. */
export function regularPolygon(c: Pt, vertex: Pt, sides: number): Pt[] {
    const r = dist(c, vertex);
    const start = Math.atan2(vertex[1] - c[1], vertex[0] - c[0]);
    return Array.from({ length: sides }, (_, i) => {
        const t = start + (i / sides) * 2 * Math.PI;
        return [round(c[0] + r * Math.cos(t)), round(c[1] + r * Math.sin(t))] as Pt;
    });
}

// ---- Profiles -----------------------------------------------------------------------------------------

type Chainable = Extract<Entity, { kind: 'line' | 'arc' | 'curve' }>;

/** Closed loops formed by lines and arcs, as `path` profiles; open chains are reported separately. */
function chainLoops(segments: Chainable[]): { profiles: SketchProfile[]; open: number } {
    const unused = new Set(segments);
    const profiles: SketchProfile[] = [];
    let open = 0;
    while (unused.size) {
        const first = unused.values().next().value!;
        unused.delete(first);
        const start = first.a;
        const out: SketchSegment[] = [toSegment(first, false)];
        let end = first.b;
        let closed = same(end, start);
        while (!closed) {
            let next: Chainable | null = null;
            let reversed = false;
            for (const s of unused) {
                if (same(s.a, end)) {
                    next = s;
                    break;
                }
                if (same(s.b, end)) {
                    next = s;
                    reversed = true;
                    break;
                }
            }
            if (!next) {
                break;
            }
            unused.delete(next);
            out.push(toSegment(next, reversed));
            end = reversed ? next.a : next.b;
            closed = same(end, start);
        }
        if (closed) {
            const last = out[out.length - 1];
            last.to = start;
            profiles.push({ kind: 'path', start, segments: out });
        } else {
            open += 1;
        }
    }
    return { profiles, open };
}

export function toSegment(s: Chainable, reversed: boolean): SketchSegment {
    const to = reversed ? s.a : s.b;
    if (s.kind === 'curve') {
        return reversed ? reverseSegment(s.a, s.seg) : s.seg;
    }
    return s.kind === 'line' ? { kind: 'line', to } : { kind: 'arc', to, through: arcMidpoint(s.a, s.m, s.b) };
}

/** The closed profiles of the drawn entities, and how many line/arc chains are still open. */
export function entitiesToProfiles(entities: Entity[]): { profiles: SketchProfile[]; open: number } {
    const profiles: SketchProfile[] = [];
    const chainable: Chainable[] = [];
    for (const e of entities) {
        switch (e.kind) {
            case 'line':
            case 'arc':
            case 'curve':
                chainable.push(e);
                break;
            case 'ellipse':
                if (e.minor > EPS && dist(e.c, e.major) > EPS) {
                    const axes = ellipseAxes(e.c, e.major, e.minor);
                    const major: Pt = [e.c[0] + axes.a * Math.cos(axes.angle), e.c[1] + axes.a * Math.sin(axes.angle)];
                    profiles.push({ kind: 'ellipse', center: e.c, major, minor: axes.b });
                }
                break;
            case 'rect': {
                const width = Math.abs(e.b[0] - e.a[0]);
                const height = Math.abs(e.b[1] - e.a[1]);
                if (width > EPS && height > EPS) {
                    profiles.push({ kind: 'rect', center: mid(e.a, e.b), width, height, ...(e.radius ? { radius: e.radius } : {}) });
                }
                break;
            }
            case 'circle':
                if (e.r > EPS) {
                    profiles.push({ kind: 'circle', center: e.c, radius: e.r });
                }
                break;
            case 'slot':
                profiles.push({ kind: 'slot', from: e.a, to: e.b, radius: e.r });
                break;
            case 'polygon':
                profiles.push({ kind: 'polygon', points: e.points });
                break;
        }
    }
    const loops = chainLoops(chainable);
    return { profiles: [...profiles, ...loops.profiles], open: loops.open };
}

let nextId = 1;
export const entityId = (): string => `e${nextId++}`;

/** Entities to edit an existing sketch with. */
export function sketchToEntities(sketch: Sketch): Entity[] {
    const out: Entity[] = [];
    for (const p of sketch.profiles) {
        switch (p.kind) {
            case 'rect':
                out.push({
                    id: entityId(), kind: 'rect',
                    a: [p.center[0] - p.width / 2, p.center[1] - p.height / 2],
                    b: [p.center[0] + p.width / 2, p.center[1] + p.height / 2],
                    ...(p.radius ? { radius: p.radius } : {}),
                });
                break;
            case 'circle':
                out.push({ id: entityId(), kind: 'circle', c: p.center, r: p.radius });
                break;
            case 'slot':
                out.push({ id: entityId(), kind: 'slot', a: p.from, b: p.to, r: p.radius });
                break;
            case 'polygon':
                out.push({ id: entityId(), kind: 'polygon', points: p.points });
                break;
            case 'ellipse':
                out.push({ id: entityId(), kind: 'ellipse', c: p.center, major: p.major, minor: p.minor });
                break;
            case 'path': {
                let at = p.start;
                for (const s of p.segments) {
                    out.push(s.kind === 'line'
                        ? { id: entityId(), kind: 'line', a: at, b: s.to }
                        : s.kind === 'arc' ? { id: entityId(), kind: 'arc', a: at, b: s.to, m: s.through } : curveEntity(entityId(), at, s));
                    at = s.to;
                }
                if (!same(at, p.start)) {
                    out.push({ id: entityId(), kind: 'line', a: at, b: p.start });
                }
                break;
            }
        }
    }
    return out;
}

/** Outline of a profile as points, for shading and previews. */
export function profilePoints(p: SketchProfile): Pt[] {
    switch (p.kind) {
        case 'rect':
            return rectCorners([p.center[0] - p.width / 2, p.center[1] - p.height / 2],
                [p.center[0] + p.width / 2, p.center[1] + p.height / 2]);
        case 'circle':
            return circlePoints(p.center, p.radius).slice(0, -1);
        case 'slot':
            return slotPoints(p.from, p.to, p.radius).slice(0, -1);
        case 'polygon':
            return p.points;
        case 'ellipse':
            return ellipsePoints(ellipseAxes(p.center, p.major, p.minor)).slice(0, -1);
        case 'path': {
            const out: Pt[] = [p.start];
            let at = p.start;
            for (const s of p.segments) {
                if (s.kind === 'line') {
                    out.push(s.to);
                } else if (s.kind === 'arc') {
                    out.push(...arcPoints(at, s.through, s.to, 32).slice(1));
                } else {
                    out.push(...segmentPoints(at, s, 48));
                }

                at = s.to;
            }
            return out;
        }
    }
}

export function area(points: Pt[]): number {
    let a = 0;
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const q = points[(i + 1) % points.length];
        a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
}

export function inside(p: Pt, polygon: Pt[]): boolean {
    let hit = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i];
        const [xj, yj] = polygon[j];
        if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
            hit = !hit;
        }
    }
    return hit;
}

/**
 * Profiles arranged as solids with holes, as the kernel builds them: a profile inside another is a hole,
 * one inside a hole is an island again.
 */
export function nestProfiles(profiles: SketchProfile[]): { outer: Pt[]; holes: Pt[][] }[] {
    const loops = profiles.map((p) => {
        const points = profilePoints(p);
        const us = points.map((q) => q[0]);
        const vs = points.map((q) => q[1]);
        // Its bounds: a point outside them is outside it, without the full test.
        const box = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
        return { points, box, size: Math.abs(area(points)), parent: -1, depth: 0 };
    });
    const inBox = (p: Pt, b: number[]) => p[0] >= b[0] && p[0] <= b[1] && p[1] >= b[2] && p[1] <= b[3];
    loops.forEach((loop, i) => {
        let best = -1;
        loops.forEach((other, j) => {
            if (i !== j && other.size > loop.size && inBox(loop.points[0], other.box) && inside(loop.points[0], other.points)
                && (best < 0 || other.size < loops[best].size)) {
                best = j;
            }
        });
        loop.parent = best;
    });
    const depth = (i: number): number => (loops[i].parent < 0 ? 0 : 1 + depth(loops[i].parent));
    return loops
        .map((loop, i) => ({ loop, i }))
        .filter(({ i }) => depth(i) % 2 === 0)
        .map(({ loop, i }) => ({ outer: loop.points, holes: loops.filter((l) => l.parent === i).map((l) => l.points) }));
}
