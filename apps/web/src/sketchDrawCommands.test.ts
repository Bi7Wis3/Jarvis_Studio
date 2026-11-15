// Select Chain, Reverse Endpoint Tangent, infinite lines, Align Grid/Origin, slot parameters and relations, the
// conic's Auto tangency, point on conic and Rho dimension, Make Path with its relations and length, and Belt/Chain.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchConstraint, SketchCurve, SketchGeometry } from '@jarvis/core';
import { conicAt } from '@jarvis/core/curves';
import { AXIS_U, ORIGIN, curveRadius, loadSolver, measure, pointOf, solveGeometry } from './solver';
import {
    EMPTY_GEOMETRY, addCircle, addConstraint, addLine, addRect, addTangentArc, dimensionFromPicks, geometryEntities, geometryProfiles,
    relationsFromPicks, type NewConstraint,
} from './sketchGeometry';
import { commitGeometry, setDrawOptions, setTool, sketchClick, sketchMove, useSketcher } from './sketcher';
import { DEFAULT_DRAW_OPTIONS, arcSlot } from './sketchDrawVariants';
import { reverseEndpointTangent, selectChainOf } from './sketchChainTools';
import { makeEndless } from './sketchInfinite';
import { trimAt } from './sketchEdit';
import { trimCorner } from './sketchTrim';
import { alignFrame, relocatedGeometry } from './sketchAlignGrid';
import { applyAlignGrid, applyBelt, applyPath, drawCommandEntries, selectChainSelected } from './sketchDrawCommands';
import { arcSlotOf, slotOf } from './sketchSlots';
import { editSlot, setSlotLengthKind, slotAmong, slotParams } from './sketchSlotParams';
import { makePath, pathLength } from './sketchPaths';
import { unmetConstraints } from './sketchCheck';
import { planeFrame } from './sketchMath';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const TOL = 0.5;
const state = () => useSketcher.getState();
const g = () => state().geometry;

function start(geometry: SketchGeometry = EMPTY_GEOMETRY) {
    useSketcher.setState({
        active: true, stage: 'draw', geometry, undo: [], redo: [], draft: [], chainStart: null, typed: '', message: null, selection: [],
        drawOptions: DEFAULT_DRAW_OPTIONS, sides: 6, conflicting: [], redundant: [], plane: 'front', offset: 0, context: [], labels: {}, picks: [],
        tool: 'select',
    });
}

function draw(tool: Parameters<typeof setTool>[0], ...clicks: [number, number][]) {
    setTool(tool);
    for (const p of clicks) {
        sketchMove(p, TOL);
        sketchClick(p, TOL);
    }
}

const at = (geometry: SketchGeometry, id: string): [number, number] => {
    const p = pointOf(geometry, id)!;
    return [p.u, p.v];
};
const lines = (geometry: SketchGeometry) => geometry.curves.filter((c): c is Extract<SketchCurve, { kind: 'line' }> => c.kind === 'line');
const add = (geometry: SketchGeometry, list: NewConstraint[]) => list.reduce((out, k) => addConstraint(out, k).g, geometry);
const lockAll = (geometry: SketchGeometry, ids: string[]) => add(geometry, ids.map((point) => ({ kind: 'fix', point }) as NewConstraint));
const distToLine = (p: [number, number], a: [number, number], b: [number, number]) =>
    Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / Math.hypot(b[0] - a[0], b[1] - a[1]);

