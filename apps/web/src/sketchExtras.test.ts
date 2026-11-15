import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import type { FontGlyphs } from '@jarvis/core/text';
import { loadSolver } from './solver';
import { addLine, EMPTY_GEOMETRY, geometryProfiles } from './sketchGeometry';
import { regionsOf } from './regionPick';
import { commitGeometry, currentSketch, deleteSelected, useSketcher } from './sketcher';
import { buildText, dissolveText } from './sketchTextItems';
import { expandOwned, ownerOf } from './sketchItems';
import { sketchSpaceMenu } from './contextMenus';
import { finishBlockEdit, startBlockEdit } from './sketchBlockForms';
import { explodeBlock, insertBlock, makeBlock } from './sketchBlocks';
import { buildEquation } from './sketchEquation';
import { applyFit, applySimplify, fitChain, simplifySpline, smoothStep } from './sketchSplineFit';
import { sketchTextTool } from './sketchTextForm';
import { compileExpression, constantValue } from '@jarvis/core/expression';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

/** A tiny font: O is a square with a square hole (lines), S two quadratic curves and a line; capital height 1000. */
const FONT: FontGlyphs = {
    family: 'Test Sans', style: 'regular', unitsPerEm: 1000, capHeight: 1000, lineHeight: 1200, kerning: { OS: -100 },
    glyphs: {
        O: {
            advance: 1000,
            contours: [
                { start: [0, 0], segments: [{ kind: 'line', to: [800, 0] }, { kind: 'line', to: [800, 1000] }, { kind: 'line', to: [0, 1000] }, { kind: 'line', to: [0, 0] }] },
                { start: [200, 200], segments: [{ kind: 'line', to: [200, 800] }, { kind: 'line', to: [600, 800] }, { kind: 'line', to: [600, 200] }, { kind: 'line', to: [200, 200] }] },
            ],
        },
        S: {
            advance: 900,
            contours: [{ start: [0, 0], segments: [{ kind: 'quad', c: [400, 600], to: [800, 0] }, { kind: 'quad', c: [400, 1200], to: [0, 0] }] }],
        },
        ' ': { advance: 300, contours: [] },
    },
};

vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
    if (url === '/api/fonts') {
        return { ok: true, json: async () => ({ fonts: [{ family: 'Test Sans', styles: ['regular'] }] }) };
    }
    if (url === '/api/fonts/glyphs') {
        const body = JSON.parse(init?.body ?? '{}');
        return { ok: true, json: async () => ({ glyphs: { ...FONT, style: body.style } }) };
    }
    return { ok: false, json: async () => ({}) };
});

beforeAll(async () => {
    await loadSolver();
});

function start(g: SketchGeometry = EMPTY_GEOMETRY) {
    useSketcher.setState({ active: true, stage: 'draw', geometry: g, labels: {}, picks: [], draft: [], selection: [], snap: false, undo: [], redo: [] });
}

const text = (overrides: Partial<import('@jarvis/core').SketchText> = {}) => ({
    id: 't1', text: 'OS', font: 'Test Sans', height: 10, at: [5, 2] as [number, number], curves: [], points: [], ...overrides,
});

