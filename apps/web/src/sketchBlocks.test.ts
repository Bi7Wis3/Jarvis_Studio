// Blocks as SolidWorks has them (SOLIDWORKS_REFERENCE.md Part B, Blocks): instances are rigid bodies in the solver,
// blocks hold text, equation curves and other blocks, Add/Remove, Rebuild while editing, Link to file, colour, hide,
// Lock angle and For construction.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import { loadSolver, pointOf, solveGeometry } from './solver';
import { addLine, addRect, EMPTY_GEOMETRY, pickAt } from './sketchGeometry';
import { commitGeometry, sketchDown, sketchMove, sketchUp, useSketcher } from './sketcher';
import {
    addBlockDefinition, addRemoveEntities, blockFileOf, explodeWithNote, insertBlock, makeBlock, placeInsert, redefineBlock, updateFromFile,
} from './sketchBlocks';
import { blockEditing, finishBlockEdit, rebuildBlockEdit, setHidden, showHiddenBlocks, startBlockEdit } from './sketchBlockForms';
import { blockLook } from './sketchItems';
import { rigidGroups } from './sketchBlockRigid';
import { definedEntities } from './sketchStatus';
import { begin, FONT, geo, itemsIntact, noDangling, press, profiles, solvesCleanly } from './audit/harness';
import { buildText } from './sketchTextItems';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));
vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ blocks: [] }) }));

beforeAll(async () => {
    await loadSolver();
});

beforeEach(() => begin());

type Pt = [number, number];
const P = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id)!;
    return [p.u, p.v];
};
const d = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** A 20 x 10 rectangle with a hole, as block "Plate" with its insertion point at its centre (20, 10). */
function plate(): { g: SketchGeometry; insert: string } {
    let g = addRect(EMPTY_GEOMETRY, [10, 5], [30, 15]).g;
    g = { ...g, points: [...g.points, { id: 'hc', u: 20, v: 10 }], curves: [...g.curves, { id: 'hole', kind: 'circle', center: 'hc', radius: 2.5 }] };
    const r = makeBlock(g, g.curves.map((c) => c.id), [20, 10], 'Plate');
    if (typeof r === 'string') {
        throw new Error(r);
    }
    return { g: r.g, insert: r.insert.id };
}

/** Every pairwise distance among the instance's points (rigid: they never change). */
const shape = (g: SketchGeometry, insert: string) => {
    const ids = g.inserts!.find((i) => i.id === insert)!.points;
    return ids.flatMap((a, i) => ids.slice(i + 1).map((b) => d(P(g, a), P(g, b))));
};