describe('select chain', () => {
    it('selects a rectangle from one side, and stops at a branch', () => {
        let geometry = addRect(EMPTY_GEOMETRY, [0, 0], [10, 5]).g;
        const side = lines(geometry)[0].id;
        expect(selectChainOf(geometry, side)).toHaveLength(4);
        // Three lines from one point: the chain of one goes no further than that point.
        const a = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        const shared = a.b;
        geometry = addLine(a.g, { at: [10, 0], point: shared }, { at: [20, 0] }).g;
        geometry = addLine(geometry, { at: [10, 0], point: shared }, { at: [10, 10] }).g;
        const [first] = lines(geometry);
        expect(selectChainOf(geometry, first.id)).toEqual([first.id]);
        // The command selects every chain of the selection.
        start(addRect(EMPTY_GEOMETRY, [0, 0], [10, 5]).g);
        useSketcher.setState({ selection: [{ type: 'curve', id: lines(g())[2].id }] });
        expect(selectChainSelected()).toBeNull();
        expect(state().selection).toHaveLength(4);
    });

    it('offers its right-click entries for what is selected', () => {
        const r = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        const arc = addTangentArc(r.g, r.b, { at: [15, 5] });
        if ('error' in arc) {
            throw new Error(arc.error);
        }
        const opened: string[] = [];
        const entries = drawCommandEntries(arc.g, [{ type: 'curve', id: arc.id }], { openTool: (id) => opened.push(id) });
        const labels = entries.map((e) => (typeof e === 'object' && 'label' in e ? e.label : ''));
        expect(labels).toEqual(expect.arrayContaining(['Select chain', 'Make path', 'Reverse endpoint tangent']));
        const line = drawCommandEntries(arc.g, [{ type: 'curve', id: r.id }], { openTool: (id) => opened.push(id) });
        expect(line.map((e) => (typeof e === 'object' && 'label' in e ? e.label : ''))).toContain('Infinite length');
    });
});

describe('reverse endpoint tangent', () => {
    it('flips a tangent arc to the rest of its circle, still tangent at its start', () => {
        const r = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        const arc = addTangentArc(r.g, r.b, { at: [15, 5] });
        if ('error' in arc) {
            throw new Error(arc.error);
        }
        const before = arc.g.curves.find((c) => c.id === arc.id) as Extract<SketchCurve, { kind: 'arc' }>;
        const flipped = reverseEndpointTangent(arc.g, arc.id);
        if ('error' in flipped) {
            throw new Error(flipped.error);
        }
        const after = flipped.curves.find((c) => c.id === arc.id) as Extract<SketchCurve, { kind: 'arc' }>;
        expect([after.start, after.end]).toEqual([before.end, before.start]);
        const solved = solveGeometry(flipped);
        expect(solved.ok).toBe(true);
        expect(unmetConstraints(solved.geometry)).toEqual([]);
        // The same circle: tangent to the line at the line's end.
        expect(curveRadius(solved.geometry, arc.id)).toBeCloseTo(5, 6);
        expect(reverseEndpointTangent(arc.g, r.id)).toEqual({ error: 'Reverse endpoint tangent works on an arc.' });
    });

    it('starts a tangent arc on the end of a conic, held tangent there', () => {
        let geometry: SketchGeometry = { points: [{ id: 's', u: 0, v: 0 }, { id: 't', u: 5, v: 5 }, { id: 'e', u: 10, v: 0 }],
            curves: [{ id: 'k', kind: 'conic', start: 's', end: 'e', apex: 't', rho: 0.5 }], constraints: [] };
        geometry = lockAll(geometry, ['s', 't', 'e']);
        const arc = addTangentArc(geometry, 'e', { at: [15, 0] });
        if ('error' in arc) {
            throw new Error(arc.error);
        }
        const solved = solveGeometry(arc.g);
        expect(solved.ok).toBe(true);
        const c = solved.geometry.curves.find((x) => x.id === arc.id) as Extract<SketchCurve, { kind: 'arc' }>;
        // Its radius at the joint is square to the conic's end tangent (from the top vertex to the end).
        const [m, e] = [at(solved.geometry, c.center), at(solved.geometry, 'e')];
        expect((e[0] - m[0]) * 5 + (e[1] - m[1]) * -5).toBeCloseTo(0, 6);
    });
});

