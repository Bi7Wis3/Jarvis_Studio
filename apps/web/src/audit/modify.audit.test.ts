// Audit of the Modify group of the sketch toolbar (trim to check sketch for feature): each tool opened through its
// toolbar entry, used with realistic clicks on tilted geometry away from the origin, on every curve kind, and checked
// for exact results, clean solving, undo and regions. Fit/simplify spline and blocks are in items.audit.test.ts, the
// model tools in model.audit.test.ts.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { curveRadius, loadSolver, measure, pointOf } from '../solver';
import { addLine, addRect, EMPTY_GEOMETRY } from '../sketchGeometry';
import {
    enterKey, repairAll, repairProblem, sketchClick, sketchDown, sketchEscape, sketchMove, sketchUp, startEditTool, typeKey, redoSketch, undoSketch, useSketcher,
    type EditTool,
} from '../sketcher';
import { findProblems } from '../sketchRepair';
import { USAGES } from '../sketchFeatureCheck';
import { applySegment, checkSketch, flipWholeSketch, moveSketchFrame, scaleWholeSketch, useSketchMore } from '../sketchMoreTools';
import {
    at, begin, click, clicks, curvesOf, everyKind, expectPt, geo, groupTools, itemsIntact, noDangling, ON_CURVE, openChains, press, profiles,
    relations, solvesCleanly, state, TOL, undoRedoRestores, withItems,
} from './harness';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

beforeEach(() => begin());

type Line = Extract<SketchCurve, { kind: 'line' }>;
const line = (id: string) => geo().curves.find((c) => c.id === id) as Line;
const ends = (c: SketchCurve): [[number, number], [number, number]] => [at((c as Line).a), at((c as Line).b)];
const len = (c: SketchCurve) => {
    const [a, b] = ends(c);
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
};

/** Opens an edit tool's form as the toolbar does: its defaults, then its EditSession starts the tool. */
function openEdit(id: string, tool: EditTool) {
    const form = press(id);
    startEditTool(tool);
    return form;
}

/** A press and release in place, then the click: what a plain click in the view sends. */
function pressClick(p: [number, number], tol = TOL): void {
    sketchMove(p, tol);
    sketchDown(p, tol);
    sketchUp();
    sketchClick(p, tol);
}

const select = (...ids: string[]) => useSketcher.setState({
    selection: ids.map((id) => ({ type: geo().curves.some((c) => c.id === id) ? 'curve' as const : 'point' as const, id })),
});

/** Two tilted lines crossing at (10, 5), and a circle about (30, 5) radius 4 that the first one (extended) would cut. */
function cross(): SketchGeometry {
    let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [20, 10] }).g;
    g = addLine(g, { at: [0, 10] }, { at: [20, 0] }).g;
    return g;
}

/** A 3 point rectangle at an angle: corners (2, 1), (14, 6), (9, 18), (-3, 13) with its relations, solved. */
function tiltedRect(): SketchGeometry {
    begin();
    press('sk-rect3', 'rect3');
    clicks([2, 1], [14, 6], [9, 18]);
    const g = geo();
    begin(g);
    return geo();
}

describe('the Modify group', () => {
    it('lists the modify tools', () => {
        expect(groupTools('modify').map((t) => t.id)).toEqual([
            'sk-trim', 'sk-extend', 'sk-fillet', 'sk-chamfer', 'sk-offset', 'sk-mirror', 'sk-split', 'sk-pattern-linear', 'sk-pattern-circular',
            'sk-move', 'sk-copy', 'sk-rotate', 'sk-scale', 'sk-stretch', 'sk-repair', 'sk-dynamic-mirror', 'sk-jog', 'sk-segment', 'sk-replace',
            'sk-modify-sketch', 'sk-check-feature', 'sk-make-path', 'sk-select-chain', 'sk-reverse-tangent', 'sk-align-grid', 'sk-fit-spline', 'sk-simplify-spline',
            'sk-add-tangency', 'sk-add-curvature', 'sk-show-combs', 'sk-show-inflections', 'sk-show-min-radius', 'sk-show-handles', 'sk-show-polygon',
            'sk-convert-spline', 'sk-block-make', 'sk-block-insert', 'sk-block-edit', 'sk-block-rebuild', 'sk-block-addremove',
            'sk-block-explode', 'sk-block-save', 'sk-convert', 'sk-intersection', 'sk-silhouette', 'sk-pierce', 'sk-close-to-model',
        ]);
    });
});