describe('rigid block instances', () => {
    it('a free instance has 3 degrees of freedom; its insertion point is a point of the sketch', () => {
        const { g, insert } = plate();
        const ins = g.inserts![0];
        expect(ins.origin).toBe(`${insert}.insertion`);
        expect(P(g, ins.origin!)).toEqual([20, 10]);
        expect(solveGeometry(g).dof).toBe(3);
        expect(ins.points.every((id) => id.startsWith(`${insert}.`))).toBe(true);
    });

    it('a relation to an instance moves it as one body: coincident corner, then a fixed angle', () => {
        const { g } = plate();
        const ins = g.inserts![0];
        const corner = ins.points[0];
        const before = shape(g, ins.id);
        const k: SketchGeometry = { ...g, points: [...g.points, { id: 'q', u: 50.0001, v: -7.25 }], constraints: [{ id: 'k1', kind: 'coincident', a: corner, b: 'q' }, { id: 'k2', kind: 'fix', point: 'q' }] };
        const r = solveGeometry(k);
        expect(r.ok).toBe(true);
        expect(d(P(r.geometry, corner), [50.0001, -7.25])).toBeLessThan(1e-9);
        shape(r.geometry, ins.id).forEach((x, i) => expect(Math.abs(x - before[i])).toBeLessThan(1e-9));
        // The insertion point moved with it, and the instance records where it went.
        const moved = r.geometry.inserts![0];
        expect(d(moved.at, P(r.geometry, ins.origin!))).toBeLessThan(1e-12);
        expect(r.dof).toBe(1);
        // A horizontal relation on its bottom edge then holds the turn: fully defined.
        const bottom = ins.curves[0];
        const h = solveGeometry({ ...r.geometry, constraints: [...r.geometry.constraints, { id: 'k3', kind: 'horizontal', line: bottom }] });
        expect(h.ok).toBe(true);
        expect(h.dof).toBe(0);
    });

    it('turning the instance (Block rotation) keeps the relations on it; they pull it back where they hold', () => {
        const { g } = plate();
        const ins = g.inserts![0];
        const withRel: SketchGeometry = { ...g, points: [...g.points, { id: 'q', u: 0, v: 0 }], curves: [...g.curves, { id: 'l', kind: 'line', a: 'q', b: ins.points[0] }] };
        const turned = placeInsert(withRel, ins.id, { at: ins.at, angle: 30, scale: 2 });
        expect(typeof turned).toBe('object');
        const t = turned as SketchGeometry;
        // The line still ends on the same (rebuilt) corner.
        expect(t.curves.find((c) => c.id === 'l')).toEqual({ id: 'l', kind: 'line', a: 'q', b: ins.points[0] });
        expect(t.inserts![0].points).toEqual(ins.points);
        const corner = P(t, ins.points[0]);
        const r = (30 * Math.PI) / 180;
        expect(d(corner, [20 + 2 * (-10 * Math.cos(r) + 5 * Math.sin(r)), 10 + 2 * (-10 * Math.sin(r) - 5 * Math.cos(r))])).toBeLessThan(1e-9);
    });

    it('dragging an instance slides it: every point by the pointer\'s move, exactly', () => {
        const { g } = plate();
        begin(g);
        const ins = geo().inserts![0];
        const before = ins.points.map((id) => P(geo(), id));
        expect(sketchDown([10, 10], 0.05)).toBe(true);
        sketchMove([13.5, 7.25], 0.05);
        sketchUp();
        const after = geo().inserts![0];
        after.points.forEach((id, i) => expect(d(P(geo(), id), [before[i][0] + 3.5, before[i][1] - 2.75])).toBeLessThan(1e-9));
        expect(after.at).toEqual([23.5, 7.25]);
        expect(after.angle).toBe(0);
        solvesCleanly();
    });

    it('a pinned instance turns about its pin when dragged; with Lock angle it stays put', () => {
        const { g } = plate();
        const ins = g.inserts![0];
        const pinned: SketchGeometry = { ...g, constraints: [{ id: 'k1', kind: 'fix', point: ins.origin! }] };
        begin(pinned);
        const before = shape(geo(), ins.id);
        sketchDown([30, 10], 0.05);
        sketchMove([30, 14], 0.05);
        sketchUp();
        const turned = geo().inserts![0];
        expect(turned.at).toEqual([20, 10]);
        expect(turned.angle).toBeGreaterThan(5);
        shape(geo(), ins.id).forEach((x, i) => expect(Math.abs(x - before[i])).toBeLessThan(1e-7));
        const locked = placeInsert(pinned, ins.id, ins, { lockAngle: true }) as SketchGeometry;
        begin(locked);
        expect(solveGeometry(locked).dof).toBe(0);
        sketchDown([30, 10], 0.05);
        sketchMove([30, 14], 0.05);
        sketchUp();
        expect(geo().inserts![0].angle).toBe(0);
        expect(P(geo(), ins.points[1])).toEqual(P(locked, ins.points[1]));
    });

    it('is shown under defined until relations hold it, then defined (all its points together)', () => {
        const { g } = plate();
        const ins = g.inserts![0];
        expect(rigidGroups(g).get(ins.points[0])).toHaveLength(ins.points.length);
        expect(definedEntities(g)?.has(ins.points[0])).toBe(false);
        const held: SketchGeometry = { ...g, constraints: [{ id: 'k1', kind: 'fix', point: ins.points[0] }, { id: 'k2', kind: 'fix', point: ins.points[1] }] };
        const r = solveGeometry(held);
        expect(r.dof).toBe(0);
    });

    it('an instance made before ids followed the block keeps its relations when it is built again', () => {
        const { g } = plate();
        const ins = g.inserts![0];
        // As an older sketch has it: other ids, no insertion point.
        const rename = new Map<string, string>(ins.points.slice(0, -1).map((id, i) => [id, `old${i}`]));
        ins.curves.forEach((id, i) => rename.set(id, `oldc${i}`));
        const r = (id: string) => rename.get(id) ?? id;
        const old: SketchGeometry = {
            ...g,
            points: g.points.filter((p) => p.id !== ins.origin).map((p) => ({ ...p, id: r(p.id) })),
            curves: g.curves.map((c) => JSON.parse(JSON.stringify(c), (k, v) => (typeof v === 'string' && k !== 'kind' ? r(v) : v))),
            constraints: [{ id: 'k1', kind: 'fix', point: 'old0' }],
            inserts: [{ id: ins.id, block: ins.block, at: ins.at, angle: 0, scale: 1, points: ins.points.slice(0, -1).map(r), curves: ins.curves.map(r) }],
        };
        expect(solveGeometry(old).dof).toBe(1);
        const rebuilt = placeInsert(old, ins.id, { at: ins.at, angle: 0, scale: 1 }) as SketchGeometry;
        expect(rebuilt.constraints).toEqual([{ id: 'k1', kind: 'fix', point: ins.points[0] }]);
        expect(rebuilt.inserts![0].origin).toBe(ins.origin);
        noDangling(rebuilt);
    });
});

