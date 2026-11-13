// Closed regions of a sketch treated as a planar graph: sketch points are vertices, lines and arcs are edges.
// Curves on no cycle (dangling chains, bridges) are open. Every 2-connected block that is a plain loop becomes a
// profile exactly as the simple chaining in sketchMath makes it; a block with shared edges, T-junctions or
// dividing lines becomes its outer boundary (the union of its regions). Curves that cross without a shared
// point are not split: the graph only knows the points the curves end at.

import type { SketchProfile, SketchRegion, SketchSegment } from '@jarvis/core';
import { area, circleThrough, dist, entitiesToProfiles, inside, profilePoints, type Entity, type Pt } from './sketchMath';

type Curve = Extract<Entity, { kind: 'line' | 'arc' }>;

/** Points closer than this (mm) are one vertex even when they are different sketch points. */
const MERGE = 1e-3;

/**
 * Closed profiles of the entities and the number of lines and arcs that are on no closed region.
 * `ends` gives the sketch point ids at the start and end of each line/arc (by entity id); curves ending at the
 * same point id share a vertex. Circles and other closed entities are profiles on their own.
 */
export function regionProfiles(entities: Entity[], ends: Map<string, [string, string]> = new Map()): { profiles: SketchProfile[]; open: number } {
    const { curves, vertex, others } = graphOf(entities, ends);
    let open = 0;
    const found: { first: number; profiles: SketchProfile[] }[] = [];
    for (const block of blocks(vertex)) {
        if (block.length === 1 && vertex[block[0]][0] !== vertex[block[0]][1]) {
            open += 1;
            continue;
        }
        block.sort((a, b) => a - b);
        const profiles = isCycle(block, vertex)
            ? entitiesToProfiles(block.map((i) => curves[i])).profiles
            : [outerBoundary(block.map((i) => curves[i]), block.map((i) => vertex[i]))];
        found.push({ first: block[0], profiles });
    }
    // Same order as before: closed entities first, then loops by their first curve.
    found.sort((a, b) => a.first - b.first);
    return { profiles: [...entitiesToProfiles(others).profiles, ...found.flatMap((f) => f.profiles)], open };
}

/**
 * The open chains of the entities: lines and arcs on no closed region, joined end to end into `path` profiles
 * that are not closed back to their start (a sweep path, a guide). A chain ends where it stops or branches.
 * Ordered by their first curve; arguments as for regionProfiles.
 */
export function openChains(entities: Entity[], ends: Map<string, [string, string]> = new Map()): SketchProfile[] {
    const { curves, vertex } = graphOf(entities, ends);
    const open = blocks(vertex).filter((b) => b.length === 1 && vertex[b[0]][0] !== vertex[b[0]][1]).map((b) => b[0]);
    const at = new Map<number, number[]>();
    for (const i of open) {
        for (const v of vertex[i]) {
            at.set(v, [...(at.get(v) ?? []), i]);
        }
    }
    const used = new Set<number>();
    const chains: { first: number; profile: SketchProfile }[] = [];
    const walk = (start: number, first: number): void => {
        const point = (v: number, i: number): Pt => (vertex[i][0] === v ? curves[i].a : curves[i].b);
        const segments: SketchSegment[] = [];
        let v = start;
        let i = first;
        const from = point(v, i);
        const members: number[] = [];
        for (;;) {
            used.add(i);
            members.push(i);
            const next = vertex[i][0] === v ? vertex[i][1] : vertex[i][0];
            const c = curves[i];
            const to = point(next, i);
            segments.push(c.kind === 'line' ? { kind: 'line', to } : { kind: 'arc', to, through: c.m });
            v = next;
            const onward = at.get(v) ?? [];
            if (onward.length !== 2) {
                break;
            }
            const k = onward.find((j) => j !== i)!;
            if (used.has(k)) {
                break;
            }
            i = k;
        }
        chains.push({ first: Math.min(...members), profile: { kind: 'path', start: from, segments } });
    };
    // From each end or branch point first, then (nothing should be left: open curves form no cycle) any curve.
    for (const [v, list] of at) {
        if (list.length !== 2) {
            for (const i of list) {
                if (!used.has(i)) {
                    walk(v, i);
                }
            }
        }
    }
    for (const i of open) {
        if (!used.has(i)) {
            walk(vertex[i][0], i);
        }
    }
    chains.sort((a, b) => a.first - b.first);
    return chains.map((c) => c.profile);
}

