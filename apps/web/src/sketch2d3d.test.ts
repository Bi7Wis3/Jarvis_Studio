// 2D to 3D: taking entities out into a sketch of their own, folding the views up about the Front view's edges (and
// an Auxiliary view about a line), and Align Sketch's motion.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Feature, SketchGeometry, Vec3 } from '@jarvis/core';
import { loadSolver } from './solver';
import { addConstraint, addRect, EMPTY_GEOMETRY } from './sketchGeometry';
import {
    alignMotion, alignRef, auxiliaryPlane, boundsOf, extractCurves, frontBounds, sketchOfGeometry, viewDepth, viewName, viewPlane,
} from './sketch2d3d';
import { planeFrame, toPartFrame } from './sketchMath';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const close = (a: Vec3, b: Vec3) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 9));
const front = planeFrame('front');

/** The drawing: a 40 x 20 Front view at the origin, a Top view 15 deep above it (10 mm gap), a Right view beside it. */
function drawing() {
    const f = addRect(EMPTY_GEOMETRY, [0, 0], [40, 20]);
    const t = addRect(f.g, [0, 30], [40, 45]);
    const r = addRect(t.g, [50, 0], [65, 20]);
    return { g: r.g, front: f.lines, top: t.lines, right: r.lines };
}

const step = (id: string, g: SketchGeometry, view: 'front' | 'top' | 'right'): Feature =>
    ({ id, op: 'sketch', name: id, sketch: sketchOfGeometry(g, 'front', 0, { view }) }) as Feature;

describe('taking entities out of a sketch', () => {
    it('moves the selected curves with their relations into a sketch of their own', () => {
        const d = drawing();
        const sized = addConstraint(d.g, { kind: 'length', line: d.front[0], value: 40 }).g;
        const { picked, rest } = extractCurves(sized, d.front, {});
        expect(picked.curves.map((c) => c.id)).toEqual(d.front);
        expect(picked.points).toHaveLength(4);
        expect(picked.constraints.some((k) => k.kind === 'length')).toBe(true);
        expect(rest.curves).toHaveLength(8);
        expect(rest.constraints.some((k) => k.kind === 'length')).toBe(false);
        const sketch = sketchOfGeometry(picked, 'front', 0, { view: 'front' });
        expect(sketch.profiles).toHaveLength(1);
        expect(sketch.view).toBe('front');
    });
});

