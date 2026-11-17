import { beforeAll, describe, expect, it } from 'vitest';
import { getOC, measureLength, measureVolume, type Wire } from 'replicad';
import { DEFAULT_PRINT, type Feature, type Shape, type Sketch, type Vec3 } from '@jarvis/core';
import { helixDerivatives, helixLength, helixPoint, helixShape, type HelixOptions, type HelixShape } from '@jarvis/core/helix';
import { sketchFrameOf } from '@jarvis/core/reference';
import { buildPartial, initOC, isValid } from './build.js';
import { helixWire } from './helixCurve.js';

const SLOW = 300_000;

beforeAll(async () => {
    await initOC();
}, SLOW);

const empty: Shape = { kind: 'empty' };
// A circle of radius 10 about the Y axis, on the top plane (u = +X, v = -Z).
const ring: Sketch = { plane: 'top', profiles: [{ kind: 'circle', center: [0, 0], radius: 10 }] };
const top = sketchFrameOf(ring, []);
const curve = (o: HelixOptions): HelixShape => helixShape(o, { centre: [0, 0], radius: 10 }, top);
const unit = (v: Vec3): Vec3 => {
    const l = Math.hypot(...v);
    return [v[0] / l, v[1] / l, v[2] / l];
};

/** The wire's edges sampled against the exact curve at the same revolution (an edge's parameter): the largest gap. */
function deviation(wire: Wire, s: HelixShape): { gap: number; edges: number; end: Vec3; kink: number } {
    const oc = getOC();
    let gap = 0;
    let kink = 0;
    let end: Vec3 = [0, 0, 0];
    let last: Vec3 | null = null;
    const edges = wire.edges;
    for (const edge of edges) {
        const c = new oc.BRepAdaptor_Curve(edge.wrapped);
        const [a, b] = [c.FirstParameter(), c.LastParameter()];
        for (let i = 0; i <= 64; i++) {
            const t = a + ((b - a) * i) / 64;
            const p = c.Value(t);
            const q = helixPoint(s, t);
            gap = Math.max(gap, Math.hypot(p.X() - q[0], p.Y() - q[1], p.Z() - q[2]));
            end = [p.X(), p.Y(), p.Z()];
            p.delete();
        }
        // Tangent continuity where edges meet.
        const point = new oc.gp_Pnt();
        const v = new oc.gp_Vec();
        c.D1(a, point, v);
        const first = unit([v.X(), v.Y(), v.Z()]);
        if (last) {
            kink = Math.max(kink, Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]));
        }
        c.D1(b, point, v);
        last = unit([v.X(), v.Y(), v.Z()]);
        point.delete();
        v.delete();
        c.delete();
    }
    return { gap, edges: edges.length, end, kink };
}

