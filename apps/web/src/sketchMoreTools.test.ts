import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { AXIS_V, curveOf, loadSolver, pointOf, solveGeometry } from './solver';
import { addCircle, addLine, addRect, EMPTY_GEOMETRY } from './sketchGeometry';
import {
    DEFAULT_EDIT_OPTIONS, deleteSelected, endChain, setTool, sketchClick, sketchDown, sketchEscape, sketchMove, sketchUp, useSketcher,
} from './sketcher';
import {
    applyReplace, applySegment, checkSketch, copySelection, flipWholeSketch, moveSketchFrame, pasteAtCursor, positionPoint, scaleWholeSketch,
    startJog, toggleDynamicMirror, useSketchMore,
} from './sketchMoreTools';
import { boxSelect, combineBox } from './sketchBoxSelect';
import { segmentEntity } from './sketchSegment';
import { jogLine } from './sketchJog';
import { replaceEntity } from './sketchReplace';
import { checkSketchFor } from './sketchFeatureCheck';
import { addZonedArc, zoneMove, ZONE_IDLE } from './sketchTangentZones';
import { movedPlane, scaleSketch } from './sketchModifySketch';
import { planeFrame, toPartFrame } from './sketchMath';
import { linearSketchPattern } from './sketchPattern';
import { editSketchPlane } from './sketchPlaneEdit';
import { choosePlane, startSketch } from './sketcher';
import { useStudio } from './state';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const TOL = 1;
const state = () => useSketcher.getState();
type Line = Extract<SketchCurve, { kind: 'line' }>;
const lines = (g: SketchGeometry) => g.curves.filter((c): c is Line => c.kind === 'line');
const at = (g: SketchGeometry, id: string) => {
    const p = pointOf(g, id)!;
    return [p.u, p.v];
};
const solves = (g: SketchGeometry) => {
    const r = solveGeometry(g);
    expect(r.ok).toBe(true);
    return r;
};

function start(g: SketchGeometry) {
    useSketchMore.setState({ box: null, dynamicMirror: null, picker: null, jog: null, hover: null, preview: [], zone: ZONE_IDLE, check: null });
    useSketcher.setState({
        active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], picks: [], editOptions: DEFAULT_EDIT_OPTIONS, message: null,
        tool: 'select', draft: [], chainStart: null, labels: {}, plane: 'top', offset: 0, context: [], cursor: null, snap: true, grid: 1,
        drag: null, dragFrom: null, trimStroke: null, dimDraft: null, dimDrag: null, xform: null,
    });
}

/** Two separate lines: (0, 0)-(10, 0) and (20, 0)-(30, 10). */
function twoLines() {
    const a = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
    const b = addLine(a.g, { at: [20, 0] }, { at: [30, 10] });
    return { g: b.g, a: a.id, b: b.id };
}

describe('box selection', () => {
    it('takes what is wholly inside left to right, and what it crosses right to left', () => {
        const s = twoLines();
        expect(boxSelect(s.g, [-1, -1], [25, 5], false).map((x) => x.id)).toEqual([s.a]);
        expect(boxSelect(s.g, [-1, -1], [25, 5], true).map((x) => x.id).sort()).toEqual([s.a, s.b].sort());
        // Shift adds, Ctrl turns each item over; what is outside the box keeps its state.
        const a = { type: 'curve' as const, id: s.a };
        const b = { type: 'curve' as const, id: s.b };
        expect(combineBox([b], [a], 'add')).toEqual([b, a]);
        expect(combineBox([a, b], [a], 'toggle')).toEqual([b]);
    });

    it('drags a box from empty space without turning the view, and Delete removes what it took', () => {
        const s = twoLines();
        start(s.g);
        // Right to left on screen: a cross selection.
        expect(sketchDown([27, 1], TOL, 500)).toBe(true);
        sketchMove([-1, -1], TOL, 300);
        expect(useSketchMore.getState().box).not.toBeNull();
        sketchUp({});
        expect(state().selection.map((x) => x.id).sort()).toEqual([s.a, s.b].sort());
        // Left to right, Ctrl: turns the first line off again.
        sketchDown([-1, -1], TOL, 300);
        sketchMove([12, 2], TOL, 400);
        sketchUp({ ctrl: true });
        expect(state().selection.map((x) => x.id)).toEqual([s.b]);
        deleteSelected();
        expect(state().geometry.curves.map((c) => c.id)).toEqual([s.a]);
    });
});

