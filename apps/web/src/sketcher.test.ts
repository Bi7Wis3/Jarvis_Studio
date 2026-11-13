import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSolver } from './solver';
import { addCircle, addLine, addRect, EMPTY_GEOMETRY } from './sketchGeometry';
import {
    applyTyped, circularPatternSelected, currentSketch, deleteConstraints, deleteSelected, fullyDefineSketch, linearPatternSelected, moveLabel, redoSketch,
    repairAll, setSnapKind, setTool, sketchClick, sketchDown, sketchEnter, sketchEscape, sketchMove, sketchUp, startSketch, startTransformPick,
    stopTransformPick, toggleLock, transformSelected, typeKey, undoSketch, useSketcher,
} from './sketcher';
import { addConstraint } from './sketchGeometry';
import { curveRadius } from './solver';
import type { SketchGeometry } from '@jarvis/core';

// The sketcher's wasm URL only resolves in the browser; with none, the solver finds its own file.
vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const TOL = 1;
const state = () => useSketcher.getState();

/** A 40 mm line along u, and a circle of radius 5 well above it. */
function scene() {
    let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [40, 0] }).g;
    g = addCircle(g, { at: [20, 30] }, 5).g;
    return g;
}

describe('dimension tool', () => {
    beforeEach(() => {
        useSketcher.setState({ active: true, stage: 'draw', geometry: scene(), labels: {}, picks: [], dimDraft: null, dimDrag: null });
        setTool('dimension');
    });

    it('catches a line from well away, and a point only right on it', () => {
        sketchMove([20, 2.2], TOL);
        expect(state().hover).toMatchObject({ type: 'curve' });
        sketchMove([20, 3], TOL);
        expect(state().hover).toBeNull();
        // Near an end, but not on it: still the line.
        sketchMove([39, 1], TOL);
        expect(state().hover).toMatchObject({ type: 'curve' });
        sketchMove([39.6, 0.2], TOL);
        expect(state().hover).toMatchObject({ type: 'point' });
    });

    it('drags a dimension out of a line and asks for its value where it was dropped', () => {
        expect(sketchDown([20, 1.5], TOL)).toBe(true);
        sketchMove([22, 9], TOL);
        sketchUp();
        expect(state().dimDrag).toBeNull();
        expect(state().dimDraft).toMatchObject({ constraint: { kind: 'length' }, at: [22, 9], text: '40' });
        // The click that follows the release changes nothing.
        sketchClick([22, 9], TOL);
        expect(state().dimDraft?.at).toEqual([22, 9]);
    });

    it('treats a press and release in place as a click, and leaves empty space to the camera', () => {
        expect(sketchDown([20, 0.5], TOL)).toBe(true);
        sketchUp();
        expect(state().dimDraft).toBeNull();
        sketchClick([20, 0.5], TOL);
        expect(state().picks).toHaveLength(1);
        expect(sketchDown([70, 70], TOL)).toBe(false);
    });

    it('drags a diameter out of a circle', () => {
        expect(sketchDown([25.5, 30], TOL)).toBe(true);
        sketchMove([32, 36], TOL);
        sketchUp();
        expect(state().dimDraft).toMatchObject({ constraint: { kind: 'diameter' }, text: '10' });
    });

    it('saves moved labels with the sketch and reads them back', () => {
        const line = state().geometry.curves.find((c) => c.kind === 'line')!;
        const g = { ...state().geometry, constraints: [{ id: 'd1', kind: 'length' as const, line: line.id, value: 40 }] };
        useSketcher.setState({ geometry: g });
        moveLabel('d1', [12, -7]);
        const saved = currentSketch();
        expect(saved.geometry?.constraints[0]).toMatchObject({ id: 'd1', at: [12, -7] });
        startSketch(null, 'sketch', { partId: 'p', featureId: null, sketch: saved });
        expect(state().labels).toEqual({ d1: [12, -7] });
    });

    it('saves open chains next to the closed profiles, for sweep paths', () => {
        // scene(): a 40 mm line and a circle.
        const saved = currentSketch();
        expect(saved.profiles).toHaveLength(1);
        expect(saved.open).toHaveLength(1);
        expect(saved.open![0]).toMatchObject({ kind: 'path', segments: [{ kind: 'line' }] });
    });
});

