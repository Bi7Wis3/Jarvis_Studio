import { describe, expect, it, vi } from 'vitest';
import { transformWithItems } from './sketchItemTransform';
import { withItems } from './audit/harness';
import { placeInsert } from './sketchBlocks';
import { buildEquation } from './sketchEquation';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

describe('move, copy, rotate and scale of text and block instances', () => {
    it('moves a text by its start point', () => {
        const items = withItems();
        const r = transformWithItems(items.g, [items.g.texts![0].curves[1]], { kind: 'move', by: [5.5, -2] }, false);
        expect(r && !('error' in r)).toBe(true);
        const g = (r as { g: typeof items.g }).g;
        expect(g.texts![0].at).toEqual([205.5, 98]);
    });

    it('turns and scales a block instance by its insertion point, angle and scale, as a rebuild places it', () => {
        const items = withItems();
        const ins = items.g.inserts![0];
        const turned = transformWithItems(items.g, [ins.curves[0]], { kind: 'rotate', centre: [0, 0], angle: 30 }, false);
        const scaled = turned && !('error' in turned) ? transformWithItems(turned.g, [ins.curves[1]], { kind: 'scale', centre: [10, 5], factor: 1.5 }, false) : null;
        expect(scaled && !('error' in scaled)).toBe(true);
        const g = (scaled as { g: typeof items.g }).g;
        const now = g.inserts![0];
        expect(now.angle).toBeCloseTo(30, 12);
        expect(now.scale).toBeCloseTo(1.5, 12);
        // Built again from the block at the new placement, it lands where the transform put it.
        const rebuilt = placeInsert(g, now.id, now);
        expect(typeof rebuilt).not.toBe('string');
        const pts = (x: typeof g) => x.inserts![0].points.map((id) => x.points.find((p) => p.id === id)!).map((p) => [p.u, p.v]).sort();
        const [a, b] = [pts(g), pts(rebuilt as typeof g)];
        a.forEach((p, i) => {
            expect(p[0]).toBeCloseTo(b[i][0], 9);
            expect(p[1]).toBeCloseTo(b[i][1], 9);
        });
    });

    it('copies a text and a block instance as new items', () => {
        const items = withItems();
        const r = transformWithItems(items.g, [items.g.texts![0].curves[0], items.g.inserts![0].curves[0]], { kind: 'move', by: [0, 30] }, true);
        expect(r && !('error' in r)).toBe(true);
        const g = (r as { g: typeof items.g }).g;
        expect(g.texts).toHaveLength(2);
        expect(g.texts![1].at).toEqual([200, 130]);
        expect(g.inserts).toHaveLength(2);
        expect(g.inserts![1].at).toEqual([150, -30]);
    });

    it('refuses to turn a text or an equation curve, and leaves other curves to the plain transform', () => {
        const items = withItems();
        const r = transformWithItems(items.g, [items.g.texts![0].curves[0]], { kind: 'rotate', centre: [0, 0], angle: 10 }, false);
        expect(r && 'error' in r && r.error).toMatch(/no rotation/);
        const e = transformWithItems(items.g, [items.g.equations![0].curves[0]], { kind: 'scale', centre: [0, 0], factor: 2 }, false);
        expect(e && 'error' in e && e.error).toMatch(/not scaled/);
        expect(transformWithItems(items.g, ['bl-missing'], { kind: 'move', by: [1, 1] }, false)).toBeNull();
    });

    it('moves an equation curve by its offset, so building it again leaves it where it was moved to', () => {
        const items = withItems();
        const r = transformWithItems(items.g, [items.g.equations![0].curves[0]], { kind: 'move', by: [5.5, -2] }, false);
        const g = (r as { g: typeof items.g }).g;
        const e = g.equations![0];
        expect(e.offset).toEqual([5.5, -2]);
        const rebuilt = buildEquation(g, e);
        expect(typeof rebuilt).not.toBe('string');
        const spline = (x: typeof g, id: string) => {
            const c = x.curves.find((k) => k.id === id) as { points: string[] };
            return c.points.map((p) => x.points.find((q) => q.id === p)!).map((p) => [p.u, p.v]);
        };
        const [moved, again] = [spline(g, e.curves[0]), spline((rebuilt as { g: typeof g }).g, (rebuilt as { item: typeof e }).item.curves[0])];
        expect(again.length).toBe(moved.length);
        again.forEach((p, i) => {
            expect(p[0]).toBeCloseTo(moved[i][0], 9);
            expect(p[1]).toBeCloseTo(moved[i][1], 9);
        });
        const copy = transformWithItems(g, [e.curves[0]], { kind: 'move', by: [0, 10] }, true);
        const cg = (copy as { g: typeof g }).g;
        expect(cg.equations).toHaveLength(2);
        expect(cg.equations![1].offset).toEqual([5.5, 8]);
    });
});
