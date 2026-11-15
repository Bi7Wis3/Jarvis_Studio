// Display/Delete Relations: filters, Suppressed, Replace.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import { loadSolver, solveGeometry } from './solver';
import { EMPTY_GEOMETRY, addConstraint, addLine, addRect } from './sketchGeometry';
import { relationStates, replaceEntity, showsUnder } from './sketchRelationEdit';
import { setSuppressed, setTool, sketchClick, startReplaceEntity, useSketcher } from './sketcher';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

function begin(g: SketchGeometry) {
    useSketcher.setState({ active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], picks: [], labels: {}, conflicting: [], redundant: [] });
    setTool('select');
}

describe('relations list', () => {
    it('filters by state and by the selected entities', () => {
        const r = addRect(EMPTY_GEOMETRY, [0, 0], [40, 10]);
        let g = addConstraint(r.g, { kind: 'length', line: r.lines[0], value: 40 }).g;
        g = addConstraint(g, { kind: 'length', line: r.lines[2], value: 40 }).g;
        g = { ...g, constraints: [...g.constraints, { id: 'k99', kind: 'horizontal', line: 'gone' }] };
        const states = relationStates(g, solveGeometry(g));
        const shown = (filter: Parameters<typeof showsUnder>[0], scope: string[] = []) => g.constraints.filter((c) => showsUnder(filter, states.get(c.id)!, c, scope)).map((c) => c.id);
        expect(shown('dangling')).toEqual(['k99']);
        expect(shown('problems').length).toBeGreaterThan(0);
        expect(shown('selected', [r.lines[1]]).every((id) => g.constraints.find((c) => c.id === id)!.kind === 'vertical')).toBe(true);
        expect(shown('all')).toHaveLength(g.constraints.length);
    });

    it('suppresses a relation so it holds nothing, and lets it hold again', () => {
        const line = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 3] });
        const h = addConstraint(line.g, { kind: 'horizontal', line: line.id });
        begin(solveGeometry(h.g).geometry);
        const dof = solveGeometry(useSketcher.getState().geometry).dof;
        setSuppressed([h.id], true);
        const g = useSketcher.getState().geometry;
        expect(g.constraints[0].suppressed).toBe(true);
        expect(solveGeometry(g).dof).toBe(dof + 1);
        expect(relationStates(g, solveGeometry(g)).get(h.id)).toBe('suppressed');
        setSuppressed([h.id], false);
        expect('suppressed' in useSketcher.getState().geometry.constraints[0]).toBe(false);
    });

    it('replaces an entity of a relation with one of the same sort, picked in the view', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        g = addLine(g, { at: [0, 5] }, { at: [10, 6] }).g;
        g = addLine(g, { at: [0, 10] }, { at: [10, 12] }).g;
        const [l1, l2, l3] = g.curves.map((c) => c.id);
        const k = addConstraint(g, { kind: 'parallel', a: l1, b: l2 });
        expect(replaceEntity(k.g, k.id, l2, g.points[0].id)).toEqual({ error: 'Pick a line to take its place.' });
        expect(replaceEntity(k.g, k.id, l2, l1)).toMatchObject({ error: expect.stringContaining('already') });
        begin(k.g);
        startReplaceEntity(k.id, l2);
        sketchClick([5, 11], 0.5);
        expect(useSketcher.getState().geometry.constraints[0]).toMatchObject({ kind: 'parallel', a: l1, b: l3 });
    });
});