describe('trim', () => {
    it('power trim: a click on a piece removes it up to the crossing, which stays on the other line', () => {
        begin(cross());
        openEdit('sk-trim', 'trim');
        undoRedoRestores(() => pressClick([3, 1.5]));
        const lines = curvesOf('line');
        expect(lines).toHaveLength(2);
        const cut = lines.find((l) => ends(l).some((p) => Math.abs(p[0] - 20) < 1e-9 && Math.abs(p[1] - 10) < 1e-9))!;
        const kept = ends(cut).find((p) => !(Math.abs(p[0] - 20) < 1e-9))!;
        expectPt(kept, [10, 5]);
        expect(relations('pointOnCurve').length + relations('coincident').length).toBeGreaterThan(0);
        solvesCleanly();
        noDangling();
    });

    it('power trim drag: a stroke across both lines trims each where it crosses, in one undo step', () => {
        begin(cross());
        openEdit('sk-trim', 'trim');
        undoRedoRestores(() => {
            sketchMove([2, 4], TOL);
            sketchDown([2, 4], TOL);
            for (let x = 2; x <= 4.01; x += 0.25) {
                sketchMove([x, 4 - (x - 2) * 1.5], TOL);
            }
            sketchUp();
        });
        expect(curvesOf('line').length).toBeGreaterThanOrEqual(2);
        solvesCleanly();
        noDangling();
    });

    it('corner: two tilted lines that do not meet are trimmed or extended to their corner', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [8, 4] }).g;
        g = addLine(g, { at: [14, -2] }, { at: [12, 10] }).g;
        begin(g);
        const form = openEdit('sk-trim', 'trim');
        form.change('trimMode', 'corner');
        undoRedoRestores(() => {
            pressClick([4, 2]);
            pressClick([13, 4]);
        });
        // Where the lines meet: on y = x / 2 and x = 14 - (y + 2) / 6.
        const y = (14 - 2 / 6) / (2 + 1 / 6);
        const corner: [number, number] = [2 * y, y];
        const shared = geo().points.filter((p) => curvesOf('line').filter((l) => ends(l).some((q) => q[0] === p.u && q[1] === p.v)).length === 2);
        expect(shared.length).toBeGreaterThan(0);
        expectPt([shared[0].u, shared[0].v], corner, 6);
        solvesCleanly();
        noDangling();
    });

    it('trim away inside: the piece between two boundaries goes', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [30, 6] }).g;
        g = addLine(g, { at: [10, -5] }, { at: [11, 10] }).g;
        g = addLine(g, { at: [20, -5] }, { at: [21, 10] }).g;
        begin(g);
        const form = openEdit('sk-trim', 'trim');
        form.change('trimMode', 'inside');
        pressClick([10.5, 2.5]);
        pressClick([20.5, 2.5]);
        undoRedoRestores(() => pressClick([15, 3]));
        expect(curvesOf('line')).toHaveLength(4);
        solvesCleanly();
        noDangling();
    });

    it('keeps the trimmed piece as construction when the form says so', () => {
        begin(cross());
        const form = openEdit('sk-trim', 'trim');
        form.change('trimConstruction', true);
        pressClick([3, 1.5]);
        expect(curvesOf('line', true)).toHaveLength(1);
        expect(len(curvesOf('line', true)[0])).toBeCloseTo(Math.hypot(10, 5), 9);
    });
});

describe('extend', () => {
    it('lengthens a tilted line to the circle it points at', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [5, 2.5] }).g;
        g = { ...g, points: [...g.points, { id: 'cc', u: 20, v: 10 }], curves: [...g.curves, { id: 'ring', kind: 'circle', center: 'cc', radius: 3 }] };
        begin(g);
        openEdit('sk-extend', 'extend');
        const id = curvesOf('line')[0].id;
        undoRedoRestores(() => click([4.5, 2.25]));
        const d = Math.hypot(20, 10) - 3;
        expectPt(ends(line(id))[1], [(d * 2) / Math.sqrt(5), d / Math.sqrt(5)], 6);
        solvesCleanly();
        noDangling();
    });

    it('says when there is nothing to extend to', () => {
        begin(addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [5, 2.5] }).g);
        openEdit('sk-extend', 'extend');
        const before = geo();
        click([4.5, 2.25]);
        expect(geo()).toBe(before);
        expect(state().message).toMatch(/Nothing to extend/);
    });
});

describe('fillet', () => {
    it('rounds a corner of a tilted rectangle with radius 2.5001: tangent arc, one region, solves', () => {
        tiltedRect();
        const form = openEdit('sk-fillet', 'fillet');
        form.change('filletRadius', '2.5001');
        undoRedoRestores(() => click([14, 6]));
        const [arc] = curvesOf('arc');
        expect(curveRadius(geo(), arc.id)).toBeCloseTo(2.5001, 6);
        // Tangent to both sides: its centre is the radius away from each side's line.
        const centre = at((arc as { center: string }).center);
        const sideDist = (a: [number, number], b: [number, number]) =>
            Math.abs((b[0] - a[0]) * (centre[1] - a[1]) - (b[1] - a[1]) * (centre[0] - a[0])) / Math.hypot(b[0] - a[0], b[1] - a[1]);
        expect(sideDist([2, 1], [14, 6])).toBeCloseTo(2.5001, 6);
        expect(sideDist([14, 6], [9, 18])).toBeCloseTo(2.5001, 6);
        expect(relations('radius')).toMatchObject([{ value: 2.5001 }]);
        expect(profiles()).toHaveLength(1);
        solvesCleanly();
        noDangling();
    });

    it('fillets the corners selected before OK', async () => {
        tiltedRect();
        const corners = geo().points.filter((p) => (Math.abs(p.u - 14) < 1e-6 && Math.abs(p.v - 6) < 1e-6) || (Math.abs(p.u - 2) < 1e-6 && Math.abs(p.v - 1) < 1e-6));
        select(...corners.map((p) => p.id));
        const form = openEdit('sk-fillet', 'fillet');
        form.change('filletRadius', '1.25');
        const r = await form.apply();
        expect(r.isError).toBe(false);
        expect(curvesOf('arc')).toHaveLength(2);
        solvesCleanly();
    });

    it('refuses a radius too large for the sides in plain words', () => {
        tiltedRect();
        const form = openEdit('sk-fillet', 'fillet');
        form.change('filletRadius', '40');
        const before = geo();
        click([14, 6]);
        expect(geo()).toBe(before);
        expect(state().message).not.toBeNull();
    });

    // Defect: a Radius of 0 (or below) in the Fillet form is dropped without a word and the next corner is rounded
    // with the radius from before.
    it('says a radius of 0 cannot be used, and fillets nothing', () => {
        tiltedRect();
        const form = openEdit('sk-fillet', 'fillet');
        form.change('filletRadius', '0');
        click([14, 6]);
        expect(curvesOf('arc')).toHaveLength(0);
        expect(state().message).toMatch(/above zero|zero/);
    });

    it('says a chamfer distance below zero or not a number cannot be used, and cuts nothing', async () => {
        for (const value of ['-1', 'abc']) {
            tiltedRect();
            const form = openEdit('sk-chamfer', 'chamfer');
            form.change('chamferDistance', value);
            const before = geo();
            click([14, 6]);
            expect(geo(), value).toBe(before);
            expect(state().message, value).toMatch(/above zero/);
            form.change('chamferDistance', '1.5');
            expect(state().message).toBeNull();
        }
    });
});

