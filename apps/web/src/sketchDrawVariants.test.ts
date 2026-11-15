import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { curveRadius, loadSolver, measure, pointOf, solveGeometry } from './solver';
import { EMPTY_GEOMETRY, addConstraint, addLine } from './sketchGeometry';
import {
    applyTyped, commitGeometry, setDrawOptions, setTool, sketchClick, sketchDown, sketchMove, sketchUp, toggleLineArc, typeKey, useSketcher,
} from './sketcher';
import {
    DEFAULT_DRAW_OPTIONS, arcParams, circleParams, editArc, editCircle, polygonInfo, rebuildPolygon,
} from './sketchDrawVariants';
import { geometryProfiles } from './sketchGeometry';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const TOL = 0.5;
const state = () => useSketcher.getState();
const g = () => state().geometry;

function start(geometry: SketchGeometry = EMPTY_GEOMETRY) {
    useSketcher.setState({
        active: true, stage: 'draw', geometry, undo: [], redo: [], draft: [], chainStart: null, typed: '', message: null,
        drawOptions: DEFAULT_DRAW_OPTIONS, sides: 6, conflicting: [], redundant: [],
    });
}

function draw(tool: Parameters<typeof setTool>[0], ...clicks: [number, number][]) {
    setTool(tool);
    for (const p of clicks) {
        sketchMove(p, TOL);
        sketchClick(p, TOL);
    }
}

const at = (id: string): [number, number] => {
    const p = pointOf(g(), id)!;
    return [p.u, p.v];
};
const kinds = (kind: string) => g().constraints.filter((c) => c.kind === kind);
const curves = (kind: SketchCurve['kind'], construction = false) => g().curves.filter((c) => c.kind === kind && !!c.construction === construction);
const lineLength = (c: SketchCurve) => (c.kind === 'line' ? Math.hypot(at(c.b)[0] - at(c.a)[0], at(c.b)[1] - at(c.a)[1]) : 0);

/** The sketch solves with nothing over defined, and its degrees of freedom. */
function solvesCleanly(): number {
    const r = solveGeometry(g());
    expect(r.ok).toBe(true);
    expect(r.redundant).toEqual([]);
    expect(state().message).toBeNull();
    return r.dof;
}

describe('line options', () => {
    beforeEach(() => start());

    it('draws a horizontal line at the form length and dimensions it', () => {
        setDrawOptions({ lineOrientation: 'horizontal', lineLength: 25.123456, lineDimensions: true });
        draw('line', [0, 0], [-7, 3]);
        const [line] = curves('line');
        expect(lineLength(line)).toBeCloseTo(25.123456, 6);
        expect(at((line as { b: string }).b)).toEqual([-25.123456, 0]);
        expect(kinds('horizontal')).toHaveLength(1);
        expect(kinds('length')).toMatchObject([{ value: 25.123456 }]);
        // One line per click pair, not a chain.
        expect(state().draft).toEqual([]);
        solvesCleanly();
    });

    it('draws an angled line and adds its length and angle', () => {
        setDrawOptions({ lineOrientation: 'angle', lineAngle: 30, lineDimensions: true });
        draw('line', [0, 0], [10, 8]);
        const [line] = curves('line');
        const a = measure(g(), kinds('angle')[0]);
        expect(a).toBeCloseTo(30, 5);
        expect(kinds('length')).toHaveLength(1);
        expect(lineLength(line)).toBeGreaterThan(0);
        solvesCleanly();
    });

    it('draws a midpoint line symmetric about the first click', () => {
        draw('midpointLine', [5, 5], [15, 9]);
        const [line] = curves('line');
        const [a, b] = [at((line as { a: string }).a), at((line as { b: string }).b)];
        expect(a[0] + b[0]).toBeCloseTo(10, 9);
        expect(a[1] + b[1]).toBeCloseTo(10, 9);
        expect(kinds('midpoint')).toHaveLength(1);
        solvesCleanly();
    });

    it('takes a typed length for the midpoint line as its whole length', () => {
        setTool('midpointLine');
        sketchMove([0, 0], TOL);
        sketchClick([0, 0], TOL);
        sketchMove([10, 0], TOL);
        for (const k of '30') {
            typeKey(k);
        }
        expect(applyTyped()).toBeNull();
        expect(lineLength(curves('line')[0])).toBeCloseTo(30, 6);
    });

    it('draws construction geometry when the form says so', () => {
        setDrawOptions({ construction: { line: true, circle: true } });
        draw('line', [0, 0], [10, 0]);
        draw('circle', [30, 0], [35, 0]);
        expect(g().curves.every((c) => c.construction)).toBe(true);
        expect(geometryProfiles(g()).profiles).toHaveLength(0);
    });

    it('switches the line tool to a tangent arc by going back over the end, and back to a line after it', () => {
        setTool('line');
        sketchMove([0, 0], TOL);
        sketchClick([0, 0], TOL);
        sketchMove([20, 0], TOL);
        sketchClick([20, 0], TOL);
        // Away, back over the end, and away again.
        sketchMove([24, 3], TOL);
        sketchMove([20.1, 0], TOL);
        sketchMove([24, 4], TOL);
        expect(state().lineArc.arc).toBe(true);
        sketchClick([30, 10], TOL);
        expect(curves('arc')).toHaveLength(1);
        expect(kinds('tangent')).toHaveLength(1);
        expect(state().lineArc.arc).toBe(false);
        // A toggles too.
        expect(toggleLineArc()).toBe(true);
        expect(state().lineArc.arc).toBe(true);
        expect(toggleLineArc()).toBe(true);
        sketchMove([30, 30], TOL);
        sketchClick([30, 30], TOL);
        expect(curves('line')).toHaveLength(2);
        solvesCleanly();
    });
});

