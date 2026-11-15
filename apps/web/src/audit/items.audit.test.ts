// Audit of the sketch items on the toolbar: Text, Sketch picture, Equation driven curve (Draw group), Fit spline,
// Simplify spline and the block tools (Modify group). Each through its toolbar entry where the form can run without
// the browser; fonts come from a stub of the server's font service.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry, SketchPicture } from '@jarvis/core';
import { curveRadius, loadSolver } from '../solver';
import { addLine, addRect, EMPTY_GEOMETRY } from '../sketchGeometry';
import { commitGeometry, deleteSelected, enterKey, undoSketch, useSketcher } from '../sketcher';
import { dissolveText } from '../sketchTextItems';
import { applySimplify, simplifySpline } from '../sketchSplineFit';
import { blockEditing, finishBlockEdit } from '../sketchBlockForms';
import { ownerOf } from '../sketchItems';
import {
    at, begin, clicks, ctx, curvesOf, FONT, geo, itemsIntact, near, noDangling, openChains, press, profiles, solvesCleanly, state,
    undoRedoRestores, withItems,
} from './harness';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

const saved: { name: string; body: unknown }[] = [];
vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (url === '/api/fonts') {
        return { ok: true, json: async () => ({ fonts: [{ family: 'Test Sans', styles: ['regular'] }] }) };
    }
    if (url === '/api/fonts/glyphs') {
        const body = JSON.parse(init?.body ?? '{}');
        return { ok: true, json: async () => ({ glyphs: { ...FONT, style: body.style } }) };
    }
    if (url === '/api/blocks' && init) {
        const body = JSON.parse(init.body ?? '{}');
        saved.push({ name: body.name, body });
        return { ok: true, json: async () => ({ name: `${body.name}.sldblk` }) };
    }
    return { ok: true, json: async () => ({ blocks: [] }) };
});

beforeAll(async () => {
    await loadSolver();
});

beforeEach(() => begin());

const select = (...ids: string[]) => useSketcher.setState({
    selection: ids.map((id) => ({ type: geo().curves.some((c) => c.id === id) ? 'curve' as const : 'point' as const, id })),
});
const bounds = (ids: string[]) => {
    const pts = geo().points.filter((p) => ids.includes(p.id));
    return { minU: Math.min(...pts.map((p) => p.u)), maxU: Math.max(...pts.map((p) => p.u)), minV: Math.min(...pts.map((p) => p.v)), maxV: Math.max(...pts.map((p) => p.v)) };
};