describe('copy and paste', () => {
    it('pastes the copied curves, with the relations among them, centred at the pointer', () => {
        const rect = addRect(EMPTY_GEOMETRY, [0, 0], [10, 4]);
        start(rect.g);
        useSketcher.setState({ selection: rect.lines.map((id) => ({ type: 'curve' as const, id })) });
        expect(copySelection()).toBe(true);
        useSketcher.setState({ cursor: [50, 50] });
        expect(pasteAtCursor()).toBe(true);
        const g = state().geometry;
        expect(lines(g)).toHaveLength(8);
        expect(g.constraints.filter((k) => k.kind === 'horizontal')).toHaveLength(4);
        const us = g.points.map((p) => p.u);
        expect(Math.max(...us)).toBeCloseTo(55, 6);
        expect(state().selection).toHaveLength(4);
        solves(g);
        // Into another sketch of the session.
        start(EMPTY_GEOMETRY);
        useSketcher.setState({ cursor: [0, 0] });
        expect(pasteAtCursor()).toBe(true);
        expect(lines(state().geometry)).toHaveLength(4);
    });
});

describe('dynamic mirror', () => {
    it('mirrors what is drawn after the line is picked, and a mirrored chain stays joined', () => {
        start(EMPTY_GEOMETRY);
        toggleDynamicMirror();
        expect(state().tool).toBe('m:pick');
        sketchClick([0, 7], TOL);
        expect(useSketchMore.getState().dynamicMirror?.line).toBe(AXIS_V);
        setTool('line');
        sketchClick([2, 0], TOL);
        sketchClick([6, 0], TOL);
        sketchClick([6, 5], TOL);
        endChain();
        const g = state().geometry;
        expect(lines(g)).toHaveLength(4);
        expect(g.constraints.filter((k) => k.kind === 'symmetric')).toHaveLength(3);
        // The two mirrored lines share their corner.
        const images = lines(g).filter((l) => at(g, l.a)[0] < 0);
        expect(new Set(images.flatMap((l) => [l.a, l.b])).size).toBe(3);
        solves(g);
        toggleDynamicMirror();
        expect(useSketchMore.getState().dynamicMirror).toBeNull();
    });
});

describe('segment', () => {
    it('puts equally spaced points on a line that follow it when it is resized', () => {
        const l = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [12, 0] });
        const r = segmentEntity(l.g, l.id, 3, 'points');
        if ('error' in r) {
            throw new Error(r.error);
        }
        expect(r.points.map((id) => at(r.g, id)[0])).toEqual([3, 6, 9]);
        // Stretch the line: the points keep their spacing.
        const g = solves({ ...r.g, constraints: [...r.g.constraints, { id: 'len', kind: 'length', line: l.id, value: 24 }] }).geometry;
        const us = r.points.map((id) => at(g, id)[0]).sort((x, y) => x - y);
        const a = at(g, (curveOf(g, l.id) as Line).a)[0];
        expect(us[1] - us[0]).toBeCloseTo(us[2] - us[1], 6);
        expect(us[0] - a).toBeCloseTo(us[1] - us[0], 6);
        expect(us[1] - us[0]).toBeCloseTo(6, 4);
    });

    it('cuts a line, an arc and a circle into equal segments', () => {
        const l = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [9, 0] });
        start(l.g);
        expect(applySegment(l.id, 3, 'segments')).toBeNull();
        expect(lines(state().geometry)).toHaveLength(3);
        const c = addCircle(EMPTY_GEOMETRY, { at: [0, 0] }, 5);
        const r = segmentEntity(c.g, c.id, 4, 'segments');
        if ('error' in r) {
            throw new Error(r.error);
        }
        expect(r.g.curves.filter((k) => k.kind === 'arc')).toHaveLength(4);
        expect(solves(r.g).dof).toBeGreaterThanOrEqual(0);
    });
});

describe('jog line', () => {
    it('steps a line out with sides perpendicular and the middle parallel', () => {
        const l = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [30, 0] });
        const r = jogLine(l.g, l.id, [10, 0], [20, 5]);
        if ('error' in r) {
            throw new Error(r.error);
        }
        expect(lines(r.g)).toHaveLength(5);
        expect(r.g.constraints.filter((k) => k.kind === 'perpendicular')).toHaveLength(2);
        expect(r.g.constraints.filter((k) => k.kind === 'parallel')).toHaveLength(1);
        solves(r.g);
    });

    it('takes two clicks in the view and stays on for more jogs', () => {
        const l = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [30, 0] });
        start(l.g);
        startJog();
        sketchClick([10, 0], TOL);
        sketchMove([20, -4], TOL);
        expect(useSketchMore.getState().preview).toHaveLength(3);
        sketchClick([20, -4], TOL);
        expect(lines(state().geometry)).toHaveLength(5);
        expect(state().tool).toBe('m:jog');
        sketchClick([2, 0], TOL);
        sketchEscape();
        expect(useSketchMore.getState().jog).toBeNull();
    });
});

