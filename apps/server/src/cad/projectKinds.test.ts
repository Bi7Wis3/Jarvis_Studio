// Model edges seen from a sketch come in as the simplest exact entity (core curveKinds.ts): a box edge a line, a
// cylinder rim a circle, the spline edges a loft makes a line or an arc where they are straight or round (an ellipse
// arc seen at a tilt), a free-form edge a spline.

import { beforeAll, describe, expect, it } from 'vitest';
import { makeBox, makeCylinder, sketchCircle, sketchRectangle, type Shape3D } from 'replicad';
import { DEFAULT_PRINT, type Feature } from '@jarvis/core';
import type { ModelCurve, P2, PlaneFrame3, TaggedCurve } from '@jarvis/core/projection';
import { buildPartial, initOC } from './build.js';
import { convertPicks, projectEdges, sectionCurves, silhouetteCurves } from './project.js';

const SLOW = 120_000;
type V = [number, number, number];

const kinds = (curves: ModelCurve[]): string[] => curves.map((c) => c.kind).sort();
const dist = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** A loft like the owner's: a hexagon on the top plane, a circle on a plane 68 in front, a slot 85.5 further on. */
const loftSteps: Feature[] = [
    { id: 's1', op: 'sketch', sketch: { plane: 'top', profiles: [{ kind: 'path', start: [0, -34.641016], segments: [
        { kind: 'line', to: [30, -17.320508] }, { kind: 'line', to: [30, 17.320508] }, { kind: 'line', to: [0, 34.641016] },
        { kind: 'line', to: [-30, 17.320508] }, { kind: 'line', to: [-30, -17.320508] }, { kind: 'line', to: [0, -34.641016] },
    ] }] } },
    { id: 'pl1', op: 'plane', definition: { kind: 'offset', base: 'front', distance: -68 } },
    { id: 's2', op: 'sketch', sketch: { plane: { planeRef: 'pl1' }, profiles: [{ kind: 'circle', center: [0, 50], radius: 13.601471 }] } },
    { id: 'pl2', op: 'plane', definition: { kind: 'offset', base: { planeRef: 'pl1' }, distance: -85.5 } },
    { id: 's3', op: 'sketch', sketch: { plane: { planeRef: 'pl2' }, profiles: [{ kind: 'path', start: [-10.745731, 82.689468], segments: [
        { kind: 'line', to: [-10.745731, 20.349972] }, { kind: 'arc', to: [10.697081, 20.349972], through: [-0.024325, 9.628566] },
        { kind: 'line', to: [10.697081, 82.689468] }, { kind: 'arc', to: [-10.745731, 82.689468], through: [-0.024325, 93.410874] },
    ] }] } },
    { id: 'loft', op: 'loft', mode: 'add', ruled: false, sections: [{ sketchRef: 's1' }, { sketchRef: 's2' }, { sketchRef: 's3' }] },
] as unknown as Feature[];

let loft: Shape3D;

beforeAll(async () => {
    await initOC();
    const built = buildPartial({ shape: { kind: 'empty' } as never, features: loftSteps }, DEFAULT_PRINT);
    expect(built.error).toBeNull();
    loft = built.shape!;
}, SLOW);

/** The plane of the slot, where the loft ends (front, 153.5 back): u = +x, v = +y. */
const END: PlaneFrame3 = { origin: [0, 0, -153.5], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] };
/** The top plane: u = +x, v = -z. */
const TOP: PlaneFrame3 = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] };