describe('rectangles', () => {
    beforeEach(() => start());

    it('draws a 3 point centre rectangle about its centre at an angle', () => {
        draw('centerRect3', [10, 10], [20, 20], [10, 20]);
        const sides = curves('line');
        expect(sides).toHaveLength(4);
        expect(kinds('parallel')).toHaveLength(2);
        expect(kinds('perpendicular')).toHaveLength(1);
        expect(curves('line', true)).toHaveLength(1);
        expect(lineLength(sides[0])).toBeCloseTo(2 * Math.hypot(10, 10), 6);
        expect(lineLength(sides[1])).toBeCloseTo(Math.hypot(10, 10), 6);
        solvesCleanly();
    });

    it('draws a parallelogram with parallel opposite sides', () => {
        draw('parallelogram', [0, 0], [20, 0], [25, 10]);
        const corners = curves('line').map((c) => at((c as { a: string }).a));
        expect(corners[3][0]).toBeCloseTo(5, 9);
        expect(corners[3][1]).toBeCloseTo(10, 9);
        expect(kinds('parallel')).toHaveLength(2);
        expect(kinds('perpendicular')).toHaveLength(0);
        // The first corner is on the origin: six coordinates less two parallels.
        expect(solvesCleanly()).toBe(4);
    });

    it('adds construction lines from the corners', () => {
        setDrawOptions({ rectLines: 'corners' });
        draw('rect', [0, 0], [40, 20]);
        const diagonals = curves('line', true);
        expect(diagonals).toHaveLength(2);
        expect(diagonals.map(lineLength)).toEqual([Math.hypot(40, 20), Math.hypot(40, 20)]);
        // The centre rectangle has one diagonal of its own: it gets just the other.
        draw('centerRect', [100, 0], [110, 5]);
        expect(curves('line', true)).toHaveLength(4);
        solvesCleanly();
    });

    it('adds construction lines between the side middles', () => {
        setDrawOptions({ rectLines: 'midpoints' });
        draw('rect3', [0, 0], [30, 0], [30, 10]);
        const lines = curves('line', true);
        expect(lines.map(lineLength).sort((a, b) => a - b).map((n) => Number(n.toFixed(6)))).toEqual([10, 30]);
        expect(kinds('midpoint')).toHaveLength(4);
        solvesCleanly();
    });
});

