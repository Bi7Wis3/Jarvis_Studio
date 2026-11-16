import { readFileSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dir = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const d = mkdtempSync(path.join(os.tmpdir(), 'jarvis-iges-test-'));
    process.env.JARVIS_PROJECTS_DIR = d;
    return d;
});

import opencascade from 'replicad-opencascadejs';
import { getOC, setOC, type Shape3D } from 'replicad';
import { runImport } from '../job.js';
import { importerFor } from '../registry.js';
import { isValidShape } from '../solids.js';
import type { ImportResult } from '../types.js';
import { boxFaces, IgesBuilder, type V3 } from './igesWriter.test-helper.js';
import { parseIges, splitParams } from './parse.js';
import { readIges } from './readIges.js';

const SLOW = 120_000;
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

beforeAll(async () => {
    setOC(await opencascade({ print: () => {}, printErr: () => {} }));
}, SLOW);

afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

/** Volumes by adaptive integration: the default fixed-order one is off by up to 1% on rational B-spline faces. */
const volumeOf = (shape: Shape3D): number => {
    const oc = getOC();
    const props = new oc.GProp_GProps();
    oc.BRepGProp.VolumePropertiesGK(shape.wrapped, props, 1e-9, false, true, false, false, false);
    const v = props.Mass();
    props.delete();
    return v;
};
const volumes = (r: ImportResult): number[] => r.bodies.map((b) => volumeOf(b.shape as Shape3D));
const allValid = (r: ImportResult): boolean => r.bodies.every((b) => isValidShape((b.shape as Shape3D).wrapped));

/** A box of trimmed planes bounded by lines. */
function box(b: IgesBuilder, w: number, d: number, h: number, at: V3 = [0, 0, 0], color?: number): number[] {
    return boxFaces(w, d, h, at).map((f) => b.planarFace(f, color));
}

describe('IGES file sections', () => {
    it('splits parameters at the delimiters and reads Hollerith strings whole', () => {
        expect(splitParams('110,1.,2.5D1,-3E-2;', ',', ';')).toEqual([110, 1, 25, -0.03]);
        expect(splitParams('406,1,5Ha,b;c,;', ',', ';')).toEqual([406, 1, 'a,b;c', null]);
        expect(splitParams('1#2##3!', '#', '!')).toEqual([1, 2, null, 3]);
    });

    it('reads the global section: delimiters, unit and scale; directory entries and their parameters', () => {
        const b = new IgesBuilder();
        const m = b.matrix([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 5]);
        b.add({ type: 110, params: [0, 0, 0, 1, 2, 3], xform: m, color: 2, status: '01010000' });
        const file = parseIges(b.toBytes({ unit: [1, 'IN'], scale: 0.5, system: 'Some CAD' }));
        expect(file.global.unitMm).toBe(25.4);
        expect(file.global.scale).toBe(0.5);
        expect(file.global.system).toBe('Some CAD');
        const line = file.entities.get(3)!;
        expect(line).toMatchObject({ type: 110, xform: 1, color: 2, blank: true, subordinate: 1, use: 0, params: [0, 0, 0, 1, 2, 3] });
    });

    it('refuses what is not an IGES file', () => {
        expect(() => readIges(new TextEncoder().encode('solid cube\nendsolid\n'), {})).toThrow(/not an IGES file/);
    });
});