describe('infinite lines', () => {
    beforeEach(() => start());

    it('draws a line without end through two clicks, left out of profiles', () => {
        setDrawOptions({ lineInfinite: true });
        draw('line', [0, 0], [10, 0]);
        const [line] = lines(g());
        expect(line.endless).toBe('both');
        expect(state().draft).toEqual([]);
        const e = geometryEntities(g()).find((x) => x.id === line.id)!;
        expect(e.kind === 'line' && Math.abs(e.a[0]) > 1e4 && Math.abs(e.b[0]) > 1e4).toBe(true);
        // A rectangle across it is still one profile.
        const withRect = addRect(g(), [2, -3], [8, 3]).g;
        expect(geometryProfiles(withRect).profiles).toHaveLength(1);
        // No length to dimension.
        expect(dimensionFromPicks(g(), [{ type: 'curve', id: line.id }], [5, 5])).toBeNull();
        setDrawOptions({ lineInfinite: false });
    });

    it('trims into rays and pieces, and to a corner', () => {
        let geometry = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        const id = geometry.curves[0].id;
        geometry = makeEndless(geometry, id) as SketchGeometry;
        geometry = addLine(geometry, { at: [5, -5] }, { at: [5, 5] }).g;
        geometry = addLine(geometry, { at: [20, -5] }, { at: [20, 5] }).g;
        // Between the two crossings: two rays remain.
        const middle = trimAt(geometry, id, [12, 0])!;
        const rays = lines(middle.g).filter((l) => l.endless);
        expect(rays.map((l) => l.endless).sort()).toEqual(['a', 'b']);
        const left = rays.find((l) => l.endless === 'a')!;
        const right = rays.find((l) => l.endless === 'b')!;
        expect(at(middle.g, left.b)[0]).toBeCloseTo(5, 9);
        expect(at(middle.g, right.a)[0]).toBeCloseTo(20, 9);
        expect(solveGeometry(middle.g).ok).toBe(true);
        // Left of the first crossing: a ray from it onwards.
        const before = trimAt(geometry, id, [-50, 0])!;
        const ray = lines(before.g).find((l) => l.id === id)!;
        expect(ray.endless).toBe('b');
        expect(at(before.g, ray.a)[0]).toBeCloseTo(5, 9);
        // That ray trimmed beyond the second crossing: a plain line from 5 to 20.
        const finite = trimAt(before.g, id, [40, 0])!;
        const piece = lines(finite.g).find((l) => l.id === id)!;
        expect(piece.endless).toBeUndefined();
        expect([at(finite.g, piece.a)[0], at(finite.g, piece.b)[0]].sort((x, y) => x - y)).toEqual([5, 20]);
        // Corner with a vertical line that does not reach it: both end at one corner point.
        let corner = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        corner = makeEndless(corner, corner.curves[0].id) as SketchGeometry;
        corner = addLine(corner, { at: [30, 5] }, { at: [30, 15] }).g;
        const [h, v] = lines(corner);
        const done = trimCorner(corner, { id: h.id, at: [2, 0] }, { id: v.id, at: [30, 10] });
        if ('error' in done) {
            throw new Error(done.error);
        }
        const [h2, v2] = [lines(done.g).find((l) => l.id === h.id)!, lines(done.g).find((l) => l.id === v.id)!];
        expect(h2.endless).toBe('a');
        expect(at(done.g, h2.b)).toEqual([30, 0]);
        expect(v2.a === h2.b || v2.b === h2.b).toBe(true);
    });

    it('makes a finite line infinite, dropping its length', () => {
        let geometry = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        const id = geometry.curves[0].id;
        geometry = addConstraint(geometry, { kind: 'length', line: id, value: 10 }).g;
        const endless = makeEndless(geometry, id) as SketchGeometry;
        expect(endless.curves[0]).toMatchObject({ endless: 'both' });
        expect(endless.constraints).toEqual([]);
        expect(makeEndless(endless, id)).toEqual({ error: 'That line is infinite already.' });
    });
});

