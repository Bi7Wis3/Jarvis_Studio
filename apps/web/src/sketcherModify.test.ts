import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { curveOf, loadSolver, pointOf } from './solver';
import { addLine, addRect, EMPTY_GEOMETRY } from './sketchGeometry';
import {
    DEFAULT_EDIT_OPTIONS, finishEditTool, setEditOptions, setTool, startEditTool, stretchSelected, transformSelected, sketchClick, sketchDown, sketchMove, sketchUp, undoSketch, useSketcher,
} from './sketcher';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const TOL = 1;
const state = () => useSketcher.getState();
const lines = (g: SketchGeometry) => g.curves.filter((c): c is Extract<SketchCurve, { kind: 'line' }> => c.kind === 'line');
const top = (g: SketchGeometry, id: string) => {
    const l = curveOf(g, id) as Extract<SketchCurve, { kind: 'line' }>;
    return Math.max(pointOf(g, l.a)!.v, pointOf(g, l.b)!.v);
};

function start(g: SketchGeometry) {
    useSketcher.setState({
        active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], picks: [], editOptions: DEFAULT_EDIT_OPTIONS, message: null,
    });
}

/** Three vertical lines at u = 0, 10, 20 and a horizontal line across them. */
function comb() {
    let g = EMPTY_GEOMETRY;
    const ids: string[] = [];
    for (const u of [0, 10, 20]) {
        const r = addLine(g, { at: [u, -10] }, { at: [u, 10] });
        g = r.g;
        ids.push(r.id);
    }
    const across = addLine(g, { at: [-10, 0] }, { at: [30, 0] });
    return { g: across.g, verticals: ids, across: across.id };
}

describe('offset form', () => {
    it('starts from the selected curves and applies the form distance with OK, Reverse flipping the side', () => {
        const rect = addRect(EMPTY_GEOMETRY, [0, 0], [40, 20]);
        start(rect.g);
        useSketcher.setState({ selection: [{ type: 'curve', id: rect.lines[0] }], cursor: null });
        startEditTool('offset');
        expect(state().offsetCurve).toBe(rect.lines[0]);
        setEditOptions({ offsetDistance: 2 });
        expect(finishEditTool('offset')).toBeNull();
        // Left of a counter-clockwise rectangle: inside.
        const vs = state().geometry.points.map((p) => p.v);
        expect(vs.some((v) => Math.abs(v - 2) < 1e-6)).toBe(true);
        expect(state().undo).toHaveLength(1);
        // Reverse: outside; Select chain off: that side alone.
        useSketcher.setState({ selection: [{ type: 'curve', id: rect.lines[0] }], cursor: null });
        startEditTool('offset');
        setEditOptions({ offsetReverse: true, offsetChain: false });
        expect(finishEditTool('offset')).toBeNull();
        expect(state().geometry.curves.filter((c) => !c.construction)).toHaveLength(9);
        expect(state().geometry.points.some((p) => Math.abs(p.v + 2) < 1e-6)).toBe(true);
    });
});

describe('fillet, chamfer and mirror forms', () => {
    it('fillets the selected corners with OK, the later ones equal to the first', () => {
        const rect = addRect(EMPTY_GEOMETRY, [0, 0], [40, 20]);
        start(rect.g);
        const corners = [...new Set(lines(rect.g).flatMap((l) => [l.a, l.b]))];
        useSketcher.setState({ selection: corners.slice(0, 2).map((id) => ({ type: 'point' as const, id })) });
        startEditTool('fillet');
        expect(state().picks).toHaveLength(2);
        setEditOptions({ filletRadius: 3 });
        expect(finishEditTool('fillet')).toBeNull();
        const g = state().geometry;
        expect(g.curves.filter((c) => c.kind === 'arc')).toHaveLength(2);
        expect(g.constraints.filter((k) => k.kind === 'radius')).toHaveLength(1);
        expect(g.constraints.filter((k) => k.kind === 'equal')).toHaveLength(1);
    });

    it('chamfers a corner at an angle, from the form options', () => {
        const rect = addRect(EMPTY_GEOMETRY, [0, 0], [40, 20]);
        start(rect.g);
        setTool('chamfer');
        setEditOptions({ chamferType: 'angle', chamferAngle: 30, chamferDistance: 4 });
        sketchClick([0, 0], TOL);
        expect(state().geometry.constraints.some((k) => k.kind === 'angle' && Math.abs(k.value - 30) < 1e-9)).toBe(true);
    });

    it('mirrors without keeping the originals when Copy is off', () => {
        const l = addLine(EMPTY_GEOMETRY, { at: [5, 0] }, { at: [15, 10] });
        start(l.g);
        useSketcher.setState({ selection: [{ type: 'curve', id: l.id }] });
        startEditTool('mirror');
        setEditOptions({ mirrorCopy: false });
        sketchClick([0, 30], TOL);
        const g = state().geometry;
        expect(g.curves).toHaveLength(1);
        expect(Math.max(...g.points.map((p) => p.u))).toBeLessThan(0);
    });
});

