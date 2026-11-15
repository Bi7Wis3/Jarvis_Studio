// Audit of the Draw group of the sketch toolbar: every tool switched on through its toolbar entry, driven by clicks
// away from the origin and at an angle, and checked for exact geometry, relations, clean solving, undo and regions.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchCurve } from '@jarvis/core';
import { ALL_TOOLS } from '../toolDefs';
import { curveRadius, loadSolver, measure, pointOf } from '../solver';
import { addLine, EMPTY_GEOMETRY } from '../sketchGeometry';
import { arcParams, polygonInfo } from '../sketchDrawVariants';
import { valueText } from '../numberText';
import {
    endChain, enterKey, setTool, sketchEscape, sketchMove, toggleLineArc, typeKey, useSketcher,
} from '../sketcher';
import {
    at, begin, click, clicks, ctx, curvesOf, everyKind, expectPt, geo, groupTools, noDangling, openChains, press, profiles, relations,
    solvesCleanly, state, TOL, undoRedoRestores, type OpenForm,
} from './harness';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

beforeEach(() => begin());

const type = (text: string) => {
    for (const k of text) {
        typeKey(k);
    }
    return enterKey();
};
const ends = (c: SketchCurve): [[number, number], [number, number]] => {
    const l = c as Extract<SketchCurve, { kind: 'line' }>;
    return [at(l.a), at(l.b)];
};
const len = (c: SketchCurve) => {
    const [a, b] = ends(c);
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
};
const dot = (p: [number, number], q: [number, number]) => p[0] * q[0] + p[1] * q[1];
const vec = (c: SketchCurve): [number, number] => {
    const [a, b] = ends(c);
    return [b[0] - a[0], b[1] - a[1]];
};
const curveForm = (kind: string) => ALL_TOOLS.find((t) => t.id === `sk-pm-${kind}`)!;

/** What the form's DrawSession does when something is drawn: its Parameters show the entity's values. */
function fill(form: OpenForm, values: { [key: string]: number }, keys: Record<string, string>): void {
    for (const [name, key] of Object.entries(keys)) {
        form.values = { ...form.values, [key]: valueText(values[name]), _subject: 'yes' };
    }
}

describe('the Draw group', () => {
    it('lists the draw tools the SKETCH_TOOLS table names', () => {
        const ids = groupTools('draw').map((t) => t.id);
        expect(ids).toEqual([
            'sk-line', 'sk-midpointLine', 'sk-rect', 'sk-centerRect', 'sk-rect3', 'sk-centerRect3', 'sk-parallelogram', 'sk-circle',
            'sk-perimeterCircle', 'sk-arc', 'sk-centerArc', 'sk-tangentArc', 'sk-slot', 'sk-centerSlot', 'sk-arcSlot3', 'sk-centerArcSlot',
            'sk-polygon', 'sk-ellipse', 'sk-partialEllipse', 'sk-spline', 'sk-styleSpline', 'sk-parabola', 'sk-conic', 'sk-centerline',
            'sk-point', 'sk-text', 'sk-picture', 'sk-equation-curve', 'sk-belt',
        ]);
    });
});

describe('line', () => {
    it('chains tilted lines away from the origin, ends on Enter, and leaves one open chain', () => {
        press('sk-line', 'line');
        undoRedoRestores(() => {
            clicks([3.2, 1.7], [15.9, 9.4], [22.3, -4.1]);
            expect(enterKey()).toBe('done');
        }, 2);
        const lines = curvesOf('line');
        expect(lines).toHaveLength(2);
        expectPt(ends(lines[0])[0], [3.2, 1.7]);
        expectPt(ends(lines[0])[1], [15.9, 9.4]);
        expectPt(ends(lines[1])[1], [22.3, -4.1]);
        // Joined: the second starts where the first ends.
        expect((lines[1] as { a: string }).a).toBe((lines[0] as { b: string }).b);
        expect(g0().constraints).toEqual([]);
        expect(state().draft).toEqual([]);
        expect(openChains()).toHaveLength(1);
        expect(solvesCleanly()).toBe(6);
        noDangling();
    });

    it('closes the chain on its start into one region', () => {
        press('sk-line', 'line');
        clicks([3.2, 1.7], [15.9, 9.4], [22.3, -4.1], [3.2, 1.7]);
        expect(curvesOf('line')).toHaveLength(3);
        expect(state().draft).toEqual([]);
        expect(profiles()).toHaveLength(1);
        solvesCleanly();
    });

    it('takes a typed length of 6.2501 exactly and keeps it as a driving dimension', () => {
        press('sk-line', 'line');
        click([3.2, 1.7]);
        sketchMove([9.1, 5.3], TOL);
        expect(type('6.2501')).toBe('done');
        const [line] = curvesOf('line');
        // Held by the solver: good to its tolerance (well inside 0.000001 mm).
        expect(len(line)).toBeCloseTo(6.2501, 6);
        expect(relations('length')).toMatchObject([{ value: 6.2501 }]);
        solvesCleanly();
    });

    it('draws a horizontal line of the form length 6.2501 with its dimension', () => {
        const form = press('sk-line', 'line');
        form.change('lineOrientation', 'horizontal');
        form.change('lineLength', '6.2501');
        form.change('lineDimensions', true);
        clicks([-12.5, 4.25], [-3, 9]);
        const [line] = curvesOf('line');
        expectPt(ends(line)[1], [-12.5 + 6.2501, 4.25]);
        expect(relations('horizontal')).toHaveLength(1);
        expect(relations('length')).toMatchObject([{ value: 6.2501 }]);
        solvesCleanly();
    });

    it('draws an Angle line at 37.5 degrees', () => {
        const form = press('sk-line', 'line');
        form.change('lineOrientation', 'angle');
        form.change('lineAngle', '37.5');
        form.change('lineLength', '12');
        form.change('lineDimensions', true);
        clicks([5, 5], [20, 8]);
        const [line] = curvesOf('line');
        const d = vec(line);
        expect(Math.atan2(d[1], d[0]) * 180 / Math.PI).toBeCloseTo(37.5, 5);
        expect(len(line)).toBeCloseTo(12, 6);
        expect(measure(geo(), relations('angle')[0])).toBeCloseTo(37.5, 5);
        solvesCleanly();
    });

    it('drops the line in progress on Escape and keeps the lines already drawn', () => {
        press('sk-line', 'line');
        clicks([3.2, 1.7], [15.9, 9.4]);
        sketchEscape();
        expect(state().draft).toEqual([]);
        expect(curvesOf('line')).toHaveLength(1);
        // The next click starts a new chain, not a line from the old end.
        clicks([30.5, 2.5], [40.25, 7.75]);
        expect(curvesOf('line')).toHaveLength(2);
        expect((curvesOf('line')[1] as { a: string }).a).not.toBe((curvesOf('line')[0] as { b: string }).b);
        noDangling();
    });

    it('drops the line in progress when another tool is picked', () => {
        press('sk-line', 'line');
        click([3.2, 1.7]);
        press('sk-circle', 'circle');
        expect(state().draft).toEqual([]);
        expect(geo().curves).toEqual([]);
        clicks([10, 10], [13, 14]);
        expect(curvesOf('circle')).toHaveLength(1);
        expect(curvesOf('line')).toHaveLength(0);
    });

    it('says plainly that zero cannot be drawn as a typed length', () => {
        press('sk-line', 'line');
        click([3.2, 1.7]);
        sketchMove([9, 5], TOL);
        expect(type('0')).toBe('done');
        expect(geo().curves).toEqual([]);
        expect(state().message).toMatch(/above zero/);
    });

    it('turns a typed negative length into a line the other way, not a crash', () => {
        press('sk-line', 'line');
        click([3.2, 1.7]);
        sketchMove([9, 5], TOL);
        type('-4');
        expect(curvesOf('line')).toHaveLength(1);
        expect(len(curvesOf('line')[0])).toBeCloseTo(4, 6);
        solvesCleanly();
    });

    it('draws the Midpoint line option about the first click', () => {
        const form = press('sk-line', 'line');
        form.change('lineMidpoint', true);
        clicks([5.5, 7.25], [12.75, 11.5]);
        const [line] = curvesOf('line');
        const [a, b] = ends(line);
        expectPt([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], [5.5, 7.25]);
        expect(relations('midpoint')).toHaveLength(1);
        solvesCleanly();
    });
});