describe('chamfer', () => {
    it('cuts a corner of a tilted rectangle 1.5 each way', () => {
        tiltedRect();
        const form = openEdit('sk-chamfer', 'chamfer');
        form.change('chamferDistance', '1.5');
        undoRedoRestores(() => click([14, 6]));
        const lines = curvesOf('line');
        expect(lines).toHaveLength(5);
        // The new edge's ends are 1.5 from the old corner along each side.
        const near = geo().points.filter((p) => Math.abs(Math.hypot(p.u - 14, p.v - 6) - 1.5) < 1e-6);
        expect(near).toHaveLength(2);
        expect(profiles()).toHaveLength(1);
        solvesCleanly();
        noDangling();
    });

    it('angle-distance: 2 along the first side at 30 degrees', () => {
        tiltedRect();
        const form = openEdit('sk-chamfer', 'chamfer');
        form.change('chamferType', 'angle');
        form.change('chamferDistance', '2');
        form.change('chamferAngle', '30');
        click([14, 6]);
        expect(curvesOf('line')).toHaveLength(5);
        solvesCleanly();
        noDangling();
    });
});

describe('offset', () => {
    it('offsets a tilted line by 3.0001 with its dimension on OK', async () => {
        begin(addLine(EMPTY_GEOMETRY, { at: [5, 5] }, { at: [25, 15] }).g);
        const form = openEdit('sk-offset', 'offset');
        form.change('offsetDistance', '3.0001');
        click([15, 10]);
        expect(state().offsetCurve).not.toBeNull();
        sketchMove([14, 14], TOL);
        const before = geo();
        const r = await form.apply();
        expect(r.isError).toBe(false);
        const lines = curvesOf('line');
        expect(lines).toHaveLength(2);
        // Distance between the two parallel lines.
        const [a, b] = ends(lines[1]);
        const d = Math.abs((20 * (a[1] - 5) - 10 * (a[0] - 5))) / Math.hypot(20, 10);
        expect(d).toBeCloseTo(3.0001, 6);
        expect(Math.abs((20 * (b[1] - 5) - 10 * (b[0] - 5))) / Math.hypot(20, 10)).toBeCloseTo(3.0001, 6);
        // The offset dimension: a construction line square to both, 3.0001 long.
        expect(relations('length').map((k) => (k as { value: number }).value)).toContain(3.0001);
        solvesCleanly();
        noDangling();
        undoSketch();
        expect(geo().curves).toEqual(before.curves);
    });

    it('offsets a rectangle chain outwards into a second closed region', async () => {
        tiltedRect();
        const form = openEdit('sk-offset', 'offset');
        form.change('offsetDistance', '2');
        click([8, 3.5]);
        sketchMove([8, 0], TOL);
        await form.apply();
        expect(curvesOf('line')).toHaveLength(8);
        expect(profiles().length).toBeGreaterThanOrEqual(1);
        solvesCleanly();
        noDangling();
    });
});