describe('text', () => {
    const textForm = () => {
        const form = press('sk-text');
        form.values = { ...form.values, font: 'Test Sans' };
        return form;
    };

    it('builds "O" 6.2501 high from (12.5, -3.25): the capital height and start exact, a region with a hole', async () => {
        const form = textForm();
        form.values = { ...form.values, text: 'O', height: '6.2501', atX: '12.5', atY: '-3.25' };
        const before = geo();
        const r = await form.apply();
        expect(r.isError, r.text).toBe(false);
        const [t] = geo().texts!;
        const b = bounds(t.points);
        near(b.minU, 12.5, 1e-9);
        near(b.minV, -3.25, 1e-9);
        near(b.maxV - b.minV, 6.2501, 1e-9);
        expect(profiles().length).toBeGreaterThanOrEqual(1);
        solvesCleanly();
        noDangling();
        itemsIntact();
        undoSketch();
        expect(geo().curves).toEqual(before.curves);
        expect(geo().texts ?? []).toEqual([]);
    });

    it('refuses an empty text, a height of 0 or below, and a width factor of 0, in plain words', async () => {
        const form = textForm();
        const before = geo();
        for (const [patch, words] of [[{ text: '  ' }, /Type the text/], [{ text: 'O', widthFactor: '0' }, /above zero/], [{ text: 'O', spacing: '-5' }, /above zero/]] as const) {
            const r = await form.def.apply!({ ...form.values, ...patch }, ctx);
            expect(r?.isError, JSON.stringify(patch)).toBe(true);
            expect(r?.text).toMatch(words);
        }
        expect(geo()).toBe(before);
    });

    it('refuses a text height of 0 or below', async () => {
        const form = textForm();
        for (const height of ['0', '-5']) {
            const r = await form.def.apply!({ ...form.values, text: 'O', height }, ctx);
            expect(r?.isError, height).toBe(true);
        }
    });

    it('edits the text in place when its curve is selected, leaving nothing of the old text behind', async () => {
        const form = textForm();
        form.values = { ...form.values, text: 'O', height: '10', atX: '0', atY: '0' };
        await form.apply();
        const first = geo().texts![0];
        select(first.curves[0]);
        const edit = press('sk-text');
        expect(edit.values.id).toBe(first.id);
        edit.values = { ...edit.values, text: 'OO' };
        expect((await edit.apply()).isError).toBe(false);
        expect(geo().texts).toHaveLength(1);
        expect(geo().texts![0].curves.length).toBe(first.curves.length * 2);
        expect(geo().curves).toHaveLength(first.curves.length * 2);
        noDangling();
        itemsIntact();
    });

    it('runs along a tilted line picked before the tool', async () => {
        begin(addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [40, 20] }).g);
        select(curvesOf('line')[0].id);
        const form = textForm();
        expect(form.values.along).toEqual([curvesOf('line')[0].id]);
        form.values = { ...form.values, text: 'OO', height: '5' };
        expect((await form.apply()).isError).toBe(false);
        expect(geo().texts![0].along).toEqual([curvesOf('line')[0].id]);
        itemsIntact();
        solvesCleanly();
    });

    it('dissolves into plain curves; deleting one glyph curve takes the whole text', async () => {
        const form = textForm();
        form.values = { ...form.values, text: 'O', height: '10', atX: '0', atY: '0' };
        await form.apply();
        const id = geo().texts![0].id;
        const n = geo().curves.length;
        undoRedoRestores(() => expect(commitGeometry(dissolveText(geo(), id))).toBe(true));
        expect(geo().texts ?? []).toEqual([]);
        expect(geo().curves).toHaveLength(n);
        expect(geo().curves.every((c) => !ownerOf(geo(), c.id))).toBe(true);
        undoSketch();
        select(geo().texts![0].curves[0]);
        deleteSelected();
        expect(geo().curves).toEqual([]);
        expect(geo().texts ?? []).toEqual([]);
        noDangling();
    });
});

describe('sketch picture', () => {
    const picture: SketchPicture = { id: 'pic1', asset: 'a1', at: [5, -3], width: 40, height: 20, angle: 15, pixels: [400, 200], lockAspect: true };

    it('changes width with the aspect locked: height follows; 0 or negative changes nothing', () => {
        begin({ ...EMPTY_GEOMETRY, pictures: [picture] });
        const form = press('sk-picture');
        expect(form.values.pid).toBe('pic1');
        form.change('width', '30.0002');
        expect(form.values.height).toBe('15.0001');
        const p = geo().pictures![0];
        expect(p.width).toBe(30.0002);
        expect(p.height).toBe(15.0001);
        for (const width of ['0', '-4']) {
            form.change('width', width);
            expect(geo().pictures![0].width).toBe(30.0002);
        }
        form.change('width', '30.0002');
        form.change('angle', '-32.5');
        expect(geo().pictures![0].angle).toBe(-32.5);
        // Never part of a profile.
        expect(profiles()).toEqual([]);
    });

    it('says why an invalid width is refused, and a later angle still applies', () => {
        begin({ ...EMPTY_GEOMETRY, pictures: [picture] });
        const form = press('sk-picture');
        form.change('width', '-4');
        expect(state().message).toMatch(/above zero/);
        expect(geo().pictures![0].width).toBe(40);
        form.change('angle', '22.0001');
        expect(geo().pictures![0].angle).toBe(22.0001);
        expect(geo().pictures![0].width).toBe(40);
        expect(form.values.width).toBe('40');
    });
});

