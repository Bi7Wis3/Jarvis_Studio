import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { closestParam, domainOf, pointAt, type CurveGeom } from '@jarvis/core/curveIntersect';
import { curveOf, loadSolver, pointOf, solveGeometry } from './solver';
import { geometryProfiles } from './sketchGeometry';
import { mirrorCurves, transformEntities, transformPoint, type Transform } from './sketchEdit';
import { circularSketchPattern, linearSketchPattern } from './sketchPattern';
import { geomOfCurve } from './sketchCut';
import { unmetConstraints } from './sketchCheck';
import { DEFAULT_EDIT_OPTIONS, stretchSelected, transformSelected, useSketcher } from './sketcher';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

type Pt = [number, number];

beforeAll(async () => {
    await loadSolver();
});

const dist = (p: Pt, q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]);

function sketch(points: Record<string, Pt>, curves: SketchCurve[]): SketchGeometry {
    return { points: Object.entries(points).map(([id, [u, v]]) => ({ id, u, v })), curves, constraints: [] };
}

/** A sketch curve sampled by s from 0 at its start to 1 at its end (once round a closed one), on its exact shape. */
interface Ev {
    geom: CurveGeom;
    closed: boolean;
    at(s: number): Pt;
}
function evalOf(g: SketchGeometry, c: SketchCurve): Ev | null {
    const geom = geomOfCurve(g, c);
    if (!geom) {
        return null;
    }
    const d = domainOf(geom);
    const span = d.period ?? d.t1 - d.t0;
    return { geom, closed: !!d.period, at: (s) => pointAt(geom, d.t0 + span * s) };
}
/** The point of the curve nearest q. */
const nearestOn = (ev: Ev, q: Pt): Pt => pointAt(ev.geom, closestParam(ev.geom, q));

/** Largest distance between the copy and the original mapped by `f` (`back` undoes f), both ways. */
function apart(copy: Ev, original: Ev, f: (p: Pt) => Pt, back: (p: Pt) => Pt): number {
    let worst = 0;
    for (let i = 0; i <= 50; i++) {
        const r = f(original.at(i / 50));
        worst = Math.max(worst, dist(r, nearestOn(copy, r)));
        const q = back(copy.at(i / 50));
        worst = Math.max(worst, dist(q, nearestOn(original, q)));
    }
    return worst;
}
/** The transform undone. */
const undo = (t: Transform): Transform => (t.kind === 'move' ? { kind: 'move', by: [-t.by[0], -t.by[1]] }
    : t.kind === 'rotate' ? { ...t, angle: -t.angle } : { ...t, factor: 1 / t.factor });

/** The sketch solves as it is (nothing moves), with no conflicting, unmet or repeated relations. */
function sound(g: SketchGeometry): void {
    const r = solveGeometry(g);
    expect(r.ok, `conflicts: ${r.conflicting.join(', ')}`).toBe(true);
    expect(r.redundant, 'repeated relations').toEqual([]);
    expect(unmetConstraints(r.geometry)).toEqual([]);
    for (const p of g.points) {
        const q = pointOf(r.geometry, p.id)!;
        expect(dist([p.u, p.v], [q.u, q.v]), `point ${p.id} moved`).toBeLessThan(1e-6);
    }
}

// One curve of each kind (with a line to the side, so patterns and stretches have something to keep).
const kinds: Record<string, () => SketchGeometry> = {
    ellipse: () => sketch({ c: [10, 5], m: [30, 5], n: [10, 13] }, [{ id: 'k', kind: 'ellipse', center: 'c', major: 'm', minor: 'n' }]),
    'partial ellipse': () => sketch({ c: [10, 5], m: [30, 5], n: [10, 13], s: [30, 5], e: [10, 13] }, [
        { id: 'k', kind: 'ellipseArc', center: 'c', major: 'm', minor: 'n', start: 's', end: 'e' }]),
    spline: () => sketch({ a: [0, 0], b: [10, 6], c: [20, 2], h: [24, 8] }, [{ id: 'k', kind: 'spline', points: ['a', 'b', 'c'], endHandle: 'h', spacing: [1.1, 0.95] }]),
    'closed spline': () => sketch({ a: [10, 0], b: [4, 7], c: [-6, 5], d: [-9, -3], e: [0, -8] }, [{ id: 'k', kind: 'spline', points: ['a', 'b', 'c', 'd', 'e', 'a'] }]),
    'B-spline': () => sketch({ a: [0, 0], b: [6, 12], c: [14, -4], d: [22, 10], e: [30, 2] }, [
        { id: 'k', kind: 'styleSpline', points: ['a', 'b', 'c', 'd', 'e'], degree: 3, knots: [0.3] }]),
    Bezier: () => sketch({ a: [0, 0], b: [6, 12], c: [14, -4], d: [22, 10] }, [{ id: 'k', kind: 'styleSpline', points: ['a', 'b', 'c', 'd'] }]),
    parabola: () => sketch({ fo: [0, 4], v: [0, 0], s: [-12, 9], e: [10, 6.25] }, [{ id: 'k', kind: 'parabola', focus: 'fo', vertex: 'v', start: 's', end: 'e' }]),
    conic: () => sketch({ s: [0, 0], ap: [10, 15], e: [25, 2] }, [{ id: 'k', kind: 'conic', start: 's', end: 'e', apex: 'ap', rho: 0.6 }]),
};