describe('mirror', () => {
    it('mirrors a circle and a line about a tilted centreline: images where they belong, symmetric', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [20, 20] }).g;
        g = { ...g, curves: g.curves.map((c) => ({ ...c, construction: true })) };
        g = { ...g, points: [...g.points, { id: 'cc', u: 10, v: 2 }], curves: [...g.curves, { id: 'ring', kind: 'circle', center: 'cc', radius: 1.5 }] };
        g = addLine(g, { at: [12, 3] }, { at: [18, 5] }).g;
        begin(g);
        openEdit('sk-mirror', 'mirror');
        undoRedoRestores(() => {
            click([11.5, 2]);
            click([15, 4]);
            click([5, 5]);
        });
        const circles = curvesOf('circle');
        expect(circles).toHaveLength(2);
        expectPt(at((circles[1] as { center: string }).center), [2, 10], 6);
        expect(curveRadius(geo(), circles[1].id)).toBeCloseTo(1.5, 9);
        const lines = curvesOf('line');
        expect(lines).toHaveLength(2);
        const image = ends(lines[1]);
        expectPt(image[0], [3, 12], 6);
        expectPt(image[1], [5, 18], 6);
        expect(relations('symmetric').length).toBeGreaterThan(0);
        solvesCleanly();
        noDangling();
    });

    function mirrorKind(kind: string) {
        const { g, ids } = everyKind();
        const axis = addLine(g, { at: [0, -100] }, { at: [0.0001, 100] });
        const withAxis = { ...axis.g, curves: axis.g.curves.map((c) => (c.id === axis.id ? { ...c, construction: true } : c)) };
        {
            begin(withAxis);
            select(ids[kind]);
            openEdit('sk-mirror', 'mirror');
            expect(state().picks.map((p) => p.id)).toEqual([ids[kind]]);
            click([0, 60]);
            const made = geo().curves.filter((c) => c.kind === kind && !c.construction);
            expect(made.length, kind).toBe(2);
            expect(state().message, kind).toBeNull();
            solvesCleanly();
            noDangling();
        }
    }

    for (const kind of ['line', 'circle', 'arc', 'spline', 'styleSpline', 'conic']) {
        it(`mirrors a ${kind} about a centreline, the image solving cleanly`, () => mirrorKind(kind));
    }

    // Defect: mirroring an ellipse, partial ellipse or parabola adds one symmetric relation too many: the sketch turns
    // "Over defined" at once (the symmetric relation on the second axis end repeats what the others hold).
    for (const kind of ['ellipse', 'ellipseArc', 'parabola']) {
        it(`mirrors a ${kind} about a centreline without over defining the sketch`, () => mirrorKind(kind));
    }
});

describe('split', () => {
    it('splits a tilted line at a click into two lines sharing the new point', () => {
        begin(addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [20, 10] }).g);
        openEdit('sk-split', 'split');
        undoRedoRestores(() => click([7, 3.5]));
        const lines = curvesOf('line');
        expect(lines).toHaveLength(2);
        expect(lines[0].kind === 'line' && lines[1].kind === 'line' && lines[0].b === lines[1].a).toBe(true);
        expectPt(ends(lines[0])[1], [7, 3.5]);
        expect(openChains()).toHaveLength(1);
        solvesCleanly();
        noDangling();
    });

    it('splits a circle at two points into two arcs that still close', () => {
        begin({ points: [{ id: 'cc', u: 12, v: -4 }], curves: [{ id: 'ring', kind: 'circle', center: 'cc', radius: 5 }], constraints: [] });
        openEdit('sk-split', 'split');
        click([17, -4]);
        click([12, 1]);
        expect(curvesOf('arc')).toHaveLength(2);
        expect(profiles()).toHaveLength(1);
        solvesCleanly();
        noDangling();
    });
});

describe('linear and circular sketch patterns', () => {
    const disc = (): SketchGeometry => ({ points: [{ id: 'cc', u: 10.5, v: 4.25 }], curves: [{ id: 'ring', kind: 'circle', center: 'cc', radius: 1.5 }], constraints: [] });

    it('linear: 4 at 12.0001 along 30 degrees, spacing dimensioned', async () => {
        begin(disc());
        select('ring');
        const form = press('sk-pattern-linear');
        form.values = { ...form.values, spacing: '12.0001', count: '4', angle: '30' };
        let r: { text: string; isError: boolean } = { text: '', isError: false };
        await (async () => {
            const before = geo();
            r = await form.apply();
            expect(geo()).not.toBe(before);
        })();
        expect(r.isError).toBe(false);
        const centres = curvesOf('circle').map((c) => at((c as { center: string }).center));
        expect(centres).toHaveLength(4);
        const t = Math.PI / 6;
        expectPt(centres[3], [10.5 + 3 * 12.0001 * Math.cos(t), 4.25 + 3 * 12.0001 * Math.sin(t)], 6);
        expect(relations('distance').concat(relations('length')).some((k) => Math.abs((k as { value: number }).value - 12.0001) < 1e-12)).toBe(true);
        solvesCleanly();
        noDangling();
        undoSketch();
        expect(curvesOf('circle')).toHaveLength(1);
    });

    it('linear: refuses a spacing of 0, a negative count and nothing selected in plain words', async () => {
        begin(disc());
        select('ring');
        const form = press('sk-pattern-linear');
        const before = geo();
        for (const patch of [{ spacing: '0' }, { spacing: '-3' }, { count: '0' }, { count: '-2' }] as Record<string, string>[]) {
            const r = await (press('sk-pattern-linear').def.apply!({ ...form.values, ...patch }, {} as never));
            expect(r?.isError, JSON.stringify(patch)).toBe(true);
        }
        useSketcher.setState({ selection: [] });
        const none = await form.apply();
        expect(none.isError).toBe(true);
        expect(geo()).toBe(before);
    });

    it('circular: 6 equally round (-4.5, 7.25)', async () => {
        begin(disc());
        select('ring');
        const form = press('sk-pattern-circular');
        form.values = { ...form.values, centre0: '-4.5', centre1: '7.25', count: '6', angle: '360', equal: true };
        const r = await form.apply();
        expect(r.isError).toBe(false);
        const centres = curvesOf('circle').map((c) => at((c as { center: string }).center));
        expect(centres).toHaveLength(6);
        const rad = Math.hypot(10.5 + 4.5, 4.25 - 7.25);
        for (const c of centres) {
            expect(Math.hypot(c[0] + 4.5, c[1] - 7.25)).toBeCloseTo(rad, 6);
        }
        solvesCleanly();
        noDangling();
    });

    it('circular: refuses one instance and a zero angle', async () => {
        begin(disc());
        select('ring');
        const form = press('sk-pattern-circular');
        const before = geo();
        expect((await form.def.apply!({ ...form.values, count: '1' }, {} as never))?.isError).toBe(true);
        expect((await form.def.apply!({ ...form.values, angle: '0' }, {} as never))?.isError).toBe(true);
        expect(geo()).toBe(before);
    });
});

