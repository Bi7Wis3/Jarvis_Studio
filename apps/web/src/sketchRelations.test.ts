// Relation tools (multi-selection, new relations, lock, redundancy), and the drawing gaps fixed with them: slot and
// centre-arc snapping, Enter, typed-value errors, dimensions to circles, angle quadrants and entity status.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import { curveRadius, loadSolver, measure, pointOf, solveGeometry } from './solver';
import {
    EMPTY_GEOMETRY, addCircle, addConstraint, addLine, addRect, addSlot, dimensionFromPicks, relationsFromPicks, type Pick,
} from './sketchGeometry';
import {
    applyDimension, constraintTool, deleteConstraints, enterKey, setDimText, setTool, sketchClick, sketchMove, sketchUp, sketchDown, toggleLock, typeKey, useSketcher,
} from './sketcher';
import { markFor } from './sketchState';
import { definedEntities } from './sketchStatus';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const TOL = 1;
const state = () => useSketcher.getState();
const curve = (id: string): Pick => ({ type: 'curve', id });
const point = (id: string): Pick => ({ type: 'point', id });
const at = (g: SketchGeometry, id: string) => {
    const p = pointOf(g, id)!;
    return [p.u, p.v];
};
const lengthOf = (g: SketchGeometry, id: string) => {
    const line = g.curves.find((c) => c.id === id);
    if (line?.kind !== 'line') {
        return NaN;
    }
    const [a, b] = [at(g, line.a), at(g, line.b)];
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
};

function begin(g: SketchGeometry, tool: Parameters<typeof setTool>[0] = 'select') {
    useSketcher.setState({
        active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], picks: [], typed: '', draft: [], message: null,
        conflicting: [], redundant: [], dimDraft: null, dimDrag: null, snapKinds: {}, labels: {},
    });
    setTool(tool);
}

describe('relations from picks', () => {
    const r = addRect(EMPTY_GEOMETRY, [0, 0], [40, 10]);
    const g = r.g;

    it('relates every picked line to the first for equal and parallel, and each line for horizontal', () => {
        expect(relationsFromPicks(g, 'equal', r.lines.map(curve))).toHaveLength(3);
        const lines = addLine(addLine(g, { at: [0, 20] }, { at: [10, 25] }).g, { at: [0, 30] }, { at: [10, 33] });
        const slanted = lines.g.curves.slice(-2).map((c) => curve(c.id));
        expect(relationsFromPicks(lines.g, 'horizontal', slanted)).toEqual(slanted.map((p) => ({ kind: 'horizontal', line: p.id })));
        expect(relationsFromPicks(lines.g, 'parallel', [curve(r.lines[0]), ...slanted])).toHaveLength(2);
    });

    it('takes two or more points for horizontal, vertical, coincident and merge', () => {
        const pts = g.points.map((p) => point(p.id));
        expect(relationsFromPicks(g, 'vertical', pts.slice(0, 2))).toEqual([{ kind: 'verticalPoints', a: pts[0].id, b: pts[1].id }]);
        expect(relationsFromPicks(g, 'coincident', pts.slice(0, 3))).toHaveLength(2);
        expect(relationsFromPicks(g, 'merge', [pts[0], curve(r.lines[0])])).toHaveProperty('need');
        // Several points onto one curve.
        expect(relationsFromPicks(g, 'coincident', [pts[0], pts[2], curve(r.lines[1])])).toEqual([
            { kind: 'pointOnCurve', point: pts[0].id, curve: r.lines[1] }, { kind: 'pointOnCurve', point: pts[2].id, curve: r.lines[1] },
        ]);
    });

    it('refuses sets the relation does not take', () => {
        expect(relationsFromPicks(g, 'perpendicular', r.lines.slice(0, 3).map(curve))).toHaveProperty('need');
        expect(relationsFromPicks(g, 'equal', [curve(r.lines[0])])).toHaveProperty('need');
        const c = addCircle(g, { at: [60, 0] }, 5);
        expect(relationsFromPicks(c.g, 'equal', [curve(r.lines[0]), curve(c.id)])).toHaveProperty('need');
        expect(relationsFromPicks(c.g, 'horizontal', [curve(c.id)])).toHaveProperty('need');
    });
});