const transforms: [string, Transform][] = [
    ['moves', { kind: 'move', by: [7, -3] }],
    ['turns', { kind: 'rotate', centre: [2, 1], angle: 37 }],
    ['scales', { kind: 'scale', centre: [2, 1], factor: 1.7 }],
];

describe('move, copy, rotate and scale on every curve kind', () => {
    for (const [name, make] of Object.entries(kinds)) {
        it(`${transforms.map((t) => t[0]).join(', ')} and copies a ${name} exactly`, () => {
            const g = make();
            const before = evalOf(g, curveOf(g, 'k')!)!;
            for (const [, t] of transforms) {
                for (const copy of [false, true]) {
                    const r = transformEntities(g, ['k'], t, copy);
                    expect(r).not.toHaveProperty('error');
                    if ('error' in r) {
                        continue;
                    }
                    const id = copy ? r.created[0] : 'k';
                    expect(apart(evalOf(r.g, curveOf(r.g, id)!)!, before, (p) => transformPoint(t, p), (p) => transformPoint(undo(t), p))).toBeLessThan(1e-9);
                    sound(r.g);
                }
            }
        });
    }

    it('copies several times and moves keeping relations through the sketcher', () => {
        const g = kinds.spline();
        useSketcher.setState({ active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [{ type: 'curve', id: 'k' }], picks: [], editOptions: DEFAULT_EDIT_OPTIONS, labels: {} });
        expect(transformSelected({ kind: 'move', by: [0, 10] }, true, { copies: 3 })).toBeNull();
        expect(useSketcher.getState().geometry.curves.filter((c) => c.kind === 'spline')).toHaveLength(4);
        useSketcher.setState({ geometry: g, selection: [{ type: 'curve', id: 'k' }] });
        expect(transformSelected({ kind: 'rotate', centre: [0, 0], angle: 90 }, false, { keepRelations: true })).toBeNull();
        const out = useSketcher.getState().geometry;
        expect(apart(evalOf(out, curveOf(out, 'k')!)!, evalOf(g, curveOf(g, 'k')!)!, (p) => [-p[1], p[0]], (p) => [p[1], -p[0]])).toBeLessThan(1e-6);
    });
});

