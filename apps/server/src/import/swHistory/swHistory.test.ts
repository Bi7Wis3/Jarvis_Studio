import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dir = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const d = mkdtempSync(path.join(os.tmpdir(), 'jarvis-swhistory-test-'));
    process.env.JARVIS_PROJECTS_DIR = d;
    return d;
});

import { DEFAULT_PRINT, DEFAULT_VIEW, type Feature, type Project } from '@jarvis/core';
import { CadKernel } from '../../cad/kernel.js';
import { ProjectStore } from '../../store.js';
import { importIntoProject } from '../project.js';
import { parseSwDocument, type SwDocument } from './format.js';
import { mapPart } from './features.js';
import { assemblyDoc, FIXTURES, plateDoc, ribbedDoc, SketchBuilder, TOP, turnY } from './fixtures.test-helper.js';
import { hasSamples, sample } from '../../testSamples.js';
import { placementOf } from './importHistory.js';
import { conventionFromPlanes, rigidOf } from './math.js';
import { mapSketch } from './sketch.js';

const SLOW = 240_000;
const fixturePath = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const text = (d: SwDocument) => `${JSON.stringify(d, null, 1)}\n`;
const scratch = (): ProjectStore => new ProjectStore({ name: 'History import', parts: [], view: { ...DEFAULT_VIEW } } as Project);

describe('the files the exporter writes', () => {
    it('are the fixtures on disk (WRITE_FIXTURES=1 writes them)', () => {
        for (const [name, make] of Object.entries(FIXTURES)) {
            if (process.env.WRITE_FIXTURES) {
                writeFileSync(fixturePath(name), text(make()));
            }
            expect(readFileSync(fixturePath(name), 'utf8'), name).toBe(text(make()));
        }
    });

    it('refuses what the exporter did not write, and newer formats', () => {
        expect(() => parseSwDocument('{"a": 1}')).toThrow(/not a file written by the SolidWorks history export/);
        expect(() => parseSwDocument('not json')).toThrow(/not a valid/);
        expect(() => parseSwDocument(JSON.stringify({ ...plateDoc(), version: 2 }))).toThrow(/newer version/);
        expect(parseSwDocument(new TextEncoder().encode(`﻿${JSON.stringify(plateDoc())}`)).kind).toBe('part');
    });
});

describe('transforms', () => {
    it('reads the layout of ArrayData from the standard planes', () => {
        const planes = plateDoc().features!.filter((f) => f.type === 'RefPlane').map((f) => f.plane!.transform);
        expect(conventionFromPlanes(planes)).toBe('rows');
        const transposed = planes.map((t) => [t![0], t![3], t![6], t![1], t![4], t![7], t![2], t![5], t![8], ...t!.slice(9)]);
        expect(conventionFromPlanes(transposed)).toBe('columns');
    });

    it('places a component as Part.position and Part.rotation apply it (three.js XYZ Euler, then the move)', () => {
        const t = turnY(90, [100, 0, 0]);
        const { position, rotation } = placementOf(t);
        expect(position).toEqual([100, 0, 0]);
        expect(rotation[1]).toBeCloseTo(90, 9);
        // A point of the part goes where SolidWorks' transform takes it.
        const local: [number, number, number] = [10, 2, 3];
        const m = new Matrix4().compose(new Vector3(...position), new Quaternion().setFromEuler(new Euler(...rotation.map((d) => (d * Math.PI) / 180) as [number, number, number], 'XYZ')), new Vector3(1, 1, 1));
        const placed = new Vector3(...local).applyMatrix4(m);
        const x = rigidOf(t, 'rows')!;
        const want = [0, 1, 2].map((k) => x.r[k][0] * local[0] + x.r[k][1] * local[1] + x.r[k][2] * local[2] + x.t[k]);
        expect([placed.x, placed.y, placed.z].map((v) => Math.round(v * 1e9) / 1e9)).toEqual(want.map((v) => Math.round(v * 1e9) / 1e9));
    });
});