describe('folding views', () => {
    it('folds the Top view back about the Front view top edge, its near edge on the Front plane', () => {
        const d = drawing();
        const top = extractCurves(d.g, d.top).picked;
        const plane = viewPlane('top', front, { lo: [0, 0], hi: [40, 20] }, boundsOf(top)!, null);
        if ('error' in plane) {
            throw new Error(plane.error);
        }
        close(plane.normal, [0, 1, 0]);
        // The near corner lands on the Front view's top corner; the far one 15 mm behind it.
        close(toPartFrame(plane, 0, [0, 30]), [0, 20, 0]);
        close(toPartFrame(plane, 0, [40, 45]), [40, 20, -15]);
    });

    it('folds the Right view about the Front view right edge', () => {
        const d = drawing();
        const right = extractCurves(d.g, d.right).picked;
        const plane = viewPlane('right', front, { lo: [0, 0], hi: [40, 20] }, boundsOf(right)!, null);
        if ('error' in plane) {
            throw new Error(plane.error);
        }
        close(plane.normal, [1, 0, 0]);
        close(toPartFrame(plane, 0, [50, 0]), [40, 0, 0]);
        close(toPartFrame(plane, 0, [65, 20]), [40, 20, -15]);
    });

    it('folds the Left and Bottom views the other way, and puts the Back as deep as the part', () => {
        const box = { lo: [0, 0] as [number, number], hi: [40, 20] as [number, number] };
        const left = viewPlane('left', front, box, { lo: [-25, 0], hi: [-10, 20] }, null);
        const bottom = viewPlane('bottom', front, box, { lo: [0, -25], hi: [40, -10] }, null);
        const back = viewPlane('back', front, box, { lo: [75, 0], hi: [115, 20] }, 15);
        if ('error' in left || 'error' in bottom || 'error' in back) {
            throw new Error('a view did not fold');
        }
        close(left.normal, [-1, 0, 0]);
        close(toPartFrame(left, 0, [-10, 0]), [0, 0, 0]);
        close(toPartFrame(left, 0, [-25, 20]), [0, 20, -15]);
        close(bottom.normal, [0, -1, 0]);
        close(toPartFrame(bottom, 0, [0, -10]), [0, 0, 0]);
        close(toPartFrame(bottom, 0, [40, -25]), [40, 0, -15]);
        close(back.normal, [0, 0, -1]);
        close(toPartFrame(back, 0, [75, 0]), [40, 0, -15]);
        close(toPartFrame(back, 0, [115, 20]), [0, 20, -15]);
        expect(viewPlane('back', front, box, box, null)).toMatchObject({ error: expect.stringMatching(/Right, Left, Top or Bottom/) });
    });

    it('folds an Auxiliary view about a slanted line of another view, square to the drawing', () => {
        // The line from (40, 0) to (50, 10), the view drawn beyond it.
        const view = addRect(EMPTY_GEOMETRY, [60, -10], [70, 0]).g;
        const plane = auxiliaryPlane(front, [40, 0], [50, 10], view);
        if ('error' in plane) {
            throw new Error(plane.error);
        }
        const s = Math.SQRT1_2;
        close(plane.normal, [s, -s, 0]);
        // The view's corner nearest the line lands on the line, on the Front plane.
        close(toPartFrame(plane, 0, [60, 0]), [50, 10, 0]);
        expect(auxiliaryPlane(front, [1, 1], [1, 1], view)).toMatchObject({ error: expect.any(String) });
    });

    it('finds the Front view and the depth from the part, and names views', () => {
        const d = drawing();
        expect(frontBounds([], front)).toMatchObject({ error: expect.stringMatching(/Add the Front view first/) });
        const features = [step('f', extractCurves(d.g, d.front).picked, 'front')];
        expect(frontBounds(features, front)).toEqual({ lo: [0, 0], hi: [40, 20] });
        expect(viewDepth(features)).toBeNull();
        const right = extractCurves(d.g, d.right).picked;
        expect(viewDepth([...features, step('r', right, 'right')])).toBe(15);
        expect(viewName(features, 'front')).toBe('Front');
        expect(viewName([{ ...features[0], name: 'Front' } as Feature], 'front')).toBe('Front2');
    });
});

describe('align sketch', () => {
    it('slides a point onto a point, or square onto a line', () => {
        expect(alignMotion({ kind: 'point', p: [1, 2] }, { kind: 'point', p: [4, 6] })).toEqual({ by: [3, 4], centre: [0, 0], angle: 0 });
        const m = alignMotion({ kind: 'point', p: [3, 5] }, { kind: 'line', a: [0, 0], b: [10, 0] });
        expect(m).toMatchObject({ angle: 0 });
        expect((m as { by: number[] }).by[1]).toBeCloseTo(-5, 12);
    });

    it('turns a line the least way to lie along the other, then slides it onto it', () => {
        const m = alignMotion({ kind: 'line', a: [0, 5], b: [10, 6] }, { kind: 'line', a: [20, 0], b: [0, 0] });
        if ('error' in m) {
            throw new Error(m.error);
        }
        expect(m.angle).toBeCloseTo((-Math.atan2(1, 10) * 180) / Math.PI, 9);
        expect(m.centre).toEqual([5, 5.5]);
        expect(m.by[1]).toBeCloseTo(-5.5, 9);
        const r = addRect(EMPTY_GEOMETRY, [0, 0], [10, 5]);
        expect(alignRef(r.g, r.lines[0])).toMatchObject({ kind: 'line' });
        expect(alignRef(r.g, 'origin')).toEqual({ kind: 'point', p: [0, 0] });
    });
});