describe('move, copy, rotate, scale, stretch', () => {
    const plate = () => addRect(EMPTY_GEOMETRY, [3.5, 2.25], [17.75, 11.125]).g;

    it('move by (6.2501, -3.0001) moves every corner exactly', async () => {
        begin(plate());
        select(...geo().curves.map((c) => c.id));
        const form = press('sk-move');
        form.values = { ...form.values, by0: '6.2501', by1: '-3.0001' };
        const before = geo().points.map((p) => [p.u, p.v]);
        undoRedoRestores(() => void form.apply());
        geo().points.forEach((p, i) => expectPt([p.u, p.v], [before[i][0] + 6.2501, before[i][1] - 3.0001], 9));
        solvesCleanly();
    });

    it('copy: three copies each 20 further on, in one undo step', async () => {
        begin(plate());
        select(...geo().curves.map((c) => c.id));
        const form = press('sk-copy');
        form.values = { ...form.values, by0: '20', by1: '5', copies: '3' };
        undoRedoRestores(() => void form.apply());
        expect(curvesOf('line')).toHaveLength(16);
        expect(profiles()).toHaveLength(4);
        solvesCleanly();
        noDangling();
    });

    it('rotate 37.5 degrees about (10, 10)', async () => {
        begin(plate());
        select(...geo().curves.map((c) => c.id));
        const form = press('sk-rotate');
        form.values = { ...form.values, angle: '37.5', centre0: '10', centre1: '10' };
        const corner = at(geo().points[0].id);
        const r = await form.apply();
        expect(r.isError).toBe(false);
        const t = (37.5 * Math.PI) / 180;
        const [dx, dy] = [corner[0] - 10, corner[1] - 10];
        expectPt(at(geo().points[0].id), [10 + dx * Math.cos(t) - dy * Math.sin(t), 10 + dx * Math.sin(t) + dy * Math.cos(t)], 6);
        // The horizontal and vertical relations cannot hold after a turn: they go, and the sketch still solves.
        solvesCleanly();
        noDangling();
    });

    it('scale 1.5 about (3.5, 2.25), and refuses 0 and a negative factor', async () => {
        begin(plate());
        select(...geo().curves.map((c) => c.id));
        const form = press('sk-scale');
        form.values = { ...form.values, factor: '1.5', centre0: '3.5', centre1: '2.25' };
        expect((await form.apply()).isError).toBe(false);
        expect(len(curvesOf('line')[0])).toBeCloseTo(14.25 * 1.5, 9);
        const before = geo();
        expect((await form.def.apply!({ ...form.values, factor: '0' }, {} as never))?.isError).toBe(true);
        expect((await form.def.apply!({ ...form.values, factor: '-2' }, {} as never))?.isError).toBe(true);
        expect(geo()).toBe(before);
    });

    it('stretch: the selected side moves, the attached sides stretch', async () => {
        begin(plate());
        const right = geo().curves[1].id;
        select(right);
        const form = press('sk-stretch');
        form.values = { ...form.values, by0: '4.0001', by1: '0' };
        expect((await form.apply()).isError).toBe(false);
        expect(len(geo().curves[0])).toBeCloseTo(14.25 + 4.0001, 6);
        expect(relations('horizontal')).toHaveLength(2);
        solvesCleanly();
    });

    it('transforms every curve kind (move, rotate, scale) without leaving it broken', async () => {
        const { g, ids } = everyKind();
        for (const tool of ['sk-move', 'sk-rotate', 'sk-scale', 'sk-copy']) {
            for (const kind of Object.keys(ids)) {
                begin(g);
                select(ids[kind]);
                const form = press(tool);
                form.values = { ...form.values, by0: '3.25', by1: '-1.5', angle: '33', factor: '1.25', centre0: '1', centre1: '2' };
                const r = await form.apply();
                expect(r.isError, `${tool} ${kind}: ${r.text}`).toBe(false);
                solvesCleanly();
                noDangling();
            }
        }
    });
});