describe('dragging in the select tool', () => {
    const at = (id: string): [number, number] => {
        const p = state().geometry.points.find((q) => q.id === id)!;
        return [p.u, p.v];
    };
    /** A 40 x 20 rectangle from the origin corner, and a separate line far to the right. */
    function setup() {
        const rect = addRect(EMPTY_GEOMETRY, { at: [10, 10] }, { at: [50, 30] });
        const g = addLine(rect.g, { at: [80, 0] }, { at: [100, 25] }).g;
        useSketcher.setState({ active: true, stage: 'draw', geometry: g, undo: [], redo: [], drag: null, dragFrom: null });
        setTool('select');
        return g;
    }
    const corner = (u: number, v: number) => state().geometry.points.find((p) => Math.abs(p.u - u) < 1e-6 && Math.abs(p.v - v) < 1e-6)!.id;

    it('moves a rectangle corner with its two sides and leaves the opposite corner and other shapes alone', () => {
        setup();
        const [far, grabbed, lineEnd] = [corner(10, 10), corner(50, 30), corner(100, 25)];
        expect(sketchDown([50, 30], TOL)).toBe(true);
        sketchMove([58, 37], TOL);
        sketchUp();
        expect(at(grabbed)[0]).toBeCloseTo(58, 3);
        expect(at(grabbed)[1]).toBeCloseTo(37, 3);
        expect(at(far)).toEqual([10, 10]);
        expect(at(lineEnd)).toEqual([100, 25]);
        // Still a rectangle: the neighbours followed on one axis each.
        expect(state().geometry.points.filter((p) => Math.abs(p.u - 58) < 1e-3)).toHaveLength(2);
        expect(state().geometry.points.filter((p) => Math.abs(p.v - 37) < 1e-3)).toHaveLength(2);
    });

    it('moves a whole line when it is grabbed between its ends, keeping the far side still', () => {
        setup();
        const [bottomLeft, bottomRight] = [corner(10, 10), corner(50, 10)];
        // The top edge, grabbed in the middle and pulled straight up.
        expect(sketchDown([30, 30], TOL)).toBe(true);
        sketchMove([30, 42], TOL);
        sketchUp();
        expect(state().geometry.points.filter((p) => Math.abs(p.v - 42) < 1e-3)).toHaveLength(2);
        expect(at(bottomLeft)).toEqual([10, 10]);
        expect(at(bottomRight)).toEqual([50, 10]);
    });

    it('undoes a drag in one step and redoes it', () => {
        const before = setup();
        sketchDown([50, 30], TOL);
        sketchMove([54, 33], TOL);
        sketchMove([58, 37], TOL);
        sketchUp();
        const after = state().geometry;
        expect(state().undo).toHaveLength(1);
        undoSketch();
        expect(state().geometry.points).toEqual(before.points);
        redoSketch();
        expect(state().geometry.points).toEqual(after.points);
        // A press that moves nothing leaves no undo step.
        undoSketch();
        sketchDown([50, 30], TOL);
        sketchUp();
        expect(state().undo).toHaveLength(0);
    });

    it('locks a line so it cannot be dragged, and unlocks it again', () => {
        setup();
        const top = state().geometry.curves.find((c) => c.kind === 'line' && [c.a, c.b].every((id) => at(id)[1] === 30))!;
        toggleLock([{ type: 'curve', id: top.id }]);
        expect(state().geometry.constraints.filter((c) => c.kind === 'fix')).toHaveLength(2);
        sketchDown([30, 30], TOL);
        sketchMove([30, 42], TOL);
        sketchUp();
        expect(state().geometry.points.filter((p) => p.v === 30)).toHaveLength(2);
        toggleLock([{ type: 'curve', id: top.id }]);
        expect(state().geometry.constraints.filter((c) => c.kind === 'fix')).toHaveLength(0);
    });
});