describe('slots', () => {
    beforeEach(() => start());

    it('draws a centrepoint straight slot about its centre with a centreline', () => {
        draw('centerSlot', [0, 0], [10, 0], [12, 3]);
        expect(curves('line')).toHaveLength(2);
        expect(curves('arc')).toHaveLength(2);
        expect(curves('line', true)).toHaveLength(1);
        expect(kinds('tangent')).toHaveLength(4);
        expect(kinds('equal')).toHaveLength(1);
        const arcs = curves('arc');
        expect(arcs.map((a) => curveRadius(g(), a.id))).toEqual([3, 3]);
        expect(kinds('midpoint')).toHaveLength(1);
        expect(geometryProfiles(g()).profiles).toHaveLength(1);
        solvesCleanly();
    });

    it('dimensions a slot centre to centre, or overall', () => {
        setDrawOptions({ slotDimensions: true });
        draw('slot', [0, 0], [20, 0], [5, 4]);
        expect(kinds('length')).toMatchObject([{ value: 20 }]);
        expect(kinds('distance')).toMatchObject([{ value: 8 }]);
        solvesCleanly();
        start();
        setDrawOptions({ slotDimensions: true, slotOverall: true });
        draw('slot', [0, 0], [20, 0], [5, 4]);
        expect(kinds('distance').map((k) => (k as { value: number }).value)).toEqual([8, 28]);
        const dof = solvesCleanly();
        // Changing the overall length moves the ends, not the width.
        const overall = kinds('distance')[1];
        const next = { ...g(), constraints: g().constraints.map((k) => (k.id === overall.id ? { ...k, value: 40 } : k)) };
        expect(commitGeometry(next)).toBe(true);
        const [e0, e1] = curves('arc').map((a) => at((a as { center: string }).center));
        expect(Math.hypot(e1[0] - e0[0], e1[1] - e0[1])).toBeCloseTo(32, 5);
        expect(dof).toBeGreaterThan(0);
    });

    it('takes a typed width', () => {
        setTool('slot');
        for (const p of [[0, 0], [20, 0]] as [number, number][]) {
            sketchMove(p, TOL);
            sketchClick(p, TOL);
        }
        typeKey('6');
        expect(applyTyped()).toBeNull();
        expect(curves('arc').map((a) => curveRadius(g(), a.id))).toEqual([3, 3]);
    });

    it('draws a 3 point arc slot that solves and is one region', () => {
        draw('arcSlot3', [10, 0], [-10, 0], [0, 10], [0, 12]);
        const arcs = curves('arc');
        expect(arcs).toHaveLength(4);
        expect(curves('arc', true)).toHaveLength(1);
        expect(kinds('tangent')).toHaveLength(4);
        const radii = arcs.map((a) => Number(curveRadius(g(), a.id)!.toFixed(6))).sort((a, b) => a - b);
        expect(radii).toEqual([2, 2, 8, 12]);
        expect(geometryProfiles(g()).profiles).toHaveLength(1);
        solvesCleanly();
    });

    it('draws a centrepoint arc slot the way the pointer went round, with its dimensions', () => {
        setDrawOptions({ slotDimensions: true });
        setTool('centerArcSlot');
        for (const p of [[0, 0], [20, 0]] as [number, number][]) {
            sketchMove(p, TOL);
            sketchClick(p, TOL);
        }
        // Round counter-clockwise to the top.
        for (let t = 0.1; t <= Math.PI / 2 + 1e-9; t += 0.1) {
            sketchMove([20 * Math.cos(t), 20 * Math.sin(t)], TOL);
        }
        sketchMove([0, 20], TOL);
        sketchClick([0, 20], TOL);
        sketchMove([0, 23], TOL);
        sketchClick([0, 23], TOL);
        const params = arcParams(g(), curves('arc', true)[0].id)!;
        expect(params.r).toBeCloseTo(20, 6);
        expect(params.angle).toBeCloseTo(90, 4);
        expect(kinds('radius')).toMatchObject([{ value: 20 }]);
        expect(kinds('distance')).toMatchObject([{ value: 6 }]);
        expect(measure(g(), kinds('angle')[0])).toBeCloseTo(90, 4);
        expect(geometryProfiles(g()).profiles).toHaveLength(1);
        solvesCleanly();
    });
});

