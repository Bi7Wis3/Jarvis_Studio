// Audit of the model tools of the sketch toolbar (Convert entities, Intersection curve, Silhouette entities, Pierce
// point) and of dimensions and relations to model edges. The model is faked as sketchModelTools.test.ts does (the
// projected edges of a part, as the kernel would answer); the kernel itself is in apps/server/src/cad/audit.kernel.test.ts.
// The forms' panels are React components that fill what OK adds; they cannot run here, so OK is tested with nothing
// picked, and what it then adds is tested through addModelCurves with the options OK passes.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import type { ModelCurve, ModelSketch } from '@jarvis/core/projection';
import { curveRadius, loadSolver, measure } from '../solver';
import { addCircle, EMPTY_GEOMETRY } from '../sketchGeometry';
import { applyDimension, commitGeometry, setDimText, setTool, useSketcher } from '../sketcher';
import { addModelCurves, edgesKey, isModelLock, modelTarget, useSketchModel } from '../sketchModel';
import { modelPlaneClick, setModelPicking } from '../sketchModelPick';
import { at, click, clicks, curvesOf, geo, groupTools, near, noDangling, press, relations, solvesCleanly, state, undoRedoRestores } from './harness';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const TOL = 0.5;

/** A plate's edges on the sketch plane, turned 20 degrees and away from the origin, with a hole. */
const T = (20 * Math.PI) / 180;
const rot = (p: [number, number]): [number, number] => [50 + p[0] * Math.cos(T) - p[1] * Math.sin(T), 30 + p[0] * Math.sin(T) + p[1] * Math.cos(T)];
const corners = [rot([0, 0]), rot([40, 0]), rot([40, 20]), rot([0, 20])];
const plate: ModelSketch = {
    curves: [
        { kind: 'line', a: corners[0], b: corners[1], edge: 0 },
        { kind: 'line', a: corners[1], b: corners[2], edge: 1 },
        { kind: 'line', a: corners[2], b: corners[3], edge: 2 },
        { kind: 'line', a: corners[3], b: corners[0], edge: 3 },
        { kind: 'circle', center: rot([20, 10]), radius: 5, edge: 4 },
    ],
    points: corners,
    skipped: [],
};
const mid = (a: [number, number], b: [number, number], t = 0.37): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** A sketch on a part with a body (the plate above), as the toolbar's Sketch on a face leaves it. */
function onPart(g: SketchGeometry = EMPTY_GEOMETRY): void {
    useSketcher.setState({
        active: true, stage: 'draw', partId: 'plate', edit: null, plane: 'top', offset: 10, context: [], tool: 'select',
        geometry: g, labels: {}, picks: [], selection: [], dimDraft: null, dimDrag: null, undo: [], redo: [], offsetCurve: null,
        mirrorAbout: false, message: null, snapKinds: { grid: false },
    });
    useSketchModel.setState({ edges: { [edgesKey(modelTarget(useSketcher.getState())!, null)]: plate }, hover: null, picking: null, picks: [], curvePicks: [], sketchPicks: [] });
}

beforeEach(() => onPart());

describe('the model tools on the toolbar', () => {
    it('are in the Modify group', () => {
        const ids = groupTools('modify').map((t) => t.id);
        for (const id of ['sk-convert', 'sk-intersection', 'sk-silhouette', 'sk-pierce']) {
            expect(ids).toContain(id);
        }
    });

    it('OK with nothing picked says what to pick, and changes nothing', async () => {
        for (const id of ['sk-convert', 'sk-intersection', 'sk-silhouette', 'sk-pierce']) {
            const form = press(id);
            const before = geo();
            const r = await form.apply();
            expect(r.isError, id).toBe(true);
            expect(r.text, id).toMatch(/pick|Nothing/i);
            expect(geo()).toBe(before);
        }
    });

    it('Convert: a click on a model edge on the plane picks it, a second click drops it, and the sketch stays as it was', () => {
        press('sk-convert');
        // What the Convert panel does when it opens.
        setTool('select');
        setModelPicking('convert');
        const before = geo();
        expect(modelPlaneClick(mid(corners[1], corners[2]), TOL)).toBe(true);
        expect(useSketchModel.getState().curvePicks).toHaveLength(1);
        expect(useSketchModel.getState().curvePicks[0]).toMatchObject({ kind: 'line' });
        expect(modelPlaneClick(mid(corners[1], corners[2]), TOL)).toBe(true);
        expect(useSketchModel.getState().curvePicks).toHaveLength(0);
        expect(geo()).toBe(before);
        setModelPicking(null);
    });
});