describe('align grid / origin', () => {
    const world = (geometry: SketchGeometry, id: string) => {
        const f = planeFrame(state().plane, state().offset, []);
        const [u, v] = at(geometry, id);
        return [0, 1, 2].map((i) => f.origin[i] + f.u[i] * u + f.v[i] * v);
    };

    it('relocates the origin only: nothing moves, what was tied to the origin stays where it was', () => {
        let geometry = addLine(EMPTY_GEOMETRY, { at: [0, 0], point: ORIGIN }, { at: [10, 0] }, 'horizontal').g;
        const free = addLine(geometry, { at: [5, 5] }, { at: [8, 9] });
        geometry = free.g;
        const [, target] = lines(geometry);
        start(geometry);
        const before = [world(g(), target.a), world(g(), target.b), world(g(), lines(g())[0].b)];
        expect(applyAlignGrid({ origin: target.a, axisIs: 'x', flip: false, mode: 'origin' })).toBeNull();
        const after = [world(g(), target.a), world(g(), target.b), world(g(), lines(g())[0].b)];
        after.forEach((p, i) => p.forEach((x, k) => expect(x).toBeCloseTo(before[i][k], 6)));
        // The picked point is the new origin; the old origin is a locked point.
        expect(at(g(), target.a)).toEqual([0, 0]);
        const first = lines(g())[0];
        expect(first.a).not.toBe(ORIGIN);
        expect(g().constraints.some((k) => k.kind === 'fix' && k.point === first.a)).toBe(true);
        expect(solveGeometry(g()).ok).toBe(true);
    });

    it('turns the axes along a line, keeping horizontal lines where they are', () => {
        let geometry = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }, 'horizontal').g;
        geometry = addLine(geometry, { at: [0, 0] }, { at: [10, 10] }).g;
        const axis = lines(geometry)[1].id;
        const f = alignFrame(geometry, { axis, axisIs: 'x', flip: false, mode: 'origin' });
        if ('error' in f) {
            throw new Error(f.error);
        }
        expect(f.angle).toBeCloseTo(Math.PI / 4, 12);
        const next = relocatedGeometry(geometry, f.at, f.angle) as SketchGeometry;
        expect(next.constraints.some((k) => k.kind === 'horizontal')).toBe(false);
        expect(next.constraints.some((k) => k.kind === 'parallel')).toBe(true);
        const solved = solveGeometry(next);
        expect(solved.ok).toBe(true);
        const [h] = lines(solved.geometry);
        expect(at(solved.geometry, h.b)[0]).toBeCloseTo(10 / Math.SQRT2, 6);
        expect(at(solved.geometry, h.b)[1]).toBeCloseTo(-10 / Math.SQRT2, 6);
    });

    it('relocates all sketch entities: the sketch keeps its coordinates and moves with its origin', () => {
        const geometry = addLine(EMPTY_GEOMETRY, { at: [2, 3] }, { at: [10, 3] }).g;
        start(geometry);
        const [line] = lines(g());
        expect(applyAlignGrid({ origin: line.a, axisIs: 'x', flip: true, mode: 'all' })).toBeNull();
        expect(at(g(), line.a)).toEqual([2, 3]);
        expect(typeof state().plane).toBe('object');
        // The old origin is now at the point that was picked, the axes half a turn round.
        const p = world(g(), line.a);
        expect(p[0]).toBeCloseTo(2 - 2, 6);
    });
});