describe('IGES trimmed surfaces to solids', () => {
    it('knits a box of trimmed planes (lines, composite curves, a polyline, a transformed face) into one solid', () => {
        const b = new IgesBuilder();
        const faces = boxFaces(10, 20, 30);
        for (const f of faces.slice(0, 4)) {
            b.planarFace(f);
        }
        // A face bounded by a closed polyline (copious data).
        const pl = b.plane([-1, 0, 0], 0);
        b.trimmed(pl, b.curveOnSurface(pl, b.polyline([...faces[4], faces[4][0]])));
        // A face drawn in the XY plane and turned into x = 10 by its transformation matrix.
        const turn = b.matrix([0, 0, 1, 1, 0, 0, 0, 1, 0], [10, 0, 0]);
        const local: V3[] = [[0, 0, 0], [20, 0, 0], [20, 30, 0], [0, 30, 0]];
        const p = b.plane([0, 0, 1], 0);
        const loop = b.composite(local.map((q, i) => b.line(q, local[(i + 1) % 4])));
        b.add({ type: 144, params: [p, 1, 0, b.curveOnSurface(p, loop)], xform: turn });
        // Loose geometry that is not imported.
        b.line([50, 0, 0], [60, 0, 0]);
        b.point([70, 0, 0]);
        b.add({ type: 212, params: [0] });
        const r = readIges(b.toBytes(), {});
        expect(r.bodies).toHaveLength(1);
        expect(allValid(r)).toBe(true);
        expect(volumes(r)[0]).toBeCloseTo(6000, 6);
        expect(r.warnings).toContain('2 free curves and points left out: curves and points in the file are not imported');
        expect(r.warnings.join(' ')).toContain('1 of type 212');
    }, SLOW);

    it('reads inches as millimetres', () => {
        const b = new IgesBuilder();
        box(b, 1, 1, 1);
        const r = readIges(b.toBytes({ unit: [1, 'IN'] }), {});
        expect(volumes(r)[0]).toBeCloseTo(25.4 ** 3, 4);
    }, SLOW);

    it('makes a cylinder of a surface of revolution with transformed arcs, and takes the faces\' colour', () => {
        const b = new IgesBuilder();
        const red = b.add({ type: 314, params: [100, 0, 0, ''] });
        // Axis along z through the origin; generatrix the line x = 5 from z = 0 to z = 12.
        const axis = b.line([0, 0, 0], [0, 0, 1]);
        const gen = b.line([5, 0, 0], [5, 0, 12]);
        const rev = b.add({ type: 120, params: [axis, gen, 0, 2 * Math.PI] });
        // The top circle runs the other way (its matrix turns it over), as a face's boundary does.
        const top = b.matrix([1, 0, 0, 0, -1, 0, 0, 0, -1], [0, 0, 12]);
        const bottomCircle = b.arc(0, [0, 0], [5, 0], [5, 0]);
        const topCircle = b.arc(0, [0, 0], [5, 0], [5, 0], top);
        const up = b.line([5, 0, 0], [5, 0, 12]);
        const down = b.line([5, 0, 12], [5, 0, 0]);
        b.trimmed(rev, b.curveOnSurface(rev, b.composite([bottomCircle, up, topCircle, down])), [], -red);
        const p0 = b.plane([0, 0, -1], 0);
        b.trimmed(p0, b.curveOnSurface(p0, b.arc(0, [0, 0], [5, 0], [5, 0])), [], -red);
        const p1 = b.plane([0, 0, 1], 12);
        b.trimmed(p1, b.curveOnSurface(p1, b.arc(12, [0, 0], [5, 0], [5, 0])), [], -red);
        const r = readIges(b.toBytes(), {});
        expect(r.bodies).toHaveLength(1);
        expect(allValid(r)).toBe(true);
        expect(volumes(r)[0]).toBeCloseTo(Math.PI * 25 * 12, 6);
        expect(r.bodies[0].color).toBe('#ff0000');
    }, SLOW);

    it('makes an elliptic cylinder of a tabulated cylinder along a conic arc', () => {
        const b = new IgesBuilder();
        // x^2 + 4 y^2 = 36: semi-axes 6 and 3; full ellipse from (6, 0).
        const ellipse = (zt: number, xform?: number): number => b.add({ type: 104, form: 1, params: [1, 0, 4, 0, 0, -36, zt, 6, 0, 6, 0], xform });
        const tab = b.add({ type: 122, params: [ellipse(0), 6, 0, 5] });
        const over = b.matrix([1, 0, 0, 0, -1, 0, 0, 0, -1], [0, 0, 5]);
        const side = b.composite([ellipse(0), b.line([6, 0, 0], [6, 0, 5]), ellipse(0, over), b.line([6, 0, 5], [6, 0, 0])]);
        b.trimmed(tab, b.curveOnSurface(tab, side));
        const p0 = b.plane([0, 0, 1], 0);
        b.trimmed(p0, b.curveOnSurface(p0, ellipse(0)));
        const p1 = b.plane([0, 0, 1], 5);
        b.trimmed(p1, b.curveOnSurface(p1, ellipse(5)));
        const r = readIges(b.toBytes(), {});
        expect(allValid(r)).toBe(true);
        expect(volumes(r)[0]).toBeCloseTo(Math.PI * 6 * 3 * 5, 5);
    }, SLOW);

    it('makes a cone frustum of a ruled surface between two circles', () => {
        const b = new IgesBuilder();
        const c0 = b.arc(0, [0, 0], [5, 0], [5, 0]);
        const c1 = b.arc(8, [0, 0], [2, 0], [2, 0]);
        const ruled = b.add({ type: 118, form: 1, params: [c0, c1, 0, 0] });
        const back = b.arc(0, [0, 0], [2, 0], [2, 0], b.matrix([1, 0, 0, 0, -1, 0, 0, 0, -1], [0, 0, 8]));
        b.trimmed(ruled, b.curveOnSurface(ruled, b.composite([c0, b.line([5, 0, 0], [2, 0, 8]), back, b.line([2, 0, 8], [5, 0, 0])])));
        const p0 = b.plane([0, 0, 1], 0);
        b.trimmed(p0, b.curveOnSurface(p0, c0));
        const p1 = b.plane([0, 0, 1], 8);
        b.trimmed(p1, b.curveOnSurface(p1, c1));
        const r = readIges(b.toBytes(), {});
        expect(allValid(r)).toBe(true);
        expect(volumes(r)[0]).toBeCloseTo((Math.PI * 8 * (25 + 10 + 4)) / 3, 4);
    }, SLOW);

    it('reads parametric spline curves (112) and surfaces (114)', () => {
        const b = new IgesBuilder();
        const faces = boxFaces(10, 10, 10);
        for (const f of faces.slice(1)) {
            b.planarFace(f);
        }
        // The bottom: X = 10 s, Y = 10 t, Z = 0 over one bicubic patch, bounded by four linear spline segments.
        const coef = (a: number, bs: number, et: number): number[] => [a, bs, 0, 0, et, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        const surf = b.add({ type: 114, params: [3, 1, 1, 1, 0, 1, 0, 1, ...coef(0, 10, 0), ...coef(0, 0, 10), ...coef(0, 0, 0)] });
        const corners: V3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
        const segs = corners.flatMap((p, i) => {
            const q = corners[(i + 1) % 4];
            return [0, 1, 2].flatMap((k) => [p[k], q[k] - p[k], 0, 0]);
        });
        const spline = b.add({ type: 112, params: [1, 0, 3, 4, 0, 1, 2, 3, 4, ...segs, ...new Array(12).fill(0)] });
        b.trimmed(surf, b.curveOnSurface(surf, spline));
        const r = readIges(b.toBytes(), {});
        expect(allValid(r)).toBe(true);
        expect(volumes(r)[0]).toBeCloseTo(1000, 6);
    }, SLOW);

    it('bounds untrimmed B-spline surfaces by their own parameter range', () => {
        const b = new IgesBuilder();
        for (const [p00, p10, p11, p01] of boxFaces(10, 10, 10)) {
            b.bilinear(p00, p10, p01, p11);
        }
        const r = readIges(b.toBytes(), {});
        expect(allValid(r)).toBe(true);
        expect(volumes(r)[0]).toBeCloseTo(1000, 6);
    }, SLOW);

    it('trims by parameter-space curves when a boundary has no model-space curve', () => {
        const b = new IgesBuilder();
        for (const [p00, p10, p11, p01] of boxFaces(10, 10, 10)) {
            const s = b.bilinear(p00, p10, p01, p11);
            const uv: V3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
            const loop = b.composite(uv.map((q, i) => b.bline(q, uv[(i + 1) % 4])));
            b.trimmed(s, b.curveOnSurface(s, 0, loop));
        }
        const r = readIges(b.toBytes(), {});
        expect(allValid(r)).toBe(true);
        expect(volumes(r)[0]).toBeCloseTo(1000, 4);
        expect(r.warnings.join(' ')).toContain('6 faces had only parameter-space trimming curves');
    }, SLOW);

    it('trims a surface of revolution by parameter-space curves: (generatrix parameter, angle)', () => {
        const b = new IgesBuilder();
        const axis = b.line([0, 0, 0], [0, 0, 1]);
        const gen = b.line([5, 0, 0], [5, 0, 12]);
        const rev = b.add({ type: 120, params: [axis, gen, 0, 2 * Math.PI] });
        for (const [a0, a1] of [[0, Math.PI], [Math.PI, 2 * Math.PI]]) {
            const uv: V3[] = [[0, a0, 0], [1, a0, 0], [1, a1, 0], [0, a1, 0]];
            b.trimmed(rev, b.curveOnSurface(rev, 0, b.composite(uv.map((q, i) => b.bline(q, uv[(i + 1) % 4])))));
        }
        const p0 = b.plane([0, 0, -1], 0);
        b.trimmed(p0, b.curveOnSurface(p0, b.arc(0, [0, 0], [5, 0], [5, 0])));
        const p1 = b.plane([0, 0, 1], 12);
        b.trimmed(p1, b.curveOnSurface(p1, b.arc(12, [0, 0], [5, 0], [5, 0])));
        const r = readIges(b.toBytes(), {});
        expect(allValid(r)).toBe(true);
        expect(volumes(r)[0]).toBeCloseTo(Math.PI * 25 * 12, 4);
    }, SLOW);

    it('reads bounded surfaces (143) with boundaries of reversed curves (141)', () => {
        const b = new IgesBuilder();
        const faces = boxFaces(10, 10, 10);
        for (const f of faces.slice(1)) {
            b.planarFace(f);
        }
        const plane = b.plane([0, 0, 1], 0);
        const c = faces[0];
        const curves = c.map((p, i) => (i === 1 ? [b.line(c[2], p), 2] : [b.line(p, c[(i + 1) % 4]), 1]));
        const boundary = b.add({ type: 141, params: [0, 2, plane, 4, ...curves.flatMap(([d, sense]) => [d, sense, 0])] });
        b.add({ type: 143, params: [0, plane, 1, boundary] });
        const r = readIges(b.toBytes(), {});
        expect(allValid(r)).toBe(true);
        expect(volumes(r)[0]).toBeCloseTo(1000, 6);
    }, SLOW);

    it('places subfigure instances (308, 408), named after their definition', () => {
        const b = new IgesBuilder();
        const faces = box(b, 10, 10, 10);
        const def = b.add({ type: 308, params: [0, 'Cube', faces.length, ...faces], status: '00000200' });
        b.add({ type: 408, params: [def, 0, 0, 0, 1] });
        b.add({ type: 408, params: [def, 50, 0, 0, 2] });
        const r = readIges(b.toBytes(), {});
        expect(r.bodies.map((x) => x.name)).toEqual(['Cube', 'Cube']);
        expect(volumes(r).map((v) => Math.round(v))).toEqual([1000, 8000]);
        const box2 = (r.bodies[1].shape as Shape3D).boundingBox;
        expect(box2.bounds[0][0]).toBeCloseTo(50, 6);
        expect(box2.bounds[1][0]).toBeCloseTo(70, 6);
    }, SLOW);

    it('places a mirrored subfigure instance as a proper solid', () => {
        const b = new IgesBuilder();
        const faces = box(b, 10, 20, 30);
        const def = b.add({ type: 308, params: [0, 'Block', faces.length, ...faces], status: '00000200' });
        const mirror = b.matrix([-1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0], 1);
        b.add({ type: 408, params: [def, 0, 0, 0, 1], xform: mirror });
        const r = readIges(b.toBytes(), {});
        expect(allValid(r)).toBe(true);
        expect(volumes(r)[0]).toBeCloseTo(6000, 6);
        const bounds = (r.bodies[0].shape as Shape3D).boundingBox.bounds;
        expect(bounds[0][0]).toBeCloseTo(-10, 6);
        expect(bounds[1][0]).toBeCloseTo(0, 6);
    }, SLOW);

    it('leaves out surfaces that do not close, as STEP does, and says why nothing came in', () => {
        const b = new IgesBuilder();
        boxFaces(10, 10, 10).slice(1).forEach((f) => b.planarFace(f));
        expect(() => readIges(b.toBytes(), {})).toThrow(/nothing came in as a solid body.*1 surface body could not be knitted closed/);
        const c = new IgesBuilder();
        box(c, 10, 10, 10);
        expect(() => readIges(c.toBytes(), { knit: false })).toThrow(/6 surfaces left out/);
    }, SLOW);
});

describe('IGES files from another CAD system (FreeCAD, OpenCascade\'s IGES writer)', () => {
    it('reads trimmed surfaces: a plate with a hole and a revolved B-spline profile', () => {
        const holed = readIges(fixture('freecad-faces-holed.igs'), {});
        expect(allValid(holed)).toBe(true);
        expect(volumes(holed)[0]).toBeCloseTo(10869.026644707676, 5);
        const revolved = readIges(fixture('freecad-faces-revolved.igs'), {});
        expect(allValid(revolved)).toBe(true);
        expect(volumes(revolved)[0]).toBeCloseTo(2345.350740515253, 4);
    }, SLOW);

    it('reads manifold solid B-rep objects (186): a revolved profile and a torus', () => {
        const revolved = readIges(fixture('freecad-solid-revolved.igs'), {});
        expect(revolved.bodies).toHaveLength(1);
        expect(allValid(revolved)).toBe(true);
        expect(volumes(revolved)[0]).toBeCloseTo(2345.350740515253, 4);
        const torus = readIges(fixture('freecad-solid-torus.igs'), {});
        expect(allValid(torus)).toBe(true);
        expect(volumes(torus)[0]).toBeCloseTo(2 * Math.PI ** 2 * 10 * 9, 4);
    }, SLOW);
});

describe('IGES import job', () => {
    it('is registered for .igs and .iges and runs through the import job, Z up turned to Y up', async () => {
        expect(importerFor('part.IGS')?.format).toBe('iges');
        expect(importerFor('part.iges')?.format).toBe('iges');
        const b = new IgesBuilder();
        box(b, 10, 20, 30);
        box(b, 5, 5, 5, [40, 0, 0]);
        const job = await runImport({ filename: 'two.igs', bytes: b.toBytes(), options: { up: 'z' } });
        expect(job.format).toBe('iges');
        expect(job.parts).toHaveLength(1);
        expect(job.parts[0].solids).toBe(2);
        expect(job.parts[0].volume).toBeCloseTo(6125, 6);
        // Z up to Y up: the 30 mm height lies along y.
        expect(job.parts[0].box![1][1] - job.parts[0].box![0][1]).toBeCloseTo(30, 6);
        const apart = await runImport({ filename: 'two.igs', bytes: b.toBytes(), options: { bodiesAsParts: true } });
        expect(apart.parts.map((p) => Math.round(p.volume)).sort((a, b) => a - b)).toEqual([125, 6000]);
    }, SLOW);
});
