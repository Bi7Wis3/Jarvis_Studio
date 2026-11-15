// Segment groups (re-spacing after a point is deleted, changing the count later), sketch patterns kept as records
// (edit, Display instance count), Ctrl-drag and Shift-drag, and pasting a whole sketch (SOLIDWORKS_REFERENCE.md
// Part B: Point, Segment; Linear and Circular Sketch Pattern; Cut, copy and paste).

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry, SketchPicture } from '@jarvis/core';
import { curveOf, loadSolver, pointOf, solveGeometry } from './solver';
import { addCircle, addLine, addRect, EMPTY_GEOMETRY } from './sketchGeometry';
import { deleteSelected, sketchDown, sketchMove, sketchUp, undoSketch, useSketcher } from './sketcher';
import { resegment, segmentEntity, segmentGroupOf } from './sketchSegment';
import { circularSketchPattern, linearSketchPattern } from './sketchPattern';
import { countSpot, editPattern, patternRecordOf } from './sketchPatternRecord';
import { repattern } from './sketchPatternForms';
import { copyWholeSketch, pastedGeometry } from './sketchPasteSketch';
import { pasteAtCursor, setPressHook } from './sketchMoreTools';
import { draggedPicture, pictureGrip } from './sketchPictureForm';
import { begin, geo, itemsIntact, noDangling, press, solvesCleanly } from './audit/harness';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

beforeEach(() => begin());

type Pt = [number, number];
const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id)!;
    return [p.u, p.v];
};

describe('segment groups', () => {
    it('deleting a point of the group spaces the others equally again', () => {
        const l = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [12, 0] });
        const r = segmentEntity(l.g, l.id, 3, 'points');
        if ('error' in r) {
            throw new Error(r.error);
        }
        expect(r.g.segments).toEqual([{ id: 'seg1', curve: l.id, mode: 'points', points: r.points, chords: r.curves }]);
        begin(r.g);
        useSketcher.setState({ selection: [{ type: 'point', id: r.points[0] }] });
        deleteSelected();
        const g = geo();
        expect(g.segments![0].points).toEqual(r.points.slice(1));
        // Two points left on a 12 long line: at 4 and 8.
        expect(P(g, r.points[1])[0]).toBeCloseTo(4, 9);
        expect(P(g, r.points[2])[0]).toBeCloseTo(8, 9);
        expect(g.segments![0].chords).toHaveLength(3);
        solvesCleanly();
        noDangling();
        undoSketch();
        expect(geo().segments![0].points).toEqual(r.points);
    });

    it('round a circle: two points left are opposite each other', () => {
        const c = addCircle(EMPTY_GEOMETRY, { at: [5, 5] }, 10);
        const r = segmentEntity(c.g, c.id, 3, 'points');
        if ('error' in r) {
            throw new Error(r.error);
        }
        begin(r.g);
        useSketcher.setState({ selection: [{ type: 'point', id: r.points[2] }] });
        deleteSelected();
        const [a, b] = r.points.slice(0, 2).map((id) => P(geo(), id));
        expect((a[0] + b[0]) / 2).toBeCloseTo(5, 9);
        expect((a[1] + b[1]) / 2).toBeCloseTo(5, 9);
        solvesCleanly();
    });

    it('deleting one of its chords ends the group: the points stay on the entity where they are', () => {
        const l = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [12, 0] });
        const r = segmentEntity(l.g, l.id, 3, 'points') as Exclude<ReturnType<typeof segmentEntity>, { error: string }>;
        begin(r.g);
        useSketcher.setState({ selection: [{ type: 'curve', id: r.curves[1] }] });
        deleteSelected();
        const g = geo();
        expect(g.segments).toEqual([]);
        expect(g.curves.filter((c) => c.construction)).toHaveLength(0);
        expect(r.points.map((id) => P(g, id)[0])).toEqual([3, 6, 9]);
        expect(g.constraints.filter((k) => k.kind === 'pointOnCurve')).toHaveLength(3);
    });

    it('changes the number of instances later, from a selected point of the group', async () => {
        const l = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [12, 0] });
        const r = segmentEntity(l.g, l.id, 3, 'points') as Exclude<ReturnType<typeof segmentEntity>, { error: string }>;
        begin(r.g);
        useSketcher.setState({ selection: [{ type: 'point', id: r.points[1] }] });
        const form = press('sk-segment');
        expect(form.values).toMatchObject({ group: 'seg1', count: '3', mode: 'points' });
        form.values = { ...form.values, count: '5' };
        expect((await form.apply()).isError).toBe(false);
        const g = geo();
        expect(g.segments).toHaveLength(1);
        expect(g.segments![0].points.map((id) => P(g, id)[0])).toEqual([2, 4, 6, 8, 10]);
        expect(g.points.filter((p) => r.points.includes(p.id))).toEqual([]);
        solvesCleanly();
        noDangling();
    });

    it('segments mode: a line in 4 pieces back to 2, a circle in 3 arcs to 5', () => {
        const l = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [12, 0] });
        const r = segmentEntity(l.g, l.id, 4, 'segments') as Exclude<ReturnType<typeof segmentEntity>, { error: string }>;
        expect(segmentGroupOf(r.g, r.curves[2])?.id).toBe('seg1');
        const two = resegment(r.g, 'seg1', 2, 'segments') as Exclude<ReturnType<typeof segmentEntity>, { error: string }>;
        expect(two.g.curves.filter((c) => c.kind === 'line')).toHaveLength(2);
        expect(P(two.g, two.points[0])[0]).toBeCloseTo(6, 9);
        expect(solveGeometry(two.g).ok).toBe(true);
        noDangling(two.g);
        const c = addCircle(EMPTY_GEOMETRY, { at: [0, 0] }, 5);
        const arcs = segmentEntity(c.g, c.id, 3, 'segments') as Exclude<ReturnType<typeof segmentEntity>, { error: string }>;
        const five = resegment(arcs.g, 'seg1', 5, 'segments') as Exclude<ReturnType<typeof segmentEntity>, { error: string }>;
        expect(five.g.curves.filter((k) => k.kind === 'arc')).toHaveLength(5);
        expect(five.g.curves.some((k) => k.kind === 'circle')).toBe(false);
        expect(solveGeometry(five.g).ok).toBe(true);
        noDangling(five.g);
    });
});