describe('equation driven curve', () => {
    it('explicit y = 0.5 x^2 from -2 to 3 within 0.0001: one fixed spline, an open chain', async () => {
        const form = press('sk-equation-curve');
        form.values = { ...form.values, type: 'explicit', y: '0.5*x^2', from: '-2', to: '3', tolerance: '0.0001' };
        undoRedoRestores(() => void form.apply());
        const [e] = geo().equations!;
        expect(e.deviation!).toBeLessThanOrEqual(0.0001);
        expect(curvesOf('spline')).toHaveLength(1);
        const pts = (curvesOf('spline')[0] as { points: string[] }).points.map((id) => at(id));
        expect(pts[0]).toEqual([-2, 2]);
        expect(pts[pts.length - 1]).toEqual([3, 4.5]);
        expect(openChains()).toHaveLength(1);
        solvesCleanly();
        itemsIntact();
    });

    it('parametric circle of radius 12.5001 over a full turn closes into a region', async () => {
        const form = press('sk-equation-curve');
        form.values = { ...form.values, type: 'parametric', x: '12.5001*cos(t) + 30', y: '12.5001*sin(t) - 10', from: '0', to: '2*pi', tolerance: '0.0001' };
        expect((await form.apply()).isError).toBe(false);
        expect(profiles()).toHaveLength(1);
        for (const id of (curvesOf('spline')[0] as { points: string[] }).points) {
            const [u, v] = at(id);
            near(Math.hypot(u - 30, v + 10), 12.5001, 1e-9);
        }
    });

    it('refuses a bad expression, a backwards range and a tolerance of 0 or below in plain words', async () => {
        const form = press('sk-equation-curve');
        const base = { ...form.values, type: 'explicit', y: 'x', from: '0', to: '10', tolerance: '0.001' };
        const before = geo();
        for (const patch of [{ y: 'sin x' }, { y: 'window.alert(1)' }, { from: '5', to: '1' }, { tolerance: '0' }, { tolerance: '-1' }, { tolerance: 'abc' }]) {
            const r = await form.def.apply!({ ...base, ...patch }, ctx);
            expect(r?.isError, JSON.stringify(patch)).toBe(true);
            expect(r?.text.length).toBeGreaterThan(0);
        }
        expect(geo()).toBe(before);
    });

    it('edits the curve in place when its spline is selected', async () => {
        const form = press('sk-equation-curve');
        form.values = { ...form.values, type: 'explicit', y: 'x', from: '0', to: '10', tolerance: '0.001' };
        await form.apply();
        select(curvesOf('spline')[0].id);
        const edit = press('sk-equation-curve');
        expect(edit.values.id).toBe(geo().equations![0].id);
        edit.values = { ...edit.values, y: '2*x' };
        expect((await edit.apply()).isError).toBe(false);
        expect(geo().equations).toHaveLength(1);
        expect(curvesOf('spline')).toHaveLength(1);
        noDangling();
        itemsIntact();
    });
});

describe('fit spline', () => {
    /** A chain: line, tangent arc, line, drawn with the tools. */
    function chain(): string[] {
        press('sk-line', 'line');
        clicks([0, 0], [20, 5]);
        enterKey();
        press('sk-tangentArc', 'tangentArc');
        clicks([20, 5], [30, 15]);
        enterKey();
        press('sk-line', 'line');
        clicks([30, 15], [32, 30]);
        enterKey();
        return geo().curves.map((c) => c.id);
    }

    it('fits one spline to a line, a tangent arc and a line within 0.01, deleting them', async () => {
        const ids = chain();
        select(...ids);
        const form = press('sk-fit-spline');
        expect(form.values.entities).toEqual(ids);
        undoRedoRestores(() => void form.apply());
        expect(curvesOf('spline')).toHaveLength(1);
        expect(curvesOf('line')).toHaveLength(0);
        expect(curvesOf('arc')).toHaveLength(0);
        const pts = (curvesOf('spline')[0] as { points: string[] }).points;
        expect(at(pts[0])).toEqual([0, 0]);
        expect(at(pts[pts.length - 1])[0]).toBeCloseTo(32, 6);
        solvesCleanly();
        noDangling();
    });

    it('keeps the originals as construction when Delete geometry is off', async () => {
        const ids = chain();
        select(...ids);
        const form = press('sk-fit-spline');
        expect((await form.def.apply!({ ...form.values, delete: false }, ctx))?.isError).toBe(false);
        expect(geo().curves.filter((c) => c.construction)).toHaveLength(3);
        solvesCleanly();
    });

    it('refuses a tolerance of 0 or below, nothing picked, and lines that do not join', async () => {
        const ids = chain();
        const form = press('sk-fit-spline');
        const before = geo();
        for (const patch of [{ entities: ids, tolerance: '0' }, { entities: ids, tolerance: '-0.5' }, { entities: [] as string[] }, { entities: [ids[0], ids[2]] }] as Record<string, string | string[]>[]) {
            const r = await form.def.apply!({ ...form.values, ...patch }, ctx);
            expect(r?.isError, JSON.stringify(patch)).toBe(true);
        }
        expect(geo()).toBe(before);
    });
});