describe('modify tools', () => {
    const begin = (g: SketchGeometry, tool: Parameters<typeof setTool>[0]) => {
        useSketcher.setState({ active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], picks: [], dimDraft: null, typed: '', drag: null });
        setTool(tool);
    };
    const kinds = () => state().geometry.curves.filter((c) => !c.construction).map((c) => c.kind).sort();
    /** Two perpendicular lines meeting at (0, 0), from (20, 0) and (0, 20). */
    function corner() {
        const a = addLine(EMPTY_GEOMETRY, { at: [20, 0] }, { at: [0, 0] }, 'horizontal');
        return addLine(a.g, { at: [0, 0], point: a.b }, { at: [0, 20] }, 'vertical').g;
    }

    it('trims the piece under the cursor, shows it first, and undoes in one step', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [-30, 0] }, { at: [30, 0] }).g;
        g = addCircle(g, { at: [0, 0] }, 10).g;
        begin(g, 'trim');
        sketchMove([0, 0.3], TOL);
        expect(state().editPreview).toHaveLength(1);
        expect(state().editPreview[0]).toMatchObject({ kind: 'line' });
        sketchClick([0, 0.3], TOL);
        expect(kinds()).toEqual(['circle', 'line', 'line']);
        expect(state().undo).toHaveLength(1);
        // Then the top of the circle, between the two cut ends: it becomes an arc.
        sketchClick([0, 10.2], TOL);
        expect(kinds()).toEqual(['arc', 'line', 'line']);
        undoSketch();
        undoSketch();
        expect(kinds()).toEqual(['circle', 'line']);
    });

    it('extends a line to the next one with T', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        g = addLine(g, { at: [25, -10] }, { at: [25, 10] }).g;
        begin(g, 'extend');
        sketchClick([9, 0.2], TOL);
        expect(state().geometry.points.some((p) => p.u === 25 && p.v === 0)).toBe(true);
    });

    it('fillets a corner with the typed radius and keeps it for the next', () => {
        begin(corner(), 'fillet');
        expect(typeKey('3')).toBe(true);
        expect(applyTyped()).toBeNull();
        expect(state().filletRadius).toBe(3);
        sketchClick([0, 0], TOL);
        const arc = state().geometry.curves.find((c) => c.kind === 'arc')!;
        expect(curveRadius(state().geometry, arc.id)).toBeCloseTo(3);
        expect(state().geometry.constraints.some((c) => c.kind === 'radius' && c.value === 3)).toBe(true);
        expect(state().message).toBeNull();
    });

    it('fillets two picked lines, and says why when the radius does not fit', () => {
        begin(corner(), 'fillet');
        useSketcher.setState({ filletRadius: 50 });
        sketchClick([10, 0], TOL);
        expect(state().picks).toHaveLength(1);
        sketchClick([0, 10], TOL);
        expect(state().message).toMatch(/too big/);
        useSketcher.setState({ filletRadius: 4 });
        sketchClick([10, 0], TOL);
        sketchClick([0, 10], TOL);
        expect(kinds()).toEqual(['arc', 'line', 'line']);
    });

    it('chamfers a corner', () => {
        begin(corner(), 'chamfer');
        sketchClick([0, 0], TOL);
        expect(kinds()).toEqual(['line', 'line', 'line']);
        expect(state().geometry.curves.filter((c) => c.construction)).toHaveLength(2);
    });

    it('offsets a rectangle to where the cursor is, or by a typed distance', () => {
        const rect = addRect(EMPTY_GEOMETRY, [0, 0], [40, 20]);
        begin(rect.g, 'offset');
        sketchClick([20, 0.2], TOL);
        expect(state().offsetCurve).toBe(rect.lines[0]);
        sketchMove([20, -5], TOL);
        expect(state().editPreview).toHaveLength(4);
        expect(state().editText).toBe('5');
        sketchClick([20, -5], TOL);
        expect(state().geometry.curves).toHaveLength(8);
        expect(Math.min(...state().geometry.points.map((p) => p.v))).toBeCloseTo(-5);
        // Typed: 2 inside.
        sketchClick([20, 0.2], TOL);
        sketchMove([20, 1], TOL);
        typeKey('2');
        applyTyped();
        expect(state().geometry.curves).toHaveLength(12);
        expect(state().geometry.points.some((p) => Math.abs(p.u - 2) < 1e-6 && Math.abs(p.v - 2) < 1e-6)).toBe(true);
    });

    it('mirrors the selected curves about the v axis, or about a line after Enter', () => {
        const g = addLine(EMPTY_GEOMETRY, { at: [5, 0] }, { at: [15, 10] }).g;
        begin(g, 'select');
        useSketcher.setState({ selection: [{ type: 'curve', id: g.curves[0].id }] });
        setTool('mirror');
        expect(state().picks).toHaveLength(1);
        sketchClick([0.2, 40], TOL);
        expect(state().geometry.curves).toHaveLength(2);
        expect(state().geometry.points.some((p) => p.u === -15 && p.v === 10)).toBe(true);
        // Pick the copy, Enter, then the original line as the mirror line.
        const copy = state().geometry.curves[1].id;
        sketchClick([-10, 5], TOL);
        expect(state().picks.map((p) => p.id)).toEqual([copy]);
        expect(sketchEnter()).toBe(true);
        sketchClick([10, 5], TOL);
        expect(state().geometry.curves).toHaveLength(3);
        sketchEscape();
    });

    it('patterns the selection in a row and round a point', () => {
        const c = addCircle(EMPTY_GEOMETRY, { at: [10, 0] }, 2);
        begin(c.g, 'select');
        useSketcher.setState({ selection: [{ type: 'curve', id: c.id }] });
        expect(linearPatternSelected(3, [0, 10])).toBeNull();
        expect(state().geometry.curves).toHaveLength(3);
        expect(linearPatternSelected(3, [0, 10])).toMatch(/Select/);
        useSketcher.setState({ selection: [{ type: 'curve', id: c.id }] });
        expect(circularPatternSelected(4, 360, [0, 0])).toBeNull();
        expect(state().geometry.curves).toHaveLength(6);
        expect(state().geometry.points.some((p) => Math.abs(p.u + 10) < 1e-6 && Math.abs(p.v) < 1e-6)).toBe(true);
    });
});