describe('sketch text', () => {
    it('builds glyphs as fixed lines and Bezier style splines that make closed regions with holes', () => {
        const built = buildText(EMPTY_GEOMETRY, text(), { regular: FONT });
        expect(typeof built).not.toBe('string');
        const { g, item } = built as Exclude<typeof built, string>;
        // O: 8 lines; S: 2 quadratic Bezier curves.
        expect(g.curves.filter((c) => c.kind === 'line')).toHaveLength(8);
        const beziers = g.curves.filter((c) => c.kind === 'styleSpline');
        expect(beziers).toHaveLength(2);
        expect(beziers.every((c) => c.kind === 'styleSpline' && c.points.length === 3 && !c.degree)).toBe(true);
        expect(g.points.every((p) => p.fixed)).toBe(true);
        expect(item.curves).toHaveLength(10);
        // Capital height 10 mm from the start point (5, 2); S comes after O's advance less the kerning: 9 mm on.
        const xs = g.points.map((p) => p.u);
        const ys = g.points.map((p) => p.v);
        expect(Math.min(...xs)).toBeCloseTo(5, 9);
        expect(Math.min(...ys)).toBeCloseTo(2, 9);
        expect(Math.max(...ys)).toBeCloseTo(14, 9);
        expect(g.points.some((p) => Math.abs(p.u - 14) < 1e-9 && Math.abs(p.v - 2) < 1e-9)).toBe(true);
        // Two closed areas for the O (the ring and its hole) and the S.
        const { profiles } = geometryProfiles(g);
        expect(profiles).toHaveLength(3);
        expect(regionsOf(g).length).toBe(3);
    });

    it('keeps the text through solving and other tools, and deletes it whole', () => {
        const built = buildText(addLine(EMPTY_GEOMETRY, { at: [0, -10] }, { at: [30, -10] }).g, text(), { regular: FONT });
        const g = (built as Exclude<typeof built, string>).g;
        start(EMPTY_GEOMETRY);
        expect(commitGeometry(g)).toBe(true);
        expect(useSketcher.getState().geometry.texts).toHaveLength(1);
        expect(currentSketch().geometry?.texts?.[0].text).toBe('OS');
        // Deleting the line (a tool that rebuilds the sketch from points and curves) keeps the text.
        const line = g.curves.find((c) => !ownerOf(g, c.id))!.id;
        useSketcher.setState({ selection: [{ type: 'curve', id: line }] });
        deleteSelected();
        expect(useSketcher.getState().geometry.texts).toHaveLength(1);
        // Deleting one glyph curve takes the whole text.
        const glyph = useSketcher.getState().geometry.texts![0].curves[0];
        expect(expandOwned(useSketcher.getState().geometry, [glyph]).length).toBeGreaterThan(10);
        useSketcher.setState({ selection: [{ type: 'curve', id: glyph }] });
        deleteSelected();
        expect(useSketcher.getState().geometry.texts).toHaveLength(0);
        expect(useSketcher.getState().geometry.curves).toHaveLength(0);
    });

    it('dissolves into plain entities that are free to move', () => {
        const { g } = buildText(EMPTY_GEOMETRY, text(), { regular: FONT }) as { g: SketchGeometry };
        const out = dissolveText(g, 't1');
        expect(out.texts).toHaveLength(0);
        expect(out.curves).toHaveLength(10);
        expect(out.points.some((p) => p.fixed)).toBe(false);
    });

    it('runs along a line, centred, flipped to the other side, and follows the line when it moves', async () => {
        const base = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [40, 0] });
        start(base.g);
        const values = { ...sketchTextTool.defaults!({ part: null, project: null, edit: null }), text: 'OS', font: 'Test Sans', height: '10', along: [base.id], align: 'center' };
        expect((await sketchTextTool.apply!(values, { part: null, project: null, edit: null })).text).toBe("");
        let g = useSketcher.getState().geometry;
        const glyphs = g.points.filter((p) => ownerOf(g, p.id));
        // Text 18 mm wide (O 10, kerning -1, S 9) centred on the 40 mm line from 11 to 29, above it; the ink ends 1 mm short.
        const xs = glyphs.map((p) => p.u);
        expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(19.5, 9);
        expect(Math.min(...glyphs.map((p) => p.v))).toBeGreaterThanOrEqual(-1e-9);
        // Move the line up by 5: the text goes with it.
        const end = g.curves.find((c) => c.id === base.id)!;
        const ids = end.kind === 'line' ? [end.a, end.b] : [];
        useSketcher.setState({ geometry: { ...g, points: g.points.map((p) => (ids.includes(p.id) ? { ...p, v: p.v + 5 } : p)) } });
        g = useSketcher.getState().geometry;
        expect(Math.min(...g.points.filter((p) => ownerOf(g, p.id)).map((p) => p.v))).toBeCloseTo(5, 6);
        // Flip vertical: below the line.
        const flipped = buildText(g, { ...g.texts![0], flipV: true }, { regular: FONT }) as { g: SketchGeometry };
        expect(Math.max(...flipped.g.points.filter((p) => ownerOf(flipped.g, p.id)).map((p) => p.v))).toBeCloseTo(5, 6);
    });
});