/** g0: the geometry as it is now (a short name for assertions). */
const g0 = () => geo();

describe('midpoint line', () => {
    it('grows both ways from the first click', () => {
        press('sk-midpointLine', 'midpointLine');
        undoRedoRestores(() => clicks([5.5, 7.25], [12.75, 11.5]));
        const [line] = curvesOf('line');
        const [a, b] = ends(line);
        expectPt(b, [12.75, 11.5]);
        expectPt(a, [-1.75, 3]);
        expect(relations('midpoint')).toHaveLength(1);
        expect(solvesCleanly()).toBe(4);
        noDangling();
    });
});

describe('centreline', () => {
    it('is a construction line: no region, no open chain, but there for mirror', () => {
        press('sk-centerline', 'centerline');
        undoRedoRestores(() => {
            clicks([-5.5, -2.25], [14.5, 8.75]);
            endChain();
        });
        expect(curvesOf('line', true)).toHaveLength(1);
        expect(curvesOf('line')).toHaveLength(0);
        expect(openChains()).toHaveLength(0);
        expect(profiles()).toHaveLength(0);
        solvesCleanly();
    });
});

describe('rectangles', () => {
    it('corner rectangle: two corners, horizontal and vertical sides, one region', () => {
        press('sk-rect', 'rect');
        undoRedoRestores(() => clicks([3.5, 2.25], [17.75, 11.125]));
        const lines = curvesOf('line');
        expect(lines).toHaveLength(4);
        const corners = lines.map((l) => ends(l)[0]);
        expect(corners).toEqual([[3.5, 2.25], [17.75, 2.25], [17.75, 11.125], [3.5, 11.125]]);
        expect(relations('horizontal')).toHaveLength(2);
        expect(relations('vertical')).toHaveLength(2);
        expect(profiles()).toHaveLength(1);
        expect(solvesCleanly()).toBe(4);
        noDangling();
    });

    it('corner rectangle takes typed 12.5 x 6.2501', () => {
        press('sk-rect', 'rect');
        click([3.5, 2.25]);
        sketchMove([10, 8], TOL);
        type('12.5x6.2501');
        const lengths = relations('length').map((k) => (k as { value: number }).value);
        expect(lengths).toEqual([12.5, 6.2501]);
        const lines = curvesOf('line');
        expect(len(lines[0])).toBeCloseTo(12.5, 9);
        expect(len(lines[1])).toBeCloseTo(6.2501, 9);
        solvesCleanly();
    });

    // Defect: a corner or centre rectangle whose second click is level with the first is dropped with no message.
    it('corner rectangle with both corners on one level does nothing, and says so', () => {
        press('sk-rect', 'rect');
        clicks([3.5, 2.25], [17.75, 2.25]);
        expect(geo().curves).toEqual([]);
        // SolidWorks draws nothing there either; the app should not swallow the click in silence.
        expect(state().message).not.toBeNull();
    });

    it('centre rectangle: corners symmetric about the first click', () => {
        press('sk-centerRect', 'centerRect');
        undoRedoRestores(() => clicks([10.5, -4.25], [16.75, -1.125]));
        const lines = curvesOf('line');
        expect(lines).toHaveLength(4);
        const xs = lines.map((l) => ends(l)[0][0]);
        const ys = lines.map((l) => ends(l)[0][1]);
        expect(Math.min(...xs)).toBeCloseTo(4.25, 9);
        expect(Math.max(...xs)).toBeCloseTo(16.75, 9);
        expect(Math.min(...ys)).toBeCloseTo(-7.375, 9);
        expect(Math.max(...ys)).toBeCloseTo(-1.125, 9);
        expect(profiles()).toHaveLength(1);
        expect(solvesCleanly()).toBe(4);
        noDangling();
    });

    it('3 point rectangle at an angle: square corners, width from the third click', () => {
        press('sk-rect3', 'rect3');
        undoRedoRestores(() => clicks([2, 1], [14, 6], [11, 13]));
        const lines = curvesOf('line');
        expect(lines).toHaveLength(4);
        expectPt(ends(lines[0])[0], [2, 1]);
        expectPt(ends(lines[0])[1], [14, 6]);
        for (let i = 0; i < 4; i++) {
            expect(dot(vec(lines[i]), vec(lines[(i + 1) % 4])) / len(lines[i]) / len(lines[(i + 1) % 4])).toBeCloseTo(0, 7);
        }
        // Width: the third click's distance from the first side.
        const width = Math.abs((14 - 2) * (13 - 1) - (6 - 1) * (11 - 2)) / 13;
        expect(len(lines[1])).toBeCloseTo(width, 6);
        expect(profiles()).toHaveLength(1);
        expect(solvesCleanly()).toBe(5);
        noDangling();
    });

    it('3 point centre rectangle at an angle about its centre', () => {
        press('sk-centerRect3', 'centerRect3');
        undoRedoRestores(() => clicks([20, 10], [26, 13], [18, 16]));
        const lines = curvesOf('line');
        expect(lines).toHaveLength(4);
        const corners = lines.map((l) => ends(l)[0]);
        const cx = corners.reduce((s, p) => s + p[0], 0) / 4;
        const cy = corners.reduce((s, p) => s + p[1], 0) / 4;
        expectPt([cx, cy], [20, 10]);
        for (let i = 0; i < 4; i++) {
            expect(dot(vec(lines[i]), vec(lines[(i + 1) % 4])) / len(lines[i]) / len(lines[(i + 1) % 4])).toBeCloseTo(0, 7);
        }
        expect(len(lines[0])).toBeCloseTo(2 * Math.hypot(6, 3), 6);
        expect(profiles()).toHaveLength(1);
        expect(solvesCleanly()).toBe(5);
        noDangling();
    });

    it('parallelogram: opposite sides parallel, the fourth corner closes it', () => {
        press('sk-parallelogram', 'parallelogram');
        undoRedoRestores(() => clicks([1.5, 2.5], [21.5, 6.5], [26.5, 16.5]));
        const corners = curvesOf('line').map((l) => ends(l)[0]);
        expectPt(corners[3], [6.5, 12.5]);
        expect(relations('parallel')).toHaveLength(2);
        expect(profiles()).toHaveLength(1);
        expect(solvesCleanly()).toBe(6);
        noDangling();
    });

    it('adds construction lines from the corners when the form asks, and draws all of it as construction when ticked', () => {
        const form = press('sk-rect', 'rect');
        form.change('rectAdd', true);
        form.change('rectFrom', 'corners');
        clicks([3.5, 2.25], [17.75, 11.125]);
        expect(curvesOf('line', true)).toHaveLength(2);
        solvesCleanly();
        begin();
        const again = press('sk-rect3', 'rect3');
        again.change('construction', true);
        clicks([2, 1], [14, 6], [11, 13]);
        expect(geo().curves.every((c) => c.construction)).toBe(true);
        expect(profiles()).toHaveLength(0);
    });
});