describe('sketches', () => {
    it('keeps the plane, the ids and the relations and dimensions that hold', () => {
        const s = new SketchBuilder();
        const lines = s.rect(0, 0, 60, 40);
        const hole = s.circle(10, 5, 3);
        s.diameter(hole, 6);
        // A relation that does not hold in the geometry is left out rather than moving the sketch when it solves.
        s.relation(4, [{ type: 3, ref: lines[1] }]);
        const m = mapSketch(s.sketch(TOP, [0, 5, 0]), 'rows');
        expect(m.sketch.plane).toBe('top');
        expect(m.sketch.offset).toBe(5);
        const g = m.sketch.geometry!;
        expect(g.curves.map((c) => c.id)).toEqual([...lines, hole.id]);
        expect(g.constraints.map((c) => c.kind)).toEqual(['horizontal', 'vertical', 'horizontal', 'vertical', 'length', 'length', 'diameter']);
        expect(g.constraints.find((c) => c.kind === 'diameter')).toMatchObject({ curve: hole.id, value: 6 });
        expect(m.notes.join()).toMatch(/1 relation was not brought across \(horizontal: it does not hold/);
        // The rectangle outline and the hole inside it: the kernel nests them.
        expect(m.sketch.profiles.map((p) => p.kind).sort()).toEqual(['circle', 'path']);
        expect(m.sketch.regions).toHaveLength(2);
    });

    it('makes an arc counter-clockwise from its start, whichever way SolidWorks ran it', () => {
        const s = new SketchBuilder();
        const c = s.point(0, 0);
        const a = s.point(10, 0);
        const b = s.point(0, 10);
        const sketch = s.sketch(TOP);
        // Clockwise from (0, 10) to (10, 0): the short quarter, 5 pi long.
        sketch.segments.push({ id: 's1_99_0', type: 1, kind: 'arc', construction: false, length: (Math.PI * 10) / 2 * 0.001, start: b, end: a, centre: c, radius: 0.01, dir: -1, circle: false });
        const arc = mapSketch(sketch, 'rows').sketch.geometry!.curves.find((x) => x.id === 's1_99_0')!;
        expect(arc).toMatchObject({ kind: 'arc', start: a, end: b });
    });
});

describe('features', () => {
    it('rebuilds the plate as sketches, an extrude, a cut and a fillet, names and ids kept', () => {
        const m = mapPart(plateDoc());
        expect(m.stop).toBeNull();
        expect(m.features.map((f) => `${f.name}:${f.op}`)).toEqual(['Sketch1:sketch', 'Boss-Extrude1:extrude', 'Sketch2:sketch', 'Cut-Extrude1:extrude', 'Fillet1:fillet']);
        const [, boss, , cut, fillet] = m.features as Extract<Feature, { op: 'extrude' | 'fillet' }>[];
        expect(boss).toMatchObject({ id: 'boss-extrude1', sketchRef: 'sketch1', mode: 'add', direction: 'normal', end: 'blind', distance: 5 });
        // An Instant3D (ICE) feature is a cut by its base type.
        expect(cut).toMatchObject({ mode: 'cut', direction: 'reverse', end: 'throughAll' });
        expect(fillet).toMatchObject({ radius: 2, tangent: true, at: [[-30, 2.5, -20], [30, 2.5, -20], [30, 2.5, 20], [-30, 2.5, 20]] });
    });

    it('keeps SolidWorks folders, closed by their end tags', () => {
        const m = mapPart(FIXTURES['tray.jarvis-sw.json']());
        expect(m.folders).toEqual([{ id: 'folder-shelled', name: 'Shelled', items: ['sketch1', 'boss-extrude1', 'shell1'] }]);
    });

    it('stops at the first feature it cannot rebuild, and says why', () => {
        const m = mapPart(ribbedDoc('plate.SLDPRT', 1));
        expect(m.stop).toMatchObject({ name: 'Rib1', why: 'ribs are not in the studio yet' });
        expect(m.features.map((f) => f.name)).toEqual(['Sketch1', 'Boss-Extrude1', 'Sketch2', 'Cut-Extrude1']);
    });

    it('turns a linear pattern\'s instance transforms into its direction and spacing', () => {
        const pattern = mapPart(FIXTURES['bar.jarvis-sw.json']()).features.find((f) => f.op === 'pattern');
        expect(pattern).toMatchObject({ kind: 'linear', count: 5, spacing: 10, direction: [1, 0, 0], features: ['cut-extrude1'] });
    });
});

describe('import into the project (CAD kernel)', () => {
    let kernel: CadKernel;
    beforeAll(() => {
        kernel = CadKernel.start();
    });
    afterAll(async () => {
        await kernel.close();
        rmSync(dir, { recursive: true, force: true });
    });

    const importFixture = async (store: ProjectStore, name: string, at = fixturePath(name).pathname) => importIntoProject(store, kernel, {
        filename: name, bytes: new Uint8Array(readFileSync(at)), path: at,
    });

    it('rebuilds each fixture part to the volume and box SolidWorks gives', async () => {
        for (const name of ['plate.jarvis-sw.json', 'tube.jarvis-sw.json', 'bar.jarvis-sw.json', 'tray.jarvis-sw.json']) {
            const store = scratch();
            const report = await importFixture(store, name);
            expect(report.text, name).toMatch(/Volume matches SolidWorks to 0.001 %/);
            expect(report.text, name).toMatch(/Bounding box .* matches SolidWorks'/);
            expect(report.text, name).toMatch(/The volume after (each of \d+ rebuilt features|the rebuilt feature) matches SolidWorks'/);
            expect(store.get().parts).toHaveLength(1);
        }
    }, SLOW);

    // One of the owner's parts and its exported history, kept outside the repository (testSamples.ts).
    it.skipIf(!hasSamples('rpm.OLED.mount.SLDPRT', 'rpm.OLED.mount.jarvis-sw.json'))('rebuilds a real part to the solid in its SLDPRT', async () => {
        const sldprt = sample('rpm.OLED.mount.SLDPRT')!;
        const body = await kernel.importFile({ filename: 'rpm.OLED.mount.SLDPRT', bytes: new Uint8Array(readFileSync(sldprt)), options: { up: 'y' } });
        const store = scratch();
        const history = await importFixture(store, 'rpm.OLED.mount.jarvis-sw.json', sample('rpm.OLED.mount.jarvis-sw.json')!);
        expect(history.text).toMatch(/Volume matches SolidWorks to 0.001 %/);
        const props = await kernel.properties(store.get().parts[0], DEFAULT_PRINT);
        expect(Math.abs(props.props!.volume - body.parts[0].volume) / body.parts[0].volume).toBeLessThan(1e-7);
        expect(props.props!.bounds.min.map((v) => Math.round(v * 1e6) / 1e6)).toEqual(body.parts[0].box![0].map((v) => Math.round(v * 1e6) / 1e6));
        expect(props.props!.bounds.max.map((v) => Math.round(v * 1e6) / 1e6)).toEqual(body.parts[0].box![1].map((v) => Math.round(v * 1e6) / 1e6));
    }, SLOW);

    it.skipIf(!hasSamples('button-2015.SLDPRT'))('continues from SolidWorks\' own body (the SLDPRT next to the JSON) where a feature cannot be rebuilt', async () => {
        const folder = join(dir, 'ribbed');
        mkdirSync(folder, { recursive: true });
        copyFileSync(sample('button-2015.SLDPRT')!, join(folder, 'button-2015.SLDPRT'));
        // SolidWorks' volume of the finished part is that of the body in the SLDPRT.
        const body = await kernel.importFile({ filename: 'button-2015.SLDPRT', bytes: new Uint8Array(readFileSync(join(folder, 'button-2015.SLDPRT'))), options: { up: 'y' } });
        const json = join(folder, 'button-2015.jarvis-sw.json');
        writeFileSync(json, JSON.stringify(ribbedDoc('button-2015.SLDPRT', body.parts[0].volume)));
        const store = scratch();
        const report = await importIntoProject(store, kernel, { filename: 'button-2015.jarvis-sw.json', bytes: new Uint8Array(readFileSync(json)), path: json });
        const part = store.get().parts[0];
        expect(part.features!.map((f) => f.name)).toEqual(['Sketch1', 'Boss-Extrude1', 'Sketch2', 'Cut-Extrude1', 'Imported1']);
        expect(part.features!.at(-1)).toMatchObject({ op: 'import', replaceBody: true, file: { name: 'button-2015.SLDPRT', format: 'sldprt' } });
        expect(report.text).toMatch(/Rib1 \(Rib\): ribs are not in the studio yet/);
        expect(report.text).toMatch(/continues with SolidWorks' own body \(Imported1, read from button-2015.SLDPRT\)/);
        expect(report.text).toMatch(/Volume matches SolidWorks to 0.001 %/);
    }, SLOW);

    it('imports an assembly: components placed as in SolidWorks, a part used twice as an instance, mates kept', async () => {
        const folder = join(dir, 'stand');
        mkdirSync(folder, { recursive: true });
        for (const name of ['plate.jarvis-sw.json', 'tube.jarvis-sw.json', 'stand.jarvis-sw.json']) {
            copyFileSync(fixturePath(name), join(folder, name));
        }
        const store = scratch();
        const report = await importFixture(store, 'stand.jarvis-sw.json', join(folder, 'stand.jarvis-sw.json'));
        const parts = store.get().parts;
        expect(parts.map((p) => p.name)).toEqual(['plate-1', 'plate-2', 'tube-1']);
        expect(parts[1].instanceOf).toBe(parts[0].id);
        expect(parts[1].position).toEqual([100, 0, 0]);
        expect(parts[1].rotation[1]).toBeCloseTo(90, 9);
        expect(parts[2].position).toEqual([0, 5, 0]);
        expect(parts[1].position).toEqual([100, 0, 0]);
        // The standard mates arrive as studio mates; the gear mate stays as SolidWorks wrote it.
        const assembly = store.get().assembly!;
        expect(assembly.mates.map((m) => [m.name, m.type, m.alignment, m.value])).toEqual([
            ['Coincident1', 'coincident', 'antiAligned', undefined], ['Parallel1', 'parallel', 'aligned', undefined], ['Distance1', 'distance', 'antiAligned', 5],
        ]);
        expect(assembly.mates[0].refs.map((r) => r.part)).toEqual([parts[0].id, parts[2].id]);
        expect(assembly.mates[0].refs[0].found).toMatchObject({ type: 'plane', normal: [0, 1, 0] });
        expect(assembly.fixed).toEqual([parts[0].id, parts[2].id]);
        expect(store.get().importedMates?.[0]).toMatchObject({ assembly: 'stand.SLDASM', components: { 'plate-1': parts[0].id, 'tube-1': parts[2].id } });
        expect(store.get().importedMates?.[0].mates).toEqual([assemblyDoc().mates![3]]);
        expect(report.text).toMatch(/3 components as 2 parts and 1 instance,/);
        expect(report.text).toMatch(/Total volume matches SolidWorks to 0.001 %/);
        expect(report.text).toMatch(/4 mates in SolidWorks/);
        expect(report.text).toMatch(/3 mates brought in as studio mates \(Coincident1: coincident, Parallel1: parallel, Distance1: distance\); they hold as SolidWorks placed the parts\./);
        expect(report.text).toMatch(/1 mate kept as SolidWorks wrote them, not yet studio mates: GearMate1 \(not a standard mate the studio has yet\)\./);
        expect(report.text).toMatch(/Fixed as in SolidWorks: plate-1, tube-1; floating: plate-2\./);
        expect(existsSync(join(folder, 'stand.jarvis-sw.json'))).toBe(true);
    }, SLOW);
});