describe('sketch pictures', () => {
    it('stay with the sketch through solving and tools, and are never part of a profile', () => {
        const line = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] });
        const pictures = [{ id: 'pic1', asset: 'a.png', at: [0, 0] as [number, number], width: 40, height: 30, angle: 0, pixels: [400, 300] as [number, number] }];
        start({ ...line.g, pictures });
        expect(commitGeometry(addLine(useSketcher.getState().geometry, { at: [0, 5] }, { at: [10, 5] }).g)).toBe(true);
        expect(useSketcher.getState().geometry.pictures).toEqual(pictures);
        useSketcher.setState({ selection: [{ type: 'curve', id: line.id }] });
        deleteSelected();
        expect(useSketcher.getState().geometry.pictures).toEqual(pictures);
        expect(currentSketch().geometry?.pictures).toEqual(pictures);
        expect(currentSketch().profiles).toHaveLength(0);
    });
});

describe('equation driven curves', () => {
    it('reads the SolidWorks functions without eval, and says what is wrong', async () => {
        const r = compileExpression('sqr(4 - x^2) + 2*sin(pi/2) - -1 + atn(1)*4/pi + log(exp(2))', ['x']);
        expect('f' in r && r.f({ x: 0 })).toBeCloseTo(2 + 2 + 1 + 1 + 2, 12);
        expect(constantValue('2*pi')).toBeCloseTo(2 * Math.PI, 15);
        expect(constantValue('2^-1')).toBe(0.5);
        expect('error' in compileExpression('x + window.alert(1)', ['x'])).toBe(true);
        expect('error' in compileExpression('sin x', ['x'])).toBe(true);
        expect('error' in compileExpression('(x + 1', ['x'])).toBe(true);
    });

    it('builds an explicit curve as a spline within the tolerance, with fixed points, and rebuilds it in place', async () => {
        const t0 = performance.now();
        const built = buildEquation(EMPTY_GEOMETRY, {
            id: 'e1', type: 'explicit', y: 'sqr(4 - x^2)', from: '-1.9', to: '1.9', tolerance: 0.001, curves: [], points: [],
        });
        expect(typeof built).not.toBe('string');
        const b = built as Exclude<typeof built, string>;
        expect(b.fit.within).toBe(true);
        expect(b.item.deviation!).toBeLessThanOrEqual(0.001);
        expect(b.g.curves).toHaveLength(1);
        expect(b.g.curves[0].kind).toBe('spline');
        // Fixed inner points; the two ends are free (they take relations, and the rigid curve follows them).
        const ends = b.g.curves[0].kind === 'spline' ? [b.g.curves[0].points[0], b.g.curves[0].points[b.g.curves[0].points.length - 1]] : [];
        expect(b.g.points.every((p) => !!p.fixed === !ends.includes(p.id))).toBe(true);
        // A parametric circle of radius 50 over a half turn, to a millionth of a millimetre.
        const fine = buildEquation(b.g, {
            id: 'e1', type: 'parametric', x: '50*cos(t)', y: '50*sin(t)', from: '0', to: 'pi', tolerance: 0.000001, curves: [], points: [],
        }) as Exclude<typeof built, string>;
        expect(fine.fit.within).toBe(true);
        expect(fine.item.deviation!).toBeLessThanOrEqual(1e-6);
        expect(fine.g.curves).toHaveLength(1);
        expect(fine.g.equations).toHaveLength(1);
        // Every spline point is on the circle; the end handles point along it.
        const through = fine.g.curves[0].kind === 'spline' ? fine.g.curves[0].points : [];
        expect(Math.max(...fine.g.points.filter((p) => through.includes(p.id)).map((p) => Math.abs(Math.hypot(p.u, p.v) - 50)))).toBeLessThan(1e-9);
        const c = fine.g.curves[0];
        const handle = c.kind === 'spline' && fine.g.points.find((p) => p.id === c.startHandle);
        expect(handle && Math.abs(handle.u - 50)).toBeLessThan(1e-6);
        // Solving keeps them exactly where they are.
        start(EMPTY_GEOMETRY);
        expect(commitGeometry(fine.g)).toBe(true);
        expect(useSketcher.getState().geometry.points).toEqual(fine.g.points);
        expect(performance.now() - t0).toBeLessThan(5000);
        // A full turn closes the spline on its first point.
        const ring = buildEquation(EMPTY_GEOMETRY, {
            id: 'e2', type: 'parametric', x: '20*cos(t)', y: '20*sin(t)', from: '0', to: '2*pi', tolerance: 0.0001, curves: [], points: [],
        }) as Exclude<typeof built, string>;
        const spline = ring.g.curves[0];
        expect(spline.kind === 'spline' && spline.points[0] === spline.points[spline.points.length - 1]).toBe(true);
        expect(geometryProfiles(ring.g).profiles).toHaveLength(1);
    });

    it('refuses an equation that cannot be solved over its range', async () => {
        expect(buildEquation(EMPTY_GEOMETRY, { id: 'e', type: 'explicit', y: 'sqr(1 - x)', from: '0', to: '2', tolerance: 0.01, curves: [], points: [] }))
            .toMatch(/cannot be solved at x = /);
        expect(buildEquation(EMPTY_GEOMETRY, { id: 'e', type: 'explicit', y: 'x', from: '2', to: '1', tolerance: 0.01, curves: [], points: [] }))
            .toMatch(/x2 must be larger/);
    });
});