describe('relation tools', () => {
    it('makes all four selected rectangle sides equal (a square), leaving out the pair that already holds', () => {
        const r = addRect(EMPTY_GEOMETRY, [0, 0], [40, 10]);
        begin(r.g);
        useSketcher.setState({ selection: r.lines.map((id) => ({ type: 'curve', id })) });
        constraintTool('equal');
        const g = state().geometry;
        const lengths = r.lines.map((id) => lengthOf(g, id));
        for (const l of lengths) {
            expect(l).toBeCloseTo(lengths[0], 4);
        }
        expect(g.constraints.filter((c) => c.kind === 'equal')).toHaveLength(2);
        expect(state().redundant).toEqual([]);
        expect(state().message).toMatch(/already held/);
        expect(state().selection).toEqual([]);
    });

    it('makes several selected lines horizontal at once, and two points level', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 3] }).g;
        g = addLine(g, { at: [0, 10] }, { at: [10, 14] }).g;
        const p = g.points.find((q) => q.u === 0 && q.v === 10)!.id;
        g = { ...g, points: [...g.points, { id: 'px', u: 20, v: 30 }] };
        begin(g);
        useSketcher.setState({ selection: g.curves.map((c) => ({ type: 'curve', id: c.id })) });
        constraintTool('horizontal');
        let s = state().geometry;
        for (const c of s.curves) {
            if (c.kind === 'line') {
                expect(at(s, c.a)[1]).toBeCloseTo(at(s, c.b)[1], 5);
            }
        }
        useSketcher.setState({ selection: [{ type: 'point', id: p }, { type: 'point', id: 'px' }] });
        constraintTool('horizontal');
        s = state().geometry;
        expect(at(s, p)[1]).toBeCloseTo(at(s, 'px')[1], 5);
        expect(s.constraints.some((c) => c.kind === 'horizontalPoints')).toBe(true);
    });

    it('picks in the view until the set fits, keeping two points for horizontal', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 3] }).g;
        g = { ...g, points: [...g.points, { id: 'px', u: 20, v: 30 }] };
        begin(g);
        constraintTool('horizontal');
        expect(state().tool).toBe('c:horizontal');
        sketchClick([20, 30], TOL);
        expect(state().picks).toHaveLength(1);
        sketchClick([10, 3], TOL);
        const s = state().geometry;
        expect(at(s, 'px')[1]).toBeCloseTo(at(s, g.curves[0].kind === 'line' ? g.curves[0].b : '')[1], 5);
    });

    it('merges selected points into one', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        g = addLine(g, { at: [12, 1] }, { at: [20, 5] }).g;
        const [l1, l2] = g.curves as Extract<SketchGeometry['curves'][number], { kind: 'line' }>[];
        begin(g);
        useSketcher.setState({ selection: [{ type: 'point', id: l1.b }, { type: 'point', id: l2.a }] });
        constraintTool('merge');
        const s = state().geometry;
        expect(s.points.some((p) => p.id === l2.a)).toBe(false);
        expect(s.curves.find((c) => c.id === l2.id)).toMatchObject({ a: l1.b });
        // The two ends of one line cannot be merged.
        useSketcher.setState({ selection: [{ type: 'point', id: l1.a }, { type: 'point', id: l1.b }] });
        constraintTool('merge');
        expect(state().message).toMatch(/collapse/);
    });

    it('adds concentric, coradial and collinear relations', () => {
        let g = addCircle(EMPTY_GEOMETRY, { at: [0, 0] }, 5).g;
        g = addCircle(g, { at: [3, 4] }, 8).g;
        const [c1, c2] = g.curves.map((c) => c.id);
        begin(g);
        useSketcher.setState({ selection: [{ type: 'curve', id: c1 }, { type: 'curve', id: c2 }] });
        constraintTool('concentric');
        let s = state().geometry;
        const centre = (id: string) => {
            const c = s.curves.find((k) => k.id === id);
            return c && c.kind !== 'line' ? at(s, c.center) : [NaN, NaN];
        };
        expect(centre(c1)[0]).toBeCloseTo(centre(c2)[0], 5);
        expect(curveRadius(s, c1)).not.toBeCloseTo(curveRadius(s, c2)!, 3);
        useSketcher.setState({ geometry: g, selection: [{ type: 'curve', id: c1 }, { type: 'curve', id: c2 }] });
        constraintTool('coradial');
        s = state().geometry;
        expect(centre(c1)[1]).toBeCloseTo(centre(c2)[1], 5);
        expect(curveRadius(s, c1)).toBeCloseTo(curveRadius(s, c2)!, 5);

        let lines = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        lines = addLine(lines, { at: [15, 2] }, { at: [25, 3] }).g;
        begin(lines);
        useSketcher.setState({ selection: lines.curves.map((c) => ({ type: 'curve', id: c.id })) });
        constraintTool('collinear');
        s = state().geometry;
        const [first, second] = s.curves;
        if (first.kind === 'line' && second.kind === 'line') {
            // The second line's ends lie on the first one's infinite line.
            const [p, q] = [at(s, first.a), at(s, first.b)];
            const off = (r: number[]) => ((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / Math.hypot(q[0] - p[0], q[1] - p[1]);
            expect(off(at(s, second.a))).toBeCloseTo(0, 5);
            expect(off(at(s, second.b))).toBeCloseTo(0, 5);
        }
    });

    it('locks a circle in place and at its size, and unlocks it', () => {
        const c = addCircle(EMPTY_GEOMETRY, { at: [10, 10] }, 5);
        begin(c.g);
        toggleLock([curve(c.id)]);
        expect(state().geometry.constraints.map((k) => k.kind).sort()).toEqual(['fix', 'fixRadius']);
        expect(state().dof).toBe(0);
        toggleLock([curve(c.id)]);
        expect(state().geometry.constraints).toEqual([]);
        expect(state().dof).toBe(3);
    });
});