describe('move with Keep relations, copies, stretch', () => {
    /** Two lines sharing a corner at (10, 0): (0, 0)-(10, 0) and (10, 0)-(10, 10). */
    function corner() {
        const a = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        const b = addLine(a.g, { at: [10, 0], point: a.b }, { at: [10, 10] });
        return { g: b.g, first: a.id, second: b.id, shared: a.b };
    }

    it('moves a line keeping its relations: the attached line stretches along instead of splitting', () => {
        const s = corner();
        start(s.g);
        useSketcher.setState({ selection: [{ type: 'curve', id: s.second }] });
        expect(transformSelected({ kind: 'move', by: [5, 0] }, false, { keepRelations: true })).toBeNull();
        const g = state().geometry;
        expect(g.points).toHaveLength(s.g.points.length);
        expect(pointOf(g, s.shared)!.u).toBeCloseTo(15, 5);
        expect(state().undo).toHaveLength(1);
        // Without it, the shared corner is split off.
        start(s.g);
        useSketcher.setState({ selection: [{ type: 'curve', id: s.second }] });
        transformSelected({ kind: 'move', by: [5, 0] }, false);
        expect(state().geometry.points.length).toBe(s.g.points.length + 1);
    });

    it('says so when the relations do not let it move', () => {
        const s = corner();
        const locked = { ...s.g, constraints: [...s.g.constraints, { id: 'lock', kind: 'fix' as const, point: s.shared }] };
        start(locked);
        useSketcher.setState({ selection: [{ type: 'curve', id: s.second }] });
        expect(transformSelected({ kind: 'move', by: [5, 0] }, false, { keepRelations: true })).toMatch(/Keep relations/);
        expect(state().undo).toHaveLength(0);
    });

    it('makes a number of copies, each a step further, in one undo step', () => {
        const s = corner();
        start(s.g);
        useSketcher.setState({ selection: [{ type: 'curve', id: s.first }] });
        expect(transformSelected({ kind: 'move', by: [0, 20] }, true, { copies: 3 })).toBeNull();
        const vs = new Set(state().geometry.points.map((p) => Math.round(p.v)));
        expect([20, 40, 60].every((v) => vs.has(v))).toBe(true);
        expect(state().undo).toHaveLength(1);
    });

    it('stretches: the selected point moves, attached lines stretch and the rest stays', () => {
        const s = corner();
        start(s.g);
        useSketcher.setState({ selection: [{ type: 'point', id: s.shared }] });
        expect(stretchSelected([3, 4])).toBeNull();
        const g = state().geometry;
        expect(pointOf(g, s.shared)).toMatchObject({ u: 13, v: 4 });
        const far = (curveOf(g, s.second) as Extract<SketchCurve, { kind: 'line' }>).b;
        expect(pointOf(g, far)).toMatchObject({ u: 10, v: 10 });
    });
});

describe('trim tool', () => {
    let s: ReturnType<typeof comb>;
    beforeEach(() => {
        s = comb();
        start(s.g);
        setTool('trim');
    });

    it('power trims along a drag in one undo step, instead of turning the view', () => {
        expect(sketchDown([-5, 5], TOL)).toBe(true);
        sketchMove([5, 5], TOL);
        sketchMove([25, 5], TOL);
        expect(state().editPreview.length).toBeGreaterThan(0);
        sketchUp();
        const g = state().geometry;
        s.verticals.forEach((id) => expect(top(g, id)).toBeCloseTo(0, 5));
        expect(state().undo).toHaveLength(1);
        expect(state().message).toMatch(/Trimmed 3 pieces/);
        undoSketch();
        s.verticals.forEach((id) => expect(top(state().geometry, id)).toBeCloseTo(10, 5));
    });

    it('still trims by a click, without a drag', () => {
        expect(sketchDown([10, 5], TOL)).toBe(true);
        sketchUp();
        sketchClick([10, 5], TOL);
        expect(top(state().geometry, s.verticals[1])).toBeCloseTo(0, 5);
        expect(top(state().geometry, s.verticals[0])).toBeCloseTo(10, 5);
    });

    it('trims away inside two picked boundaries, and to a corner', () => {
        setEditOptions({ trimMode: 'inside' });
        // Not a stroke in this mode: the press is left to the camera.
        expect(sketchDown([0, 5], TOL)).toBe(false);
        sketchClick([0, 5], TOL);
        sketchClick([20, 5], TOL);
        expect(state().picks).toHaveLength(2);
        sketchClick([5, 0], TOL);
        expect(lines(state().geometry)).toHaveLength(5);
        expect(state().message).toBeNull();

        start(s.g);
        setTool('trim');
        setEditOptions({ trimMode: 'corner' });
        sketchClick([-5, 0], TOL);
        sketchClick([10, -5], TOL);
        const g = state().geometry;
        const across = curveOf(g, s.across) as Extract<SketchCurve, { kind: 'line' }>;
        const xs = [pointOf(g, across.a)!.u, pointOf(g, across.b)!.u].sort((a, b) => a - b);
        expect(xs).toEqual([-10, 10]);
        expect(top(g, s.verticals[1])).toBeCloseTo(0, 5);
    });
});