describe('fit spline and simplify spline', () => {
    /** A line from (0, 0) to (10, 0), then a tangent arc of radius 5 up to (15, 5), then a line on to (15, 15). */
    function chain(): SketchGeometry {
        return {
            points: [
                { id: 'a', u: 0, v: 0 }, { id: 'b', u: 10, v: 0 }, { id: 'o', u: 10, v: 5 }, { id: 'c', u: 15, v: 5 }, { id: 'd', u: 15, v: 15 },
                { id: 'x', u: 15, v: 20 },
            ],
            curves: [
                { id: 'l1', kind: 'line', a: 'a', b: 'b' },
                { id: 'arc', kind: 'arc', center: 'o', start: 'b', end: 'c' },
                { id: 'l2', kind: 'line', a: 'c', b: 'd' },
                { id: 'other', kind: 'line', a: 'd', b: 'x' },
            ],
            constraints: [{ id: 'k', kind: 'vertical', line: 'other' }],
        };
    }

    it('fits a spline within the tolerance to a chain of lines and arcs, deleting it and keeping its joins', async () => {
        const g = chain();
        const fit = fitChain(g, ['l2', 'l1', 'arc'], 0.01);
        expect(typeof fit).not.toBe('string');
        const f = fit as Exclude<typeof fit, string>;
        expect(f.within).toBe(true);
        expect(f.deviation).toBeLessThanOrEqual(0.01);
        expect(f.closed).toBe(false);
        const r = applyFit(g, ['l1', 'arc', 'l2'], f, 'delete');
        expect(r.g.curves.map((c) => c.kind).sort()).toEqual(['line', 'spline']);
        const spline = r.g.curves.find((c) => c.id === r.id)!;
        // The far end is still the point the other line starts on.
        expect(spline.kind === 'spline' && spline.points.includes('d')).toBe(true);
        start(EMPTY_GEOMETRY);
        expect(commitGeometry(r.g)).toBe(true);
        // Kept as construction, the spline fixed.
        const kept = applyFit(g, ['l1', 'arc', 'l2'], f, 'fixed');
        expect(kept.g.curves.filter((c) => c.construction).map((c) => c.id).sort()).toEqual(['arc', 'l1', 'l2']);
        expect(fitChain(g, ['l1', 'l2'], 0.01)).toMatch(/end to end/);
    });

    it('simplifies a spline to fewer points within the tolerance, and smooths it step by step', async () => {
        // 41 points along a gentle sine.
        const pts = Array.from({ length: 41 }, (_, i) => ({ id: `s${i}`, u: i, v: 3 * Math.sin(i / 8) }));
        const g: SketchGeometry = { points: pts, curves: [{ id: 'sp', kind: 'spline', points: pts.map((p) => p.id) }], constraints: [] };
        const fit = simplifySpline(g, 'sp', 0.01) as Exclude<ReturnType<typeof simplifySpline>, string>;
        expect(fit.within).toBe(true);
        expect(fit.points.length).toBeLessThan(15);
        const smoother = smoothStep(g, 'sp', fit) as Exclude<ReturnType<typeof smoothStep>, string>;
        expect(smoother.points.length).toBeLessThan(fit.points.length);
        expect(smoother.deviation).toBeGreaterThanOrEqual(0);
        const out = applySimplify(g, 'sp', fit) as SketchGeometry;
        const c = out.curves[0];
        expect(c.kind === 'spline' && c.points.length).toBe(fit.points.length);
        // Same curve id, same end points.
        expect(c.kind === 'spline' && [c.points[0], c.points[c.points.length - 1]]).toEqual(['s0', 's40']);
        start(EMPTY_GEOMETRY);
        expect(commitGeometry(out)).toBe(true);
    });
});

