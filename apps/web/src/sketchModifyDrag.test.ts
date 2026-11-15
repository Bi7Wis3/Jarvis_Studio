// Modify Sketch in the view: the left button drags the whole sketch, the right button turns it about the centre of
// rotation (which the left button drags), right-clicking a flip symbol flips it; nothing moves until release.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import { loadSolver, pointOf } from './solver';
import { addLine, EMPTY_GEOMETRY } from './sketchGeometry';
import { undoSketch, useSketcher } from './sketcher';
import { ARM_PX, dragMap, flipAt, modifyDown, modifyMove, modifyUp, movedEntities, startModifyDrag, stopModifyDrag, useModifyDrag } from './sketchModifyDrag';
import { planeFrame, toPartFrame } from './sketchMath';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const state = () => useSketcher.getState();
const TOL = 1;

function start(g: SketchGeometry): void {
    useSketcher.setState({
        active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], message: null, tool: 'select', labels: {},
        plane: 'top', offset: 0, context: [], look: 0,
    });
    startModifyDrag();
}

const line = () => addLine(EMPTY_GEOMETRY, { at: [2, 1] }, { at: [6, 1] });

beforeEach(() => stopModifyDrag());

describe('modify sketch by dragging in the view', () => {
    it('takes presses only while the form is open', () => {
        useSketcher.setState({ active: true, stage: 'draw' });
        expect(modifyDown(0, [5, 5], TOL)).toBe(false);
        start(line().g);
        expect(modifyDown(1, [5, 5], TOL)).toBe(false);
        expect(modifyDown(0, [5, 5], TOL)).toBe(true);
    });

    it('moves the sketch with the left button on release, keeping the view, in one undo step', () => {
        const l = line();
        start(l.g);
        modifyDown(0, [5, 5], TOL);
        modifyMove([10, 3]);
        modifyMove([15, 2]);
        // While dragging nothing moves; the ghost shows the sketch moved.
        expect(state().plane).toBe('top');
        const drag = useModifyDrag.getState().drag!;
        expect(movedEntities(l.g, dragMap(drag, [0, 0]))).toEqual([{ kind: 'line', a: [12, -2], b: [16, -2] }]);
        expect(modifyUp()).toBeNull();
        const origin = toPartFrame(state().plane, state().offset, [0, 0]);
        const expected = toPartFrame('top', 0, [10, -3]);
        origin.forEach((x, i) => expect(x).toBeCloseTo(expected[i], 9));
        // The geometry is the same in its own coordinates; the camera was not turned to it.
        expect(pointOf(state().geometry, (l.g.curves[0] as { a: string }).a)).toMatchObject({ u: 2, v: 1 });
        expect(state().look).toBe(0);
        undoSketch();
        expect(state().plane).toBe('top');
    });

    it('turns the sketch with the right button about the centre of rotation, in whole degrees', () => {
        start(line().g);
        modifyDown(2, [10, 0], TOL);
        modifyMove([7, 7.2]);
        modifyMove([-0.05, 10]);
        expect(useModifyDrag.getState().drag!.angle).toBeCloseTo(90.29, 1);
        expect(modifyUp()).toBeNull();
        const f = planeFrame(state().plane, state().offset);
        const v = planeFrame('top').v;
        f.u.forEach((x, i) => expect(x).toBeCloseTo(v[i], 9));
    });

    it('drags the centre of rotation away and turns about it', () => {
        start(line().g);
        modifyDown(0, [0.2, 0], TOL);
        modifyMove([5, 0]);
        modifyMove([10, 0]);
        expect(modifyUp()).toBeNull();
        expect(useModifyDrag.getState().centre).toEqual([10, 0]);
        expect(state().plane).toBe('top');
        // A half turn about (10, 0): the sketch origin goes to (20, 0).
        modifyDown(2, [20, 0], TOL);
        modifyMove([10, 10]);
        modifyMove([0, 0.0001]);
        modifyUp();
        const origin = toPartFrame(state().plane, state().offset, [0, 0]);
        const expected = toPartFrame('top', 0, [20, 0]);
        origin.forEach((x, i) => expect(x).toBeCloseTo(expected[i], 6));
    });

    it('flips with a right-click on a flip symbol, and a press without a drag moves nothing', () => {
        const l = line();
        start(l.g);
        const arm = (ARM_PX / 10) * TOL;
        expect(flipAt([arm, 0.3], arm, TOL)).toBe('x');
        expect(flipAt([0, arm], arm, TOL)).toBe('y');
        expect(flipAt([0.1, 0.1], arm, TOL)).toBe('both');
        expect(flipAt([3, 3], arm, TOL)).toBeNull();
        modifyDown(2, [0, arm], TOL);
        modifyUp();
        const end = (l.g.curves[0] as { b: string }).b;
        expect(pointOf(state().geometry, end)).toMatchObject({ u: -6, v: 1 });
        modifyDown(0, [5, 5], TOL);
        modifyMove([5.1, 5]);
        modifyUp();
        expect(state().plane).toBe('top');
    });
});