interface Loop {
    profile: SketchProfile;
    points: Pt[];
    size: number;
}

function loopOf(profile: SketchProfile): Loop {
    const points = cleanRing(profilePoints(profile));
    return { profile, points, size: Math.abs(area(points)) };
}

/**
 * Every bounded region of the sketch: the areas its curves divide the plane into. `loops[0]` is the region's
 * outline and the other loops are what lies directly inside it (its holes); `at` is a point inside the region,
 * away from its edges. A circle inside a square gives the ring [square, circle] and the disc [circle]; two squares
 * sharing an edge give two regions. Arguments as for regionProfiles.
 */
export function sketchRegions(entities: Entity[], ends: Map<string, [string, string]> = new Map()): SketchRegion[] {
    const { curves, vertex, others } = graphOf(entities, ends);
    // Each block: its outline and the faces inside it (a plain loop is its own single face).
    const found: { first: number; outer: Loop; faces: Loop[] }[] = [];
    for (const block of blocks(vertex)) {
        if (block.length === 1 && vertex[block[0]][0] !== vertex[block[0]][1]) {
            continue;
        }
        block.sort((a, b) => a - b);
        if (isCycle(block, vertex)) {
            for (const profile of entitiesToProfiles(block.map((i) => curves[i])).profiles) {
                const loop = loopOf(profile);
                found.push({ first: block[0], outer: loop, faces: [loop] });
            }
            continue;
        }
        const faces = traceFaces(block.map((i) => curves[i]), block.map((i) => vertex[i])).map((f) => loopOf(f.profile));
        const outer = faces.reduce((a, b) => (b.size > a.size ? b : a));
        found.push({ first: block[0], outer, faces: faces.filter((f) => f !== outer) });
    }
    found.sort((a, b) => a.first - b.first);
    const groups = [
        ...entitiesToProfiles(others).profiles.map((profile) => {
            const loop = loopOf(profile);
            return { outer: loop, faces: [loop] };
        }),
        ...found,
    ].filter((g) => g.outer.size > 1e-9 && g.outer.points.length >= 3);
    const faces = groups.flatMap((g, gi) => g.faces.filter((f) => f.size > 1e-9 && f.points.length >= 3).map((f) => ({ f, gi })));
    // Each group's outline is a hole of the smallest face of another group that contains it.
    const holes = new Map<Loop, Loop[]>();
    groups.forEach((g, gi) => {
        const probe = interiorPoint(g.outer.points, []);
        let parent: Loop | null = null;
        for (const { f, gi: other } of faces) {
            if (other !== gi && f.size > g.outer.size && (!parent || f.size < parent.size) && inside(probe, f.points)) {
                parent = f;
            }
        }
        if (parent) {
            holes.set(parent, [...(holes.get(parent) ?? []), g.outer]);
        }
    });
    return faces.map(({ f }) => {
        const inner = holes.get(f) ?? [];
        return { loops: [f.profile, ...inner.map((h) => h.profile)], at: interiorPoint(f.points, inner.map((h) => h.points)) };
    });
}

/** The ring without repeated consecutive points (nor a closing copy of the first). */
function cleanRing(points: Pt[]): Pt[] {
    const out: Pt[] = [];
    for (const p of points) {
        if (!out.length || dist(out[out.length - 1], p) > 1e-9) {
            out.push(p);
        }
    }
    while (out.length > 1 && dist(out[0], out[out.length - 1]) <= 1e-9) {
        out.pop();
    }
    return out;
}