describe('over defined', () => {
    it('reports a relation that repeats others, marks the sketch (+), and clears when it goes', () => {
        const r = addRect(EMPTY_GEOMETRY, [0, 0], [40, 10]);
        begin(r.g);
        useSketcher.setState({ selection: [{ type: 'curve', id: r.lines[0] }] });
        constraintTool('horizontal');
        expect(state().geometry.constraints.filter((c) => c.kind === 'horizontal')).toHaveLength(3);
        expect(state().redundant).toHaveLength(1);
        expect(state().message).toMatch(/Over defined/);
        expect(markFor(solveGeometry(state().geometry))).toBe('(+) ');
        deleteConstraints(state().redundant);
        expect(state().redundant).toEqual([]);
        expect(markFor(solveGeometry(state().geometry))).toBe('(-) ');
    });

    it('solves a slot without redundant tangents: two centres and a radius left free', () => {
        const r = solveGeometry(addSlot(EMPTY_GEOMETRY, [0, 0], [20, 0], 3).g);
        expect(r.redundant).toEqual([]);
        expect(r.dof).toBe(5);
    });
});

describe('drawing', () => {
    it('starts a slot on the origin and on an existing point', () => {
        const g = addLine(EMPTY_GEOMETRY, { at: [30, 20] }, { at: [40, 20] }).g;
        const end = g.points[0].id;
        begin(g, 'slot');
        sketchClick([0, 0], TOL);
        sketchClick([30, 20], TOL);
        sketchClick([15, 13], TOL);
        const arcs = state().geometry.curves.filter((c) => c.kind === 'arc');
        expect(arcs.map((c) => c.kind === 'arc' && c.center).sort()).toEqual([end, 'origin'].sort());
        expect(state().redundant).toEqual([]);
    });

    it('joins a centre arc end to the point it snapped to', () => {
        const g = addLine(EMPTY_GEOMETRY, { at: [0, 10] }, { at: [-20, 10] }).g;
        const end = g.points[0].id;
        begin(g, 'centerArc');
        sketchClick([0, 0], TOL);
        sketchClick([10, 0], TOL);
        sketchMove([7, 7], TOL);
        sketchMove([0, 10], TOL);
        sketchClick([0, 10], TOL);
        const arc = state().geometry.curves.find((c) => c.kind === 'arc');
        expect(arc).toMatchObject({ kind: 'arc', center: 'origin', end });
    });

    it('sizes a circle on a point: the circle passes through it', () => {
        const g = { ...EMPTY_GEOMETRY, points: [{ id: 'px', u: 10, v: 0 }] };
        begin(g, 'circle');
        sketchClick([0, 0], TOL);
        sketchClick([10, 0], TOL);
        expect(state().geometry.constraints).toContainEqual(expect.objectContaining({ kind: 'pointOnCurve', point: 'px' }));
    });

    it('ends a line chain with Enter instead of leaving the sketch, and leaves only when idle', () => {
        begin(EMPTY_GEOMETRY, 'line');
        sketchClick([0, 0], TOL);
        sketchClick([10, 0], TOL);
        expect(state().draft).toHaveLength(1);
        expect(enterKey()).toBe('done');
        expect(state().draft).toHaveLength(0);
        expect(state().active).toBe(true);
        expect(enterKey()).toBe('exit');
    });

    it('applies a typed value with Enter and shows its error in the status line', () => {
        begin(EMPTY_GEOMETRY, 'arc');
        sketchClick([0, 0], TOL);
        sketchClick([20, 0], TOL);
        typeKey('2');
        expect(enterKey()).toBe('done');
        expect(state().message).toMatch(/radius must be at least/);
        expect(state().draft).toHaveLength(2);
        begin(EMPTY_GEOMETRY, 'line');
        sketchClick([0, 0], TOL);
        typeKey('/');
        enterKey();
        expect(state().message).toMatch(/Type a number/);
    });

    it('keeps a typed line angle as drawn, below the axis too', () => {
        begin(EMPTY_GEOMETRY, 'line');
        sketchClick([0, 0], TOL);
        for (const k of '20,-30') {
            typeKey(k);
        }
        enterKey();
        const g = state().geometry;
        const angle = g.constraints.find((c) => c.kind === 'angle')!;
        expect(angle).toMatchObject({ value: 30 });
        expect(measure(g, angle)).toBeCloseTo(30, 5);
        const end = g.points.find((p) => p.id !== 'origin' && Math.abs(p.u) > 1)!;
        expect(end.v).toBeLessThan(0);
    });
});