describe('helix and spiral curves in the kernel', () => {
    it('builds each Defined by mode within 1e-6 mm, with its height, turns and length', () => {
        const cases: [HelixOptions, number, number][] = [
            [{ definedBy: 'pitchRevolution', pitch: 4, revolutions: 10 }, 40, 10],
            [{ definedBy: 'heightRevolution', height: 30, revolutions: 6.5 }, 30, 6.5],
            [{ definedBy: 'heightPitch', height: 25, pitch: 2 }, 25, 12.5],
        ];
        for (const [o, height, turns] of cases) {
            const s = curve(o);
            const wire = helixWire(s);
            const { gap, edges, end, kink } = deviation(wire, s);
            expect(gap, `${o.definedBy}: largest gap ${gap}`).toBeLessThan(1e-6);
            expect(kink).toBeLessThan(1e-9);
            // One edge a turn.
            expect(edges).toBe(Math.ceil(turns));
            expect(end[1]).toBeCloseTo(height, 9);
            const exact = turns * Math.hypot(2 * Math.PI * 10, height / turns);
            expect(helixLength(s) / exact).toBeCloseTo(1, 12);
            expect(measureLength(wire) / exact).toBeCloseTo(1, 8);
        }
    }, SLOW);

    it('builds a variable pitch helix in one smooth piece per turn and row', () => {
        const s = curve({
            definedBy: 'pitchRevolution',
            variablePitch: [{ pitch: 1.5 }, { pitch: 1.5, revolutions: 1.5 }, { pitch: 5, revolutions: 2.5, diameter: 24 }, { pitch: 5, revolutions: 6 }],
        });
        const wire = helixWire(s);
        const { gap, end, kink } = deviation(wire, s);
        expect(gap).toBeLessThan(1e-6);
        expect(kink).toBeLessThan(1e-9);
        // 1.5 x 1.5 + (1.5 + 5) / 2 + 3.5 x 5 = 23 high, ending at a radius of 12.
        expect(end[1]).toBeCloseTo(23, 9);
        expect(Math.hypot(end[0], end[2])).toBeCloseTo(12, 9);
        expect(measureLength(wire) / helixLength(s)).toBeCloseTo(1, 8);
        // A spring with closed ends swept along it is one valid solid of about the wire's area times the length.
        const table = [{ pitch: 1.5 }, { pitch: 1.5, revolutions: 1 }, { pitch: 4, revolutions: 2 }, { pitch: 4, revolutions: 5 }, { pitch: 1.5, revolutions: 6 }, { pitch: 1.5, revolutions: 7 }];
        const closed = curve({ definedBy: 'pitchRevolution', variablePitch: table });
        const [at, d] = helixDerivatives(closed, 0, 1);
        const spring = buildPartial({ shape: empty, features: [
            { id: 'circle', op: 'sketch', sketch: ring },
            { id: 'helix', op: 'helix', sketchRef: 'circle', definedBy: 'pitchRevolution', variablePitch: table },
            { id: 'wire', op: 'sketch', sketch: { plane: { origin: at, normal: unit(d), xDir: [1, 0, 0] }, profiles: [{ kind: 'circle', center: [0, 0], radius: 0.6 }] } },
            { id: 'spring', op: 'sweep', mode: 'add', profile: { sketchRef: 'wire' }, path: { curveRef: 'helix' } },
        ] }, DEFAULT_PRINT);
        expect(spring.error).toBeNull();
        expect(spring.shape!.solids.length).toBe(1);
        expect(isValid(spring.shape!)).toBe(true);
        expect(Math.abs(measureVolume(spring.shape!) / (Math.PI * 0.36 * helixLength(closed)) - 1)).toBeLessThan(2e-3);
    }, SLOW);

    it('builds a tapered helix and a spiral', () => {
        const cone = curve({ definedBy: 'pitchRevolution', pitch: 5, revolutions: 3, taper: 12, taperOutward: true });
        const coneWire = helixWire(cone);
        const c = deviation(coneWire, cone);
        expect(c.gap).toBeLessThan(1e-6);
        expect(Math.hypot(c.end[0], c.end[2])).toBeCloseTo(10 + 15 * Math.tan((12 * Math.PI) / 180), 9);
        expect(measureLength(coneWire) / helixLength(cone)).toBeCloseTo(1, 8);

        const spiral = curve({ definedBy: 'spiral', pitch: 3, revolutions: 4.25, reverse: false });
        const spiralWire = helixWire(spiral);
        const p = deviation(spiralWire, spiral);
        expect(p.gap).toBeLessThan(1e-6);
        expect(p.end[1]).toBeCloseTo(0, 12);
        expect(Math.hypot(p.end[0], p.end[2])).toBeCloseTo(10 + 3 * 4.25, 9);
        expect(measureLength(spiralWire) / helixLength(spiral)).toBeCloseTo(1, 8);
        const box = spiralWire.boundingBox;
        // Flat in the sketch plane.
        expect(Math.abs(box.bounds[0][1]) + Math.abs(box.bounds[1][1])).toBeLessThan(1e-6);
    }, SLOW);

    it('starts at the start angle and turns in the direction set', () => {
        // 90 degrees from u (+X) towards v (-Z) is -Z; a quarter turn clockwise (seen from above) brings it back to +X.
        const s = curve({ definedBy: 'pitchRevolution', pitch: 8, revolutions: 2, startAngle: 90, clockwise: true });
        const wire = helixWire(s);
        const start = wire.startPoint;
        [start.x, start.y, start.z].forEach((n, i) => expect(n).toBeCloseTo([0, 0, -10][i], 9));
        const oc = getOC();
        const c = new oc.BRepAdaptor_Curve(wire.edges[0].wrapped);
        const q = c.Value(0.25);
        expect(q.X()).toBeCloseTo(10, 9);
        expect(q.Y()).toBeCloseTo(2, 9);
        expect(q.Z()).toBeCloseTo(0, 9);
        q.delete();
        c.delete();
        // Counterclockwise and reversed: the quarter turn goes to -X, below the sketch.
        const r = curve({ definedBy: 'pitchRevolution', pitch: 8, revolutions: 2, startAngle: 90, reverse: true });
        const quarter = helixPoint(r, 0.25);
        expect(quarter[0]).toBeCloseTo(-10, 9);
        expect(quarter[1]).toBeCloseTo(-2, 9);
        expect(deviation(helixWire(r), r).gap).toBeLessThan(1e-6);
    }, SLOW);

    it('sweeps a spring along a helix step: one valid solid, wire area x helix length', () => {
        const pitch = 6;
        const turns = 8;
        const s = curve({ definedBy: 'pitchRevolution', pitch, revolutions: turns });
        // The wire's profile square to the helix at its start (as a plane normal to the curve there).
        const [at, d] = helixDerivatives(s, 0, 1);
        const features: Feature[] = [
            { id: 'circle', op: 'sketch', sketch: ring },
            { id: 'helix', op: 'helix', sketchRef: 'circle', definedBy: 'pitchRevolution', pitch, revolutions: turns },
            { id: 'wire', op: 'sketch', sketch: { plane: { origin: at, normal: unit(d), xDir: [1, 0, 0] }, profiles: [{ kind: 'circle', center: [0, 0], radius: 1 }] } },
            { id: 'spring', op: 'sweep', mode: 'add', profile: { sketchRef: 'wire' }, path: { curveRef: 'helix' } },
        ];
        const built = buildPartial({ shape: empty, features }, DEFAULT_PRINT);
        expect(built.error).toBeNull();
        expect(built.shape!.solids.length).toBe(1);
        expect(isValid(built.shape!)).toBe(true);
        const length = turns * Math.hypot(2 * Math.PI * 10, pitch);
        expect(Math.abs(measureVolume(built.shape!) / (Math.PI * length) - 1)).toBeLessThan(1e-3);
        // A circular profile follows it too.
        const rod = buildPartial({ shape: empty, features: [...features.slice(0, 2), { id: 'rod', op: 'sweep', mode: 'add', diameter: 2, path: { curveRef: 'helix' } }] }, DEFAULT_PRINT);
        expect(rod.error).toBeNull();
        expect(Math.abs(measureVolume(rod.shape!) / (Math.PI * length) - 1)).toBeLessThan(1e-3);
        // As in SolidWorks: the wire sketched on the Front plane (through the axis) at the start of a clockwise helix.
        // Kept at its angle to the axis it moves by a screw motion: area x the turns of its centre (no twisting).
        const axial = buildPartial({ shape: empty, features: [
            features[0],
            { id: 'helix', op: 'helix', sketchRef: 'circle', definedBy: 'heightRevolution', height: pitch * turns, revolutions: turns, clockwise: true },
            { id: 'wire', op: 'sketch', sketch: { plane: 'front', profiles: [{ kind: 'circle', center: [10, 0], radius: 1 }] } },
            { id: 'spring', op: 'sweep', mode: 'add', profile: { sketchRef: 'wire' }, path: { curveRef: 'helix' } },
        ] }, DEFAULT_PRINT);
        expect(axial.error).toBeNull();
        expect(isValid(axial.shape!)).toBe(true);
        expect(Math.abs(measureVolume(axial.shape!) / (Math.PI * 2 * Math.PI * 10 * turns) - 1)).toBeLessThan(1e-3);
    }, SLOW);

    it('sweeps a flat spiral spring along a spiral step', () => {
        const spiral = curve({ definedBy: 'spiral', pitch: 3, revolutions: 4 });
        const [at, d] = helixDerivatives(spiral, 0, 1);
        const built = buildPartial({ shape: empty, features: [
            { id: 'circle', op: 'sketch', sketch: ring },
            { id: 'spiral', op: 'helix', sketchRef: 'circle', definedBy: 'spiral', pitch: 3, revolutions: 4 },
            { id: 'strip', op: 'sketch', sketch: { plane: { origin: at, normal: unit(d), xDir: [0, 1, 0] }, profiles: [{ kind: 'rect', center: [0, 0], width: 4, height: 0.5 }] } },
            { id: 'spring', op: 'sweep', mode: 'add', profile: { sketchRef: 'strip' }, path: { curveRef: 'spiral' } },
        ] }, DEFAULT_PRINT);
        expect(built.error).toBeNull();
        expect(built.shape!.solids.length).toBe(1);
        expect(isValid(built.shape!)).toBe(true);
        expect(Math.abs(measureVolume(built.shape!) / (2 * helixLength(spiral)) - 1)).toBeLessThan(1e-3);
    }, SLOW);

    it('names a helix step that cannot be made, and a sweep along a missing curve', () => {
        const bad = buildPartial({ shape: empty, features: [
            { id: 'circle', op: 'sketch', sketch: ring },
            { id: 'h', name: 'Helix/Spiral1', op: 'helix', sketchRef: 'circle', definedBy: 'spiral', pitch: 4, revolutions: 3, reverse: true },
        ] }, DEFAULT_PRINT);
        expect(bad.error).toMatch(/^feature "Helix\/Spiral1" \(helix\): the spiral runs into its centre/);
        const missing = buildPartial({ shape: empty, features: [
            { id: 's', op: 'sweep', mode: 'add', diameter: 1, path: { curveRef: 'nothing' } },
        ] }, DEFAULT_PRINT);
        expect(missing.error).toMatch(/curve "nothing" not found/);
    }, SLOW);

    it('still builds an older project\'s inline helix sweep the same', () => {
        const coil = buildPartial({ shape: empty, features: [{
            id: 'coil', op: 'sweep', mode: 'add', profile: { sketch: { plane: 'front', profiles: [{ kind: 'circle', center: [8, 0], radius: 1 }] } },
            path: { helix: { axis: 'y', pitch: 4, turns: 10 } },
        }] }, DEFAULT_PRINT);
        expect(coil.error).toBeNull();
        // The volume the kernel gave before helix steps existed (baseline 54f126f).
        expect(measureVolume(coil.shape!) / 1579.1362934014896).toBeCloseTo(1, 9);
    }, SLOW);
});