describe('centre draw tools', () => {
    const begin = (tool: Parameters<typeof setTool>[0]) => {
        useSketcher.setState({ active: true, stage: 'draw', geometry: EMPTY_GEOMETRY, undo: [], redo: [], selection: [], typed: '' });
        setTool(tool);
    };

    it('draws a centre arc the way the cursor turns', () => {
        begin('centerArc');
        sketchClick([0, 0], TOL);
        sketchClick([10, 0], TOL);
        sketchMove([7, 7], TOL);
        sketchMove([0, 10], TOL);
        sketchMove([-7, 7], TOL);
        sketchMove([-10, 0], TOL);
        sketchClick([-10, 0], TOL);
        const arc = state().geometry.curves[0];
        expect(arc).toMatchObject({ kind: 'arc', center: 'origin' });
        const at = (id: string) => state().geometry.points.find((p) => p.id === id)!;
        if (arc.kind === 'arc') {
            // Counter-clockwise over the top: from (10, 0) to (-10, 0).
            expect(at(arc.start).u).toBeCloseTo(10);
            expect(at(arc.end).u).toBeCloseTo(-10);
        }
        // The other way round: under, so the arc runs from the end back to the start.
        sketchClick([20, 0], TOL);
        sketchClick([30, 0], TOL);
        sketchMove([27, -7], TOL);
        sketchMove([20, -10], TOL);
        sketchClick([20, -10], TOL);
        const cw = state().geometry.curves[1];
        if (cw.kind === 'arc') {
            expect(at(cw.start).v).toBeCloseTo(-10);
            expect(at(cw.end).u).toBeCloseTo(30);
        }
    });

    it('draws a centre rectangle about the origin, and from typed sizes', () => {
        begin('centerRect');
        sketchClick([0, 0], TOL);
        sketchClick([20, 10], TOL);
        expect(state().geometry.curves.filter((c) => !c.construction)).toHaveLength(4);
        expect(state().geometry.points.some((p) => p.u === -20 && p.v === -10)).toBe(true);
        sketchClick([50, 0], TOL);
        sketchMove([55, 5], TOL);
        typeKey('8');
        typeKey(',');
        typeKey('4');
        applyTyped();
        expect(state().geometry.points.some((p) => Math.abs(p.u - 46) < 1e-6 && Math.abs(p.v + 2) < 1e-6)).toBe(true);
        expect(state().geometry.constraints.filter((c) => c.kind === 'length')).toHaveLength(2);
    });
});