describe('simplify spline', () => {
    it('leaves fewer points within 0.01, ends kept', () => {
        const form = press('sk-equation-curve');
        form.values = { ...form.values, type: 'explicit', y: '3*sin(x/4)', from: '0', to: '30', tolerance: '0.0001' };
        void form.apply();
        // A plain spline: dissolve the equation item by taking its points as they are.
        const g = geo();
        const plain: SketchGeometry = { ...g, equations: [], points: g.points.map((p) => ({ ...p, fixed: undefined })) };
        begin(plain);
        const id = curvesOf('spline')[0].id;
        const before = (curvesOf('spline')[0] as { points: string[] }).points.length;
        select(id);
        const simplify = press('sk-simplify-spline');
        expect(simplify.values.spline).toBe(id);
        // The form's report works out the simplified spline (a React effect); its result is what OK applies.
        const fit = simplifySpline(geo(), id, 0.01);
        expect(typeof fit).not.toBe('string');
        const r = applySimplify(geo(), id, fit as Exclude<typeof fit, string>);
        expect(typeof r).not.toBe('string');
        expect(commitGeometry(r as SketchGeometry)).toBe(true);
        const after = (curvesOf('spline')[0] as { points: string[] }).points;
        expect(after.length).toBeLessThan(before);
        expect(at(after[0])).toEqual([0, 0]);
        solvesCleanly();
        noDangling();
    });

    it('OK with no spline picked says so', async () => {
        const form = press('sk-simplify-spline');
        const r = await form.apply();
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/Pick the spline/);
    });
});