describe('circles', () => {
    it('circle from centre and a point, away from the origin', () => {
        press('sk-circle', 'circle');
        undoRedoRestores(() => clicks([7.3, -2.1], [10.3, 1.9]));
        const [c] = curvesOf('circle');
        expect(curveRadius(geo(), c.id)).toBeCloseTo(5, 9);
        expectPt(at((c as { center: string }).center), [7.3, -2.1]);
        expect(profiles()).toHaveLength(1);
        expect(solvesCleanly()).toBe(3);
        noDangling();
    });

    it('takes a typed diameter of 12.5002 as a driving diameter', () => {
        press('sk-circle', 'circle');
        click([7.3, -2.1]);
        sketchMove([10, 0], TOL);
        type('12.5002');
        const [c] = curvesOf('circle');
        expect(curveRadius(geo(), c.id)).toBeCloseTo(6.2501, 9);
        expect(relations('diameter')).toMatchObject([{ value: 12.5002 }]);
        solvesCleanly();
    });

    it('sets the radius of the circle just drawn from the form to 6.2501, and refuses zero and negative', () => {
        const form = press('sk-circle', 'circle');
        clicks([7.3, -2.1], [10.3, 1.9]);
        const [c] = curvesOf('circle');
        form.change('p_cx', '7.3');
        form.change('p_cy', '-2.1');
        form.change('p_r', '6.2501');
        expect(curveRadius(geo(), c.id)).toBe(6.2501);
        const before = geo();
        form.change('p_r', '0');
        expect(geo()).toBe(before);
        expect(state().message).toMatch(/above zero/);
        form.change('p_r', '-3');
        expect(geo()).toBe(before);
        form.change('p_r', '1e12');
        // Absurdly large: it may be taken, but it must stay a number and solve.
        expect(Number.isFinite(curveRadius(geo(), c.id)!)).toBe(true);
    });

    it('perimeter circle through three points, centre where they say', () => {
        press('sk-perimeterCircle', 'perimeterCircle');
        undoRedoRestores(() => clicks([15, 3], [5, 13], [-5, 3]));
        const [c] = curvesOf('circle');
        expectPt(at((c as { center: string }).center), [5, 3]);
        expect(curveRadius(geo(), c.id)).toBeCloseTo(10, 9);
        expect(profiles()).toHaveLength(1);
        solvesCleanly();
        noDangling();
    });

    it('perimeter circle refuses three points in a line in plain words', () => {
        press('sk-perimeterCircle', 'perimeterCircle');
        clicks([0, 0.5], [5, 3], [10, 5.5]);
        expect(geo().curves).toEqual([]);
        expect(state().message).toMatch(/in a line/);
    });
});

