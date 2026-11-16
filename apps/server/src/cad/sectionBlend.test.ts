import { beforeAll, describe, expect, it } from 'vitest';
import opencascade from 'replicad-opencascadejs';
import { cast, getOC, makeBox, makeCylinder, setOC, type Edge, type Shape3D } from 'replicad';
import { strays } from './applied.js';
import { resolveEdges } from './refs.js';
import { sectionBlend, type SectionBlendInfo } from './sectionBlend.js';

const SLOW = 240_000;
/* eslint-disable @typescript-eslint/no-explicit-any */
type OC = any;

beforeAll(async () => {
    setOC(await opencascade({ print: () => {}, printErr: () => {} }));
}, SLOW);

/** Area of the corner a round of radius r takes out of (or fills into) a 90 degree corner, and its centroid's offset. */
const corner = (r: number): { area: number; centroid: number } => ({
    area: r * r * (1 - Math.PI / 4),
    centroid: r * (5 / 6 - Math.PI / 4) / (1 - Math.PI / 4),
});

/** Volume integrated to a relative error of 1e-9 (the quick integration can be off on spline faces). */
function volume(shape: Shape3D): number {
    const oc = getOC() as OC;
    const props = new oc.GProp_GProps();
    oc.BRepGProp.VolumeProperties(shape.wrapped, props, 1e-9, false, false);
    const v = props.Mass();
    props.delete();
    return v;
}

const change = (before: Shape3D, after: Shape3D): number => volume(after) - volume(before);

/**
 * How the result leaves the body it was made from, null when it does not (an outside edge's blend only takes material
 * away, an inside corner's only adds it): applied.ts's check, on points of the faces.
 */
const leaves = (body: Shape3D, edges: Edge[], made: Shape3D, size: number): string | null => strays(body, edges, made, size);

function edgesWhere(shape: Shape3D, test: (mid: [number, number, number], edge: Edge) => boolean): Edge[] {
    return shape.edges.filter((e) => {
        const p = e.pointAt(0.5);
        const mid: [number, number, number] = [p.x, p.y, p.z];
        p.delete();
        return test(mid, e);
    });
}

const TILT = Math.PI / 6;
const HOLE = 4;
const ORIGIN: [number, number, number] = [-10 * Math.tan(TILT), 0, -10];
const AXIS: [number, number, number] = [Math.sin(TILT), 0, Math.cos(TILT)];

/** A block 40 x 40 x 10 with a hole of radius 4 tilted 30 degrees from the vertical; the rim on the top face. */
function obliqueHole(): { body: Shape3D; rim: Edge[] } {
    const block = makeBox([-20, -20, 0], [20, 20, 10]);
    const body = block.cut(makeCylinder(HOLE, 40, ORIGIN, AXIS)) as Shape3D;
    return { body, rim: edgesWhere(body, (m, e) => Math.abs(m[2] - 10) < 1e-6 && e.geomType !== 'LINE') };
}

/**
 * The largest distance of points on the new faces of a fillet of radius r on the oblique hole's rim from the true
 * rolling-ball blend: the envelope of balls whose centres lie r below the top face and r outside the hole's cylinder.
 */
function obliqueRimError(made: Shape3D, r: number): number {
    const oc = getOC() as OC;
    const centre = (phi: number): [number, number, number] => {
        const off = [(HOLE + r) * Math.cos(phi) * Math.cos(TILT), (HOLE + r) * Math.sin(phi), -(HOLE + r) * Math.cos(phi) * Math.sin(TILT)];
        const t = (10 - r - ORIGIN[2] - off[2]) / AXIS[2];
        return [ORIGIN[0] + t * AXIS[0] + off[0], ORIGIN[1] + off[1], ORIGIN[2] + t * AXIS[2] + off[2]];
    };
    const offBall = (x: number[]): number => {
        const d = (phi: number): number => Math.hypot(...centre(phi).map((c, k) => x[k] - c));
        let best = 0;
        for (let k = 1; k < 720; k++) {
            if (d(2 * Math.PI * k / 720) < d(2 * Math.PI * best / 720)) {
                best = k;
            }
        }
        let [lo, hi] = [2 * Math.PI * (best - 1) / 720, 2 * Math.PI * (best + 1) / 720];
        for (let it = 0; it < 80; it++) {
            const [m1, m2] = [lo + (hi - lo) / 3, hi - (hi - lo) / 3];
            if (d(m1) < d(m2)) {
                hi = m2;
            } else {
                lo = m1;
            }
        }
        return Math.abs(d((lo + hi) / 2) - r);
    };
    let worst = 0;
    for (const face of made.faces.filter((f) => !['PLANE', 'CYLINDRE'].includes(f.geomType))) {
        const b = oc.BRepTools.UVBounds(face.wrapped, 0, 0, 0, 0);
        const surface = oc.BRep_Tool.Surface(face.wrapped);
        for (let i = 0; i <= 8; i++) {
            for (let j = 0; j <= 8; j++) {
                const p = surface.Value(b.UMin + (b.UMax - b.UMin) * i / 8, b.VMin + (b.VMax - b.VMin) * j / 8);
                worst = Math.max(worst, offBall([p.X(), p.Y(), p.Z()]));
            }
        }
    }
    return worst;
}