describe('smart dimension', () => {
    let g: SketchGeometry;
    let line: string;
    let c1: string;
    let c2: string;
    beforeEach(() => {
        const l = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [40, 0] });
        let next = addCircle(l.g, { at: [10, 20] }, 3);
        c1 = next.id;
        next = addCircle(next.g, { at: [30, 20] }, 4);
        c2 = next.id;
        g = { ...next.g, points: [...next.g.points, { id: 'px', u: 50, v: 20 }] };
        line = l.id;
    });

    it('measures to the centre of a circle from a point, a line and another circle', () => {
        const centre = (id: string) => {
            const c = g.curves.find((k) => k.id === id);
            return c?.kind === 'circle' ? c.center : '';
        };
        expect(dimensionFromPicks(g, [point('px'), curve(c2)], [40, 25])).toMatchObject({ kind: 'distance', a: 'px', b: centre(c2), axis: 'u' });
        expect(dimensionFromPicks(g, [curve(line), curve(c1)], [5, 10])).toMatchObject({ kind: 'distance', a: centre(c1), b: line });
        const cc = dimensionFromPicks(g, [curve(c1), curve(c2)], [20, 30]);
        expect(cc).toMatchObject({ kind: 'distance', a: centre(c1), b: centre(c2) });
        expect(measure(g, { ...cc!, id: 'm' } as never)).toBeCloseTo(20);
    });

    it('sets a circle-to-circle distance with the dimension tool', () => {
        begin(g, 'dimension');
        sketchClick([10, 23], TOL);
        sketchClick([34, 20], TOL);
        sketchClick([20, 35], TOL);
        expect(state().dimDraft?.constraint).toMatchObject({ kind: 'distance', axis: 'u' });
        setDimText('25');
        applyDimension();
        const s = state().geometry;
        const centre = (id: string) => {
            const c = s.curves.find((k) => k.id === id);
            return c?.kind === 'circle' ? at(s, c.center) : [NaN, NaN];
        };
        expect(centre(c2)[0] - centre(c1)[0]).toBeCloseTo(25, 4);
    });
});

