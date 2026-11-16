import { readFileSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { readContainer } from './container.js';
import { parseXt } from './xtParse.js';
import { XtModel } from './xtModel.js';
import { blendPatch, curveBuilder, CURVE_TOL, SURFACE_TOL } from './rebuild.js';
import { BlendSurface, ConeSurface, LineCurve, SphereSurface, TorusSurface } from './geometry.js';
import { bodyToBrep } from './brep.js';
import { isValidShape, shapeVolume, solidsFromBrep } from './occ.js';
import { readSldprt } from './readSldprt.js';
import { dist, nurbsEval, nurbsSegment, surfEval, type V3 } from './nurbs.js';
import { boxNodes, cylinderNodes, writeXt, type TestNode } from './xtWriter.test-helper.js';

const SLOW = 120_000;
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** A 2015+ style archive: ZIP local headers with a disguised signature and nibble-swapped names. */
function archive(entries: [string, Uint8Array][]): Uint8Array {
    const sig = [0x0f, 0xba, 0x02, 0x64];
    const parts: Buffer[] = [Buffer.from([0x09, 0x43, 0x24, 0x00, 0, 0, 0, 4])];
    // A decoy with the same tail but another signature, as the real files have.
    parts.push(Buffer.from([1, 2, 3, 4, 0x14, 0, 6, 0, 8, 0, 0, 0, 0, 0, 0xbc, 7, 0, 0, 0xef, 1, 0, 0, 0xde, 3, 0, 0, 3, 0, 0, 0, 0x05, 0x27, 0x56]));
    for (const [name, data] of entries) {
        const packed = deflateRawSync(data);
        const nameBytes = Buffer.from(name, 'latin1').map((x) => ((x >> 4) | (x << 4)) & 0xff);
        const h = Buffer.alloc(26);
        h.set([0x14, 0, 6, 0, 8, 0], 0);
        h.writeUInt32LE(crc32(data), 10);
        h.writeUInt32LE(packed.length, 14);
        h.writeUInt32LE(data.length, 18);
        h.writeUInt16LE(nameBytes.length, 22);
        parts.push(Buffer.from(sig), h, Buffer.from(nameBytes), packed);
    }
    return new Uint8Array(Buffer.concat(parts));
}

describe('containers', () => {
    it('reads the 2015+ archive by its record structure', () => {
        const c = readContainer(archive([['Contents/Config-0-Partition', new Uint8Array([1, 2, 3])], ['PreviewPNG', new Uint8Array(500).fill(7)]]));
        expect(c.kind).toBe('zip2015');
        expect([...c.streams.keys()]).toEqual(['Contents/Config-0-Partition', 'PreviewPNG']);
        expect([...c.streams.get('PreviewPNG')!]).toEqual(new Array(500).fill(7));
    });

    it('reads both real container kinds', () => {
        const ole = readContainer(fixture('ring-ole.SLDPRT'));
        expect(ole.kind).toBe('ole');
        expect(ole.streams.has('Contents/Config-0-Partition')).toBe(true);
        const zip = readContainer(fixture('button-2015.SLDPRT'));
        expect(zip.kind).toBe('zip2015');
        expect(zip.streams.has('Contents/Config-0-Partition')).toBe(true);
        expect(zip.warnings).toEqual([]);
    });
});

describe('Parasolid XT reader', () => {
    it('reads nodes of the base schema with pointers, vectors and chars', () => {
        const xt = parseXt(writeXt(cylinderNodes(0.005, 0.01)));
        expect(xt.modellerVersion).toBe(2700199);
        expect(xt.nodes.size).toBe(22);
        const cyl = xt.nodes.get(20)!;
        expect(xt.types.get(cyl.type)!.name).toBe('CYLINDER');
        expect(cyl.f.radius).toBe(0.005);
        expect(cyl.f.axis).toEqual([0, 0, 1]);
        expect(xt.nodes.get(14)!.f).toMatchObject({ loop: 10, other: 12, edge: 16, sense: '-' });
    });

    it('applies embedded schema changes (copy, delete, insert, append)', () => {
        const nodes: TestNode[] = [
            { type: 29, index: 1, fields: { node_id: 1, pvec: [1, 2, 3], tag: 77 } },
            { type: 29, index: 2, fields: { node_id: 2, pvec: [4, 5, 6], tag: 78 } },
            { type: 30, index: 3, fields: { node_id: 3, sense: '+', start: [7, 8, 9], direction: [0, 0, 1] } },
        ];
        const xt = parseXt(writeXt(nodes, [
            { type: 29, codes: ['C', 'C', 'C', 'C', 'C', 'C', { code: 'A', name: 'tag', type: 'd' }] },
            { type: 30, codes: ['C', 'C', 'C', 'C', 'C', 'C', 'C', 'D', { code: 'I', name: 'start', type: 'v' }, 'C'] },
        ]));
        expect(xt.schema).toBe('SCH_2700199_26105_13006');
        expect(xt.nodes.get(2)!.f).toMatchObject({ pvec: [4, 5, 6], tag: 78 });
        expect(xt.nodes.get(3)!.f.start).toEqual([7, 8, 9]);
        expect(xt.nodes.get(3)!.f.pvec).toBeUndefined();
        expect(xt.nodes.get(3)!.f.direction).toEqual([0, 0, 1]);
    });

    it('reads indices past 32766 in their two-short form', () => {
        const xt = parseXt(writeXt([{ type: 29, index: 40000, fields: { node_id: 1, owner: 70000, pvec: [0, 0, 0] } }]));
        expect(xt.nodes.get(40000)!.f.owner).toBe(70000);
    });
});

describe('geometry', () => {
    it('follows Parasolid parameterisations (cone radius grows along +axis)', () => {
        const cone = new ConeSurface([0, 0, 0], [0, 0, 1], 2, Math.sin(0.3), Math.cos(0.3), [1, 0, 0]);
        const p = cone.eval(0, 4).p;
        expect(p[2]).toBeCloseTo(4, 12);
        expect(p[0]).toBeCloseTo(2 + 4 * Math.tan(0.3), 12);
        const torus = new TorusSurface([0, 0, 0], [0, 0, 1], 10, 2, [1, 0, 0]);
        for (const s of [cone, torus, new SphereSurface([1, 2, 3], 4, [0, 1, 0], [1, 0, 0])]) {
            const e = s.eval(0.7, 0.4);
            const pr = s.project([e.p[0] + 0.01, e.p[1] - 0.02, e.p[2] + 0.005]);
            expect(dist(s.project(pr.p).p, pr.p)).toBeLessThan(1e-10);
        }
    });

    it('cuts the exact piece of a B-spline curve', () => {
        const c = { degree: 3, knots: [0, 0, 0, 0, 1, 2, 3, 3, 3, 3], cw: [[0, 0, 0, 1], [1, 2, 0, 2], [3, 1, 1, 1], [4, 4, 0, 1.5], [6, 2, 2, 1], [7, 0, 0, 1]], rational: true };
        const piece = nurbsSegment(c, 0.4, 2.6);
        for (const t of [0.4, 1, 1.7, 2.6]) {
            expect(dist(nurbsEval(c, t).p, nurbsEval(piece, t).p)).toBeLessThan(1e-12);
        }
    });

    it('turns B-surface, B-curve, SP-curve, offset and swept nodes into evaluators', () => {
        const nodes: TestNode[] = [
            // Bilinear B-surface over the unit square at z = x y (metres), poles v fastest.
            { type: 124, index: 1, fields: { node_id: 1, sense: '+', nurbs: 2 } },
            { type: 126, index: 2, fields: { u_degree: 1, v_degree: 1, n_u_vertices: 2, n_v_vertices: 2, n_u_knots: 2, n_v_knots: 2,
                vertex_dim: 3, bspline_vertices: 3, u_knot_mult: 4, v_knot_mult: 4, u_knots: 5, v_knots: 5 } },
            { type: 45, index: 3, fields: { vertices: [0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1] } },
            { type: 127, index: 4, fields: { mult: [2, 2] } },
            { type: 128, index: 5, fields: { knots: [0, 1] } },
            // An SP-curve along the diagonal of that surface.
            { type: 137, index: 6, fields: { node_id: 6, sense: '+', surface: 1, b_curve: 7 } },
            { type: 134, index: 7, fields: { node_id: 7, sense: '+', nurbs: 8 } },
            { type: 136, index: 8, fields: { degree: 1, n_vertices: 2, vertex_dim: 2, n_knots: 2, bspline_vertices: 9, knot_mult: 4, knots: 5 } },
            { type: 45, index: 9, fields: { vertices: [0, 0, 1, 1] } },
            // An offset of 1 mm and a swept surface of a B-curve section along z.
            { type: 60, index: 10, fields: { node_id: 10, sense: '+', check: 'V', surface: 1, offset: 0.001 } },
            { type: 67, index: 11, fields: { node_id: 11, sense: '+', section: 12, sweep: [0, 0, 1] } },
            { type: 134, index: 12, fields: { node_id: 12, sense: '+', nurbs: 13 } },
            { type: 136, index: 13, fields: { degree: 1, n_vertices: 2, vertex_dim: 3, n_knots: 2, bspline_vertices: 3, knot_mult: 4, knots: 5 } },
        ];
        const m = new XtModel(parseXt(writeXt(nodes)));
        const bs = m.surface(1);
        expect(dist(bs.eval(0.5, 0.5).p, [500, 500, 250])).toBeLessThan(1e-9);
        const sp = m.curve(6);
        expect(dist(sp.eval(0.5).p, [500, 500, 250])).toBeLessThan(1e-9);
        const off = m.surface(10);
        const onBasis = bs.eval(0.25, 0.75);
        const n = off.project(onBasis.p).n;
        expect(dist(off.project(onBasis.p).p, [onBasis.p[0] + n[0], onBasis.p[1] + n[1], onBasis.p[2] + n[2]])).toBeLessThan(1e-9);
        const swept = m.surface(11);
        expect(dist(swept.eval(0.5, 3).p, [0, 500, 3])).toBeLessThan(1e-9);
    });

    it('rebuilds an intersection curve from its chart', () => {
        // Cylinder about z (radius 5 mm) cut by the plane z = x / 2: an ellipse. Chart points in metres.
        const r = 0.005;
        const chart: number[] = [];
        for (let i = 0; i <= 6; i++) {
            const a = (i / 6) * Math.PI;
            chart.push(r * Math.cos(a), r * Math.sin(a), (r * Math.cos(a)) / 2);
        }
        const k = 1 / Math.hypot(1, 0.5);
        const nodes: TestNode[] = [
            { type: 51, index: 1, fields: { node_id: 1, sense: '+', pvec: [0, 0, 0], axis: [0, 0, 1], radius: r, x_axis: [1, 0, 0] } },
            { type: 50, index: 2, fields: { node_id: 2, sense: '+', pvec: [0, 0, 0], normal: [-0.5 * k, 0, k], x_axis: [k, 0, 0.5 * k] } },
            { type: 38, index: 3, fields: { node_id: 3, sense: '+', surface: [1, 2], chart: 4, start: 5, end: 6 } },
            { type: 40, index: 4, fields: { base_parameter: 0, base_scale: 1, chart_count: 7, hvec: chart } },
            { type: 41, index: 5, fields: { type: 'L', hvec: chart.slice(0, 3) } },
            { type: 41, index: 6, fields: { type: 'L', hvec: chart.slice(-3) } },
        ];
        const m = new XtModel(parseXt(writeXt(nodes)));
        m.curveBuilder = curveBuilder;
        const curve = m.curve(3);
        const [a, b] = curve.range;
        for (let i = 0; i <= 50; i++) {
            const p = curve.eval(a + ((b - a) * (i + 0.5)) / 51).p;
            expect(Math.abs(Math.hypot(p[0], p[1]) - 5)).toBeLessThan(CURVE_TOL * 2);
            expect(Math.abs(p[2] - p[0] / 2)).toBeLessThan(CURVE_TOL * 2);
        }
    });

    it('rebuilds a rolling-ball blend face as exact arcs across, within tolerance along', () => {
        // A 2 mm tube about a gently curved spine; the face covers a quarter of it.
        const spine = new LineCurve([0, 0, 0], [0, 1, 0]);
        const blend = new BlendSurface(spine, 2, [null, null]);
        const boundary: V3[] = [];
        for (let i = 0; i <= 10; i++) {
            boundary.push([2, i, 0], [0, i, 2]);
        }
        const patch = blendPatch(blend, boundary);
        expect(patch.error).toBeLessThanOrEqual(SURFACE_TOL);
        const s = patch.surface;
        const [u0, u1] = [s.uKnots[3], s.uKnots[s.uKnots.length - 4]];
        for (const u of [u0, (u0 + u1) / 3, u1]) {
            for (const v of [0, 0.3, 0.5, 1]) {
                const p = surfEval(s, u, v * s.vKnots[s.vKnots.length - 1]).p;
                expect(Math.abs(Math.hypot(p[0], p[2]) - 2)).toBeLessThan(1e-9);
            }
        }
    });
});

describe('to OpenCascade', () => {
    beforeAll(async () => {
        setOC(await opencascade({ print: () => {}, printErr: () => {} }));
    }, SLOW);

    const solidOf = (nodes: TestNode[]): { valid: boolean; volume: number } => {
        const m = new XtModel(parseXt(writeXt(nodes)));
        m.curveBuilder = curveBuilder;
        const result = solidsFromBrep(bodyToBrep(m, m.bodies()[0]).text);
        return { valid: isValidShape(result.shape.wrapped), volume: shapeVolume(result.shape.wrapped) };
    };

    it('builds a closed solid from planes, a cylinder and ring edges', () => {
        const { valid, volume } = solidOf(cylinderNodes(0.005, 0.01));
        expect(valid).toBe(true);
        expect(volume).toBeCloseTo(Math.PI * 25 * 10, 6);
    }, SLOW);

    it('shares vertices and edges, whichever way the edge curves run', () => {
        for (const sense of ['+', '-'] as const) {
            const { valid, volume } = solidOf(boxNodes(0.04, 0.01, 0.02, sense));
            expect(valid).toBe(true);
            expect(volume).toBeCloseTo(40 * 10 * 20, 6);
        }
    }, SLOW);

    it('reads real parts from both container kinds as valid solids', () => {
        const ring = readSldprt(fixture('ring-ole.SLDPRT'));
        expect(ring.bodies).toHaveLength(1);
        expect(isValidShape(ring.bodies[0].shape.wrapped)).toBe(true);
        // The 8 mm ring: 11.2 mm across, 8 mm bore, 5 mm high.
        expect(shapeVolume(ring.bodies[0].shape.wrapped)).toBeCloseTo(Math.PI * (5.6 ** 2 - 4 ** 2) * 5, 4);
        expect(ring.modellerVersion).toBe('22.1.236');
        expect(Buffer.from(ring.thumbnail!.subarray(1, 4)).toString()).toBe('PNG');
        expect(ring.bodies[0].colour).toMatch(/^#[0-9a-f]{6}$/);

        const button = readSldprt(fixture('button-2015.SLDPRT'));
        expect(button.bodies).toHaveLength(1);
        expect(isValidShape(button.bodies[0].shape.wrapped)).toBe(true);
        expect(shapeVolume(button.bodies[0].shape.wrapped)).toBeCloseTo(10.354, 2);
        expect(button.modellerVersion).toBe('27.0.199');
        expect(button.warnings).toEqual([]);
    }, SLOW);
});