describe('arcs', () => {
    it('3 point arc: start, end, then a point on it', () => {
        press('sk-arc', 'arc');
        undoRedoRestores(() => clicks([30, 5], [10, 5], [20, 15]));
        const [a] = curvesOf('arc');
        const arc = a as Extract<SketchCurve, { kind: 'arc' }>;
        expectPt(at(arc.center), [20, 5]);
        expect(curveRadius(geo(), a.id)).toBeCloseTo(10, 9);
        // Counter-clockwise over the top: from (30, 5) to (10, 5).
        expectPt(at(arc.start), [30, 5]);
        expect(openChains()).toHaveLength(1);
        expect(solvesCleanly()).toBe(5);
        noDangling();
    });

    it('centre arc: centre, start, round clockwise to the end', () => {
        press('sk-centerArc', 'centerArc');
        undoRedoRestores(() => {
            clicks([-10, 4], [-2, 4]);
            // Round clockwise a quarter turn.
            for (let t = -0.1; t >= -Math.PI / 2; t -= 0.1) {
                sketchMove([-10 + 8 * Math.cos(t), 4 + 8 * Math.sin(t)], TOL);
            }
            click([-10, -4]);
        });
        const [a] = curvesOf('arc');
        const arc = a as Extract<SketchCurve, { kind: 'arc' }>;
        expectPt(at(arc.center), [-10, 4]);
        // Stored counter-clockwise: from the end (-10, -4) to the start (-2, 4).
        expectPt(at(arc.start), [-10, -4]);
        expectPt(at(arc.end), [-2, 4]);
        solvesCleanly();
        noDangling();
    });

    /** A quarter centre arc about (-10, 4), radius 8, with its form's Parameters filled as DrawSession fills them. */
    function quarterArc() {
        const form = press('sk-centerArc', 'centerArc');
        clicks([-10, 4], [-2, 4]);
        for (let t = 0.1; t <= Math.PI / 2; t += 0.1) {
            sketchMove([-10 + 8 * Math.cos(t), 4 + 8 * Math.sin(t)], TOL);
        }
        click([-10, 12]);
        const [a] = curvesOf('arc');
        fill(form, { ...arcParams(geo(), a.id)! }, { cx: 'p_cx', cy: 'p_cy', sx: 'p_sx', sy: 'p_sy', ex: 'p_ex', ey: 'p_ey', r: 'p_r', angle: 'p_angle' });
        return { form, id: a.id };
    }

    // Defect: the arc form's Parameters compare the solved arc with the old start and end values, so a new Radius is
    // always refused with "Relations or dimensions hold that value" (sketchDrawForms.tsx applyParams).
    it('takes the arc radius of 6.2501 from the form', () => {
        const { form, id } = quarterArc();
        form.change('p_r', '6.2501');
        expect(state().message).toBeNull();
        expect(curveRadius(geo(), id)).toBeCloseTo(6.2501, 9);
    });

    // Defect: the same for the arc's Angle.
    it('takes the arc angle of 45.0001 degrees from the form', () => {
        const { form, id } = quarterArc();
        form.change('p_angle', '45.0001');
        expect(state().message).toBeNull();
        expect(arcParams(geo(), id)!.angle).toBeCloseTo(45.0001, 6);
    });

    // Defect: the same for the arc's Centre (moving the centre moves both ends).
    it('moves the arc by its Centre X from the form', () => {
        const { form, id } = quarterArc();
        form.change('p_cx', '-7.4999');
        expect(state().message).toBeNull();
        expect(arcParams(geo(), id)!.cx).toBeCloseTo(-7.4999, 9);
    });

    it('refuses an arc angle of 400 degrees in plain words', () => {
        const { form } = quarterArc();
        const before = geo();
        form.change('p_angle', '400');
        expect(geo()).toBe(before);
        expect(state().message).toMatch(/360/);
    });

    it('tangent arc from the end of a tilted line: tangent there and solves', () => {
        begin(addLine(EMPTY_GEOMETRY, { at: [2, 3] }, { at: [12, 8] }).g);
        press('sk-tangentArc', 'tangentArc');
        undoRedoRestores(() => {
            click([12, 8]);
            sketchMove([15, 12], TOL);
            click([18, 14]);
        });
        const [a] = curvesOf('arc');
        const arc = a as Extract<SketchCurve, { kind: 'arc' }>;
        expect(relations('tangent')).toHaveLength(1);
        const c = at(arc.center);
        // The centre is on the line's normal at its end.
        expect(dot([c[0] - 12, c[1] - 8], [10, 5])).toBeCloseTo(0, 6);
        const end = arc.start === 'p2' || at(arc.start)[0] === 12 ? arc.end : arc.start;
        expectPt(at(end), [18, 14]);
        expect(openChains()).toHaveLength(1);
        solvesCleanly();
        noDangling();
    });

    it('tangent arc off the end of a spline says plainly that it needs a line or arc', () => {
        const { g } = everyKind();
        begin(g);
        press('sk-tangentArc', 'tangentArc');
        click([20, -44]);
        expect(curvesOf('arc')).toHaveLength(1);
        expect(state().message).toMatch(/line or arc/);
    });
});