describe('polygon', () => {
    beforeEach(() => start());

    for (const sides of [5, 6]) {
        it(`draws a ${sides}-sided polygon on an inscribed circle that stays regular`, () => {
            useSketcher.setState({ sides });
            setDrawOptions({ polygonInscribed: true });
            draw('polygon', [50, 50], [60, 50]);
            const circle = curves('circle', true)[0];
            expect(curveRadius(g(), circle.id)).toBeCloseTo(10, 9);
            const sideLines = curves('line');
            expect(sideLines).toHaveLength(sides);
            expect(kinds('tangent')).toHaveLength(sides % 2 ? sides : sides - 1);
            // Regular: corners at the circumradius.
            const R = 10 / Math.cos(Math.PI / sides);
            for (const l of sideLines) {
                const [u, v] = at((l as { a: string }).a);
                expect(Math.hypot(u - 50, v - 50)).toBeCloseTo(R, 6);
            }
            // Free: centre, size and rotation.
            expect(solvesCleanly()).toBe(4);
            // Still regular when a dimension makes the circle grow.
            expect(commitGeometry(addConstraint(g(), { kind: 'radius', curve: circle.id, value: 20 }).g)).toBe(true);
            const [cu, cv] = at((circle as { center: string }).center);
            for (const l of curves('line')) {
                const [u, v] = at((l as { a: string }).a);
                expect(Math.hypot(u - cu, v - cv)).toBeCloseTo(2 * R, 5);
            }
        });
    }

    it('draws a polygon on a circumscribed circle: corners on it', () => {
        setDrawOptions({ polygonInscribed: false });
        draw('polygon', [50, 50], [62, 50]);
        expect(curves('line')).toHaveLength(6);
        for (const l of curves('line')) {
            const [u, v] = at((l as { a: string }).a);
            expect(Math.hypot(u - 50, v - 50)).toBeCloseTo(12, 6);
        }
        expect(solvesCleanly()).toBe(4);
    });

    it('reads the polygon back and draws it again with new values', () => {
        draw('polygon', [3, 0], [13, 0]);
        const info = polygonInfo(g(), g().curves.map((c) => c.id))!;
        expect(info).toMatchObject({ sides: 6, inscribed: false, cx: 3, cy: 0, diameter: 20, angle: 0 });
        const r = rebuildPolygon(g(), info, { sides: 8, inscribed: true, cx: 5, cy: 0, diameter: 30, angle: 0 })!;
        expect(commitGeometry(r.g)).toBe(true);
        const again = polygonInfo(g(), r.curves)!;
        expect(again).toMatchObject({ sides: 8, inscribed: true, cx: 5, cy: 0 });
        expect(again.diameter).toBeCloseTo(30, 9);
        expect(curves('line')).toHaveLength(8);
        solvesCleanly();
    });
});

describe('parameters of the entity just drawn', () => {
    beforeEach(() => start());

    it('moves and resizes a circle', () => {
        draw('circle', [2, 0], [7, 0]);
        const id = curves('circle')[0].id;
        expect(commitGeometry(editCircle(g(), id, { cx: 12.345678, r: 7.000001 }))).toBe(true);
        expect(circleParams(g(), id)).toEqual({ cx: 12.345678, cy: 0, r: 7.000001 });
    });

    it('changes an arc by its radius and angle', () => {
        draw('centerArc', [0, 0], [10, 0], [0, 10]);
        const id = curves('arc')[0].id;
        expect(commitGeometry(editArc(g(), id, { r: 20, angle: 45 }))).toBe(true);
        const p = arcParams(g(), id)!;
        expect(p.r).toBeCloseTo(20, 9);
        expect(p.angle).toBeCloseTo(45, 9);
        expect(p.sx).toBeCloseTo(20, 9);
    });

    it('keeps a line drawn from a tangent arc tangent', () => {
        const base = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g;
        start(base);
        draw('tangentArc', [10, 0], [20, 10]);
        expect(kinds('tangent')).toHaveLength(1);
    });
});

describe('dragging with a draw tool', () => {
    beforeEach(() => {
        start();
        // Slanted, so no automatic horizontal relation holds its end (the angle snaps to 15 degrees).
        draw('line', [0, 0], [20, 5]);
        setTool('select');
        setTool('line');
    });
    const far = (): [number, number] => at(curves('line')[0].kind === 'line' ? (curves('line')[0] as { b: string }).b : '');

    it('drags the point under the press, as the select tool does, once the pointer has moved', () => {
        const end = far();
        expect(sketchDown(end, TOL)).toBe(true);
        // Within the slop nothing moves: the press may still be the tool's click.
        sketchMove([end[0] + 0.1, end[1] + 0.1], TOL);
        expect(far()).toEqual(end);
        sketchMove([24, 6], TOL);
        sketchMove([25, 7], TOL);
        sketchUp();
        expect(far()[0]).toBeCloseTo(25, 6);
        expect(far()[1]).toBeCloseTo(7, 6);
        expect(state().drag).toBeNull();
        expect(state().tool).toBe('line');
        // One undo step for the drag.
        expect(state().undo.length).toBeGreaterThan(0);
    });

    it('leaves a press without a drag to the tool, and a press on nothing to the view', () => {
        const before = g();
        expect(sketchDown(far(), TOL)).toBe(true);
        sketchUp();
        expect(g()).toBe(before);
        expect(sketchDown([50, 50], TOL)).toBe(false);
        sketchUp();
    });

    it('does not drag while a line is being drawn', () => {
        sketchMove(far(), TOL);
        sketchClick(far(), TOL);
        expect(state().draft.length).toBe(1);
        expect(sketchDown([0, 0], TOL)).toBe(false);
    });
});