describe('slots', () => {
    beforeEach(() => start());

    it('reads and sets a straight slot\'s parameters, centre to centre or overall', () => {
        draw('slot', [2, 1], [22, 1], [12, 6]);
        const found = slotAmong(g(), g().curves.map((c) => c.id))!;
        expect(found.kind).toBe('straight');
        expect(slotParams(g(), found)).toEqual({ cx: 12, cy: 1, width: 10, length: 20 });
        expect(slotParams(g(), found, true).length).toBe(30);
        const edited = editSlot(g(), found, { cx: 12, cy: 1, width: 6, length: 30 }, true) as SketchGeometry;
        expect(commitGeometry(edited)).toBe(true);
        const again = slotAmong(g(), g().curves.map((c) => c.id))!;
        const p = slotParams(g(), again, true);
        expect(p.cx).toBeCloseTo(12, 9);
        expect(p.cy).toBeCloseTo(1, 9);
        expect(p.width).toBeCloseTo(6, 9);
        expect(p.length).toBeCloseTo(30, 9);
    });

    it('turns a slot\'s own length dimension between centre to centre and overall', () => {
        setDrawOptions({ slotDimensions: true, slotOverall: false });
        draw('slot', [0, 0], [20, 0], [10, 5]);
        const found = slotAmong(g(), g().curves.map((c) => c.id))!;
        const overall = setSlotLengthKind(g(), found, true);
        expect(commitGeometry(overall)).toBe(true);
        expect(g().constraints.some((k) => k.kind === 'length')).toBe(false);
        expect(g().constraints.some((k) => k.kind === 'distance' && Math.abs(k.value - 30) < 1e-9)).toBe(true);
        const back = setSlotLengthKind(g(), slotAmong(g(), g().curves.map((c) => c.id))!, false);
        expect(commitGeometry(back)).toBe(true);
        expect(g().constraints.some((k) => k.kind === 'length' && Math.abs(k.value - 20) < 1e-9)).toBe(true);
        setDrawOptions({ slotDimensions: false });
    });

    it('reads and sets an arc slot\'s radius and angle; fixes it and makes arc slots equal', () => {
        const options = DEFAULT_DRAW_OPTIONS;
        const one = arcSlot(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [20, 0] }, { at: [0, 20] }, 4, options) as SketchGeometry;
        const found = slotAmong(one, one.curves.map((c) => c.id))!;
        expect(found.kind).toBe('arc');
        const p = slotParams(one, found);
        expect(p.radius).toBeCloseTo(20, 9);
        expect(p.angle).toBeCloseTo(90, 9);
        expect(p.width).toBeCloseTo(4, 9);
        expect(p.length).toBeCloseTo(10 * Math.PI, 9);
        const turned = editSlot(one, found, { ...p, angle: 60, radius: 25 }) as SketchGeometry;
        const solved = solveGeometry(turned);
        expect(solved.ok).toBe(true);
        const q = slotParams(solved.geometry, slotAmong(solved.geometry, one.curves.map((c) => c.id))!);
        expect(q.angle).toBeCloseTo(60, 6);
        expect(q.radius).toBeCloseTo(25, 6);
        // Two arc slots made equal: the second takes the first one's radius, width and angle.
        const both = arcSlot(one, { at: [100, 0] }, { at: [130, 0] }, { at: [100, 30] }, 6, options) as SketchGeometry;
        const second = both.curves.find((c) => !one.curves.some((k) => k.id === c.id) && c.kind === 'arc' && !c.construction)!.id;
        const first = one.curves.find((c) => c.kind === 'arc' && !c.construction)!.id;
        const rel = relationsFromPicks(both, 'equalSlots', [{ type: 'curve', id: first }, { type: 'curve', id: second }]);
        if ('need' in rel) {
            throw new Error(rel.need);
        }
        expect(rel.map((k) => k.kind)).toEqual(['equal', 'equal', 'equalSweep']);
        // The first slot fixed, so the second does the changing.
        const fixed = relationsFromPicks(both, 'fixSlot', [{ type: 'curve', id: first }]);
        if ('need' in fixed) {
            throw new Error(fixed.need);
        }
        const equal = solveGeometry(add(both, [...fixed, ...rel]));
        expect(equal.ok).toBe(true);
        expect(unmetConstraints(equal.geometry)).toEqual([]);
        const s2 = slotParams(equal.geometry, { kind: 'arc', slot: arcSlotOf(equal.geometry, second)! });
        expect(s2.radius).toBeCloseTo(20, 6);
        expect(s2.angle).toBeCloseTo(90, 6);
        expect(s2.width).toBeCloseTo(4, 6);
        expect(slotOf(both, first)).toBeNull();
    });
});