describe('point, centreline, quick snaps', () => {
    const begin = (g: SketchGeometry, tool: Parameters<typeof setTool>[0]) => {
        useSketcher.setState({ active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], typed: '', draft: [], snapKinds: {} });
        setTool(tool);
    };

    it('places loose points, snapped onto curves, and keeps them when other things are deleted', () => {
        begin(addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [20, 0] }).g, 'point');
        sketchClick([7.3, 0.2], TOL);
        sketchClick([5, 9.8], TOL);
        const g = state().geometry;
        expect(g.points).toHaveLength(4);
        const onLine = g.points.find((p) => Math.abs(p.u - 7.3) < 1e-6)!;
        expect(onLine.v).toBeCloseTo(0);
        expect(g.constraints.some((c) => c.kind === 'pointOnCurve' && c.point === onLine.id)).toBe(true);
        // On an existing point: nothing new.
        sketchClick([20.1, 0.1], TOL);
        expect(state().geometry.points).toHaveLength(4);
        expect(state().message).toMatch(/already/);
        // Deleting the line keeps the loose point at (5, 10) (the one on the line loses its relation).
        setTool('select');
        useSketcher.setState({ selection: [{ type: 'curve', id: g.curves[0].id }] });
        deleteSelected();
        expect(state().geometry.curves).toHaveLength(0);
        expect(state().geometry.points.map((p) => [p.u, p.v])).toEqual([[7.3, 0], [5, 10]]);
    });

    it('draws centrelines as construction lines', () => {
        begin(EMPTY_GEOMETRY, 'centerline');
        sketchClick([0, 0], TOL);
        sketchClick([0, 30], TOL);
        expect(state().geometry.curves).toMatchObject([{ kind: 'line', construction: true }]);
        expect(state().geometry.constraints).toMatchObject([{ kind: 'vertical' }]);
        typeKey('1');
        typeKey('0');
        applyTyped();
        expect(state().geometry.curves).toHaveLength(2);
        expect(state().geometry.curves[1].construction).toBe(true);
    });

    it('skips snap kinds switched off in quick snaps', () => {
        begin(addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [20, 0] }).g, 'line');
        sketchMove([10.2, 0.2], TOL);
        expect(state().snapKind).toBe('mid');
        setSnapKind('mid', false);
        expect(state().snapKinds).toEqual({ mid: false });
        sketchMove([10.2, 0.2], TOL);
        expect(state().snapKind).toBe('curve');
        setSnapKind(null);
        expect(state().snapKinds).toEqual({});
    });
});