describe('sketch patterns kept as records', () => {
    function seed() {
        const c = addCircle(EMPTY_GEOMETRY, { at: [10, 0] }, 2);
        return c;
    }

    it('a linear pattern is recorded; editing its count makes it again from the original', () => {
        const c = seed();
        const r = linearSketchPattern(c.g, [c.id], { count: 3, spacing: 10, angle: 0, showCount: true });
        if ('error' in r) {
            throw new Error(r.error);
        }
        const rec = r.g.patterns![0];
        expect(rec).toMatchObject({ id: 'pat1', kind: 'linear', seed: [c.id], showCount: true });
        expect(rec.curves.length).toBeGreaterThanOrEqual(2);
        expect(patternRecordOf(r.g, r.created![0])?.id).toBe('pat1');
        expect(countSpot(r.g, rec)).toEqual([35, 0]);
        const five = editPattern(r.g, 'pat1', { ...rec.options, count: 5 }, (g, s, o) => linearSketchPattern(g, s, o as never)) as SketchGeometry;
        expect(five.patterns).toHaveLength(1);
        expect(five.patterns![0].id).toBe('pat1');
        expect(five.curves.filter((k) => k.kind === 'circle')).toHaveLength(5);
        const solved = solveGeometry(five);
        expect(solved.ok).toBe(true);
        const centres = five.curves.filter((k) => k.kind === 'circle').map((k) => P(solved.geometry, (k as { center: string }).center)[0]).sort((a, b) => a - b);
        centres.forEach((u, i) => expect(u).toBeCloseTo(10 + 10 * i, 9));
        noDangling(five);
    });

    it('the count shown in the view changes the pattern (one undo step); deleting the original forgets the pattern', () => {
        const c = seed();
        const r = circularSketchPattern(c.g, [c.id], { count: 4, angle: 360, centre: [0, 0], showCount: true });
        if ('error' in r) {
            throw new Error(r.error);
        }
        begin(r.g);
        expect(repattern('pat1', { count: 6 })).toBeNull();
        expect(geo().curves.filter((k) => k.kind === 'circle')).toHaveLength(6);
        expect(countSpot(geo(), geo().patterns![0])).toEqual([0, 0]);
        solvesCleanly();
        undoSketch();
        expect(geo().curves.filter((k) => k.kind === 'circle')).toHaveLength(4);
        useSketcher.setState({ selection: [{ type: 'curve', id: c.id }] });
        deleteSelected();
        expect(geo().patterns).toEqual([]);
    });

    it('the circular form takes its centre from Radius and Arc Angle, and back', async () => {
        const c = seed();
        begin(c.g);
        useSketcher.setState({ selection: [{ type: 'curve', id: c.id }] });
        const form = press('sk-pattern-circular');
        expect(form.values.showCount).toBe(false);
        // The centre is the origin by default: 10 from the circle's middle, at 180 degrees.
        expect(form.values).toMatchObject({ radiusAt: '10', arcAngle: '180' });
        form.change('arcAngle', '90');
        expect(Number(form.values.centre0)).toBeCloseTo(10, 9);
        expect(Number(form.values.centre1)).toBeCloseTo(10, 9);
        form.change('centre1', '-5');
        expect(Number(form.values.radiusAt)).toBeCloseTo(5, 9);
        form.values = { ...form.values, centre0: '10', centre1: '-5', count: '4', angle: '360', showCount: true };
        expect((await form.apply()).isError).toBe(false);
        expect(geo().patterns![0]).toMatchObject({ kind: 'circular', showCount: true });
        expect((geo().patterns![0].options.form as { count: string }).count).toBe('4');
        solvesCleanly();
    });
});

