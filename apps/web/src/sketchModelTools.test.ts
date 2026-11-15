import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature } from '@jarvis/core';
import type { ModelSketch, PlaneFrame3 } from '@jarvis/core/projection';
import { loadSolver } from './solver';
import { addCircle, EMPTY_GEOMETRY } from './sketchGeometry';
import { setTool, sketchClick, useSketcher } from './sketcher';
import { startPicker, stopPicker } from './sketchMoreTools';
import { edgesKey, isModelLock, modelTarget, useSketchModel } from './sketchModel';
import { modelPickWanted, modelPlaneClick, setModelPicking } from './sketchModelPick';
import { pierceCurves } from './sketchPierce';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const TOL = 1;
const state = () => useSketcher.getState();

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
const circleId = () => state().geometry.curves.find((c) => c.kind === 'circle')!.id;

beforeEach(() => {
    useSketcher.setState({
        active: true, stage: 'draw', partId: 'plate', edit: null, plane: 'top', offset: 10, context: [],
        geometry: addCircle(EMPTY_GEOMETRY, { at: [10, -4] }, 2).g, labels: {}, picks: [], selection: [], dimDraft: null, dimDrag: null,
        undo: [], redo: [], offsetCurve: null, mirrorAbout: false,
    });
    useSketchModel.setState({ edges: { [edgesKey(modelTarget(state())!, null)]: plate }, hover: null, picking: null, picks: [], curvePicks: [], sketchPicks: [] });
});

describe('sketch tools that take model edges on the sketch plane', () => {
    it('mirrors about a straight model edge, copied in as locked construction', () => {
        setTool('mirror');
        useSketcher.setState({ picks: [{ type: 'curve', id: circleId() }] });
        sketchClick([40.2, -10], TOL);
        const circles = state().geometry.curves.filter((c) => c.kind === 'circle');
        expect(circles).toHaveLength(2);
        const centres = circles.map((c) => (c.kind === 'circle' ? point(c.center).u : 0)).sort((a, b) => a - b);
        expect(centres[0]).toBeCloseTo(10, 9);
        expect(centres[1]).toBeCloseTo(70, 9);
        expect(state().geometry.curves.find((c) => c.kind === 'line')).toMatchObject({ construction: true });
    });

    it('takes a model edge as the base of an offset', () => {
        setTool('offset');
        sketchClick([40.2, -10], TOL);
        const line = state().geometry.curves.find((c) => c.kind === 'line')!;
        expect(line).toMatchObject({ construction: true });
        expect(state().offsetCurve).toBe(line.id);
        sketchClick([35, -10], TOL);
        const offset = state().geometry.curves.filter((c) => c.kind === 'line' && !c.construction);
        expect(offset).toHaveLength(1);
        const o = offset[0];
        expect(o.kind === 'line' && point(o.a).u).toBeCloseTo(35, 6);
    });

    it('gives a straight model edge to a selection box that takes a line (a pattern direction)', () => {
        const picked: string[] = [];
        startPicker({ back: 'select', accept: () => null, onPick: (p) => picked.push(p.id) });
        sketchClick([20, -19.8], TOL);
        stopPicker();
        expect(picked).toHaveLength(1);
        const line = state().geometry.curves.find((c) => c.id === picked[0])!;
        expect(line.kind === 'line' && [point(line.a).v, point(line.b).v]).toEqual([-20, -20]);
        expect(state().geometry.constraints.filter(isModelLock)).toHaveLength(2);
    });

    it('picks model edges on the plane for Convert entities, and leaves the sketch alone meanwhile', () => {
        setModelPicking('convert');
        expect(modelPickWanted()).toMatchObject({ use: 'form', allow: ['edge', 'face'] });
        expect(modelPlaneClick([25, -10], TOL)).toBe(true);
        expect(useSketchModel.getState().curvePicks).toEqual([{ kind: 'circle', center: [20, -10], radius: 5, edge: 4 }]);
        expect(modelPlaneClick([25, -10], TOL)).toBe(true);
        expect(useSketchModel.getState().curvePicks).toEqual([]);
        expect(state().geometry.curves).toHaveLength(1);
        setModelPicking(null);
        expect(modelPickWanted()).toBeNull();
    });
});

describe('pierce points of other sketches', () => {
    const TOP: PlaneFrame3 = { origin: [0, 10, 0], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] };
    const front = {
        id: 's1', op: 'sketch',
        sketch: {
            plane: 'front', profiles: [],
            geometry: {
                points: [{ id: 'p1', u: 5, v: 0 }, { id: 'p2', u: 5, v: 20 }, { id: 'p3', u: 0, v: 10 }, { id: 'p4', u: 9, v: 30 }, { id: 'p5', u: 12, v: 30 }],
                curves: [
                    { id: 'c1', kind: 'line', a: 'p1', b: 'p2' }, { id: 'c2', kind: 'circle', center: 'p3', radius: 5 },
                    { id: 'c3', kind: 'line', a: 'p4', b: 'p5' },
                ],
                constraints: [],
            },
        },
    } as unknown as Feature;

    it('finds where a line and a circle pass through the plane, and says when one does not', () => {
        expect(pierceCurves([front], TOP, ['s1/c1']).points).toEqual([[5, 0]]);
        const circle = pierceCurves([front], TOP, ['s1/c2']).points.sort((a, b) => a[0] - b[0]);
        expect(circle.map(([u, v]) => [Math.round(u * 1e9) / 1e9, Math.round(v * 1e9) / 1e9 + 0])).toEqual([[-5, 0], [5, 0]]);
        const none = pierceCurves([front], TOP, ['s1/c3']);
        expect(none.points).toEqual([]);
        expect(none.skipped).toHaveLength(1);
    });
});