describe('blocks holding text, equation curves and blocks', () => {
    function textAndPlate() {
        const { g, insert } = plate();
        const t = buildText(g, { id: 't1', text: 'O', font: 'Test Sans', height: 4, at: [12, 6], curves: [], points: [] }, { regular: FONT });
        if (typeof t === 'string') {
            throw new Error(t);
        }
        return { g: t.g, insert, text: t.item };
    }

    it('makes a block of a block instance and a text: nested, and the outer instance is one rigid body', () => {
        const { g, insert, text } = textAndPlate();
        const r = makeBlock(g, [g.inserts![0].curves[0], text.curves[0]], [0, 0], 'Panel');
        if (typeof r === 'string') {
            throw new Error(r);
        }
        expect(r.block.geometry.inserts?.map((i) => i.id)).toEqual([insert]);
        expect(r.block.geometry.texts?.map((t) => t.id)).toEqual(['t1']);
        expect(r.g.texts ?? []).toEqual([]);
        expect(r.g.inserts!.map((i) => i.block)).toEqual([r.block.id]);
        expect(r.g.blocks!.map((b) => b.name)).toEqual(['Plate', 'Panel']);
        // Every entity of the text and the plate is now the outer instance's.
        expect(r.insert.curves).toHaveLength(g.curves.length);
        expect(solveGeometry(r.g).dof).toBe(3);
        itemsIntact(r.g);
        noDangling(r.g);
        expect(profiles(r.g).length).toBeGreaterThanOrEqual(2);
    });

    it('exploding the outer instance gives the nested block and the text back as items; turned, the text becomes plain', () => {
        const { g, text } = textAndPlate();
        const made = makeBlock(g, [g.inserts![0].curves[0], text.curves[0]], [0, 0], 'Panel') as Exclude<ReturnType<typeof makeBlock>, string>;
        const straight = explodeWithNote(made.g, made.insert.id)!;
        expect(straight.note).toBeNull();
        expect(straight.g.texts).toHaveLength(1);
        expect(straight.g.inserts!.map((i) => i.block)).toEqual([made.g.blocks![0].id]);
        expect(solveGeometry(straight.g).dof).toBe(3);
        itemsIntact(straight.g);
        noDangling(straight.g);
        const turned = placeInsert(made.g, made.insert.id, { at: [5, 5], angle: 90, scale: 1 }) as SketchGeometry;
        const exploded = explodeWithNote(turned, made.insert.id)!;
        expect(exploded.note).toMatch(/text inside the block became plain entities/);
        expect(exploded.g.texts ?? []).toEqual([]);
        const nested = exploded.g.inserts![0];
        expect(nested.angle).toBe(90);
        // The nested plate's insertion point (20, 10) turned about (0, 0) and moved to (5, 5).
        expect(d(nested.at, [-5, 25])).toBeLessThan(1e-9);
        itemsIntact(exploded.g);
    });

    it('changing the inner block changes the outer block and all its instances', () => {
        const { g, text } = textAndPlate();
        const made = makeBlock(g, [g.inserts![0].curves[0], text.curves[0]], [0, 0], 'Panel') as Exclude<ReturnType<typeof makeBlock>, string>;
        const second = insertBlock(made.g, made.block.id, { at: [100, 0], angle: 0, scale: 1 }) as Exclude<ReturnType<typeof insertBlock>, string>;
        const inner = second.g.blocks![0];
        const bigger = { ...inner.geometry, curves: inner.geometry.curves.map((c) => (c.kind === 'circle' ? { ...c, radius: 4 } : c)) };
        const next = redefineBlock(second.g, inner.id, bigger);
        const outer = next.blocks!.find((b) => b.id === made.block.id)!;
        expect(outer.geometry.curves.filter((c) => c.kind === 'circle').map((c) => (c as { radius: number }).radius)).toEqual([4]);
        for (const ins of next.inserts!) {
            expect(next.curves.filter((c) => ins.curves.includes(c.id) && c.kind === 'circle').map((c) => (c as { radius: number }).radius)).toEqual([4]);
        }
        itemsIntact(next);
        noDangling(next);
    });

    it('a block cannot be placed inside itself while it is open', () => {
        const { g } = plate();
        begin(g);
        useSketcher.setState({ selection: [{ type: 'curve', id: g.inserts![0].curves[0] }] });
        expect(startBlockEdit(g.inserts![0].id, false)).toBeNull();
        const form = press('sk-block-insert');
        form.values = { ...form.values, block: g.blocks![0].id, x: '0', y: '0', angle: '0', scale: '1' };
        return form.apply().then((r) => {
            expect(r.isError).toBe(true);
            expect(r.text).toMatch(/instance of itself/);
            finishBlockEdit(false);
        });
    });
});