describe('conic', () => {
    beforeEach(() => start());

    it('Auto tangency takes the top vertex from the joined ends and makes the conic tangent there', () => {
        let geometry = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        geometry = addLine(geometry, { at: [30, 20] }, { at: [30, 10] }).g;
        start(geometry);
        setDrawOptions({ conicAutoTangency: true });
        // Rho 0.6: from the chord's middle (20, 5) 0.6 of the way to the top vertex (30, 0).
        draw('conic', [10, 0], [30, 10], [26, 2]);
        const conic = g().curves.find((c) => c.kind === 'conic') as Extract<SketchCurve, { kind: 'conic' }>;
        expect(conic).toBeTruthy();
        expect(at(g(), conic.apex)[0]).toBeCloseTo(30, 6);
        expect(at(g(), conic.apex)[1]).toBeCloseTo(0, 6);
        expect(conic.rho).toBeCloseTo(0.6, 6);
        expect(g().constraints.filter((k) => k.kind === 'tangent')).toHaveLength(2);
        expect(solveGeometry(g()).ok).toBe(true);
        setDrawOptions({ conicAutoTangency: false });
    });

    it('holds a point on a conic, and takes a Rho dimension', () => {
        let geometry: SketchGeometry = { points: [{ id: 's', u: 0, v: 0 }, { id: 't', u: 5, v: 5 }, { id: 'e', u: 10, v: 0 }, { id: 'q', u: 3, v: 3 }],
            curves: [{ id: 'k', kind: 'conic', start: 's', end: 'e', apex: 't', rho: 0.6 }], constraints: [] };
        geometry = lockAll(geometry, ['s', 't', 'e']);
        const free = solveGeometry(geometry).dof;
        const on = relationsFromPicks(geometry, 'coincident', [{ type: 'point', id: 'q' }, { type: 'curve', id: 'k' }]);
        if ('need' in on) {
            throw new Error(on.need);
        }
        const held = solveGeometry(add(geometry, on));
        expect(held.ok).toBe(true);
        expect(held.dof).toBe(free - 1);
        const q = at(held.geometry, 'q');
        let best = Infinity;
        for (let i = 0; i <= 20000; i++) {
            const p = conicAt([0, 0], [5, 5], [10, 0], 0.6, i / 20000);
            best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
        }
        expect(best).toBeLessThan(1e-3);
        // Rho as a dimension: driving sets it, driven follows it.
        const dim = dimensionFromPicks(geometry, [{ type: 'curve', id: 'k' }], [5, 8]);
        expect(dim).toMatchObject({ kind: 'rho', curve: 'k' });
        const driving = solveGeometry(addConstraint(geometry, { kind: 'rho', curve: 'k', value: 0.7 }).g);
        expect(driving.ok).toBe(true);
        expect((driving.geometry.curves[0] as { rho: number }).rho).toBe(0.7);
        const k = driving.geometry.constraints.find((c) => c.kind === 'rho')!;
        expect(measure(driving.geometry, k)).toBe(0.7);
        // A Rho of 1 or more cannot hold.
        const bad = solveGeometry(addConstraint(geometry, { kind: 'rho', curve: 'k', value: 1.2 }).g);
        expect(unmetConstraints(bad.geometry).length).toBeGreaterThan(0);
    });
});