const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Triangles of a simple polygon by ear clipping (what is left unclipped of a degenerate polygon is dropped). */
function triangulate(ring: Pt[]): [Pt, Pt, Pt][] {
    const pts = area(ring) < 0 ? [...ring].reverse() : ring;
    const idx = pts.map((_, i) => i);
    const out: [Pt, Pt, Pt][] = [];
    while (idx.length > 3) {
        let clipped = false;
        for (let k = 0; k < idx.length; k++) {
            const [a, b, c] = [pts[idx[(k + idx.length - 1) % idx.length]], pts[idx[k]], pts[idx[(k + 1) % idx.length]]];
            if (cross(a, b, c) <= 1e-12) {
                continue;
            }
            const blocked = idx.some((j) => {
                const p = pts[j];
                return p !== a && p !== b && p !== c && cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
            });
            if (!blocked) {
                out.push([a, b, c]);
                idx.splice(k, 1);
                clipped = true;
                break;
            }
        }
        if (!clipped) {
            break;
        }
    }
    if (idx.length === 3) {
        out.push([pts[idx[0]], pts[idx[1]], pts[idx[2]]]);
    }
    return out;
}

function segmentDistance(p: Pt, a: Pt, b: Pt): number {
    const d: Pt = [b[0] - a[0], b[1] - a[1]];
    const len = d[0] * d[0] + d[1] * d[1];
    const t = len > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / len)) : 0;
    return dist(p, [a[0] + d[0] * t, a[1] + d[1] * t]);
}

/**
 * A point strictly inside `outer` and outside the holes, as far from all their edges as the candidates allow:
 * points of the ear-clipped triangles (centroids and towards each corner), else a grid over the bounds.
 */
export function interiorPoint(outer: Pt[], holes: Pt[][]): Pt {
    const rings = [outer, ...holes];
    const valid = (p: Pt) => inside(p, outer) && !holes.some((h) => inside(p, h));
    const clearance = (p: Pt) => {
        let best = Infinity;
        for (const ring of rings) {
            for (let i = 0; i < ring.length; i++) {
                best = Math.min(best, segmentDistance(p, ring[i], ring[(i + 1) % ring.length]));
            }
        }
        return best;
    };
    const candidates: Pt[] = [];
    for (const [a, b, c] of triangulate(outer)) {
        const at = (wa: number, wb: number, wc: number): Pt => [a[0] * wa + b[0] * wb + c[0] * wc, a[1] * wa + b[1] * wb + c[1] * wc];
        candidates.push(at(1 / 3, 1 / 3, 1 / 3), at(2 / 3, 1 / 6, 1 / 6), at(1 / 6, 2 / 3, 1 / 6), at(1 / 6, 1 / 6, 2 / 3));
    }
    let pool = candidates.filter(valid);
    if (!pool.length) {
        const us = outer.map((p) => p[0]);
        const vs = outer.map((p) => p[1]);
        const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
        const n = 24;
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                candidates.push([u0 + ((u1 - u0) * (i + 0.5)) / n, v0 + ((v1 - v0) * (j + 0.5)) / n]);
            }
        }
        pool = candidates.filter(valid);
    }
    let best: Pt = pool[0] ?? outer[0];
    let bestClear = -1;
    for (const p of pool) {
        const c = clearance(p);
        if (c > bestClear) {
            best = p;
            bestClear = c;
        }
    }
    return best;
}

/**
 * The lines and arcs as graph edges with their end vertices, and the closed entities apart. A curve drawn over
 * another between the same two vertices (the shared side of two rectangles drawn one after the other) counts once.
 */