describe('angle dimensions', () => {
    // Two lines from the origin: along +u, and at 60 degrees.
    function lines() {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0], point: 'origin' }, { at: [20, 0] }).g;
        g = addLine(g, { at: [0, 0], point: 'origin' }, { at: [10, 10 * Math.sqrt(3)] }).g;
        return g;
    }

    it('dimensions the angle the label is placed in', () => {
        const g = lines();
        const [a, b] = g.curves.map((c) => curve(c.id));
        const inside = dimensionFromPicks(g, [a, b], [10, 4])!;
        expect(measure(g, { ...inside, id: 'm' } as never)).toBeCloseTo(60, 4);
        const beside = dimensionFromPicks(g, [a, b], [-6, 6])!;
        expect(measure(g, { ...beside, id: 'm' } as never)).toBeCloseTo(120, 4);
        const below = dimensionFromPicks(g, [a, b], [3, -8])!;
        expect(measure(g, { ...below, id: 'm' } as never)).toBeCloseTo(120, 4);
    });

    it('keeps a typed obtuse value as typed, in the quadrant it was placed in', () => {
        const g = lines();
        begin(g, 'dimension');
        const [a, b] = g.curves.map((c) => c.id);
        useSketcher.setState({ picks: [curve(a), curve(b)] });
        sketchClick([-6, 6], TOL);
        expect(state().dimDraft?.text).toBe('120');
        setDimText('100');
        applyDimension();
        const s = state().geometry;
        const dim = s.constraints.find((c) => c.kind === 'angle')!;
        expect(dim).toMatchObject({ value: 100 });
        expect(measure(s, dim)).toBeCloseTo(100, 4);
        // The lines themselves are 80 degrees apart now (the supplement is the other side).
        const [la, lb] = s.curves;
        if (la.kind === 'line' && lb.kind === 'line') {
            const dir = (l: typeof la) => {
                const [p, q] = [at(s, l.a), at(s, l.b)];
                return Math.atan2(q[1] - p[1], q[0] - p[0]);
            };
            expect((Math.abs(dir(lb) - dir(la)) * 180) / Math.PI).toBeCloseTo(80, 3);
        }
    });

    it('drags a dimension out between two lines', () => {
        begin(lines(), 'dimension');
        expect(sketchDown([15, 0.3], TOL)).toBe(true);
        sketchUp();
        sketchClick([15, 0.3], TOL);
        sketchClick([5, 8.66], TOL);
        sketchClick([-6, 6], TOL);
        expect(state().dimDraft?.text).toBe('120');
    });
});

describe('entity status', () => {
    it('tells which points and curves are fully defined', () => {
        const r = addRect(EMPTY_GEOMETRY, { at: [0, 0], point: 'origin' }, { at: [40, 10] });
        const g = addConstraint(r.g, { kind: 'length', line: r.lines[0], value: 40 }).g;
        const defined = definedEntities(g)!;
        const bottom = g.curves.find((c) => c.id === r.lines[0]);
        expect(defined.has(r.lines[0])).toBe(true);
        expect(defined.has(r.lines[1])).toBe(false);
        expect(defined.has(r.lines[2])).toBe(false);
        if (bottom?.kind === 'line') {
            expect(defined.has(bottom.b)).toBe(true);
        }
        const top = g.points.find((p) => p.v === 10)!;
        expect(defined.has(top.id)).toBe(false);
    });

    it('needs a circle radius as well as its centre', () => {
        const c = addCircle(EMPTY_GEOMETRY, { at: [0, 0], point: 'origin' }, 5);
        expect(definedEntities(c.g)!.has(c.id)).toBe(false);
        const sized = addConstraint(c.g, { kind: 'diameter', curve: c.id, value: 10 }).g;
        expect(definedEntities(sized)!.has(c.id)).toBe(true);
        const other = addCircle(sized, { at: [20, 0] }, 3);
        const d = definedEntities(other.g)!;
        expect(d.has(c.id)).toBe(true);
        expect(d.has(other.id)).toBe(false);
    });
});