describe('make path', () => {
    beforeEach(() => start());

    it('orders a chain, refuses branches and a second path', () => {
        const a = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        const b = addLine(a.g, { at: [10, 0], point: a.b }, { at: [10, 10] });
        const c = addLine(b.g, { at: [10, 10], point: b.b }, { at: [0, 10] });
        const made = makePath(c.g, [c.id, a.id, b.id]);
        if ('error' in made) {
            throw new Error(made.error);
        }
        // In chain order, from either free end.
        expect([[a.id, b.id, c.id].join(), [c.id, b.id, a.id].join()]).toContain(made.g.paths![0].curves.join());
        expect(makePath(made.g, [a.id])).toMatchObject({ error: expect.stringContaining('one path only') });
        const branch = addLine(c.g, { at: [10, 0], point: a.b }, { at: [20, 0] });
        expect(makePath(branch.g, [a.id, b.id, branch.id])).toMatchObject({ error: expect.stringContaining('branch') });
        // Clicking one of its curves selects the whole path.
        start(made.g);
        setTool('select');
        sketchClick([5, 0], TOL);
        expect(state().selection.map((x) => x.id).sort()).toEqual([a.id, b.id, c.id].sort());
    });

    it('keeps a follower tangent to whichever member it touches, and moves on as it slides', () => {
        // A cam profile: a flat run, then a ramp.
        const a = addLine(EMPTY_GEOMETRY, { at: [-20, 0] }, { at: [0, 0] });
        const b = addLine(a.g, { at: [0, 0], point: a.b }, { at: [20, 10] });
        let geometry = lockAll(b.g, b.g.points.map((p) => p.id));
        const path = makePath(geometry, [a.id, b.id]) as { g: SketchGeometry; id: string };
        // A roller of radius 2 that can only slide up and down at x = -10.
        const roller = addCircle(path.g, { at: [-10, 5] }, 2);
        geometry = addConstraint(roller.g, { kind: 'fix', point: roller.center, axis: 'u' }).g;
        geometry = addConstraint(geometry, { kind: 'fixRadius', curve: roller.id }).g;
        const rel = relationsFromPicks(geometry, 'tangent', [{ type: 'curve', id: a.id }, { type: 'curve', id: roller.id }]);
        if ('need' in rel) {
            throw new Error(rel.need);
        }
        expect(rel[0]).toMatchObject({ kind: 'pathTangent', path: path.id, curve: roller.id });
        geometry = add(geometry, rel);
        const flat = solveGeometry(geometry);
        expect(flat.ok).toBe(true);
        expect(at(flat.geometry, roller.center)[1]).toBeCloseTo(2, 6);
        // Slid along step by step (as a drag does) to x = 10: past the corner it rides up the ramp.
        let now = flat.geometry;
        for (let x = -9; x <= 10; x += 1) {
            const step = solveGeometry({ ...now, points: now.points.map((p) => (p.id === roller.center ? { ...p, u: x } : p)) });
            expect(step.ok).toBe(true);
            now = step.geometry;
        }
        const centre = at(now, roller.center);
        expect(centre[0]).toBeCloseTo(10, 9);
        expect(distToLine(centre, [0, 0], [20, 10])).toBeCloseTo(2, 6);
        expect(centre[1]).toBeGreaterThan(5);
    });

    it('drives a path length, set in its form', () => {
        const a = addLine(EMPTY_GEOMETRY, { at: [0, 0], point: ORIGIN }, { at: [10, 0] }, 'horizontal');
        const b = addLine(a.g, { at: [10, 0], point: a.b }, { at: [10, 5] }, 'vertical');
        start(b.g);
        const before = solveGeometry(g()).dof;
        const r = applyPath([a.id, b.id], null, { show: true, driving: true, value: 20 });
        expect(r).toMatchObject({ id: expect.any(String) });
        const solved = solveGeometry(g());
        expect(solved.dof).toBe(before - 1);
        const dim = g().constraints.find((k) => k.kind === 'pathLength')!;
        expect(dim).toMatchObject({ value: 20 });
        expect(measure(g(), dim)).toBeCloseTo(20, 6);
        expect(pathLength(g(), g().paths![0])).toBeCloseTo(20, 6);
        // Deleting a member breaks the path: it goes, with its dimension's curve.
        commitGeometry({ ...g(), curves: g().curves.filter((c) => c.id !== b.id), constraints: g().constraints.filter((k) => k.kind !== 'pathLength' && !(k.kind === 'vertical')) });
        expect(g().paths ?? []).toEqual([]);
    });
});