describe('mirror on every curve kind', () => {
    for (const [name, make] of Object.entries(kinds)) {
        it(`mirrors a ${name} about a line, held symmetric, and moves it across with Copy off`, () => {
            const g0 = make();
            const g: SketchGeometry = { ...g0, points: [...g0.points, { id: 'm1', u: -20, v: -30 }, { id: 'm2', u: -14, v: 40 }], curves: [...g0.curves, { id: 'ax', kind: 'line', a: 'm1', b: 'm2', construction: true }] };
            const before = evalOf(g, curveOf(g, 'k')!)!;
            const [a, b] = [[-20, -30], [-14, 40]] as Pt[];
            const reflect = (p: Pt): Pt => {
                const u: Pt = [(b[0] - a[0]) / dist(a, b), (b[1] - a[1]) / dist(a, b)];
                const t = (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
                const foot: Pt = [a[0] + u[0] * t, a[1] + u[1] * t];
                return [2 * foot[0] - p[0], 2 * foot[1] - p[1]];
            };
            for (const keep of [true, false]) {
                const r = mirrorCurves(g, ['k'], 'ax', keep) as { g: SketchGeometry; created: string[] };
                expect(r).not.toHaveProperty('error');
                const copy = curveOf(r.g, r.created[0])!;
                expect(copy.kind).toBe(curveOf(g, 'k')!.kind);
                expect(apart(evalOf(r.g, copy)!, before, reflect, reflect)).toBeLessThan(1e-9);
                expect(curveOf(r.g, 'k') !== undefined).toBe(keep);
                sound(r.g);
            }
        });
    }
});

describe('linear and circular sketch patterns on every curve kind', () => {
    for (const [name, make] of Object.entries(kinds)) {
        it(`patterns a ${name} in rows and round a centre, each instance exact and held`, () => {
            const g = make();
            const before = evalOf(g, curveOf(g, 'k')!)!;
            const lin = linearSketchPattern(g, ['k'], { count: 3, spacing: 40, angle: 30, dimension: true, fixDirection: true }) as { g: SketchGeometry; created: string[] };
            expect(lin).not.toHaveProperty('error');
            const along = (k: number) => (p: Pt): Pt => [p[0] + 40 * k * Math.cos(Math.PI / 6), p[1] + 40 * k * Math.sin(Math.PI / 6)];
            const copies = lin.created.filter((id) => curveOf(lin.g, id)?.kind === curveOf(g, 'k')!.kind);
            expect(copies).toHaveLength(2);
            copies.forEach((id, i) => expect(apart(evalOf(lin.g, curveOf(lin.g, id)!)!, before, along(i + 1), along(-i - 1))).toBeLessThan(1e-9));
            sound(lin.g);
            const circ = circularSketchPattern(g, ['k'], { count: 3, angle: 360, equal: true, centre: [-30, -10], dimensionRadius: true, dimensionAngle: true }) as { g: SketchGeometry; created: string[] };
            expect(circ).not.toHaveProperty('error');
            const turned = circ.created.filter((id) => curveOf(circ.g, id)?.kind === curveOf(g, 'k')!.kind);
            expect(turned).toHaveLength(2);
            turned.forEach((id, i) => expect(apart(evalOf(circ.g, curveOf(circ.g, id)!)!, before,
                (p) => transformPoint({ kind: 'rotate', centre: [-30, -10], angle: 120 * (i + 1) }, p),
                (p) => transformPoint({ kind: 'rotate', centre: [-30, -10], angle: -120 * (i + 1) }, p))).toBeLessThan(1e-9));
            sound(circ.g);
        });
    }
});

describe('stretch on every curve kind', () => {
    it('moves the picked curve and stretches the line joined to it', () => {
        for (const [name, make] of Object.entries(kinds)) {
            const g0 = make();
            const c = curveOf(g0, 'k')!;
            const ends = c.kind === 'ellipse' ? [] : c.kind === 'spline' || c.kind === 'styleSpline' ? [c.points[0]] : 'start' in c ? [c.start] : [];
            const g: SketchGeometry = ends.length && !(c.kind === 'spline' && c.points[0] === c.points[c.points.length - 1])
                ? { ...g0, points: [...g0.points, { id: 'far', u: -40, v: -40 }], curves: [...g0.curves, { id: 'l', kind: 'line', a: 'far', b: ends[0] }] }
                : g0;
            const before = evalOf(g, c)!;
            useSketcher.setState({ active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [{ type: 'curve', id: 'k' }], picks: [], editOptions: DEFAULT_EDIT_OPTIONS, labels: {} });
            expect(stretchSelected([5, 2]), name).toBeNull();
            const out = useSketcher.getState().geometry;
            expect(apart(evalOf(out, curveOf(out, 'k')!)!, before, (p) => [p[0] + 5, p[1] + 2], (p) => [p[0] - 5, p[1] - 2]), name).toBeLessThan(1e-6);
            if (curveOf(out, 'l')) {
                expect(pointOf(out, 'far')).toMatchObject({ u: -40, v: -40 });
            }
        }
    });
});

describe('the copies build', () => {
    it('a closed spline patterned round a centre gives a closed area per instance', () => {
        const g = kinds['closed spline']();
        const circ = circularSketchPattern(g, ['k'], { count: 4, angle: 360, equal: true, centre: [-40, 0] }) as { g: SketchGeometry };
        expect(geometryProfiles(circ.g).profiles).toHaveLength(4);
    });
});
