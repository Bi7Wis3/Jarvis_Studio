// The Horizontal Dimension and Ordinate tools take model corners and edges as the Smart Dimension does.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelSketch } from '@jarvis/core/projection';
import { loadSolver } from './solver';
import { addCircle, EMPTY_GEOMETRY } from './sketchGeometry';
import { setDimensionTool, setOrdinateTool, sketchClick, useSketcher } from './sketcher';
import { edgesKey, isModelLock, modelTarget, useSketchModel } from './sketchModel';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const TOL = 1;
const state = () => useSketcher.getState();

/** The top face of a 40 x 20 plate, as the kernel projects it onto the top plane. */
const plate: ModelSketch = {
    curves: [
        { kind: 'line', a: [0, 0], b: [40, 0], edge: 0 },
        { kind: 'line', a: [40, 0], b: [40, -20], edge: 1 },
        { kind: 'line', a: [40, -20], b: [0, -20], edge: 2 },
        { kind: 'line', a: [0, -20], b: [0, 0], edge: 3 },
    ],
    points: [[0, 0], [40, 0], [40, -20], [0, -20]],
    skipped: [],
};

describe('dimension tools and model geometry', () => {
    beforeEach(() => {
        useSketcher.setState({
            active: true, stage: 'draw', partId: 'plate', edit: null, plane: 'top', offset: 10, context: [],
            geometry: addCircle(EMPTY_GEOMETRY, { at: [10, -4] }, 2).g, labels: {}, picks: [], dimDraft: null, dimDrag: null, undo: [], redo: [],
        });
        const target = modelTarget(state())!;
        useSketchModel.setState({ edges: { [edgesKey(target, null)]: plate }, hover: null });
    });

    it('measures horizontally from the circle centre to a model corner', () => {
        setDimensionTool('u');
        sketchClick([10, -4], TOL);
        sketchClick([40, -20], TOL);
        expect(state().picks).toHaveLength(2);
        expect(state().geometry.constraints.filter(isModelLock)).toHaveLength(1);
        sketchClick([25, 5], TOL);
        expect(state().dimDraft).toMatchObject({ constraint: { kind: 'distance', axis: 'u' }, text: '30' });
    });

    it('dimensions ordinates from a model corner as the zero', () => {
        setOrdinateTool('u');
        sketchClick([0, -20], TOL);
        expect(state().geometry.constraints.filter(isModelLock)).toHaveLength(1);
        sketchClick([10, -4], TOL);
        const ord = state().geometry.constraints.find((c) => c.kind === 'distance' && c.ordinate);
        expect(ord).toMatchObject({ axis: 'u', value: 10 });
    });
});
