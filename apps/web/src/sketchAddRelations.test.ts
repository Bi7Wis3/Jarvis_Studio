// The Add Relations form: the relations listed for exactly the selection, and adding one keeps the selection.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import { curveRadius, loadSolver, solveGeometry } from './solver';
import { EMPTY_GEOMETRY, addCircle, addConstraint, addLine, addSlot, relationsFromPicks, type NewConstraint, type Pick } from './sketchGeometry';
import { unmetConstraints } from './sketchCheck';
import { addEllipse } from './sketchConics';
import { fittingRelations } from './sketchRelationForms';
import { addRelationToSelection, setRelationPicking, setTool, sketchClick, useSketcher } from './sketcher';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const curve = (id: string): Pick => ({ type: 'curve', id });
const point = (id: string): Pick => ({ type: 'point', id });

function twoLines(): SketchGeometry {
    const a = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 1] });
    return addLine(a.g, { at: [0, 5] }, { at: [10, 7] }).g;
}

describe('intersection and slot relations', () => {
    it('holds a point where two lines cross', () => {
        let g = twoLines();
        const [l1, l2] = g.curves.map((c) => c.id);
        g = { ...g, points: [...g.points, { id: 'p9', u: 3, v: 3 }] };
        const r = relationsFromPicks(g, 'intersection', [curve(l1), curve(l2), point('p9')]);
        expect(r).toEqual([{ kind: 'intersection', point: 'p9', a: l1, b: l2 }]);
        expect(relationsFromPicks(g, 'intersection', [curve(l1), point('p9')])).toEqual({ need: 'Pick two lines and a point' });
        // Two lines that cross: (0,0)-(10,1) and a steep one through (5,-5)-(6,5).
        let x = addLine(g, { at: [5, -5] }, { at: [6, 5] }).g;
        const l3 = x.curves[x.curves.length - 1].id;
        x = addConstraint(x, { kind: 'intersection', point: 'p9', a: l1, b: l3 }).g;
        const s = solveGeometry(x);
        expect(s.ok).toBe(true);
        expect(unmetConstraints(s.geometry)).toEqual([]);
    });

    it('makes straight slots equal, and fixes one', () => {
        const a = addSlot(EMPTY_GEOMETRY, [0, 0], [20, 0], 3);
        const b = addSlot(a.g, [0, 20], [12, 20], 2);
        const relations = relationsFromPicks(b.g, 'equalSlots', [curve(a.arcs[0]), curve(b.lines[1])]);
        // One line of each slot and one arc of each.
        const [lines, arcs] = relations as { kind: 'equal'; a: string; b: string }[];
        expect(a.lines).toContain(lines.a);
        expect(b.lines).toContain(lines.b);
        expect(a.arcs).toContain(arcs.a);
        expect(b.arcs).toContain(arcs.b);
        let g = b.g;
        for (const c of relations as NewConstraint[]) {
            g = addConstraint(g, c).g;
        }
        const s = solveGeometry(g);
        expect(s.ok).toBe(true);
        expect(curveRadius(s.geometry, b.arcs[1])).toBeCloseTo(curveRadius(s.geometry, a.arcs[1])!, 6);
        expect(relationsFromPicks(b.g, 'equalSlots', [curve(a.arcs[0]), curve(a.lines[1])])).toMatchObject({ need: expect.any(String) });
        const fixed = relationsFromPicks(b.g, 'fixSlot', [curve(a.lines[0])]);
        expect(Array.isArray(fixed) && fixed.every((c) => c.kind === 'fix')).toBe(true);
        expect((fixed as NewConstraint[]).length).toBe(6);
    });
});

describe('equal ellipses', () => {
    it('gives two ellipses the same radii', () => {
        const a = addEllipse(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }, [0, 4]);
        const b = addEllipse(a.g, { at: [30, 0] }, { at: [36, 0] }, [30, 2]);
        const r = relationsFromPicks(b.g, 'equal', [curve(a.id), curve(b.id)]);
        expect(r).toEqual([{ kind: 'equal', a: a.id, b: b.id }]);
        const s = solveGeometry(addConstraint(b.g, (r as NewConstraint[])[0]).g);
        expect(s.ok).toBe(true);
        // Two radii held: two degrees of freedom fewer.
        expect(s.dof).toBe(solveGeometry(b.g).dof - 2);
        const radii = (id: string) => {
            const e = s.geometry.curves.find((c) => c.id === id) as Extract<SketchGeometry['curves'][number], { kind: 'ellipse' }>;
            const [c, p, q] = [e.center, e.major, e.minor].map((x) => s.geometry.points.find((pt) => pt.id === x)!);
            return [Math.hypot(p.u - c.u, p.v - c.v), Math.hypot(q.u - c.u, q.v - c.v)].sort((x, y) => x - y);
        };
        const [ra, rb] = [radii(a.id), radii(b.id)];
        expect(ra[0]).toBeCloseTo(rb[0], 5);
        expect(ra[1]).toBeCloseTo(rb[1], 5);
    });
});

describe('add relations', () => {
    it('lists the relations that fit exactly the selection', () => {
        const g = twoLines();
        const [l1, l2] = g.curves.map((c) => c.id);
        expect(fittingRelations(g, [curve(l1)])).toEqual(['horizontal', 'vertical', 'fix']);
        expect(fittingRelations(g, [curve(l1), curve(l2)])).toEqual(['horizontal', 'vertical', 'collinear', 'perpendicular', 'parallel', 'equal', 'fix']);
        const c = addCircle(g, { at: [30, 0] }, 4);
        expect(fittingRelations(c.g, [curve(l1), curve(c.id)])).toEqual(['tangent', 'fix']);
        const [p] = g.points.map((x) => x.id);
        expect(fittingRelations(c.g, [point(p), curve(c.id)])).toEqual(['concentric', 'coincident', 'fix']);
        expect(fittingRelations(c.g, [])).toEqual([]);
    });

    it('adds the relation and keeps the selection; clicks add to it while the form is open', () => {
        const g = twoLines();
        const [l1, l2] = g.curves.map((c) => c.id);
        useSketcher.setState({ active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], picks: [], labels: {}, conflicting: [], redundant: [] });
        setTool('select');
        setRelationPicking(true);
        sketchClick([5, 0.5], 1);
        sketchClick([5, 6], 1);
        setRelationPicking(false);
        expect(useSketcher.getState().selection.map((x) => x.id)).toEqual([l1, l2]);
        expect(addRelationToSelection('parallel')).toBeNull();
        const s = useSketcher.getState();
        expect(s.geometry.constraints).toEqual([expect.objectContaining({ kind: 'parallel', a: l1, b: l2 })]);
        expect(s.selection.map((x) => x.id)).toEqual([l1, l2]);
        expect(addRelationToSelection('midpoint')).toBe('Pick a point and a line');
    });
});
