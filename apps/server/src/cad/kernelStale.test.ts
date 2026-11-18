import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PRINT, type Shape, type Vec3 } from '@jarvis/core';
import { CadJobDropped, CadKernel, type MeshData } from './kernel.js';

const SLOW = 600_000;

let kernel: CadKernel;

beforeAll(() => {
    kernel = CadKernel.start();
});

afterAll(async () => {
    await kernel.close();
});

const box = (x: number): { shape: Shape } => ({ shape: { kind: 'box', size: [x, 10, 10] as Vec3, radius: 0 } });

describe('queued mesh jobs of a state edited again', () => {
    it('are dropped when their turn comes, unless still wanted or awaited by someone else', async () => {
        await kernel.mesh(box(5), DEFAULT_PRINT);
        const wanted = new Set(['running', 'b', 'c', 'd']);
        const want = (name: string) => ({ stale: () => !wanted.has(name) });
        // The first starts at once; the others wait their turn.
        const running = kernel.mesh(box(6), DEFAULT_PRINT, undefined, 'normal', want('running'));
        const b = kernel.mesh(box(7), DEFAULT_PRINT, undefined, 'normal', want('b'));
        const c = kernel.mesh(box(8), DEFAULT_PRINT, undefined, 'normal', want('c'));
        const d = kernel.mesh(box(9), DEFAULT_PRINT, undefined, 'normal', want('d'));
        // An export waits for the same mesh as d: d is no longer droppable.
        const exported = kernel.mesh(box(9), DEFAULT_PRINT);
        wanted.clear();
        wanted.add('c');
        await expect(running).resolves.toBeTruthy();
        await expect(b).rejects.toBeInstanceOf(CadJobDropped);
        await expect(c).resolves.toBeTruthy();
        await expect(d).resolves.toBe(await exported);
        // A dropped mesh is built when it is asked for again.
        await expect(kernel.mesh(box(7), DEFAULT_PRINT)).resolves.toBeTruthy();
    }, SLOW);

    it('sends a coarse mesh ahead of a mesh that takes a while, and only then', async () => {
        // A plate with 400 small holes (script Z-up): hundreds of curved faces.
        const code = `let plate = r.makeBaseBox(80, 80, 2);
            const pins = [];
            for (let i = 0; i < 400; i++) pins.push(r.makeCylinder(0.5, 4, [-38 + 4 * (i % 20), -38 + 4 * Math.floor(i / 20), -1]));
            return plate.cut(r.makeCompound(pins));`;
        const early: MeshData[] = [];
        const done = await kernel.mesh({ shape: { kind: 'script', code, size: [80, 2, 80] } }, DEFAULT_PRINT, undefined, 'normal',
            { interim: (mesh) => early.push(mesh) });
        expect(early).toHaveLength(1);
        expect(early[0].indices.length).toBeLessThan(done.indices.length);
        const quick: MeshData[] = [];
        await kernel.mesh(box(11), DEFAULT_PRINT, undefined, 'normal', { interim: (mesh) => quick.push(mesh) });
        expect(quick).toHaveLength(0);
    }, SLOW);
});

describe('a worker that dies while starting', () => {
    it('fails the jobs waiting for it instead of starting workers in a loop, and the next job starts a new one', async () => {
        const fresh = CadKernel.start();
        try {
            const waiting = fresh.mesh(box(3), DEFAULT_PRINT);
            await (fresh as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
            await expect(waiting).rejects.toThrow(/CAD worker/);
            expect(fresh.activity().queue).toHaveLength(0);
            const built = await fresh.mesh(box(4), DEFAULT_PRINT);
            expect(built.indices.length).toBeGreaterThan(0);
        } finally {
            await fresh.close();
        }
    }, SLOW);
});