describe('dynamic mirror', () => {
    it('mirrors a line drawn after picking a tilted centreline, live, until switched off', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [20, 20] }).g;
        g = { ...g, curves: g.curves.map((c) => ({ ...c, construction: true })) };
        begin(g);
        press('sk-dynamic-mirror');
        click([10, 10]);
        expect(useSketchMore.getState().dynamicMirror).not.toBeNull();
        press('sk-line', 'line');
        clicks([12, 3], [18, 5]);
        enterKey();
        const lines = curvesOf('line');
        expect(lines).toHaveLength(2);
        expectPt(ends(lines[1])[0], [3, 12], 6);
        expectPt(ends(lines[1])[1], [5, 18], 6);
        solvesCleanly();
        noDangling();
        press('sk-dynamic-mirror');
        expect(useSketchMore.getState().dynamicMirror).toBeNull();
        clicks([30, 2], [35, 4]);
        enterKey();
        expect(curvesOf('line')).toHaveLength(3);
    });

    // Defect: the ellipse, spline, parabola and conic tools commit straight away, past the dynamic mirror, so what they
    // draw is not mirrored (sketcher.ts placedConic does not go through commitDrawn / afterDrawn).
    it('mirrors an ellipse drawn with dynamic mirror on', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [20, 20] }).g;
        g = { ...g, curves: g.curves.map((c) => ({ ...c, construction: true })) };
        begin(g);
        press('sk-dynamic-mirror');
        click([10, 10]);
        press('sk-ellipse');
        clicks([15, 5], [20, 5], [15, 7]);
        expect(curvesOf('ellipse')).toHaveLength(2);
        press('sk-dynamic-mirror');
    });

    it('mirrors a parabola and a spline drawn with dynamic mirror on, solving cleanly', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [20, 20] }).g;
        g = { ...g, curves: g.curves.map((c) => ({ ...c, construction: true })) };
        begin(g);
        press('sk-dynamic-mirror');
        click([10, 10]);
        press('sk-parabola');
        clicks([30, 12], [30, 10], [26, 12], [34, 12]);
        expect(curvesOf('parabola')).toHaveLength(2);
        press('sk-spline');
        clicks([40, 2], [45, 6], [50, 3]);
        enterKey();
        expect(curvesOf('spline')).toHaveLength(2);
        solvesCleanly();
        noDangling();
        press('sk-dynamic-mirror');
    });
});

describe('jog line', () => {
    it('puts a step into a tilted line: perpendicular and parallel pieces, tool stays on', () => {
        begin(addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [30, 10] }).g);
        press('sk-jog');
        undoRedoRestores(() => {
            click([9, 3]);
            click([18, 9]);
        });
        expect(curvesOf('line').length).toBeGreaterThanOrEqual(5);
        expect(relations('perpendicular').length + relations('parallel').length).toBeGreaterThan(0);
        expect(state().tool).toBe('m:jog');
        solvesCleanly();
        noDangling();
        sketchEscape();
    });

    it('says plainly that a jog goes on a line when an arc is clicked', () => {
        begin({ points: [{ id: 'c', u: 0, v: 0 }, { id: 's', u: 10, v: 0 }, { id: 'e', u: 0, v: 10 }], curves: [{ id: 'a', kind: 'arc', center: 'c', start: 's', end: 'e' }], constraints: [] });
        press('sk-jog');
        const before = geo();
        click([10 * Math.SQRT1_2, 10 * Math.SQRT1_2]);
        expect(geo()).toBe(before);
        expect(state().message).toMatch(/line/);
    });
});

describe('segment', () => {
    it('4 equally spaced points on a tilted line, held equal', async () => {
        begin(addLine(EMPTY_GEOMETRY, { at: [2, 1] }, { at: [27, 11] }).g);
        select(curvesOf('line')[0].id);
        const form = press('sk-segment');
        form.values = { ...form.values, count: '5', mode: 'points' };
        undoRedoRestores(() => void form.apply());
        const loose = geo().points.filter((p) => !['p1', 'p2'].includes(p.id) && !curvesOf('line').some((l) => ends(l).some((q) => q[0] === p.u && q[1] === p.v && false)));
        expect(loose.length).toBeGreaterThanOrEqual(4);
        solvesCleanly();
        noDangling();
    });

    it('3 equal segments of an arc', async () => {
        begin({ points: [{ id: 'c', u: 5, v: 5 }, { id: 's', u: 15, v: 5 }, { id: 'e', u: 5, v: 15 }], curves: [{ id: 'a', kind: 'arc', center: 'c', start: 's', end: 'e' }], constraints: [] });
        select('a');
        const form = press('sk-segment');
        form.values = { ...form.values, count: '3', mode: 'segments' };
        expect((await form.apply()).isError).toBe(false);
        expect(curvesOf('arc')).toHaveLength(3);
        for (const a of curvesOf('arc')) {
            expect(curveRadius(geo(), a.id)).toBeCloseTo(10, 6);
        }
        solvesCleanly();
    });

    it('refuses 0, 1.5 and a spline in plain words', async () => {
        const { g, ids } = everyKind();
        begin(g);
        const form = press('sk-segment');
        expect((await form.def.apply!({ ...form.values, curve: ids.line, count: '0' }, {} as never))?.isError).toBe(true);
        expect((await form.def.apply!({ ...form.values, curve: ids.line, count: '1.5' }, {} as never))?.isError).toBe(true);
        const r = await form.def.apply!({ ...form.values, curve: ids.spline, count: '3' }, {} as never);
        expect(r?.isError).toBe(true);
        expect(geo().curves).toHaveLength(g.curves.length);
    });
});