describe('slots', () => {
    it('straight slot at an angle: two lines, two arcs, tangent and one region', () => {
        press('sk-slot', 'slot');
        undoRedoRestores(() => clicks([5, 5], [21, 17], [14, 16]));
        expect(curvesOf('line')).toHaveLength(2);
        expect(curvesOf('arc')).toHaveLength(2);
        expect(curvesOf('line', true)).toHaveLength(1);
        const [a1, a2] = curvesOf('arc');
        const r = Math.abs(16 * (16 - 5) - 12 * (14 - 5)) / 20;
        expect(curveRadius(geo(), a1.id)).toBeCloseTo(r, 9);
        expect(curveRadius(geo(), a2.id)).toBeCloseTo(r, 9);
        expect(curvesOf('arc').map((a) => at((a as { center: string }).center)).sort((p, q) => p[0] - q[0])).toEqual([[5, 5], [21, 17]]);
        expect(relations('tangent')).toHaveLength(4);
        expect(profiles()).toHaveLength(1);
        solvesCleanly();
        noDangling();
    });

    it('straight slot with dimensions: width 6.2501 typed, length centre to centre', () => {
        const form = press('sk-slot', 'slot');
        form.change('slotDimensions', true);
        clicks([5, 5], [21, 17]);
        sketchMove([14, 16], TOL);
        type('6.2501');
        const [a1] = curvesOf('arc');
        expect(curveRadius(geo(), a1.id)).toBeCloseTo(3.12505, 9);
        expect(relations('distance').map((k) => (k as { value: number }).value)).toContain(6.2501);
        expect(relations('length')).toMatchObject([{ value: 20 }]);
        solvesCleanly();
    });

    it('centrepoint straight slot about its centre', () => {
        press('sk-centerSlot', 'centerSlot');
        undoRedoRestores(() => clicks([30, -10], [38, -4], [31, -4]));
        const arcs = curvesOf('arc');
        expect(arcs).toHaveLength(2);
        const centres = arcs.map((a) => at((a as { center: string }).center));
        expectPt([(centres[0][0] + centres[1][0]) / 2, (centres[0][1] + centres[1][1]) / 2], [30, -10]);
        expect(relations('midpoint')).toHaveLength(1);
        expect(profiles()).toHaveLength(1);
        solvesCleanly();
        noDangling();
    });

    it('3 point arc slot, then the width; refuses one wider than its arc', () => {
        press('sk-arcSlot3', 'arcSlot3');
        undoRedoRestores(() => clicks([30, 5], [10, 5], [20, 15], [20, 17]));
        const radii = curvesOf('arc').map((a) => Number(curveRadius(geo(), a.id)!.toFixed(9))).sort((p, q) => p - q);
        expect(radii).toEqual([2, 2, 8, 12]);
        expect(profiles()).toHaveLength(1);
        solvesCleanly();
        noDangling();
        begin();
        press('sk-arcSlot3', 'arcSlot3');
        clicks([30, 5], [10, 5], [20, 15], [20, 40]);
        expect(geo().curves).toEqual([]);
        expect(state().message).toMatch(/wider than its arc/);
    });

    it('centrepoint arc slot: centre, start, round, width', () => {
        press('sk-centerArcSlot', 'centerArcSlot');
        undoRedoRestores(() => {
            clicks([-20, -20], [-8, -20]);
            for (let t = 0.1; t <= 2 * Math.PI / 3; t += 0.1) {
                sketchMove([-20 + 12 * Math.cos(t), -20 + 12 * Math.sin(t)], TOL);
            }
            click([-20 + 12 * Math.cos(2 * Math.PI / 3), -20 + 12 * Math.sin(2 * Math.PI / 3)]);
            click([-20, -6.5]);
        });
        const radii = curvesOf('arc').map((a) => Number(curveRadius(geo(), a.id)!.toFixed(6))).sort((p, q) => p - q);
        expect(radii).toEqual([1.5, 1.5, 10.5, 13.5]);
        expect(curveRadius(geo(), curvesOf('arc', true)[0].id)).toBeCloseTo(12, 9);
        expect(profiles()).toHaveLength(1);
        noDangling();
    });

    // Defect: a centrepoint arc slot over 120 degrees holds one tangent relation too many: solving it again reports
    // it redundant, and the next unrelated edit says "Over defined".
    it('centrepoint arc slot of 120 degrees solves with nothing redundant, also at the next edit', () => {
        press('sk-centerArcSlot', 'centerArcSlot');
        clicks([-20, -20], [-8, -20]);
        for (let t = 0.1; t <= 2 * Math.PI / 3; t += 0.1) {
            sketchMove([-20 + 12 * Math.cos(t), -20 + 12 * Math.sin(t)], TOL);
        }
        click([-20 + 12 * Math.cos(2 * Math.PI / 3), -20 + 12 * Math.sin(2 * Math.PI / 3)]);
        click([-20, -6.5]);
        press('sk-point', 'point');
        click([30, 30]);
        expect(state().message).toBeNull();
        solvesCleanly();
    });

    it('centrepoint arc slots of any angle, with and without dimensions, solve with nothing redundant', () => {
        for (const dims of [false, true]) {
            for (const angle of [17.3, 45, 90, 119.9, 120, 120.1, 150, 179.9, 200, 300]) {
                begin();
                useSketcher.setState((s) => ({ drawOptions: { ...s.drawOptions, slotDimensions: dims } }));
                press('sk-centerArcSlot', 'centerArcSlot');
                clicks([-20, -20], [-8, -20]);
                const end = (angle * Math.PI) / 180;
                for (let t = 0.1; t <= end; t += 0.1) {
                    sketchMove([-20 + 12 * Math.cos(t), -20 + 12 * Math.sin(t)], TOL);
                }
                click([-20 + 12 * Math.cos(end), -20 + 12 * Math.sin(end)]);
                click([-20 + 13.5 * Math.cos(end / 2), -20 + 13.5 * Math.sin(end / 2)]);
                expect(curvesOf('arc').length, `${angle}`).toBe(4);
                press('sk-point', 'point');
                click([30, 30]);
                expect(state().message, `${angle}`).toBeNull();
                solvesCleanly();
            }
        }
    });

    it('drops a slot half drawn on Escape', () => {
        press('sk-arcSlot3', 'arcSlot3');
        clicks([30, 5], [10, 5], [20, 15]);
        sketchEscape();
        expect(state().draft).toEqual([]);
        expect(geo().curves).toEqual([]);
    });
});