describe('modify sketch', () => {
    it('moves and turns the sketch with its origin, so the geometry stays put relative to it', () => {
        start(addLine(EMPTY_GEOMETRY, { at: [0, 0], point: 'origin' }, { at: [10, 0] }).g);
        expect(moveSketchFrame([5, 0])).toBeNull();
        const p = toPartFrame(state().plane, state().offset, [0, 0]);
        const top = toPartFrame('top', 0, [5, 0]);
        p.forEach((x, i) => expect(x).toBeCloseTo(top[i], 9));
        const turned = movedPlane('top', 0, [], [0, 0], [0, 0], 90);
        const f = planeFrame(turned);
        const v = planeFrame('top').v;
        f.u.forEach((x, i) => expect(x).toBeCloseTo(v[i], 9));
        // A point placed at given coordinates.
        const g = state().geometry;
        const end = (curveOf(g, g.curves[0].id) as Line).b;
        expect(positionPoint(end, [0, 0])).toBeNull();
    });

    it('scales about the origin with the dimensions, and flips about an axis', () => {
        const l = addLine(EMPTY_GEOMETRY, { at: [2, 1] }, { at: [6, 1] });
        const g = { ...l.g, constraints: [...l.g.constraints, { id: 'len', kind: 'length' as const, line: l.id, value: 4 }] };
        const s = scaleSketch(g, 2.5) as SketchGeometry;
        expect(s.constraints.find((k) => k.id === 'len')).toMatchObject({ value: 10 });
        start(g);
        expect(scaleWholeSketch(2.5)).toBeNull();
        expect(at(state().geometry, (l.g.curves[0] as Line).b)).toEqual([15, 2.5]);
        expect(flipWholeSketch('x')).toBeNull();
        expect(at(state().geometry, (l.g.curves[0] as Line).b)[1]).toBeCloseTo(-2.5, 9);
    });
});

describe('check sketch for feature', () => {
    it('passes a closed contour, and names an open end or a second contour', () => {
        const rect = addRect(EMPTY_GEOMETRY, [0, 0], [10, 5]);
        expect(checkSketchFor(rect.g, 'multipleClosed').ok).toBe(true);
        const open = { ...rect.g, curves: rect.g.curves.slice(1) };
        const r = checkSketchFor(open, 'multipleClosed');
        expect(r.ok).toBe(false);
        expect(r.text).toMatch(/Open contour/);
        expect(checkSketchFor(open, 'singleOpenOrClosed').ok).toBe(true);
        const two = addCircle(rect.g, { at: [30, 0] }, 2).g;
        expect(checkSketchFor(two, 'multipleClosed').ok).toBe(true);
        expect(checkSketchFor(two, 'singleClosed').text).toMatch(/2 contours/);
        const crossing = addLine(rect.g, { at: [-2, 2] }, { at: [12, 2] }).g;
        expect(checkSketchFor(crossing, 'multipleClosed').ok).toBe(false);
        start(open);
        expect(checkSketch('multipleClosed').ok).toBe(false);
        expect(state().highlight.length).toBeGreaterThan(0);
    });
});

describe('replace entity', () => {
    it('moves the relations and the joins of the old entity to the new one', () => {
        const rect = addRect(EMPTY_GEOMETRY, [0, 0], [10, 5]);
        const top = rect.lines.find((id) => {
            const l = curveOf(rect.g, id) as Line;
            return at(rect.g, l.a)[1] === 5 && at(rect.g, l.b)[1] === 5;
        })!;
        const g0 = { ...rect.g, constraints: [...rect.g.constraints, { id: 'len', kind: 'length' as const, line: top, value: 10 }] };
        const n = addLine(g0, { at: [0, 6] }, { at: [10, 6] });
        const r = replaceEntity(n.g, top, n.id, { old: 'delete', contour: true });
        if ('error' in r) {
            throw new Error(r.error);
        }
        expect(curveOf(r.g, top)).toBeUndefined();
        expect(r.g.constraints.find((k) => k.id === 'len')).toMatchObject({ line: n.id });
        expect(checkSketchFor(r.g, 'singleClosed').ok).toBe(true);
        solves(r.g);
        // A radius cannot hold on a line: it goes, and Make construction keeps the old one.
        const c = addCircle(EMPTY_GEOMETRY, { at: [0, 0] }, 3);
        const withR = { ...c.g, constraints: [{ id: 'r', kind: 'radius' as const, curve: c.id, value: 3 }] };
        const l = addLine(withR, { at: [5, 0] }, { at: [9, 0] });
        start(l.g);
        expect(applyReplace(c.id, l.id, { old: 'construction', contour: false })).toBeNull();
        expect(curveOf(state().geometry, c.id)?.construction).toBe(true);
        expect(state().geometry.constraints.some((k) => k.id === 'r')).toBe(false);
    });
});