describe('replace entity', () => {
    it('a new line takes over the old one\'s length dimension; the old one becomes construction', async () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [2, 1] }, { at: [12, 6] }).g;
        const old = g.curves[0].id;
        g = { ...g, constraints: [...g.constraints, { id: 'len', kind: 'length', line: old, value: Math.hypot(10, 5) }] };
        g = addLine(g, { at: [2, 10] }, { at: [14, 13] }).g;
        const fresh = g.curves[1].id;
        begin(g);
        const form = press('sk-replace');
        form.values = { ...form.values, from: old, to: fresh, old: 'construction' };
        undoRedoRestores(() => void form.apply());
        expect(relations('length')).toMatchObject([{ line: fresh }]);
        expect(geo().curves.find((c) => c.id === old)?.construction).toBe(true);
        solvesCleanly();
        noDangling();
    });

    it('asks for both entities when one is missing', async () => {
        begin(cross());
        const form = press('sk-replace');
        const r = await form.def.apply!({ ...form.values, from: curvesOf('line')[0].id, to: '' }, {} as never);
        expect(r?.isError).toBe(true);
    });
});

describe('modify sketch', () => {
    it('scales the whole sketch by 2 about its origin, keeping dimensions in step', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [2, 1] }, { at: [12, 6] }).g;
        g = { ...g, constraints: [{ id: 'len', kind: 'length', line: g.curves[0].id, value: Math.hypot(10, 5) }] };
        begin(g);
        press('sk-modify-sketch');
        undoRedoRestores(() => expect(scaleWholeSketch(2)).toBeNull());
        expectPt(ends(curvesOf('line')[0])[1], [24, 12], 6);
        expect((relations('length')[0] as { value: number }).value).toBeCloseTo(2 * Math.hypot(10, 5), 9);
        solvesCleanly();
    });

    it('refuses a scale factor of 0 or below', () => {
        begin(cross());
        const before = geo();
        expect(scaleWholeSketch(0)).not.toBeNull();
        expect(scaleWholeSketch(-1)).not.toBeNull();
        expect(geo()).toBe(before);
    });

    it('flips about X: v changes sign', () => {
        begin(cross());
        undoRedoRestores(() => expect(flipWholeSketch('x')).toBeNull());
        expectPt(ends(curvesOf('line')[0])[1], [20, -10], 9);
        solvesCleanly();
    });

    it('moves the sketch plane by (5, 0)', () => {
        begin(cross());
        const plane = state().plane;
        expect(moveSketchFrame([5, 0])).toBeNull();
        expect(state().plane).not.toEqual(plane);
    });

    // Defect: Scale about a movable origin is two changes, the scale (undoable) and a move of the sketch plane (not
    // undoable): Ctrl+Z takes back the scale but leaves the sketch moved.
    it('scale about a movable origin is undone as a whole', () => {
        begin(cross());
        const plane = state().plane;
        expect(scaleWholeSketch(2, [5, 5])).toBeNull();
        undoSketch();
        expect(state().plane).toEqual(plane);
    });

    it('moving and turning the sketch plane are one undo step each, and redo puts them back', () => {
        begin(cross());
        const [plane0, g0] = [state().plane, geo()];
        expect(moveSketchFrame([5, 0])).toBeNull();
        const plane1 = state().plane;
        expect(moveSketchFrame([0, 0], [1, 2], 30)).toBeNull();
        const plane2 = state().plane;
        undoSketch();
        expect(state().plane).toEqual(plane1);
        undoSketch();
        expect(state().plane).toEqual(plane0);
        expect(geo()).toEqual(g0);
        redoSketch();
        redoSketch();
        expect(state().plane).toEqual(plane2);
        scaleWholeSketch(2, [5, 5]);
        const plane3 = state().plane;
        undoSketch();
        expect(state().plane).toEqual(plane2);
        redoSketch();
        expect(state().plane).toEqual(plane3);
    });
});

describe('check sketch for feature', () => {
    it('passes a closed rectangle for an extrude and names an open chain', () => {
        tiltedRect();
        press('sk-check-feature');
        const extrude = USAGES.find((u) => u.value === 'extrude')!.contour;
        expect(checkSketch(extrude).ok).toBe(true);
        begin(cross());
        const r = checkSketch(extrude);
        expect(r.ok).toBe(false);
        expect(r.text.length).toBeGreaterThan(0);
        // One open line is a good sweep path.
        begin(addLine(EMPTY_GEOMETRY, { at: [2, 1] }, { at: [14, 6] }).g);
        expect(checkSketch(USAGES.find((u) => u.value === 'sweepPath')!.contour).ok).toBe(true);
    });
});

describe('repair sketch', () => {
    it('finds and closes a 0.004 mm gap between two lines, and removes a duplicate', () => {
        let g = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 5] }).g;
        g = addLine(g, { at: [10.004, 5] }, { at: [20, 0] }).g;
        g = addLine(g, { at: [0, 0] }, { at: [10, 5] }).g;
        begin(g);
        press('sk-repair');
        const problems = findProblems(geo(), 0.01);
        expect(problems.length).toBeGreaterThanOrEqual(2);
        expect(repairAll(0.01)).toBe(true);
        expect(findProblems(geo(), 0.01)).toEqual([]);
        expect(curvesOf('line')).toHaveLength(2);
        solvesCleanly();
        noDangling();
        void repairProblem;
    });
});