describe('blocks', () => {
    /** A 10 x 4 rectangle from (20, 10) with a circle of radius 1 in it, the rectangle's top horizontal. */
    function plate(): { g: SketchGeometry; ids: string[] } {
        const pts = [[20, 10], [30, 10], [30, 14], [20, 14]] as [number, number][];
        const g: SketchGeometry = {
            points: [...pts.map((p, i) => ({ id: `r${i}`, u: p[0], v: p[1] })), { id: 'cc', u: 25, v: 12 }],
            curves: [
                ...pts.map((_, i) => ({ id: `s${i}`, kind: 'line' as const, a: `r${i}`, b: `r${(i + 1) % 4}` })),
                { id: 'hole', kind: 'circle', center: 'cc', radius: 1 },
            ],
            constraints: [{ id: 'k1', kind: 'horizontal', line: 's2' }, { id: 'k2', kind: 'length', line: 's0', value: 10 }],
        };
        return { g, ids: ['s0', 's1', 's2', 's3', 'hole'] };
    }

    it('makes a block with an instance in place of the entities, and inserts turned and scaled copies', async () => {
        const { g, ids } = plate();
        const made = makeBlock(g, ids, [20, 10], 'Plate');
        expect(typeof made).not.toBe('string');
        const m = made as Exclude<typeof made, string>;
        expect(m.block.geometry.points.find((p) => p.id === 'r2')).toMatchObject({ u: 10, v: 4 });
        expect(m.block.geometry.constraints.map((k) => k.kind).sort()).toEqual(['horizontal', 'length']);
        expect(m.g.curves).toHaveLength(5);
        expect(m.g.points.every((p) => p.fixed)).toBe(true);
        expect(m.g.constraints).toHaveLength(0);
        // Same place as before.
        expect(m.g.points.filter((p) => p.id !== m.insert.origin).map((p) => [p.u, p.v]).sort()).toEqual(g.points.map((p) => [p.u, p.v]).sort());
        // A copy at (0, 0), turned 90 degrees, twice the size: the far corner (10, 4) lands at (-8, 20); radius 2.
        const r = insertBlock(m.g, m.block.id, { at: [0, 0], angle: 90, scale: 2 });
        const ins = (r as Exclude<typeof r, string>);
        const pts = ins.insert.points.map((id) => ins.g.points.find((p) => p.id === id)!);
        expect(pts.some((p) => Math.abs(p.u + 8) < 1e-9 && Math.abs(p.v - 20) < 1e-9)).toBe(true);
        const circle = ins.g.curves.find((c) => ins.insert.curves.includes(c.id) && c.kind === 'circle');
        expect(circle?.kind === 'circle' && circle.radius).toBe(2);
        expect(geometryProfiles(ins.g).profiles.length).toBe(4);
        // Solving moves nothing.
        start(EMPTY_GEOMETRY);
        expect(commitGeometry(ins.g)).toBe(true);
        expect(useSketcher.getState().geometry.inserts).toHaveLength(2);
    });

    it('keeps points that other curves still use, and a line from the origin gets its own point', async () => {
        const g: SketchGeometry = {
            points: [{ id: 'a', u: 5, v: 0 }, { id: 'b', u: 5, v: 5 }],
            curves: [{ id: 'l1', kind: 'line', a: 'origin', b: 'a' }, { id: 'l2', kind: 'line', a: 'a', b: 'b' }],
            constraints: [],
        };
        const m = makeBlock(g, ['l1'], [0, 0], 'Arm') as Exclude<ReturnType<typeof makeBlock>, string>;
        expect(m.g.curves.find((c) => c.id === 'l2')).toBeTruthy();
        expect(m.g.points.find((p) => p.id === 'a')).toBeTruthy();
        expect(m.block.geometry.points.some((p) => p.id === 'block-origin')).toBe(true);
        expect(m.g.curves).toHaveLength(2);
    });

    it('edits the block once for every instance, and explodes one instance into free entities with its relations', async () => {
        const { g, ids } = plate();
        const m = makeBlock(g, ids, [20, 10], 'Plate') as Exclude<ReturnType<typeof makeBlock>, string>;
        const two = insertBlock(m.g, m.block.id, { at: [0, 30], angle: 0, scale: 3 }) as Exclude<ReturnType<typeof insertBlock>, string>;
        start(EMPTY_GEOMETRY);
        expect(commitGeometry(two.g)).toBe(true);
        expect(startBlockEdit(m.insert.id, false)).toBeNull();
        // The block opens at the first instance's insertion point, free to edit.
        const open = useSketcher.getState().geometry;
        expect(open.curves).toHaveLength(5);
        expect(open.points.some((p) => p.fixed)).toBe(false);
        expect(commitGeometry(addLine(open, { at: [20, 10] }, { at: [30, 14] }).g)).toBe(true);
        expect(finishBlockEdit(true)).toBeNull();
        const after = useSketcher.getState().geometry;
        expect(after.inserts!.every((i) => i.curves.length === 6)).toBe(true);
        expect(after.curves).toHaveLength(12);
        // One undo step takes the whole edit back.
        expect(useSketcher.getState().undo.at(-1)?.curves).toHaveLength(10);
        // Exploded: free points, the block's relations among them, the length scaled with the instance.
        const big = after.inserts!.find((i) => i.scale === 3)!;
        const out = explodeBlock(after, big.id) as SketchGeometry;
        expect(out.inserts).toHaveLength(1);
        const freed = out.points.filter((p) => big.points.includes(p.id));
        expect(freed.every((p) => !p.fixed)).toBe(true);
        expect(out.constraints.find((k) => k.kind === 'length')).toMatchObject({ value: 30 });
        expect(commitGeometry(out)).toBe(true);
    });

    it('offers Edit block and Explode block on a right-click of an instance, Edit and Dissolve on a text', async () => {
        const { g, ids } = plate();
        const m = makeBlock(g, ids, [20, 10], 'Plate') as Exclude<ReturnType<typeof makeBlock>, string>;
        const done: string[] = [];
        const actions = {
            openTool: (id: string) => done.push(id), deleteSelected: () => undefined, endChain: () => undefined, fitSketch: () => undefined,
            closeSketch: () => undefined, itemAction: (action: string, id: string) => done.push(`${action}:${id}`),
        };
        const menu = (geometry: SketchGeometry, id: string) => sketchSpaceMenu(
            { stage: 'draw', tool: 'select', geometry, draft: 0, selection: [{ type: 'curve', id }], lastUsed: {} }, actions);
        const entries = menu(m.g, m.insert.curves[0]);
        expect(entries[0]).toEqual({ header: 'Block Plate' });
        const labels = entries.flatMap((e) => (typeof e === 'object' && 'label' in e ? [e.label] : []));
        expect(labels).toEqual(expect.arrayContaining(['Edit block', 'Explode block', 'Block properties', 'Save block', 'Delete']));
        const explode = entries.find((e) => typeof e === 'object' && 'label' in e && e.label === 'Explode block') as { onSelect: () => void };
        explode.onSelect();
        expect(done).toEqual([`explodeBlock:${m.insert.id}`]);
        const t = buildText(EMPTY_GEOMETRY, text(), { regular: FONT }) as { g: SketchGeometry };
        const textLabels = menu(t.g, t.g.curves[0].id).flatMap((e) => (typeof e === 'object' && 'label' in e ? [e.label] : []));
        expect(textLabels).toEqual(expect.arrayContaining(['Edit text', 'Dissolve sketch text']));
    });

    it('closes a block being edited into the sketch when the sketch is saved', async () => {
        const { g, ids } = plate();
        const m = makeBlock(g, ids, [20, 10], 'Plate') as Exclude<ReturnType<typeof makeBlock>, string>;
        start(EMPTY_GEOMETRY);
        commitGeometry(m.g);
        startBlockEdit(m.insert.id, false);
        const sketch = currentSketch();
        expect(sketch.geometry?.inserts).toHaveLength(1);
        expect(sketch.geometry?.blocks).toHaveLength(1);
    });
});
