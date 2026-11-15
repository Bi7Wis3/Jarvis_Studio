import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature } from '@jarvis/core';
import type { ModelSketch } from '@jarvis/core/projection';
import { loadSolver } from './solver';
import { addCircle, EMPTY_GEOMETRY } from './sketchGeometry';
import { applyDimension, constraintTool, setDimText, setTool, sketchClick, sketchMove, useSketcher } from './sketcher';
import { edgesKey, isModelLock, modelTarget, sketchLockSource, useSketchModel } from './sketchModel';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const TOL = 1;
const state = () => useSketcher.getState();

/** The top face of a 40 x 20 plate with a hole of radius 5, as the kernel projects it onto the top plane at y 10. */
const plate: ModelSketch = {
    curves: [
        { kind: 'line', a: [0, 0], b: [40, 0], edge: 0 },
        { kind: 'line', a: [40, 0], b: [40, -20], edge: 1 },
        { kind: 'line', a: [40, -20], b: [0, -20], edge: 2 },
        { kind: 'line', a: [0, -20], b: [0, 0], edge: 3 },
        { kind: 'circle', center: [20, -10], radius: 5, edge: 4 },
    ],
    points: [[0, 0], [40, 0], [40, -20], [0, -20]],
    skipped: [],
};

const point = (id: string) => state().geometry.points.find((p) => p.id === id)!;

describe('dimensions and relations to model edges', () => {
    beforeEach(() => {
        useSketcher.setState({
            active: true, stage: 'draw', partId: 'plate', edit: null, plane: 'top', offset: 10, context: [],
            geometry: addCircle(EMPTY_GEOMETRY, { at: [10, -4] }, 2).g, labels: {}, picks: [], dimDraft: null, dimDrag: null, undo: [], redo: [],
        });
        const target = modelTarget(state())!;
        useSketchModel.setState({ edges: { [edgesKey(target, null)]: plate }, hover: null });
    });

    it('lights up a model edge under the cursor of the dimension tool', () => {
        setTool('dimension');
        sketchMove([40.3, -10], TOL);
        expect(useSketchModel.getState().hover).toMatchObject({ kind: 'line', a: [40, 0], b: [40, -20] });
        // An edge on the sketch's own axis: the axis is picked as usual.
        sketchMove([30, 0.3], TOL);
        expect(useSketchModel.getState().hover).toBeNull();
        // Over the sketch's own circle: that wins.
        sketchMove([12, -4], TOL);
        expect(useSketchModel.getState().hover).toBeNull();
    });

    it('dimensions a circle centre to a straight model edge: the edge comes in as a locked construction line', () => {
        setTool('dimension');
        sketchClick([12, -4], TOL);
        sketchClick([40.2, -12], TOL);
        expect(state().picks).toHaveLength(2);
        const line = state().geometry.curves.find((c) => c.kind === 'line')!;
        expect(line).toMatchObject({ construction: true });
        expect(state().geometry.constraints.filter(isModelLock)).toHaveLength(2);
        sketchClick([45, 5], TOL);
        expect(state().dimDraft).toMatchObject({ constraint: { kind: 'distance' }, text: '30' });
        setDimText('6.25');
        applyDimension();
        const circle = state().geometry.curves.find((c) => c.kind === 'circle')!;
        expect(circle.kind === 'circle' && point(circle.center).u).toBeCloseTo(33.75, 9);
        // The model line stays where the model is.
        expect(line.kind === 'line' && [point(line.a), point(line.b)].map((p) => [p.u, p.v])).toEqual([[40, 0], [40, -20]]);

        // Picking the same edge again reuses the line brought in before.
        const c = circle.kind === 'circle' ? point(circle.center) : null;
        sketchClick([c!.u + 2, c!.v], TOL);
        sketchClick([40.2, -15], TOL);
        expect(state().geometry.curves.filter((c) => c.kind === 'line')).toHaveLength(1);
    });

    it('makes a circle concentric with a circular model edge, and dimensions to a model corner', () => {
        constraintTool('concentric');
        sketchClick([12, -4], TOL);
        sketchClick([25, -10], TOL);
        const circle = state().geometry.curves.find((c) => c.kind === 'circle' && !c.construction)!;
        const centre = circle.kind === 'circle' ? point(circle.center) : null;
        expect(centre!.u).toBeCloseTo(20, 9);
        expect(centre!.v).toBeCloseTo(-10, 9);
        expect(state().geometry.curves.find((c) => c.kind === 'circle' && c.construction)).toMatchObject({ radius: 5 });

        setTool('dimension');
        sketchClick([40.2, -0.2], TOL);
        expect(state().picks[0]).toMatchObject({ type: 'point' });
        const corner = point(state().picks[0].id);
        expect([corner.u, corner.v]).toEqual([40, 0]);
    });

    it('selects an entity of another sketch: it comes in locked, as from that sketch', () => {
        const other = {
            id: 's1', name: 'Sketch1', op: 'sketch',
            sketch: {
                plane: 'top', offset: 10, profiles: [],
                geometry: { points: [{ id: 'p1', u: 5, v: -15 }, { id: 'p2', u: 15, v: -15 }], curves: [{ id: 'c1', kind: 'line', a: 'p1', b: 'p2' }], constraints: [] },
            },
        } as unknown as Feature;
        useSketcher.setState({ context: [other], showSketches: true });
        useSketchModel.setState({ edges: { [edgesKey(modelTarget(state())!, null)]: plate } });
        setTool('select');
        sketchClick([10, -14.8], TOL);
        const line = state().geometry.curves.find((c) => c.kind === 'line')!;
        expect(line).toMatchObject({ construction: true });
        expect(state().selection).toEqual([{ type: 'curve', id: line.id }]);
        const locks = state().geometry.constraints.filter((c) => sketchLockSource(c) === 's1');
        expect(locks).toHaveLength(2);
        expect(line.kind === 'line' && [point(line.a), point(line.b)].map((p) => [p.u, p.v])).toEqual([[5, -15], [15, -15]]);
    });
});