describe('belt / chain', () => {
    beforeEach(() => start());

    /** Two pulleys: radius 5 at the origin (locked) and radius 3 at (30, 0), its centre free to slide along u. */
    function pulleys(): { g: SketchGeometry; big: string; small: string; smallCentre: string } {
        const big = addCircle(EMPTY_GEOMETRY, { at: [0, 0], point: ORIGIN }, 5);
        const small = addCircle(big.g, { at: [30, 0] }, 3);
        let geometry = addConstraint(small.g, { kind: 'fixRadius', curve: big.id }).g;
        geometry = addConstraint(geometry, { kind: 'fixRadius', curve: small.id }).g;
        geometry = addConstraint(geometry, { kind: 'fix', point: small.center, axis: 'v' }).g;
        return { g: geometry, big: big.id, small: small.id, smallCentre: small.center };
    }

    const openBelt = (d: number, r1: number, r2: number) => {
        const beta = Math.asin((r1 - r2) / d);
        return 2 * Math.sqrt(d * d - (r1 - r2) ** 2) + Math.PI * (r1 + r2) + 2 * beta * (r1 - r2);
    };

    it('runs a belt round two pulleys: tangent lines and arcs, one closed path', () => {
        const p = pulleys();
        start(p.g);
        const free = solveGeometry(g()).dof;
        const r = applyBelt({ pulleys: [p.big, p.small], flip: [false, false] }, null);
        expect(r).toMatchObject({ id: expect.any(String) });
        const path = g().paths!.find((x) => x.belt)!;
        expect(path.curves).toHaveLength(4);
        const solved = solveGeometry(g());
        expect(solved.ok).toBe(true);
        expect(solved.dof).toBe(free);
        expect(unmetConstraints(solved.geometry)).toEqual([]);
        expect(pathLength(g(), path)).toBeCloseTo(openBelt(30, 5, 3), 6);
        // Plain lines and arcs for the kernel: the belt is one closed loop round the two pulleys, nothing left open.
        const built = geometryProfiles(g());
        expect(built.open).toBe(0);
        expect(built.profiles).toHaveLength(3);
        // Each run is tangent to both pulleys.
        for (const l of lines(g())) {
            const [a, b] = [at(g(), l.a), at(g(), l.b)];
            expect(distToLine([0, 0], a, b)).toBeCloseTo(5, 6);
            expect(distToLine([30, 0], a, b)).toBeCloseTo(3, 6);
        }
    });

    it('keeps its thickness off the pulleys, and drives the layout with its length', () => {
        const p = pulleys();
        start(p.g);
        applyBelt({ pulleys: [p.big, p.small], flip: [false, false], thickness: 1, length: openBelt(40, 6, 4) }, null);
        const solved = solveGeometry(g());
        expect(solved.ok).toBe(true);
        expect(at(g(), p.smallCentre)[0]).toBeCloseTo(40, 4);
        const arcs = g().curves.filter((c) => c.kind === 'arc');
        expect(arcs.map((c) => curveRadius(g(), c.id)!).sort()).toEqual([expect.closeTo(4, 6), expect.closeTo(6, 6)]);
    });

    it('crosses the belt when one pulley is flipped', () => {
        const p = pulleys();
        start(p.g);
        applyBelt({ pulleys: [p.big, p.small], flip: [false, true] }, null);
        const [l1, l2] = lines(g());
        // Crossed runs: each pulley centre on opposite sides of a run.
        const side = (q: [number, number], a: [number, number], b: [number, number]) => Math.sign((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]));
        for (const l of [l1, l2]) {
            const [a, b] = [at(g(), l.a), at(g(), l.b)];
            expect(side([0, 0], a, b)).toBe(-side([30, 0], a, b));
        }
        expect(solveGeometry(g()).ok).toBe(true);
    });

    it('is rebuilt when edited, in place of the old belt', () => {
        const p = pulleys();
        start(p.g);
        const first = applyBelt({ pulleys: [p.big, p.small], flip: [false, false] }, null) as { id: string };
        const count = g().curves.length;
        applyBelt({ pulleys: [p.big, p.small], flip: [false, false], thickness: 2 }, first.id);
        expect(g().curves.length).toBe(count);
        expect(g().paths!.filter((x) => x.belt)).toHaveLength(1);
        expect(g().paths![0].belt!.thickness).toBe(2);
        const c: SketchConstraint | undefined = g().constraints.find((k) => k.kind === 'tangent');
        expect(c).toBeTruthy();
        expect(AXIS_U).toBe('axis-u');
    });
});