describe('Ctrl-drag and Shift-drag', () => {
    function rect(): SketchGeometry {
        return addRect(EMPTY_GEOMETRY, [0, 0], [10, 5]).g;
    }

    const drag = (from: Pt, to: Pt, keys: { ctrl?: boolean; shift?: boolean }) => {
        useSketcher.setState({ tool: 'select' });
        sketchMove(from, 0.05, undefined, keys);
        expect(sketchDown(from, 0.05)).toBe(true);
        sketchMove(to, 0.05, undefined, keys);
        sketchUp(keys);
    };

    it('Ctrl-drag copies the selection by the pointer\'s move; the original stays', () => {
        begin(rect());
        const ids = geo().curves.map((c) => c.id);
        useSketcher.setState({ selection: ids.map((id) => ({ type: 'curve' as const, id })) });
        drag([5, 0], [25.5, -3.25], { ctrl: true });
        const g = geo();
        expect(g.curves).toHaveLength(8);
        const copied = useSketcher.getState().selection.filter((x) => x.type === 'curve').map((x) => x.id);
        expect(copied).toHaveLength(4);
        expect(copied.some((id) => ids.includes(id))).toBe(false);
        const us = g.points.map((p) => p.u);
        expect(Math.max(...us)).toBeCloseTo(30.5, 9);
        expect(Math.min(...g.points.map((p) => p.v))).toBeCloseTo(-3.25, 9);
        solvesCleanly();
    });

    it('Shift-drag moves the pressed line off the rest; a press without a drag stays a click', () => {
        begin(rect());
        const top = geo().curves.find((c) => c.kind === 'line' && P(geo(), (c as { a: string }).a)[1] === 5 && P(geo(), (c as { b: string }).b)[1] === 5)!;
        drag([5, 5], [5, 9], { shift: true });
        const line = curveOf(geo(), top.id) as { a: string; b: string };
        expect(P(geo(), line.a)[1]).toBeCloseTo(9, 9);
        expect(P(geo(), line.b)[1]).toBeCloseTo(9, 9);
        // The sides stay where they were.
        expect(geo().points.filter((p) => Math.abs(p.v - 5) < 1e-9)).toHaveLength(2);
        const before = geo();
        drag([5, 9], [5, 9], { shift: true });
        expect(geo()).toBe(before);
    });
});

