// Fully Define Sketch with options: relations first, then baseline or chain dimensions from a datum, placed as asked.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { loadSolver, solveGeometry } from './solver';
import { EMPTY_GEOMETRY, addLine, toggleConstruction } from './sketchGeometry';
import { DEFAULT_FULLY_DEFINE, fullyDefineWith } from './sketchFullyDefine';
import { calculateFullyDefine, clearFullyDefinePreview, previewText, showFullyDefinePreview, useFullyDefinePreview } from './sketchFullyDefinePreview';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

/** An L of two lines: (2, 3) to (12, 3) to (12, 9), not related to anything. */
function ell(): SketchGeometry {
    const a = addLine(EMPTY_GEOMETRY, { at: [2, 3] }, { at: [12, 3] });
    return addLine(a.g, { at: [12, 3], point: a.b }, { at: [12, 9] }).g;
}

const kinds = (g: SketchGeometry) => g.constraints.map((c) => c.kind);
const distances = (g: SketchGeometry) => g.constraints.filter((c): c is Extract<SketchConstraint, { kind: 'distance' }> => c.kind === 'distance');

describe('fully define with options', () => {
    it('adds the relations the geometry keeps, then baseline dimensions from the origin, to no freedom left', () => {
        const r = fullyDefineWith(ell(), DEFAULT_FULLY_DEFINE);
        expect('error' in r).toBe(false);
        if ('error' in r) {
            return;
        }
        expect(r.dof).toBe(0);
        expect(kinds(r.g)).toEqual(expect.arrayContaining(['horizontal', 'vertical']));
        expect(distances(r.g).every((d) => d.a === 'origin')).toBe(true);
        expect(solveGeometry(r.g).redundant).toEqual([]);
    });

    it('uses only the relations allowed, and chains dimensions point to point', () => {
        const r = fullyDefineWith(ell(), { ...DEFAULT_FULLY_DEFINE, relations: [], horizontal: 'chain', vertical: 'chain' });
        if ('error' in r) {
            throw new Error(r.error);
        }
        expect(r.relations).toBe(0);
        expect(kinds(r.g)).not.toContain('horizontal');
        expect(r.dof).toBe(0);
        // A chain: some dimension starts at a point other than the origin.
        expect(distances(r.g).some((d) => d.a !== 'origin')).toBe(true);
    });

    it('measures from a datum line and places the dimensions below and left', () => {
        let g = ell();
        const datum = addLine(g, { at: [0, -5] }, { at: [0, 20] });
        g = toggleConstruction(datum.g, [datum.id]);
        g = { ...g, constraints: [{ id: 'k50', kind: 'fix', point: datum.g.points[datum.g.points.length - 2].id },
            { id: 'k52', kind: 'fix', point: datum.b }] };
        const r = fullyDefineWith(g, { ...DEFAULT_FULLY_DEFINE, datumH: datum.id, above: false, right: false });
        if ('error' in r) {
            throw new Error(r.error);
        }
        const toLine = distances(r.g).filter((d) => d.b === datum.id);
        expect(toLine.length).toBeGreaterThan(0);
        expect(toLine.every((d) => (d.at?.[1] ?? 0) < 3)).toBe(true);
        expect(distances(r.g).filter((d) => d.axis === 'v').every((d) => (d.at?.[0] ?? 0) < 2)).toBe(true);
    });

    it('defines only the selected entities', () => {
        const g = ell();
        const first = g.curves[0];
        const r = fullyDefineWith(g, { ...DEFAULT_FULLY_DEFINE, only: [first.id] });
        if ('error' in r) {
            throw new Error(r.error);
        }
        const second = g.curves[1];
        const far = second.kind === 'line' ? second.b : '';
        expect(r.g.constraints.some((c) => JSON.stringify(c).includes(`"${far}"`))).toBe(false);
    });
});

describe('Calculate (a preview until OK)', () => {
    it('works out what OK adds without changing the sketch, the same each time', () => {
        const g = ell();
        const before = JSON.stringify(g);
        const p = calculateFullyDefine(g, DEFAULT_FULLY_DEFINE);
        if ('error' in p) {
            throw new Error(p.error);
        }
        expect(JSON.stringify(g)).toBe(before);
        expect(p.base).toBe(g);
        expect(p.added).toHaveLength(p.relations + p.dimensions);
        expect(p.dof).toBe(0);
        expect(previewText(p)).toMatch(/to add, shown in the view; the sketch would be fully defined/);
        const ok = fullyDefineWith(g, DEFAULT_FULLY_DEFINE);
        if ('error' in ok) {
            throw new Error(ok.error);
        }
        const shape = (cs: SketchConstraint[]) => cs.map((c) => [c.kind, 'value' in c ? c.value : null]);
        expect(shape(p.added)).toEqual(shape(ok.g.constraints));
    });

    it('is shown, then dropped', () => {
        const p = calculateFullyDefine(ell(), { ...DEFAULT_FULLY_DEFINE, relations: [] });
        showFullyDefinePreview(p);
        expect(useFullyDefinePreview.getState().preview).not.toBeNull();
        expect(useFullyDefinePreview.getState().text).toMatch(/0 relations and \d+ dimensions/);
        clearFullyDefinePreview();
        expect(useFullyDefinePreview.getState()).toEqual({ preview: null, text: null });
        showFullyDefinePreview({ error: 'The sketch is over-constrained; fix that first (SketchXpert).' });
        expect(useFullyDefinePreview.getState()).toMatchObject({ preview: null, text: expect.stringMatching(/over-constrained/) });
    });
});