function graphOf(entities: Entity[], ends: Map<string, [string, string]>): { curves: Curve[]; vertex: [number, number][]; others: Entity[] } {
    const all: Curve[] = [];
    const others: Entity[] = [];
    for (const e of entities) {
        if (e.kind === 'line' || e.kind === 'arc') {
            all.push(e);
        } else {
            others.push(e);
        }
    }
    const merged = mergeVertices(all, ends);
    const seen = new Set<string>();
    const curves: Curve[] = [];
    const vertex: [number, number][] = [];
    all.forEach((c, i) => {
        const [a, b] = merged[i];
        const middle = c.kind === 'arc' ? `:${Math.round(c.m[0] / MERGE)}:${Math.round(c.m[1] / MERGE)}` : '';
        const key = `${Math.min(a, b)}-${Math.max(a, b)}${middle}`;
        if (!seen.has(key)) {
            seen.add(key);
            curves.push(c);
            vertex.push(merged[i]);
        }
    });
    return { curves, vertex, others };
}

/** Vertex indices [start, end] of each curve: shared point ids and coinciding points are one vertex. */
function mergeVertices(curves: Curve[], ends: Map<string, [string, string]>): [number, number][] {
    const parent = new Map<string, string>();
    const at = new Map<string, Pt>();
    const find = (id: string): string => {
        let r = id;
        while (parent.get(r) !== r) {
            r = parent.get(r)!;
        }
        parent.set(id, r);
        return r;
    };
    const ids = curves.map((c, i): [string, string] => {
        const [a, b] = ends.get(c.id) ?? [`#${i}a`, `#${i}b`];
        for (const [id, p] of [[a, c.a], [b, c.b]] as const) {
            if (!parent.has(id)) {
                parent.set(id, id);
                at.set(id, p);
            }
        }
        return [a, b];
    });
    const points = [...at.entries()];
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            if (dist(points[i][1], points[j][1]) < MERGE) {
                parent.set(find(points[i][0]), find(points[j][0]));
            }
        }
    }
    const index = new Map<string, number>();
    const indexOf = (id: string): number => {
        const r = find(id);
        if (!index.has(r)) {
            index.set(r, index.size);
        }
        return index.get(r)!;
    };
    return ids.map(([a, b]) => [indexOf(a), indexOf(b)]);
}

/** 2-connected blocks (Hopcroft-Tarjan) as lists of curve indices; a self-closing curve is a block of its own. */
function blocks(ends: [number, number][]): number[][] {
    const n = Math.max(0, ...ends.flat().map((v) => v + 1));
    const adj: [number, number][][] = Array.from({ length: n }, () => []);
    const out: number[][] = [];
    ends.forEach(([u, v], e) => {
        if (u === v) {
            out.push([e]);
        } else {
            adj[u].push([v, e]);
            adj[v].push([u, e]);
        }
    });
    const disc: number[] = new Array(n).fill(-1);
    const low: number[] = new Array(n).fill(0);
    const stack: number[] = [];
    let time = 0;
    const visit = (u: number, via: number): void => {
        disc[u] = low[u] = time++;
        for (const [v, e] of adj[u]) {
            if (e === via) {
                continue;
            }
            if (disc[v] < 0) {
                stack.push(e);
                visit(v, e);
                low[u] = Math.min(low[u], low[v]);
                if (low[v] >= disc[u]) {
                    const block: number[] = [];
                    let x: number;
                    do {
                        x = stack.pop()!;
                        block.push(x);
                    } while (x !== e);
                    out.push(block);
                }
            } else if (disc[v] < disc[u]) {
                // Back edge (or a second curve between the same two points).
                stack.push(e);
                low[u] = Math.min(low[u], disc[v]);
            }
        }
    };
    for (let u = 0; u < n; u++) {
        if (disc[u] < 0) {
            visit(u, -1);
        }
    }
    return out;
}

function isCycle(block: number[], vertex: [number, number][]): boolean {
    const degree = new Map<number, number>();
    for (const i of block) {
        for (const v of vertex[i]) {
            degree.set(v, (degree.get(v) ?? 0) + 1);
        }
    }
    return [...degree.values()].every((d) => d === 2);
}