describe('add/remove, rebuild, link, colour, hide, construction', () => {
    it('removes the hole from the block: it stays in the sketch at this instance, other instances lose it', () => {
        const { g } = plate();
        const two = insertBlock(g, g.blocks![0].id, { at: [60, 0], angle: 0, scale: 1 }) as Exclude<ReturnType<typeof insertBlock>, string>;
        const ins = two.g.inserts![0];
        const hole = ins.curves.find((c) => two.g.curves.find((x) => x.id === c)?.kind === 'circle')!;
        const r = addRemoveEntities(two.g, ins.id, [], [hole]) as SketchGeometry;
        expect(r.blocks![0].geometry.curves.some((c) => c.kind === 'circle')).toBe(false);
        const plain = r.curves.filter((c) => c.kind === 'circle');
        expect(plain).toHaveLength(1);
        expect(r.inserts!.every((i) => !i.curves.includes(plain[0].id))).toBe(true);
        expect(P(r, (plain[0] as { center: string }).center)).toEqual([20, 10]);
        expect(r.points.find((p) => p.id === (plain[0] as { center: string }).center)?.fixed).toBeUndefined();
        itemsIntact(r);
        noDangling(r);
        expect(solveGeometry(r).ok).toBe(true);
    });

    it('adds a sketch line to the block: every instance gets it, with its relation to the instance', () => {
        const { g } = plate();
        const two = insertBlock(g, g.blocks![0].id, { at: [60, 0], angle: 90, scale: 2 }) as Exclude<ReturnType<typeof insertBlock>, string>;
        const ins = two.g.inserts![1];
        const corner = ins.points[2];
        const l = addLine(two.g, { at: P(two.g, corner) }, { at: [80, 30] });
        const line = l.g.curves.find((c) => c.id === l.id) as { a: string };
        const tied: SketchGeometry = { ...l.g, constraints: [...l.g.constraints, { id: 'kc', kind: 'coincident', a: line.a, b: corner }] };
        const r = addRemoveEntities(tied, ins.id, [l.id], []) as SketchGeometry;
        expect(typeof r).toBe('object');
        expect(r.curves.some((c) => c.id === l.id)).toBe(false);
        expect(r.blocks![0].geometry.curves.filter((c) => c.kind === 'line')).toHaveLength(5);
        // The relation to the corner went into the block.
        expect(r.blocks![0].geometry.constraints.some((k) => k.kind === 'coincident')).toBe(true);
        for (const i of r.inserts!) {
            expect(r.curves.filter((c) => i.curves.includes(c.id) && c.kind === 'line')).toHaveLength(5);
        }
        // The added line's far end sits where it was, in the instance it was added at.
        const added = r.curves.filter((c) => r.inserts![1].curves.includes(c.id) && c.kind === 'line').map((c) => c as { a: string; b: string });
        expect(added.some((c) => d(P(r, c.b), [80, 30]) < 1e-9 || d(P(r, c.a), [80, 30]) < 1e-9)).toBe(true);
        itemsIntact(r);
        noDangling(r);
    });

    it('Rebuild block while editing applies the block to the sketch, and the relation to it holds again', () => {
        const { g } = plate();
        const ins = g.inserts![0];
        // A fixed line end coincident with the instance's top right corner.
        const withLine: SketchGeometry = {
            ...g, points: [...g.points, { id: 'q', u: 50, v: 30 }, { id: 'e', u: 30, v: 15 }], curves: [...g.curves, { id: 'l', kind: 'line', a: 'q', b: 'e' }],
            constraints: [{ id: 'k1', kind: 'fix', point: 'q' }, { id: 'k2', kind: 'coincident', a: 'e', b: ins.points[2] }],
        };
        begin(withLine);
        expect(startBlockEdit(ins.id, false)).toBeNull();
        // In the block: move the rectangle's right side out by 5 (its corner points by 5 in u).
        const inside = useSketcher.getState().geometry;
        const moved: SketchGeometry = { ...inside, constraints: [], points: inside.points.map((p) => (p.u > 25 ? { ...p, u: p.u + 5 } : p)) };
        commitGeometry(moved);
        expect(rebuildBlockEdit()).toBeNull();
        expect(blockEditing()).not.toBeNull();
        const outer = blockEditing()!.outer;
        expect(d(P(outer, 'e'), P(outer, ins.points[2]))).toBeLessThan(1e-9);
        expect(finishBlockEdit(true)).toBeNull();
        expect(d(P(geo(), 'e'), P(geo(), ins.points[2]))).toBeLessThan(1e-9);
        // The corner is 5 further right of the insertion point than it was (15, 5 in the block).
        expect(d(P(geo(), ins.points[2]), geo().inserts![0].at)).toBeCloseTo(Math.hypot(15, 5), 9);
    });

    it('Link to file: a linked block follows its file and cannot be edited here', () => {
        const { g } = plate();
        const block = g.blocks![0];
        const linked: SketchGeometry = { ...g, blocks: [{ ...block, link: 'Plate' }] };
        begin(linked);
        expect(startBlockEdit(g.inserts![0].id, false)).toMatch(/linked to the file Plate/);
        const file = blockFileOf(linked, block.id, 'Plate')!;
        expect(updateFromFile(linked, block.id, file)).toBeNull();
        const changed = { ...file, geometry: { ...file.geometry, curves: file.geometry.curves.filter((c) => c.kind !== 'circle') }, colour: '#00ff00' };
        const next = updateFromFile(linked, block.id, changed)!;
        expect(next.blocks).toHaveLength(1);
        expect(next.blocks![0].link).toBe('Plate');
        expect(next.blocks![0].colour).toBe('#00ff00');
        expect(next.curves.some((c) => c.kind === 'circle')).toBe(false);
        itemsIntact(next);
        noDangling(next);
    });

    it('a block file keeps its nested blocks; reading it in maps them to blocks of the sketch', () => {
        const { g } = plate();
        const outer = makeBlock(g, [g.inserts![0].curves[0]], [0, 0], 'Holder') as Exclude<ReturnType<typeof makeBlock>, string>;
        const file = blockFileOf(outer.g, outer.block.id, 'Holder')!;
        expect(file.blocks?.map((b) => b.name)).toEqual(['Plate']);
        const read = addBlockDefinition(EMPTY_GEOMETRY, file.name, file.geometry, { blocks: file.blocks });
        expect(read.g.blocks!.map((b) => b.name)).toEqual(['Plate', 'Holder']);
        expect(read.block.geometry.inserts![0].block).toBe(read.g.blocks![0].id);
        const placed = insertBlock(read.g, read.block.id, { at: [0, 0], angle: 0, scale: 1 }) as Exclude<ReturnType<typeof insertBlock>, string>;
        expect(placed.insert.curves).toHaveLength(5);
        // The same file again: nothing new.
        expect(addBlockDefinition(read.g, file.name, file.geometry, { blocks: file.blocks }).g.blocks).toHaveLength(2);
    });

    it('colour, hide and For construction', () => {
        const { g } = plate();
        const ins = g.inserts![0];
        const coloured: SketchGeometry = { ...g, blocks: [{ ...g.blocks![0], colour: '#ff8800' }] };
        expect(blockLook(coloured).colour.get(ins.curves[0])).toBe('#ff8800');
        begin(coloured);
        expect(pickAt(geo(), [10, 10], 0.05)?.id).toBe(ins.curves[3]);
        setHidden(ins.id, true);
        expect(blockLook(geo()).hidden.has(ins.curves[0])).toBe(true);
        expect(pickAt(geo(), [10, 10], 0.05)).toBeNull();
        showHiddenBlocks();
        expect(geo().inserts![0].hidden).toBeUndefined();
        const construction = placeInsert(g, ins.id, ins, { construction: true }) as SketchGeometry;
        expect(construction.curves.filter((c) => ins.curves.includes(c.id)).every((c) => c.construction)).toBe(true);
        expect(profiles(construction)).toEqual([]);
    });
});