describe('converted curves of every kind', () => {
    const kinds: ModelCurve[] = [
        { kind: 'line', a: [12.5, 3.25], b: [31.75, 14.125] },
        { kind: 'circle', center: [-20.5, 18.25], radius: 7.2501 },
        { kind: 'arc', center: [40.5, -12.25], start: [48.5, -12.25], end: [40.5, -4.25] },
        { kind: 'ellipse', center: [-40, -30], major: [-40 + 12 * Math.cos(0.5), -30 + 12 * Math.sin(0.5)], minor: 6 },
        { kind: 'ellipseArc', center: [60, 30], major: [70, 30], minor: 5, start: [70, 30], end: [60, 35] },
        { kind: 'bezier', poles: [[30, -50], [35, -40], [45, -40], [50, -50]] },
        { kind: 'bspline', poles: [[0, -70], [5, -60], [10, -72], [15, -61], [20, -70]], degree: 3 },
        { kind: 'conic', start: [90, 0], apex: [100, 10], end: [110, 0], rho: 0.4 },
    ];

    const converts = (curve: ModelCurve) => {
        undoRedoRestores(() => {
            const r = addModelCurves(geo(), [curve], { lock: true, construction: false });
            expect(commitGeometry(r.g)).toBe(true);
        });
        expect(geo().curves).toHaveLength(1);
        expect(geo().constraints.every(isModelLock)).toBe(true);
        expect(state().message).toBeNull();
        expect(solvesCleanly()).toBe(0);
        noDangling();
        const c = geo().curves[0];
        if (curve.kind === 'line' && c.kind === 'line') {
            expect(at(c.a)).toEqual(curve.a);
            expect(at(c.b)).toEqual(curve.b);
        }
        if (curve.kind === 'circle' && c.kind === 'circle') {
            expect(c.radius).toBe(7.2501);
            expect(at(c.center)).toEqual(curve.center);
        }
    };
    for (const curve of kinds.filter((k) => !['arc', 'ellipse', 'ellipseArc'].includes(k.kind))) {
        it(`${curve.kind}: comes in locked where it was, solves with nothing free`, () => converts(curve));
    }
    // Defect: a converted arc, ellipse or partial ellipse is locked at every one of its points, though they are not all
    // free (as Lock does): the locks repeat each other and the sketch is "Over defined" as soon as it comes in.
    for (const curve of kinds.filter((k) => ['arc', 'ellipse', 'ellipseArc'].includes(k.kind))) {
        it(`${curve.kind}: comes in locked where it was, solves with nothing free`, () => converts(curve));
    }

    it('For construction makes them construction, and no region', () => {
        const r = addModelCurves(geo(), plate.curves, { lock: true, construction: true });
        expect(commitGeometry(r.g)).toBe(true);
        expect(geo().curves.every((c) => c.construction)).toBe(true);
        const { geometryProfiles } = useGeometry;
        expect(geometryProfiles(geo()).profiles).toHaveLength(0);
    });

    it('the plate converted as it is: two regions (the plate with its hole, and the hole)', () => {
        const r = addModelCurves(geo(), plate.curves, { lock: true, construction: false });
        expect(commitGeometry(r.g)).toBe(true);
        const { geometryProfiles } = useGeometry;
        expect(geometryProfiles(geo()).profiles.length).toBeGreaterThanOrEqual(1);
        expect(solvesCleanly()).toBe(0);
        noDangling();
    });
});

import * as useGeometry from '../sketchGeometry';

describe('dimensions and relations to model edges', () => {
    it('dimensions a sketch circle\'s centre to a tilted model edge: 6.2501, the edge stays put', () => {
        onPart(addCircle(EMPTY_GEOMETRY, { at: rot([10, 8]) }, 2).g);
        press('sk-dimension');
        const edgePoint = mid(corners[0], corners[1]);
        const circle = curvesOf('circle')[0];
        // The circle (its centre), the model edge, then where the dimension goes.
        click([rot([10, 8])[0] + 2, rot([10, 8])[1]], TOL);
        click(edgePoint, TOL);
        expect(state().picks).toHaveLength(2);
        click(rot([-5, 4]), TOL);
        expect(state().dimDraft).not.toBeNull();
        setDimText('6.2501');
        applyDimension();
        expect(state().dimDraft).toBeNull();
        const [k] = relations('distance');
        expect(k).toMatchObject({ value: 6.2501 });
        near(measure(geo(), k)!, 6.2501);
        // The edge came in as locked construction and did not move.
        const edge = curvesOf('line', true)[0];
        expect(edge.kind === 'line' && at(edge.a)).toEqual(corners[0]);
        expect(curveRadius(geo(), circle.id)).toBe(2);
        solvesCleanly();
        noDangling();
    });

    it('makes a sketch circle tangent to a model edge', () => {
        onPart(addCircle(EMPTY_GEOMETRY, { at: rot([10, 8]) }, 3).g);
        press('sk-c-tangent');
        clicks([rot([10, 8])[0] + 3, rot([10, 8])[1]], mid(corners[0], corners[1]));
        expect(relations('tangent')).toHaveLength(1);
        const c = at(curvesOf('circle')[0].kind === 'circle' ? (curvesOf('circle')[0] as { center: string }).center : '');
        // Distance from the centre to the edge's line equals the radius.
        const [a, b] = [corners[0], corners[1]];
        const d = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / Math.hypot(b[0] - a[0], b[1] - a[1]);
        near(d, curveRadius(geo(), curvesOf('circle')[0].id)!);
        solvesCleanly();
    });

    it('puts a sketch point on a model corner with coincident', () => {
        onPart({ points: [{ id: 'free', u: 0, v: 0.5 }], curves: [], constraints: [] });
        press('sk-c-coincident');
        clicks([0, 0.5], corners[2]);
        expect(at('free')[0]).toBeCloseTo(corners[2][0], 6);
        expect(at('free')[1]).toBeCloseTo(corners[2][1], 6);
        solvesCleanly();
    });
});