describe('a spring drawn on a plane perpendicular to its helix', () => {
    // Circle sketch, helix, a plane Perpendicular to the helix and Coincident with its start, the wire sketched on it
    // with its centre where the helix pierces the plane (the plane's origin), a sweep, and a point on the helix's end.
    const flow = (pitch: number, radius: number): Feature[] => [
        { id: 'ring', op: 'sketch', sketch: { plane: 'top', profiles: [{ kind: 'circle', center: [0, 0], radius }] } },
        { id: 'coil', op: 'helix', sketchRef: 'ring', definedBy: 'pitchRevolution', pitch, revolutions: 6, clockwise: true },
        { id: 'square', op: 'plane', definition: { kind: 'curveNormal', curve: { curveRef: 'coil' }, point: { curveRef: 'coil', at: 'start' } } },
        { id: 'wire', op: 'sketch', sketch: { plane: { planeRef: 'square' }, profiles: [{ kind: 'circle', center: [0, 0], radius: 1 }] } },
        { id: 'spring', op: 'sweep', mode: 'add', profile: { sketchRef: 'wire' }, path: { curveRef: 'coil' } },
        { id: 'tip', op: 'point', position: [0, 0, 0], definition: { kind: 'onCurve', curve: { curveRef: 'coil', at: 'end' } } },
    ];

    it('is one valid solid of the wire area times the helix length, and still is after the pitch and diameter change', () => {
        for (const [pitch, radius] of [[5, 10], [8, 14]]) {
            const built = buildPartial({ shape: empty, features: flow(pitch, radius) }, DEFAULT_PRINT);
            expect(built.error).toBeNull();
            expect(built.shape!.solids.length).toBe(1);
            expect(isValid(built.shape!)).toBe(true);
            const length = 6 * Math.hypot(2 * Math.PI * radius, pitch);
            expect(Math.abs(measureVolume(built.shape!) / (Math.PI * length) - 1), `pitch ${pitch}, radius ${radius}`).toBeLessThan(1e-3);
            // The point on the helix's end is where the curve ends now.
            const tip = built.followed?.tip;
            expect(tip?.op === 'point' && tip.position.map((c) => Math.round(c * 1e9) / 1e9 + 0)).toEqual([radius, 6 * pitch, 0]);
        }
    }, SLOW);
});