describe('polygon', () => {
    it('draws a hexagon away from the origin at an angle, regular, one region', () => {
        press('sk-polygon', 'polygon');
        clicks([40, 20], [46, 28]);
        const sides = curvesOf('line');
        expect(sides).toHaveLength(6);
        for (const l of sides) {
            expect(Math.hypot(...([0, 1].map((i) => ends(l)[0][i] - [40, 20][i]) as [number, number]))).toBeCloseTo(10, 6);
        }
        expect(profiles()).toHaveLength(1);
        expect(solvesCleanly()).toBe(4);
        noDangling();
    });

    // Defect: undo and redo solve the sketch again, and the second solve moves it by 0.000001 mm (the radius 10 comes
    // back as 9.999999), so redo does not give back exactly what was drawn. Seen with most tools; checked here.
    it('undo and redo give back the hexagon exactly', () => {
        press('sk-polygon', 'polygon');
        undoRedoRestores(() => clicks([40, 20], [46, 28]), 1, 1e-9);
    });

    it('changes the side count of the polygon just drawn from the form, and refuses 2 and 41', () => {
        const form = press('sk-polygon', 'polygon');
        clicks([40, 20], [46, 28]);
        form.change('sides', '8');
        expect(curvesOf('line')).toHaveLength(8);
        solvesCleanly();
        noDangling();
        const before = geo();
        form.change('sides', '2');
        expect(state().message).toMatch(/3 to 40/);
        form.change('sides', '41');
        expect(state().message).toMatch(/3 to 40/);
        form.change('sides', '7.5');
        expect(state().message).toMatch(/3 to 40/);
        expect(geo()).toBe(before);
    });

    it('sets the circle diameter of the polygon just drawn to 12.5002', () => {
        const form = press('sk-polygon', 'polygon');
        clicks([40, 20], [46, 28]);
        const info = polygonInfo(geo(), geo().curves.map((c) => c.id))!;
        fill(form, { cx: info.cx, cy: info.cy, d: info.diameter, angle: info.angle }, { cx: 'p_cx', cy: 'p_cy', d: 'p_d', angle: 'p_angle' });
        form.change('p_d', '12.5002');
        const circle = curvesOf('circle', true)[0];
        expect(2 * curveRadius(geo(), circle.id)!).toBeCloseTo(12.5002, 9);
        solvesCleanly();
    });
});

describe('point', () => {
    it('places a point and moves it from the form to 6.2501, -3.0001', () => {
        const form = press('sk-point', 'point');
        undoRedoRestores(() => click([4.75, -2.5]));
        expect(geo().points).toHaveLength(1);
        expectPt(at(geo().points[0].id), [4.75, -2.5]);
        form.change('p_x', '6.2501');
        form.change('p_y', '-3.0001');
        expectPt(at(geo().points[0].id), [6.2501, -3.0001], 12);
        // The tool stays on for the next point.
        click([9.5, 1.25]);
        expect(geo().points).toHaveLength(2);
        expect(solvesCleanly()).toBe(4);
    });
});

describe('ellipse', () => {
    it('centre, a tilted first axis, then the second: square axes, one region', () => {
        press('sk-ellipse');
        expect(state().tool).toBe('ellipse');
        undoRedoRestores(() => clicks([10, 5], [22, 10], [8, 8]));
        const [e] = curvesOf('ellipse');
        const el = e as Extract<SketchCurve, { kind: 'ellipse' }>;
        expectPt(at(el.center), [10, 5]);
        expectPt(at(el.major), [22, 10]);
        const [c, m, n] = [at(el.center), at(el.major), at(el.minor)];
        expect(dot([m[0] - c[0], m[1] - c[1]], [n[0] - c[0], n[1] - c[1]])).toBeCloseTo(0, 9);
        expect(Math.hypot(n[0] - c[0], n[1] - c[1])).toBeCloseTo(Math.abs(12 * 3 - 5 * -2) / 13, 9);
        expect(profiles()).toHaveLength(1);
        expect(solvesCleanly()).toBe(5);
        noDangling();
    });

    it('takes Radius 1 = 6.2501 from its form', async () => {
        press('sk-ellipse');
        clicks([10, 5], [22, 10], [8, 8]);
        const [e] = curvesOf('ellipse');
        useSketcher.setState({ selection: [{ type: 'curve', id: e.id }] });
        const def = curveForm('ellipse');
        const v = def.defaults!(ctx);
        const r = await def.apply!({ ...v, r1: '6.2501' }, ctx);
        expect(r?.isError).toBe(false);
        const el = curvesOf('ellipse')[0] as Extract<SketchCurve, { kind: 'ellipse' }>;
        const [c, m] = [at(el.center), at(el.major)];
        expect(Math.hypot(m[0] - c[0], m[1] - c[1])).toBeCloseTo(6.2501, 9);
        const bad = await def.apply!({ ...v, r1: '0' }, ctx);
        expect(bad?.isError).toBe(true);
        const neg = await def.apply!({ ...v, r2: '-2' }, ctx);
        expect(neg?.isError).toBe(true);
    });

    it('refuses a second click on the first axis in plain words', () => {
        press('sk-ellipse');
        clicks([10, 5], [22, 10], [34, 15]);
        expect(geo().curves).toEqual([]);
        expect(state().message).toMatch(/second radius/);
    });

    it('is drawn as construction when its form says For construction', async () => {
        press('sk-ellipse');
        clicks([10, 5], [22, 10], [8, 8]);
        const [e] = curvesOf('ellipse');
        useSketcher.setState({ selection: [{ type: 'curve', id: e.id }] });
        const def = curveForm('ellipse');
        await def.apply!({ ...def.defaults!(ctx), construction: true }, ctx);
        expect(curvesOf('ellipse', true)).toHaveLength(1);
        expect(profiles()).toHaveLength(0);
    });
});

describe('partial ellipse', () => {
    it('centre, both axes, round counter-clockwise to the end; open chain', () => {
        press('sk-partialEllipse');
        undoRedoRestores(() => {
            clicks([0, 0], [10, 0]);
            click([0, 5]);
            // round from the minor-axis end (0, 5) to (-10, 0)
            for (let t = Math.PI / 2 + 0.1; t <= Math.PI; t += 0.1) {
                sketchMove([10 * Math.cos(t), 5 * Math.sin(t)], TOL);
            }
            click([-10, 0]);
        });
        const [e] = curvesOf('ellipseArc');
        const el = e as Extract<SketchCurve, { kind: 'ellipseArc' }>;
        expectPt(at(el.start), [0, 5]);
        expectPt(at(el.end), [-10, 0]);
        expect(openChains()).toHaveLength(1);
        solvesCleanly();
        noDangling();
    });
});