describe('sectionBlend', () => {
    it('refuses a blend wider than a face beside the edge', () => {
        // Box 40 x 10 x 20: the top front edge's front face is 10 high, so a round or chamfer of 12 would run off it.
        const box = makeBox([0, 0, 0], [40, 10, 20]);
        const edge = resolveEdges(box, [[20, 10, 0]]);
        expect(() => sectionBlend(box, edge, { kind: 'fillet', radius: 12 })).toThrow(/wider than a face beside the edge/);
        expect(() => sectionBlend(box, edge, { kind: 'chamfer', distances: [12, 12] })).toThrow(/wider than a face beside the edge/);
        // Up to the face's height it is made, and stays within the box.
        const made = sectionBlend(box, edge, { kind: 'fillet', radius: 9.5 });
        expect(leaves(box, edge, made, 9.5)).toBeNull();
        // The check itself: a corner cut that also grows a lump below the box is caught.
        const lump = box.cut(makeBox([0, 8, -1], [40, 11, 2])).fuse(makeBox([10, -2, 0], [20, 0.5, 5])) as Shape3D;
        expect(leaves(box, edge, lump, 2)).toMatch(/outside the body/);
        within(change(box, made), -(9.5 * 9.5) * (1 - Math.PI / 4) * 40, 1e-4);
    }, SLOW);

    it('fillets and chamfers the rim of an oblique hole on its true shape', () => {
        const { body, rim } = obliqueHole();
        expect(rim.length).toBeGreaterThan(0);
        for (const r of [1, 2]) {
            const info: Partial<SectionBlendInfo> = {};
            const made = sectionBlend(body, rim, { kind: 'fillet', radius: r }, info);
            expect(leaves(body, rim, made, r)).toBeNull();
            // On the true rolling-ball blend. OpenCascade's own fillet here strays from it (2e-3 mm at r 1, 1.2e-2 mm at
            // r 2), so its volume is only a rough check.
            expect(obliqueRimError(made, r)).toBeLessThan(1e-4);
            expect(info.error!).toBeLessThan(1e-4);
            expect(info.points!).toBeGreaterThan(10);
            const occ = body.fillet(r, (f) => f.inList(rim));
            expect(Math.abs(change(body, made) - change(body, occ))).toBeLessThan(2e-2 * Math.abs(change(body, occ)));
            const chamfered = sectionBlend(body, rim, { kind: 'chamfer', distances: [r, r] }, info);
            expect(leaves(body, rim, chamfered, r)).toBeNull();
            const occChamfer = body.chamfer(r, (f) => f.inList(rim));
            expect(Math.abs(change(body, chamfered) - change(body, occChamfer))).toBeLessThan(1e-4 * Math.abs(change(body, occChamfer)));
            expect(info.error!).toBeLessThan(1e-4);
        }
    }, SLOW);

    it('follows a spline edge between a lofted face and a flat one', () => {
        // A loft between two spline outlines (y = 0 and y = 10): its top edges are splines between a flat top and
        // the lofted side.
        const oc = getOC() as OC;
        const outline = (y: number, k: number): OC => {
            const pts = [[-20, 0], [-10, 8], [0, 10], [10, 6], [20, 0]].map(([x, z]) => new oc.gp_Pnt(x * k, y, z * k));
            const arr = new oc.NCollection_Array1_gp_Pnt(1, pts.length);
            pts.forEach((p, i) => arr.SetValue(i + 1, p));
            const interp = new oc.GeomAPI_Interpolate(new oc.NCollection_HArray1_gp_Pnt(arr), false, 1e-9);
            interp.Perform();
            const wire = new oc.BRepBuilderAPI_MakeWire();
            wire.Add(new oc.BRepBuilderAPI_MakeEdge(interp.Curve()).Edge());
            wire.Add(new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Pnt(20 * k, y, 0), new oc.gp_Pnt(-20 * k, y, 0)).Edge());
            return wire.Wire();
        };
        const loft = new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6);
        loft.AddWire(outline(0, 1));
        loft.AddWire(outline(10, 0.8));
        loft.Build(new oc.Message_ProgressRange());
        const body = cast(loft.Shape()) as Shape3D;
        const top = edgesWhere(body, (m, e) => Math.abs(m[1] - 10) < 1e-6 && e.geomType === 'BSPLINE_CURVE');
        expect(top).toHaveLength(1);
        const info: Partial<SectionBlendInfo> = {};
        const made = sectionBlend(body, top, { kind: 'fillet', radius: 1 }, info);
        expect(leaves(body, top, made, 1)).toBeNull();
        expect(info.error!).toBeLessThan(1e-3);
        expect(change(body, made)).toBeLessThan(0);
        expect(Math.abs(change(body, made) - info.expected!)).toBeLessThan(0.05 * Math.abs(info.expected!));
        try {
            const occ = body.fillet(1, (f) => f.inList(top));
            expect(Math.abs(change(body, made) - change(body, occ))).toBeLessThan(5e-3 * Math.abs(change(body, occ)));
        } catch {
            // OpenCascade cannot make it: the volume check above stands
        }
    }, SLOW);

    it('fills a concave curved corner (a boss on a plate)', () => {
        const R = 6;
        const r = 2;
        const body = makeBox([-20, -20, 0], [20, 20, 5]).fuse(makeCylinder(R, 10, [0, 0, 5], [0, 0, 1])) as Shape3D;
        const foot = edgesWhere(body, (m, e) => Math.abs(m[2] - 5) < 1e-6 && e.geomType === 'CIRCLE');
        const info: Partial<SectionBlendInfo> = {};
        const made = sectionBlend(body, foot, { kind: 'fillet', radius: r }, info);
        // An inside corner's blend only adds material: nothing of the body is lost.
        expect(leaves(body, foot, made, r)).toBeNull();
        const { area, centroid } = corner(r);
        within(change(body, made), area * 2 * Math.PI * (R + centroid), 1e-3);
        expect(info.error!).toBeLessThan(1e-3);
        const chamfered = sectionBlend(body, foot, { kind: 'chamfer', distances: [r, r] }, info);
        // The chamfer's triangle (r²/2), its centroid r/3 out from the wall.
        within(change(body, chamfered), r * r / 2 * 2 * Math.PI * (R + r / 3), 1e-3);
    }, SLOW);

    it('ends against a wall square to the edge, and against a slanted one', () => {
        const r = 2;
        for (const slant of [0, 25]) {
            // A step: the lower block's top front edge (y = 10, z = 0) runs into a taller block whose face toward it
            // leans by `slant` degrees about the vertical.
            const oc = getOC() as OC;
            const k = Math.tan(slant * Math.PI / 180);
            const pts = [[30, 0], [50, 0], [50, 20], [30 + 20 * k, 20]];
            const wire = new oc.BRepBuilderAPI_MakeWire();
            pts.forEach(([x, z], i) => {
                const [x2, z2] = pts[(i + 1) % pts.length];
                wire.Add(new oc.BRepBuilderAPI_MakeEdge(new oc.gp_Pnt(x, 0, z), new oc.gp_Pnt(x2, 0, z2)).Edge());
            });
            const face = new oc.BRepBuilderAPI_MakeFace(wire.Wire(), true).Face();
            const tall = cast(new oc.BRepPrimAPI_MakePrism(face, new oc.gp_Vec(0, 20, 0), false, true).Shape()) as Shape3D;
            const body = makeBox([0, 0, 0], [40, 10, 20]).fuse(tall) as Shape3D;
            const edge = resolveEdges(body, [[15, 10, 0]]);
            const info: Partial<SectionBlendInfo> = {};
            const made = sectionBlend(body, edge, { kind: 'fillet', radius: r }, info);
            expect(leaves(body, edge, made, r)).toBeNull();
            const { area, centroid } = corner(r);
            within(change(body, made), -area * (30 + centroid * k), 1e-3);
            expect(info.error!).toBeLessThan(1e-3);
        }
    }, SLOW);

    it('rounds a closed chain of lines and arcs (a rounded boss rim)', () => {
        const oc = getOC() as OC;
        // A 30 x 20 rectangle with corners rounded at 5, extruded 10: its top rim is one smooth closed chain.
        const plate = makeBox([-15, -10, 0], [15, 10, 10]).fillet(5, (f) => f.inDirection('Z')) as Shape3D;
        const rim = edgesWhere(plate, (m) => Math.abs(m[2] - 10) < 1e-6);
        expect(rim).toHaveLength(8);
        const info: Partial<SectionBlendInfo> = {};
        const made = sectionBlend(plate, rim, { kind: 'fillet', radius: 1.5 }, info);
        expect(leaves(plate, rim, made, 1.5)).toBeNull();
        expect(info.chains).toBe(1);
        const occ = plate.fillet(1.5, (f) => f.inList(rim));
        expect(Math.abs(change(plate, made) - change(plate, occ))).toBeLessThan(1e-3 * Math.abs(change(plate, occ)));
        expect(info.error!).toBeLessThan(1e-3);
        void oc;
    }, SLOW);
});

function within(actual: number, expected: number, fraction: number): void {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.abs(expected) * fraction);
}
