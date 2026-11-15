import { beforeAll, describe, expect, it } from 'vitest';
import type { Sketch } from '@jarvis/core';
import { layoutText, outlineProfiles, polylinePath, type FontGlyphs, type FontStyle } from '@jarvis/core/text';
import { fontGlyphs, listFonts } from '../fonts.js';

const SLOW = 120_000;

describe('sketch text in the kernel', () => {
    // Built here directly (not through the kernel worker) to check the exact solids.
    let build: typeof import('./sketch.js');
    let r: typeof import('replicad');

    beforeAll(async () => {
        r = await import('replicad');
        const oc = (await import('replicad-opencascadejs')).default;
        r.setOC(await oc({ print: () => {}, printErr: () => {} }));
        build = await import('./sketch.js');
    }, SLOW);

    const valid = (shape: import('replicad').Shape3D): boolean => {
        const analyzer = new (r.getOC().BRepCheck_Analyzer)(shape.wrapped, true, false);
        const ok = analyzer.IsValid();
        analyzer.delete();
        return ok;
    };
    const exactVolume = (shape: import('replicad').Shape3D): number => {
        const props = new (r.getOC().GProp_GProps)();
        r.getOC().BRepGProp.VolumePropertiesGK(shape.wrapped, props, 1e-10, false, true, false, false, false);
        const v = props.Mass();
        props.delete();
        return v;
    };
    const fonts = (family: string, text: string, styles: FontStyle[] = ['regular']) =>
        Object.fromEntries(styles.map((s) => [s, fontGlyphs(family, s, text)!])) as Partial<Record<FontStyle, FontGlyphs>>;

    it('finds an open-licence font on this machine', () => {
        expect(listFonts().map((f) => f.family)).toContain('DejaVu Sans');
    });

    it('extrudes a word into one valid solid with exact Bezier edges, and cuts it into a plate', () => {
        const text = 'Jarvis 8&@';
        const { outlines, missing } = layoutText({ text, height: 10, at: [-30, -5] }, fonts('DejaVu Sans', text));
        expect(missing).toEqual([]);
        // Every letter's outline, with the holes of a, @ and 8.
        expect(outlines.length).toBeGreaterThan(10);
        const sketch: Sketch = { plane: 'top', offset: 5, profiles: outlineProfiles(outlines) };
        const word = build.extrudeSketch(sketch, [0, 2]);
        expect(valid(word)).toBe(true);
        // The font's quadratic curves are built as Bezier edges, not as polylines.
        expect(word.edges.some((e) => e.geomType === 'BEZIER_CURVE')).toBe(true);
        const area = exactVolume(word) / 2;
        // Capital height 10 mm: a few hundred square millimetres of ink.
        expect(area).toBeGreaterThan(50);
        expect(area).toBeLessThan(1000);

        // Engrave it 1 mm deep into the top of a 100 x 10 x 40 plate.
        const plate = build.extrudeSketch({ plane: 'top', profiles: [{ kind: 'rect', center: [0, 0], width: 100, height: 40 }] }, [-5, 5]);
        const tool = build.extrudeSketch(sketch, [-1, 0]);
        const cut = plate.cut(tool);
        expect(valid(cut)).toBe(true);
        expect(Math.abs(exactVolume(plate) - exactVolume(cut) - area) / area).toBeLessThan(1e-6);
    }, SLOW);

    it('runs bold and rotated characters along an arc as valid solids', () => {
        const text = 'A<b>B</b><r30>C</r>';
        const arc = Array.from({ length: 721 }, (_, i) => {
            const t = Math.PI - (Math.PI * i) / 720;
            return [40 * Math.cos(t), 40 * Math.sin(t)] as [number, number];
        });
        const { outlines } = layoutText({ text, height: 6, at: [0, 0], align: 'center' }, fonts('Liberation Sans', 'ABC', ['regular', 'bold']), polylinePath(arc));
        expect(outlines.length).toBeGreaterThanOrEqual(5);
        // Centred on the top of the arc, outside it.
        for (const o of outlines) {
            expect(Math.hypot(...o.start)).toBeGreaterThan(39.99);
            expect(Math.abs(o.start[0])).toBeLessThan(15);
        }
        const solid = build.extrudeSketch({ plane: 'front', profiles: outlineProfiles(outlines) }, [0, 1]);
        expect(valid(solid)).toBe(true);
    }, SLOW);
});