describe('the simplest entity for each model edge', () => {
    it('a box edge is a line and a cylinder rim a circle', () => {
        expect(kinds(projectEdges(makeBox([0, 0, 0], [10, 10, 10]), TOP).curves).every((k) => k === 'line')).toBe(true);
        const rims = projectEdges(makeCylinder(5, 10, [0, 0, 0], [0, 1, 0]), TOP).curves;
        expect(rims.map(({ edge: _e, ...c }) => c)).toEqual([{ kind: 'circle', center: [0, 0], radius: 5 }, { kind: 'circle', center: [0, 0], radius: 5 }]);
    }, SLOW);

    it('the loft gives every edge as a spline; seen from its end the slot is two lines and two arcs again', () => {
        const curves = projectEdges(loft, END).curves;
        // The edges on the end plane: the slot's sides (split where the loft's faces change) and its two round ends.
        const onEnd = curves.filter((c) => (c.kind === 'line' || c.kind === 'arc') && [c.kind === 'line' ? c.a : c.start].every((p) => p[1] > 9));
        const arcs = onEnd.filter((c) => c.kind === 'arc');
        expect(arcs.length).toBeGreaterThanOrEqual(2);
        for (const arc of arcs) {
            if (arc.kind === 'arc') {
                const top = arc.center[1] > 50;
                expect(dist(arc.center, top ? [-0.024325, 82.689468] : [-0.024325, 20.349972])).toBeLessThan(1e-6);
                expect(dist(arc.start, arc.center)).toBeCloseTo(10.721406, 5);
            }
        }
        const sides = onEnd.filter((c): c is Extract<ModelCurve, { kind: 'line' }> & TaggedCurve => c.kind === 'line' && Math.abs(c.a[0] - c.b[0]) < 1e-9);
        expect(sides.every((c) => Math.abs(Math.abs(c.a[0]) - 10.72) < 0.03)).toBe(true);
        // Nothing on the end plane is left a spline; the edges running along the loft are free-form and stay splines.
        expect(curves.filter((c) => c.kind === 'bezier' || c.kind === 'bspline').length).toBeGreaterThan(0);
        // The hexagon's corners seen end-on make nothing.
        expect(curves.some((c) => c.kind === 'bezier' && c.poles.every((p) => dist(p, c.poles[0]) < 1e-9))).toBe(false);
    }, SLOW);

    it('converting the loft\'s end face gives its loop as the slot: two lines and two arcs, the split sides joined', () => {
        const r = convertPicks(loft, END, [], [{ at: [0, 50, -153.5], normal: [0, 0, -1] }]);
        expect(r.skipped).toEqual([]);
        expect(kinds(r.curves)).toEqual(['arc', 'arc', 'line', 'line']);
    }, SLOW);

    it('the hexagon face converts as six lines, though the loft split each side', () => {
        const r = convertPicks(loft, TOP, [], [{ at: [0, 0, 0], normal: [0, -1, 0] }]);
        expect(kinds(r.curves)).toEqual(Array(6).fill('line'));
    }, SLOW);

    it('seen at a tilt, the slot\'s round ends are exact elliptical arcs', () => {
        const T = (35 * Math.PI) / 180;
        const tilted: PlaneFrame3 = { origin: [0, 0, -153.5], u: [Math.cos(T), 0, Math.sin(T)], v: [0, 1, 0], n: [-Math.sin(T), 0, Math.cos(T)] };
        const r = convertPicks(loft, tilted, [], [{ at: [0, 50, -153.5], normal: [0, 0, -1] }]);
        expect(kinds(r.curves)).toEqual(['ellipseArc', 'ellipseArc', 'line', 'line']);
        for (const e of r.curves) {
            if (e.kind === 'ellipseArc') {
                expect(Math.hypot(e.major[0] - e.center[0], e.major[1] - e.center[1])).toBeCloseTo(10.721406, 5);
                expect(e.minor).toBeCloseTo(10.721406 * Math.cos(T), 5);
            }
        }
    }, SLOW);

    it('a free-form section stays a spline: no arc or ellipse is made up for a piece of it', () => {
        const mixed = sketchCircle(10).loftWith(sketchRectangle(16, 16, { origin: 40 }));
        const frame = { origin: [0, 0, 20] as V, u: [1, 0, 0] as V, v: [0, 1, 0] as V, n: [0, 0, 1] as V };
        const section = sectionCurves(mixed, frame, []);
        expect(section.curves.length).toBeGreaterThan(0);
        expect(section.curves.every((c) => c.kind === 'bezier' || c.kind === 'bspline')).toBe(true);
        // Its outline from the side joins the pieces of one line into one.
        const side = { origin: [0, -30, 0] as V, u: [1, 0, 0] as V, v: [0, 0, 1] as V, n: [0, -1, 0] as V };
        const outline = silhouetteCurves(mixed, side, true);
        expect(kinds(outline.curves)).toEqual(['line', 'line', 'line', 'line']);
    }, SLOW);
});