describe('sketch picture dragged in the view', () => {
    const pic: SketchPicture = { id: 'pic1', asset: 'a.png', at: [10, 20], width: 40, height: 20, angle: 90, pixels: [400, 200], lockAspect: true };

    it('inside it moves the picture; a corner sizes it about the opposite corner, the aspect kept', () => {
        // Turned 90 degrees: the picture runs from (10, 20) up 40 and left 20.
        expect(pictureGrip(pic, [0, 40], 0.1)).toBe('move');
        expect(pictureGrip(pic, [10, 60], 0.1)).toBe(1);
        expect(pictureGrip(pic, [20, 40], 0.1)).toBeNull();
        expect(draggedPicture(pic, 'move', [0, 40], [5.5, 37.25]).at).toEqual([15.5, 17.25]);
        // The far corner (local 40, 20) is at (-10, 60); dragged to (-30, 100) the picture doubles about (10, 20).
        const big = draggedPicture(pic, 2, [-10, 60], [-30, 100]);
        expect(big.width).toBeCloseTo(80, 9);
        expect(big.height).toBeCloseTo(40, 9);
        expect(big.at[0]).toBeCloseTo(10, 9);
        expect(big.at[1]).toBeCloseTo(20, 9);
        // Free aspect, the first corner dragged: the far corner stays.
        const free = draggedPicture({ ...pic, lockAspect: false }, 0, [10, 20], [5, 30]);
        expect(free.width).toBeCloseTo(30, 9);
        expect(free.height).toBeCloseTo(15, 9);
        expect(free.at[0]).toBeCloseTo(5, 9);
        expect(free.at[1]).toBeCloseTo(30, 9);
    });

    it('a press on empty space goes to the open form first (no selection box), and its moves until release', () => {
        begin(EMPTY_GEOMETRY);
        useSketcher.setState({ tool: 'select' });
        const moves: Pt[] = [];
        setPressHook((raw) => (raw[0] > 0 ? { move: (to) => moves.push(to), up: () => moves.push([-1, -1]) } : null));
        expect(sketchDown([5, 5], 0.05)).toBe(true);
        sketchMove([6, 7], 0.05);
        sketchUp();
        expect(moves).toEqual([[6, 7], [-1, -1]]);
        setPressHook(null);
    });
});

describe('copy and paste of a whole sketch', () => {
    it('keeps its relations; pasted on a face its centre is where the face was clicked, on a plane it stays where it was', () => {
        const r = addRect(EMPTY_GEOMETRY, [0, 0], [10, 5]);
        expect(copyWholeSketch({ plane: 'front', profiles: [], geometry: r.g }, 'Sketch1')).toBeNull();
        const onFace = pastedGeometry([100, 50])!;
        expect(onFace.curves).toHaveLength(4);
        expect(onFace.constraints.map((k) => k.kind).sort()).toEqual(r.g.constraints.map((k) => k.kind).sort());
        const us = onFace.points.map((p) => p.u);
        expect((Math.min(...us) + Math.max(...us)) / 2).toBe(100);
        const onPlane = pastedGeometry(null)!;
        expect(onPlane.points.map((p) => [p.u, p.v]).sort()).toEqual(r.g.points.map((p) => [p.u, p.v]).sort());
        // Ctrl+V in an open sketch pastes it at the pointer.
        begin(EMPTY_GEOMETRY);
        useSketcher.setState({ cursor: [-20, 0], tool: 'select' });
        expect(pasteAtCursor()).toBe(true);
        expect(geo().curves).toHaveLength(4);
        const pu = geo().points.map((p) => p.u);
        expect((Math.min(...pu) + Math.max(...pu)) / 2).toBe(-20);
        solvesCleanly();
        itemsIntact();
    });
});