describe('splines', () => {
    it('spline through tilted points, ended by Enter; an open chain', () => {
        press('sk-spline');
        undoRedoRestores(() => {
            clicks([-10, -5], [0, 3], [10, -6], [20, 1]);
            expect(enterKey()).toBe('done');
        });
        const [s] = curvesOf('spline');
        const pts = (s as { points: string[] }).points.map((id) => at(id));
        expect(pts).toEqual([[-10, -5], [0, 3], [10, -6], [20, 1]]);
        expect(openChains()).toHaveLength(1);
        expect(solvesCleanly()).toBe(8);
        noDangling();
    });

    it('closes a spline on its first point into a region', () => {
        press('sk-spline');
        clicks([-10, -5], [0, 8], [10, -6], [-10, -5]);
        const [s] = curvesOf('spline');
        expect((s as { points: string[] }).points).toHaveLength(4);
        expect(profiles()).toHaveLength(1);
        solvesCleanly();
    });

    it('says a spline of one point cannot be made', () => {
        press('sk-spline');
        click([3, 3]);
        enterKey();
        expect(geo().curves).toEqual([]);
        expect(state().message).toMatch(/two points/);
    });

    it('moves a spline point to 6.2501 from its form', async () => {
        press('sk-spline');
        clicks([-10, -5], [0, 3], [10, -6]);
        enterKey();
        const [s] = curvesOf('spline');
        useSketcher.setState({ selection: [{ type: 'curve', id: s.id }] });
        const def = curveForm('spline');
        const r = await def.apply!({ ...def.defaults!(ctx), x1: '6.2501' }, ctx);
        expect(r?.isError).toBe(false);
        expect(at((curvesOf('spline')[0] as { points: string[] }).points[1])[0]).toBeCloseTo(6.2501, 12);
    });

    it('style spline (Bezier) from control vertices, ended by Enter', () => {
        press('sk-styleSpline');
        undoRedoRestores(() => {
            clicks([30, -50], [35, -40], [45, -40], [50, -50]);
            enterKey();
        });
        const [s] = curvesOf('styleSpline');
        expect((s as { points: string[] }).points.map((id) => at(id))).toEqual([[30, -50], [35, -40], [45, -40], [50, -50]]);
        expect(openChains()).toHaveLength(1);
        solvesCleanly();
        noDangling();
    });

    it('refuses a degree 5 B-spline with 4 control vertices in plain words', async () => {
        press('sk-styleSpline');
        clicks([30, -50], [35, -40], [45, -40], [50, -50]);
        enterKey();
        const [s] = curvesOf('styleSpline');
        useSketcher.setState({ selection: [{ type: 'curve', id: s.id }] });
        const def = curveForm('styleSpline');
        const r = await def.apply!({ ...def.defaults!(ctx), type: '5' }, ctx);
        expect(r?.isError).toBe(true);
        expect(r?.text).toMatch(/at least 6 control vertices/);
        // Back to Bezier so later style splines are not B-splines.
        await def.apply!({ ...def.defaults!(ctx), type: 'bezier' }, ctx);
    });
});

describe('parabola', () => {
    it('focus, vertex, start and end; an open chain on the parabola', () => {
        press('sk-parabola');
        undoRedoRestores(() => clicks([80, -28], [80, -30], [72, -22], [88, -22]));
        const [p] = curvesOf('parabola');
        const pa = p as Extract<SketchCurve, { kind: 'parabola' }>;
        expectPt(at(pa.focus), [80, -28]);
        expectPt(at(pa.vertex), [80, -30]);
        // y = x^2 / (4 f) about the vertex, f = 2: at x = -8, y = 8.
        expectPt(at(pa.start), [72, -22]);
        expectPt(at(pa.end), [88, -22]);
        expect(openChains()).toHaveLength(1);
        solvesCleanly();
        noDangling();
    });

    it('takes the apex to 80.0001 from its form', async () => {
        press('sk-parabola');
        clicks([80, -28], [80, -30], [72, -22], [88, -22]);
        const [p] = curvesOf('parabola');
        useSketcher.setState({ selection: [{ type: 'curve', id: p.id }] });
        const def = curveForm('parabola');
        const r = await def.apply!({ ...def.defaults!(ctx), apex0: '80.0001' }, ctx);
        expect(r?.isError).toBe(false);
        expect(at((curvesOf('parabola')[0] as { vertex: string }).vertex)[0]).toBeCloseTo(80.0001, 9);
    });
});

describe('conic', () => {
    it('both ends, the top vertex, then Rho from the pointer; an open chain', () => {
        press('sk-conic', 'conic');
        undoRedoRestores(() => clicks([90, 0], [110, 0], [100, 10], [100, 4]));
        const [k] = curvesOf('conic');
        const co = k as Extract<SketchCurve, { kind: 'conic' }>;
        expect(co.rho).toBeCloseTo(0.4, 9);
        expectPt(at(co.apex), [100, 10]);
        expect(openChains()).toHaveLength(1);
        solvesCleanly();
        noDangling();
    });

    it('takes Rho 0.6251 from its form and refuses 1 and 0', async () => {
        press('sk-conic', 'conic');
        clicks([90, 0], [110, 0], [100, 10], [100, 4]);
        const [k] = curvesOf('conic');
        useSketcher.setState({ selection: [{ type: 'curve', id: k.id }] });
        const def = curveForm('conic');
        const ok = await def.apply!({ ...def.defaults!(ctx), rho: '0.6251' }, ctx);
        expect(ok?.isError).toBe(false);
        expect((curvesOf('conic')[0] as { rho: number }).rho).toBe(0.6251);
        for (const rho of ['1', '0', '-0.5']) {
            const bad = await def.apply!({ ...def.defaults!(ctx), rho }, ctx);
            expect(bad?.isError).toBe(true);
        }
    });

    it('refuses a top vertex on the line between the ends', () => {
        press('sk-conic', 'conic');
        clicks([90, 0], [110, 0], [100, 0], [100, 4]);
        expect(geo().curves).toEqual([]);
        expect(state().message).toMatch(/off the line/);
    });
});