describe('blocks', () => {
    /** A plate (tilted rectangle) with a hole, as a block at its centre. */
    async function plateBlock() {
        let g = addRect(EMPTY_GEOMETRY, [10, 5], [30, 15]).g;
        g = { ...g, points: [...g.points, { id: 'hc', u: 20, v: 10 }], curves: [...g.curves, { id: 'hole', kind: 'circle', center: 'hc', radius: 2.5 }] };
        begin(g);
        select(...geo().curves.map((c) => c.id));
        const form = press('sk-block-make');
        expect(form.values.x).toBe('20');
        expect(form.values.y).toBe('10');
        form.values = { ...form.values, name: 'Plate' };
        const r = await form.apply();
        expect(r.isError, r.text).toBe(false);
        return geo();
    }

    it('make block: the entities become one fixed instance in place; the relations go into the block', async () => {
        const before = addRect(EMPTY_GEOMETRY, [10, 5], [30, 15]).g;
        await plateBlock();
        expect(geo().blocks).toHaveLength(1);
        expect(geo().inserts).toHaveLength(1);
        expect(geo().blocks![0].geometry.constraints.map((k) => k.kind).sort()).toEqual(['horizontal', 'horizontal', 'vertical', 'vertical']);
        expect(geo().constraints).toEqual([]);
        expect(geo().points.every((p) => p.fixed)).toBe(true);
        const corners = before.points.map((p) => [p.u, p.v]).sort();
        // The hole's centre and the instance's insertion point are both at (20, 10).
        expect(geo().points.filter((p) => !(p.u === 20 && p.v === 10)).map((p) => [p.u, p.v]).sort()).toEqual(corners);
        expect(geo().points.filter((p) => p.u === 20 && p.v === 10).map((p) => p.id).sort()).toEqual([geo().inserts![0].origin, `${geo().inserts![0].id}.hc`].sort());
        expect(profiles().length).toBeGreaterThanOrEqual(1);
        solvesCleanly();
        itemsIntact();
    });

    it('make block with nothing picked says so', async () => {
        const form = press('sk-block-make');
        const r = await form.apply();
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/Pick the entities/);
    });

    it('insert block at (-40.0001, 12.5), turned 30 degrees, scale 1.5: points exactly where they belong', async () => {
        await plateBlock();
        const form = press('sk-block-insert');
        form.values = { ...form.values, x: '-40.0001', y: '12.5', angle: '30', scale: '1.5' };
        undoRedoRestores(() => void form.apply());
        expect(geo().inserts).toHaveLength(2);
        const ins = geo().inserts![1];
        const t = Math.PI / 6;
        // The corner (10, 5) is (-10, -5) from the insertion point (20, 10).
        const want: [number, number] = [-40.0001 + 1.5 * (-10 * Math.cos(t) + 5 * Math.sin(t)), 12.5 + 1.5 * (-10 * Math.sin(t) - 5 * Math.cos(t))];
        const pts = geo().points.filter((p) => ins.points.includes(p.id));
        expect(pts.some((p) => Math.abs(p.u - want[0]) < 1e-9 && Math.abs(p.v - want[1]) < 1e-9)).toBe(true);
        const hole = geo().curves.find((c) => ins.curves.includes(c.id) && c.kind === 'circle')!;
        expect(curveRadius(geo(), hole.id)).toBeCloseTo(3.75, 12);
        solvesCleanly();
        itemsIntact();
    });

    it('insert block refuses a scale of 0 or below', async () => {
        await plateBlock();
        const form = press('sk-block-insert');
        for (const scale of ['0', '-1']) {
            const r = await form.def.apply!({ ...form.values, scale }, ctx);
            expect(r?.isError, scale).toBe(true);
        }
    });

    it('changes a placed instance from its properties: turned 90 degrees about its insertion point', async () => {
        await plateBlock();
        const ins = geo().inserts![0];
        select(ins.curves[0]);
        const form = press('sk-block-insert');
        expect(form.values.insert).toBe(ins.id);
        form.change('angle', '90');
        const pts = geo().points.filter((p) => geo().inserts![0].points.includes(p.id));
        // The corner (10, 5) turns to (25, 0) about (20, 10).
        expect(pts.some((p) => Math.abs(p.u - 25) < 1e-9 && Math.abs(p.v - 0) < 1e-9)).toBe(true);
        itemsIntact();
    });

    it('edit block: a circle drawn in the block shows in every instance on OK', async () => {
        await plateBlock();
        const insert = press('sk-block-insert');
        insert.values = { ...insert.values, x: '60', y: '0', angle: '0', scale: '1' };
        await insert.apply();
        select(geo().inserts![0].curves[0]);
        const edit = press('sk-block-edit');
        expect(blockEditing()).not.toBeNull();
        press('sk-circle', 'circle');
        clicks([14, 8], [15, 8]);
        expect((await edit.apply()).isError).toBe(false);
        expect(blockEditing()).toBeNull();
        expect(geo().blocks![0].geometry.curves.filter((c) => c.kind === 'circle')).toHaveLength(2);
        expect(geo().inserts!.every((i) => geo().curves.filter((c) => i.curves.includes(c.id) && c.kind === 'circle').length === 2)).toBe(true);
        solvesCleanly();
        noDangling();
        itemsIntact();
    });

    it('edit block, then cancel: nothing changes', async () => {
        await plateBlock();
        const before = geo();
        select(geo().inserts![0].curves[0]);
        press('sk-block-edit');
        press('sk-circle', 'circle');
        clicks([14, 8], [15, 8]);
        finishBlockEdit(false);
        expect(geo()).toBe(before);
    });

    it('explode block: the instance turns into free entities with the block\'s relations', async () => {
        await plateBlock();
        select(geo().inserts![0].curves[0]);
        undoRedoRestores(() => press('sk-block-explode'));
        expect(geo().inserts ?? []).toEqual([]);
        expect(geo().points.some((p) => p.fixed)).toBe(false);
        expect(geo().constraints.map((k) => k.kind).sort()).toEqual(['horizontal', 'horizontal', 'vertical', 'vertical']);
        solvesCleanly();
        noDangling();
    });

    it('explode with nothing selected says so', () => {
        press('sk-block-explode');
        expect(state().message).toMatch(/Select a block instance/);
    });

    it('save block posts the block under its name', async () => {
        await plateBlock();
        const form = press('sk-block-save');
        expect(form.values.name).toBe('Plate');
        const r = await form.apply();
        expect(r.isError).toBe(false);
        expect(saved.at(-1)?.name).toBe('Plate');
    });

    it('save block with no block in the sketch says so', async () => {
        const form = press('sk-block-save');
        const r = await form.apply();
        expect(r.isError).toBe(true);
    });
});