/** Direction (angle) a curve leaves its start (or end, when reversed) and its signed curvature (left turn > 0). */
function leaving(c: Curve, reversed: boolean): { angle: number; bend: number } {
    const from = reversed ? c.b : c.a;
    const to = reversed ? c.a : c.b;
    const circle = c.kind === 'arc' ? circleThrough(c.a, c.m, c.b) : null;
    if (c.kind === 'line' || !circle) {
        return { angle: Math.atan2(to[1] - from[1], to[0] - from[0]), bend: 0 };
    }
    // Counter-clockwise from a to b when m is right of the chord a→b; reversed runs the other way.
    const ccw = ((c.b[0] - c.a[0]) * (c.m[1] - c.a[1]) - (c.b[1] - c.a[1]) * (c.m[0] - c.a[0]) < 0) !== reversed;
    const s = ccw ? 1 : -1;
    const r: Pt = [from[0] - circle.c[0], from[1] - circle.c[1]];
    return { angle: Math.atan2(s * r[0], -s * r[1]), bend: s / circle.r };
}

/**
 * Every face of a 2-connected block's embedding (outgoing half-edges sorted by their leaving angle around each
 * vertex), each with the area it encloses. The face enclosing the largest area is the outside one.
 */
function traceFaces(curves: Curve[], vertex: [number, number][]): { profile: SketchProfile; size: number }[] {
    // Half-edge h: curve h >> 1, forward (start → end) when even.
    const tail = (h: number) => vertex[h >> 1][h & 1];
    const head = (h: number) => vertex[h >> 1][1 - (h & 1)];
    const around = new Map<number, { h: number; angle: number; bend: number }[]>();
    for (let h = 0; h < curves.length * 2; h++) {
        const list = around.get(tail(h)) ?? [];
        list.push({ h, ...leaving(curves[h >> 1], (h & 1) === 1) });
        around.set(tail(h), list);
    }
    const slot = new Map<number, number>();
    for (const list of around.values()) {
        // Counter-clockwise order; on a shared tangent the curve bending left more lies further round.
        list.sort((p, q) => (Math.abs(p.angle - q.angle) > 1e-9 ? p.angle - q.angle : p.bend - q.bend || p.h - q.h));
        list.forEach((x, i) => slot.set(x.h, i));
    }
    // Next half-edge of the face: the one just clockwise of the way back, at the head.
    const next = (h: number): number => {
        const list = around.get(head(h))!;
        return list[(slot.get(h ^ 1)! - 1 + list.length) % list.length].h;
    };
    const seen = new Set<number>();
    const faces: { profile: SketchProfile; size: number }[] = [];
    for (let h0 = 0; h0 < curves.length * 2; h0++) {
        if (seen.has(h0)) {
            continue;
        }
        const face: number[] = [];
        for (let h = h0; !seen.has(h); h = next(h)) {
            seen.add(h);
            face.push(h);
        }
        const profile = facePath(curves, face);
        faces.push({ profile, size: Math.abs(area(profilePoints(profile))) });
    }
    return faces;
}

/** Outer boundary of a 2-connected block: the traced face enclosing the largest area. */
function outerBoundary(curves: Curve[], vertex: [number, number][]): SketchProfile {
    let best: SketchProfile | null = null;
    let bestArea = -1;
    for (const { profile, size } of traceFaces(curves, vertex)) {
        if (size > bestArea) {
            best = profile;
            bestArea = size;
        }
    }
    return best!;
}

function facePath(curves: Curve[], face: number[]): SketchProfile {
    const first = curves[face[0] >> 1];
    const start = face[0] & 1 ? first.b : first.a;
    const segments: SketchSegment[] = face.map((h) => {
        const c = curves[h >> 1];
        const to = h & 1 ? c.a : c.b;
        return c.kind === 'line' ? { kind: 'line', to } : { kind: 'arc', to, through: c.m };
    });
    segments[segments.length - 1].to = start;
    return { kind: 'path', start, segments };
}