describe('a profile of mixed curves, drawn with the tools', () => {
    it('line, tangent arc, line, 3 point arc closing it: one region, solves cleanly', () => {
        press('sk-line', 'line');
        clicks([0, 0], [20, 0]);
        // Line tool: A switches to a tangent arc.
        sketchMove([21, 1], TOL);
        expect(toggleLineArc()).toBe(true);
        click([20, 10]);
        click([0, 10]);
        endChain();
        press('sk-arc', 'arc');
        clicks([0, 10], [0, 0], [-5, 5]);
        expect(profiles()).toHaveLength(1);
        solvesCleanly();
        noDangling();
        const points = geo().points.length;
        expect(pointOf(geo(), geo().points[points - 1].id)).toBeTruthy();
    });
});

describe('every draw tool half way', () => {
    const tools: [string, string, number][] = [
        ['sk-line', 'line', 1], ['sk-midpointLine', 'midpointLine', 1], ['sk-rect', 'rect', 1], ['sk-centerRect', 'centerRect', 1],
        ['sk-rect3', 'rect3', 2], ['sk-centerRect3', 'centerRect3', 2], ['sk-parallelogram', 'parallelogram', 2], ['sk-circle', 'circle', 1],
        ['sk-perimeterCircle', 'perimeterCircle', 2], ['sk-arc', 'arc', 2], ['sk-centerArc', 'centerArc', 2], ['sk-slot', 'slot', 2],
        ['sk-centerSlot', 'centerSlot', 2], ['sk-arcSlot3', 'arcSlot3', 2], ['sk-centerArcSlot', 'centerArcSlot', 1], ['sk-polygon', 'polygon', 1],
        ['sk-ellipse', 'ellipse', 2], ['sk-partialEllipse', 'partialEllipse', 3], ['sk-spline', 'spline', 3], ['sk-styleSpline', 'styleSpline', 3],
        ['sk-parabola', 'parabola', 3], ['sk-conic', 'conic', 3], ['sk-centerline', 'centerline', 1],
    ];
    const points: [number, number][] = [[3.25, 1.5], [14.5, 7.75], [9.5, 15.25]];
    for (const [id, tool, n] of tools) {
        it(`${id}: Escape drops what was clicked, and another tool picked half way leaves nothing behind`, () => {
            press(id, tool as never);
            clicks(...points.slice(0, n));
            expect(state().draft.length).toBeGreaterThan(0);
            sketchEscape();
            expect(state().draft).toEqual([]);
            expect(geo().curves).toEqual([]);
            expect(geo().points).toEqual([]);
            press(id, tool as never);
            clicks(...points.slice(0, n));
            press('sk-select');
            expect(state().draft).toEqual([]);
            expect(geo().curves).toEqual([]);
            expect(geo().points).toEqual([]);
            expect(state().undo).toEqual([]);
        });
    }
});

describe('the View and snaps and History groups', () => {
    it('Sketch settings: automatic relations off draws a nearly level line with no Horizontal relation', async () => {
        const form = press('sk-options');
        expect((await form.def.apply!({ ...form.values, autoRelations: false }, ctx))?.isError).toBe(false);
        press('sk-line', 'line');
        clicks([0, 5], [20, 5.01]);
        expect(relations('horizontal')).toEqual([]);
        begin();
        press('sk-line', 'line');
        clicks([0, 5], [20, 5.01]);
        expect(relations('horizontal')).toHaveLength(1);
    });

    it('Sketch settings: automatic solve off keeps a change unsolved and says so; Solve solves it', async () => {
        const { solveSketch } = await import('../sketcher');
        const form = press('sk-options');
        await form.def.apply!({ ...form.values, autoSolve: false }, ctx);
        press('sk-circle', 'circle');
        clicks([10, 10], [13, 14]);
        expect(state().message).toMatch(/Automatic solve is off/);
        expect(solveSketch()).toBe(true);
        expect(state().message).toBe('Solved.');
    });

    it('Sketch settings: refuses a negative grid spacing and a snap angle past 180 degrees', async () => {
        const form = press('sk-options');
        expect((await form.def.apply!({ ...form.values, gridMajor: '-1' }, ctx))?.isError).toBe(true);
        expect((await form.def.apply!({ ...form.values, gridMinorPerMajor: '0' }, ctx))?.isError).toBe(true);
        expect((await form.def.apply!({ ...form.values, snapAngle: '200' }, ctx))?.isError).toBe(true);
    });

    it('Quick snaps: with point snaps off a click near an end does not join it', async () => {
        const { setSnapKind } = await import('../sketcher');
        press('sk-snaps');
        press('sk-line', 'line');
        clicks([0, 0], [10, 3]);
        enterKey();
        setSnapKind('point', false);
        clicks([10.02, 3.01], [20, 8]);
        enterKey();
        const [first, second] = curvesOf('line') as Extract<SketchCurve, { kind: 'line' }>[];
        expect(second.a).not.toBe(first.b);
        setSnapKind(null);
    });

    it('Undo and Redo buttons step back and forth through drawn entities', () => {
        press('sk-circle', 'circle');
        clicks([10, 10], [13, 14]);
        clicks([30, 10], [33, 14]);
        press('sk-undo');
        expect(curvesOf('circle')).toHaveLength(1);
        press('sk-undo');
        expect(curvesOf('circle')).toHaveLength(0);
        press('sk-undo');
        expect(curvesOf('circle')).toHaveLength(0);
        press('sk-redo');
        press('sk-redo');
        expect(curvesOf('circle')).toHaveLength(2);
    });
});

// Unused imports kept honest.
void setTool;