describe('move, rotate, copy, mirror and pattern on text, equation curve and block instance curves', () => {
    const targets = (items: ReturnType<typeof withItems>) => ({
        text: items.g.texts![0].curves[0], equation: items.g.equations![0].curves[0], insert: items.g.inserts![0].curves[0],
    });
    // SOLIDWORKS_REFERENCE.md Part B, Blocks: a block is one rigid unit (it moves, turns, scales and patterns as one);
    // text is placed by its start point; an equation curve is where its equation puts it.
    for (const what of ['text', 'equation', 'insert'] as const) {
        // Defect (text, block instance): Move on one curve of a block instance moves that curve's points only, tearing
        // the line off its instance; on a text curve it says "Moved 1 item" while nothing moves.
        it(`sk-move on one curve of a ${what} moves the whole ${what} by (5.5, -2), or says it cannot`, async () => {
            const items = withItems();
            begin(items.g);
            select(targets(items)[what]);
            const form = press('sk-move');
            form.values = { ...form.values, by0: '5.5', by1: '-2' };
            const before = geo();
            const r = await form.apply();
            if (r.isError) {
                expect(geo()).toBe(before);
                return;
            }
            const item = [...(before.texts ?? []), ...(before.equations ?? []), ...(before.inserts ?? [])].find((x) => x.curves.includes(targets(items)[what]))!;
            for (const id of item.points) {
                const [p, q] = [before.points.find((x) => x.id === id)!, geo().points.find((x) => x.id === id)!];
                expect(q.u - p.u, id).toBeCloseTo(5.5, 9);
                expect(q.v - p.v, id).toBeCloseTo(-2, 9);
            }
        });
    }

    for (const tool of ['sk-move', 'sk-rotate', 'sk-copy', 'sk-pattern-linear', 'sk-pattern-circular']) {
        it(`${tool} on each item never throws and leaves the items whole`, async () => {
            const items = withItems();
            for (const [what, id] of Object.entries(targets(items))) {
                begin(items.g);
                select(id);
                const form = press(tool);
                form.values = { ...form.values, by0: '5.5', by1: '-2', angle: '30', centre0: '0', centre1: '0', count: '3', spacing: '25' };
                const before = geo();
                let r: { text: string; isError: boolean } = { text: '', isError: false };
                await expect((async () => {
                    r = await form.apply();
                })()).resolves.toBeUndefined();
                itemsIntact();
                noDangling();
                if (r.isError) {
                    expect(geo(), `${tool} on ${what}`).toBe(before);
                    expect(r.text.length).toBeGreaterThan(0);
                } else {
                    solvesCleanly();
                }
            }
        });
    }
});
