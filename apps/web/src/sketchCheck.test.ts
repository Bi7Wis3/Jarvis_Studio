import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import { addConstraint, addLine, EMPTY_GEOMETRY } from './sketchGeometry';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));
// A solver that reports success without moving anything, as PlaneGCS sometimes does on a system it cannot meet.
vi.mock('./solver', async (original) => {
    const real = await original<typeof import('./solver')>();
    return {
        ...real,
        solveGeometry: (g: SketchGeometry) => ({ geometry: g, dof: 0, ok: true, conflicting: [], redundant: [] }),
    };
});

const { loadSolver } = await import('./solver');
const { toggleConstructionSelected, useSketcher } = await import('./sketcher');

beforeAll(async () => {
    await loadSolver();
});

describe('commit', () => {
    it('refuses a solve reported as ok whose relations do not hold, and says which', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [30, 5] }).g;
        g = addConstraint(g, { kind: 'horizontal', line: g.curves[0].id }).g;
        useSketcher.setState({ active: true, stage: 'draw', geometry: g, selection: [{ type: 'curve', id: g.curves[0].id }], undo: [], message: null });
        toggleConstructionSelected();
        const s = useSketcher.getState();
        expect(s.geometry).toBe(g);
        expect(s.undo).toHaveLength(0);
        expect(s.message).toMatch(/horizontal would not hold\. Not applied\./);
        expect(s.conflicting).toEqual([g.constraints[0].id]);
    });

    it('applies a result whose relations hold', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [30, 0] }).g;
        g = addConstraint(g, { kind: 'horizontal', line: g.curves[0].id }).g;
        useSketcher.setState({ active: true, stage: 'draw', geometry: g, selection: [{ type: 'curve', id: g.curves[0].id }], undo: [], message: null });
        toggleConstructionSelected();
        expect(useSketcher.getState().undo).toHaveLength(1);
    });
});