describe('every curve kind under the curve-picking modify tools', () => {
    const tools: [string, EditTool][] = [['sk-trim', 'trim'], ['sk-extend', 'extend'], ['sk-split', 'split'], ['sk-offset', 'offset'], ['sk-fillet', 'fillet'], ['sk-chamfer', 'chamfer']];
    for (const [id, tool] of tools) {
        it(`${id} on each curve kind either works or says plainly that it does not`, () => {
            const { g, ids } = everyKind();
            for (const kind of Object.keys(ids)) {
                begin(g);
                openEdit(id, tool);
                const before = geo();
                expect(() => {
                    pressClick(ON_CURVE[kind]);
                    // Fillet and chamfer take two curves: the second click on the same kind's neighbour point.
                    if (tool === 'offset' && state().offsetCurve) {
                        sketchMove([ON_CURVE[kind][0] + 2, ON_CURVE[kind][1] + 2], TOL);
                        pressClick([ON_CURVE[kind][0] + 2, ON_CURVE[kind][1] + 2]);
                    }
                }).not.toThrow();
                if (geo() === before) {
                    const pending = state().offsetCurve || state().picks.length || state().trimPicks.length;
                    expect(state().message || pending, `${id} on ${kind}: no change and no word`).toBeTruthy();
                } else {
                    solvesCleanly();
                    noDangling();
                }
                // Trim, Extend and Split (sketchCut.ts) and Offset (sketchCurveOffset.ts) work on every kind now.
                if (['ellipse', 'ellipseArc', 'spline', 'styleSpline', 'parabola', 'conic'].includes(kind) && tool === 'offset') {
                    expect(geo().offsets?.length ?? 0, `${id} on ${kind}: ${state().message ?? ''}`).toBeGreaterThan(0);
                }
            }
        });
    }

    it('trim, split and offset on text, equation curve and block instance curves leave the items whole', () => {
        const items = withItems();
        const targets: Record<string, [number, number]> = {
            text: [200 + 4, 100], equation: [0, 0], insert: [157.5, -56],
        };
        for (const [id, tool] of [['sk-trim', 'trim'], ['sk-split', 'split'], ['sk-offset', 'offset'], ['sk-extend', 'extend']] as [string, EditTool][]) {
            for (const [what, p] of Object.entries(targets)) {
                begin(items.g);
                openEdit(id, tool);
                const before = geo();
                expect(() => {
                    pressClick(p);
                    if (state().offsetCurve) {
                        pressClick([p[0] + 1, p[1] + 1]);
                    }
                }).not.toThrow();
                itemsIntact();
                noDangling();
                if (geo() === before) {
                    expect(state().message || state().offsetCurve || state().picks.length, `${id} on ${what}: no change and no word`).toBeTruthy();
                } else {
                    solvesCleanly();
                }
            }
        }
    });
});

describe('trim and split on the curves of text and block instances', () => {
    // SOLIDWORKS_REFERENCE.md Part B, Text: text is edited as text and dissolved into entities to edit those; Blocks:
    // a block is one rigid unit changed through Edit Block (or exploded). Neither is cut up in place.
    const cases: [string, EditTool, 'text' | 'insert', [number, number]][] = [
        ['sk-trim', 'trim', 'text', [204, 100]], ['sk-trim', 'trim', 'insert', [157.5, -56]],
        ['sk-split', 'split', 'text', [204, 100]], ['sk-split', 'split', 'insert', [157.5, -56]],
    ];
    for (const [id, tool, what, p] of cases) {
        // Defect: trim takes the whole text or block instance apart (the item goes, its other curves stay loose) and
        // removes the piece without a word; split cuts a generated curve so the item no longer owns all of it.
        it(`${id} on a ${what} curve says to dissolve or edit it first, and changes nothing`, () => {
            const items = withItems();
            begin(items.g);
            openEdit(id, tool);
            const before = geo();
            pressClick(p);
            expect(geo()).toBe(before);
            expect(state().message).toMatch(/dissolve|explode|edit block|text|block/i);
        });
    }
});

describe('cut, copy and paste', () => {
    it('Ctrl+C, Ctrl+V pastes a rectangle at the pointer with its relations', async () => {
        const { copySelection, pasteAtCursor } = await import('../sketchMoreTools');
        begin(addRect(EMPTY_GEOMETRY, [3.5, 2.25], [17.75, 11.125]).g);
        select(...geo().curves.map((c) => c.id));
        expect(copySelection()).toBe(true);
        sketchMove([50.5, 40.25], TOL);
        undoRedoRestores(() => expect(pasteAtCursor()).toBe(true));
        expect(curvesOf('line')).toHaveLength(8);
        expect(relations('horizontal')).toHaveLength(4);
        expect(profiles()).toHaveLength(2);
        solvesCleanly();
        noDangling();
    });
});

void pointOf;
void measure;
void typeKey;
void applySegment;