describe('tangent arc intent zones', () => {
    it('picks tangent or normal from the way the pointer leaves the end, and holds a normal arc by its centre on the line', () => {
        expect(zoneMove(ZONE_IDLE, [0, 0], [1, 0], [3, 0.5], 1).intent).toEqual({ kind: 'tangent', sign: 1 });
        expect(zoneMove(ZONE_IDLE, [0, 0], [1, 0], [-3, 0.5], 1).intent).toEqual({ kind: 'tangent', sign: -1 });
        const normal = zoneMove(ZONE_IDLE, [0, 0], [1, 0], [0.5, -3], 1);
        expect(normal.intent).toEqual({ kind: 'normal', sign: -1 });
        // Moving on keeps the choice; back on the end point starts over.
        expect(zoneMove(normal, [0, 0], [1, 0], [5, -1], 1)).toBe(normal);
        expect(zoneMove(normal, [0, 0], [1, 0], [0.2, 0], 1).intent).toBeNull();
        const l = addLine(EMPTY_GEOMETRY, { at: [-10, 0] }, { at: [0, 0] });
        const end = (l.g.curves[0] as Line).b;
        const r = addZonedArc(l.g, end, { at: [4, -4] }, { kind: 'normal', sign: -1 });
        if ('error' in r) {
            throw new Error(r.error);
        }
        const arc = curveOf(r.g, r.id) as Extract<SketchCurve, { kind: 'arc' }>;
        expect(at(r.g, arc.center)[1]).toBeCloseTo(0, 9);
        expect(r.g.constraints.some((k) => k.kind === 'pointOnCurve' && k.point === arc.center)).toBe(true);
        solves(r.g);
    });

    it('draws a normal arc with the tangent arc tool when the pointer leaves across the line', () => {
        const l = addLine(EMPTY_GEOMETRY, { at: [-10, 5] }, { at: [0, 5] });
        start(l.g);
        setTool('tangentArc');
        sketchMove([0, 5], TOL);
        sketchClick([0, 5], TOL);
        sketchMove([0, 5.2], TOL);
        sketchMove([0.3, 8], TOL);
        sketchMove([4, 9], TOL);
        sketchClick([4, 9], TOL);
        const arc = state().geometry.curves.find((c) => c.kind === 'arc') as Extract<SketchCurve, { kind: 'arc' }>;
        expect(state().message).toBeNull();
        expect(arc).toBeDefined();
        expect(at(state().geometry, arc.center)[1]).toBeCloseTo(5, 6);
    });
});

describe('linear pattern direction from a line', () => {
    it('keeps the rows parallel to the picked line when it turns', () => {
        const guide = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 10] });
        const seed = addCircle(guide.g, { at: [20, 0] }, 1);
        expect('error' in linearSketchPattern(seed.g, [guide.id], { count: 3, spacing: 5, angle: 45, directionLine: guide.id })).toBe(true);
        const r = linearSketchPattern(seed.g, [seed.id], { count: 3, spacing: 5, angle: 45, directionLine: guide.id });
        if ('error' in r) {
            throw new Error(r.error);
        }
        expect(r.g.constraints.some((k) => k.kind === 'parallel' && k.b === guide.id)).toBe(true);
        // Turn the guide upright: the instances follow.
        const g = solves({ ...r.g, constraints: [...r.g.constraints, { id: 'up', kind: 'vertical', line: guide.id }] }).geometry;
        const centres = g.curves.filter((c): c is Extract<SketchCurve, { kind: 'circle' }> => c.kind === 'circle').map((c) => at(g, c.center));
        expect(new Set(centres.map((p) => Math.round(p[0] * 1e6))).size).toBe(1);
    });
});

describe('edit sketch plane', () => {
    it('opens the sketch step at the plane choice and keeps its geometry on the new plane', () => {
        const rect = addRect(EMPTY_GEOMETRY, [0, 0], [10, 5]);
        const sketch = { plane: 'top' as const, profiles: [], geometry: rect.g };
        editSketchPlane('part1', 'sk1');
        expect(useStudio.getState().editing).toEqual({ partId: 'part1', featureId: 'sk1' });
        // The toolbar's editor opens the sketch for editing.
        startSketch('part1', 'sketch', { partId: 'part1', featureId: 'sk1', sketch });
        expect(state().stage).toBe('plane');
        choosePlane('front', 0);
        expect(state().stage).toBe('draw');
        expect(state().plane).toBe('front');
        expect(state().geometry.curves).toHaveLength(4);
        useStudio.setState({ editing: null });
    });
});