describe('move, copy, rotate, scale', () => {
    const begin = (g: SketchGeometry) => {
        useSketcher.setState({ active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], typed: '', draft: [], labels: {} });
        setTool('select');
    };

    it('moves the selection by two picked points, and says what it dropped', () => {
        const rect = addRect(EMPTY_GEOMETRY, [0, 0], [20, 10]);
        // Its first corner held on the v axis: that relation ties it to the rest and goes with the move.
        const corner = (rect.g.curves[0] as { a: string }).a;
        begin(addConstraint(rect.g, { kind: 'pointOnCurve', point: corner, curve: 'axis-v' }).g);
        useSketcher.setState({ selection: rect.lines.map((id) => ({ type: 'curve' as const, id })) });
        startTransformPick('move');
        expect(state().tool).toBe('xform');
        sketchClick([0.1, 0.1], TOL);
        expect(state().xform?.picks).toEqual([[0, 0]]);
        sketchMove([30, 30], TOL);
        expect(state().editPreview).toHaveLength(4);
        expect(transformSelected({ kind: 'move', by: [30, 30] }, false)).toBeNull();
        // Closing the form goes back to selecting and keeps the status line.
        stopTransformPick();
        expect(state().tool).toBe('select');
        expect(state().message).toMatch(/Moved 4 items; removed 1 relation/);
        expect(state().geometry.points.some((p) => p.u === 30 && p.v === 30)).toBe(true);
        expect(state().undo).toHaveLength(1);
    });

    it('copies, rotates and scales, keeping the original for a copy', () => {
        const c = addCircle(EMPTY_GEOMETRY, { at: [10, 0] }, 2);
        begin(c.g);
        useSketcher.setState({ selection: [{ type: 'curve', id: c.id }] });
        expect(transformSelected({ kind: 'rotate', centre: [0, 0], angle: 90 }, true)).toBeNull();
        expect(state().geometry.curves).toHaveLength(2);
        expect(state().geometry.points.some((p) => Math.abs(p.u) < 1e-6 && Math.abs(p.v - 10) < 1e-6)).toBe(true);
        // The copy is selected now; scale it.
        expect(transformSelected({ kind: 'scale', centre: [0, 0], factor: 0.5 }, false)).toBeNull();
        const copy = state().geometry.curves[1];
        expect(curveRadius(state().geometry, copy.id)).toBeCloseTo(1);
        useSketcher.setState({ selection: [] });
        expect(transformSelected({ kind: 'move', by: [1, 0] }, false)).toMatch(/Select/);
    });
});

describe('relations, repair, fully define', () => {
    const begin = (g: SketchGeometry) => {
        useSketcher.setState({ active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], typed: '', draft: [], labels: {}, message: null });
        setTool('select');
    };

    it('deletes relations in one undo step', () => {
        const rect = addRect(EMPTY_GEOMETRY, [0, 0], [20, 10]);
        begin(rect.g);
        const ids = state().geometry.constraints.slice(0, 2).map((c) => c.id);
        useSketcher.setState({ selection: [{ type: 'constraint', id: ids[0] }] });
        deleteConstraints(ids);
        expect(state().geometry.constraints).toHaveLength(2);
        expect(state().selection).toEqual([]);
        undoSketch();
        expect(state().geometry.constraints).toHaveLength(4);
    });

    it('repairs everything and reports it', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        g = addLine(g, { at: [10.2, 0] }, { at: [10, 10] }).g;
        begin(g);
        expect(repairAll()).toBe(true);
        expect(state().geometry.points).toHaveLength(3);
        expect(state().message).toMatch(/Repaired 1 problem/);
        repairAll();
        expect(state().message).toMatch(/Nothing/);
    });

    it('fully defines a rectangle', () => {
        begin(addRect(EMPTY_GEOMETRY, [5, 5], [25, 15]).g);
        fullyDefineSketch();
        expect(state().dof).toBe(0);
        expect(state().message).toMatch(/Added 4 dimensions; the sketch is fully defined/);
        fullyDefineSketch();
        expect(state().message).toMatch(/already/);
    });
});
