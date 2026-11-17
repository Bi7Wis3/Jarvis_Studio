import { rmSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dir = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const d = mkdtempSync(path.join(os.tmpdir(), 'jarvis-mates-test-'));
    process.env.JARVIS_PROJECTS_DIR = d;
    return d;
});

import type { Part, Vec3 } from '@jarvis/core';
import type { MateGeom } from '@jarvis/core/mates';
import { ProjectStore } from './store.js';
import { MateService, mateTools, type MateKernel } from './mates.js';
import { createTools } from './tools.js';
import type { HostTool } from './tools.js';
import type { ModelMatePick } from './cad/mateEntities.js';

/** A kernel that knows a few faces by where they were picked: x of the pick names the face. */
let faces: Record<string, MateGeom> = {};
const kernel: MateKernel = {
    entities: async (_part, _print, picks: ModelMatePick[]) => picks.map((p) => faces[String(p.at[0])] ?? { error: 'the face picked is no longer on the part' }),
};

const material = { color: '#888888', metalness: 0, roughness: 1 };
const part = (id: string, position: Vec3): Part => ({ id, name: id, shape: { kind: 'empty' }, position, rotation: [0, 0, 0], material });

let store: ProjectStore;
let tools: HostTool[];
const run = async (name: string, args: unknown): Promise<string> => (await tools.find((t) => t.name === name)!.run(args)).text;
const face = (partId: string, x: number) => ({ part: partId, pick: { kind: 'face', at: [x, 0, 0] } });

beforeEach(() => {
    store = new ProjectStore();
    store.remove('mates');
    store.create('mates');
    store.mutate((draft) => {
        draft.parts = [part('plate', [0, 0, 0]), part('pin', [12, 40, -3]), part('block', [50, 30, 0])];
    });
    faces = {
        1: { type: 'cylinder', point: [10, 0, 0], direction: [0, 1, 0], radius: 3, inside: true },
        2: { type: 'cylinder', point: [0, 0, 0], direction: [0, 1, 0], radius: 2.9 },
        3: { type: 'plane', origin: [0, 10, 0], normal: [0, 1, 0] },
        4: { type: 'plane', origin: [0, 5, 0], normal: [0, -1, 0] },
        5: { type: 'plane', origin: [0, -5, 0], normal: [0, -1, 0] },
    };
    tools = mateTools(store, kernel);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('mate tools', () => {
    it('adds a concentric and a coincident mate, moves the pin into the hole, and undo takes both back', async () => {
        const text = await run('mates_add', {
            mates: [
                { type: 'concentric', refs: [face('plate', 1), face('pin', 2)] },
                { type: 'coincident', refs: [face('plate', 3), face('pin', 4)] },
            ],
        });
        expect(text).toContain('Added Concentric1, Coincident1.');
        expect(text).toContain('Moved: pin.');
        expect(text).toContain('(-) pin (pin): 1 degree(s) of freedom left');
        const pin = store.get().parts.find((p) => p.id === 'pin')!;
        expect(pin.position[0]).toBeCloseTo(10, 6);
        expect(pin.position[1]).toBeCloseTo(5, 6);
        expect(pin.position[2]).toBeCloseTo(0, 6);
        const mates = store.get().assembly!.mates;
        expect(mates.map((m) => [m.name, m.alignment])).toEqual([['Concentric1', 'aligned'], ['Coincident1', 'antiAligned']]);
        expect(mates[0].refs[0].found).toEqual(faces[1]);
        store.undo();
        expect(store.get().assembly).toBeUndefined();
        expect(store.get().parts.find((p) => p.id === 'pin')!.position).toEqual([12, 40, -3]);
        store.redo();
        expect(store.get().assembly!.mates).toHaveLength(2);
    });

    it('adds a distance mate at the distance the parts stand, then edits its value', async () => {
        await run('mates_add', { mates: [{ type: 'distance', refs: [face('plate', 3), face('block', 5)] }] });
        let mate = store.get().assembly!.mates[0];
        expect(mate.value).toBeCloseTo(15, 9);
        expect(store.get().parts.find((p) => p.id === 'block')!.position).toEqual([50, 30, 0]);
        const text = await run('mates_update', { updates: [{ id: 'Distance1', value: 2.5 }] });
        expect(text).toContain('Moved: block.');
        mate = store.get().assembly!.mates[0];
        expect(mate.value).toBe(2.5);
        expect(store.get().parts.find((p) => p.id === 'block')!.position[1]).toBeCloseTo(17.5, 6);
    });

    it('positions only, without keeping the mate', async () => {
        const text = await run('mates_add', { mates: [{ type: 'coincident', refs: [face('plate', 3), face('block', 5)] }], positionOnly: true });
        expect(text).toContain('Positioned only');
        expect(store.get().assembly).toBeUndefined();
        expect(store.get().parts.find((p) => p.id === 'block')!.position[1]).toBeCloseTo(15, 6);
    });

    it('reports an over defining mate, and a lost face, without failing', async () => {
        await run('mates_add', { mates: [{ type: 'coincident', refs: [face('plate', 3), face('block', 5)] }] });
        const text = await run('mates_add', { mates: [{ type: 'distance', value: 4, refs: [face('plate', 3), face('block', 5)] }] });
        expect(text).toMatch(/Distance1 .*ERROR: This mate is over defining the assembly/);
        expect(store.get().parts.find((p) => p.id === 'block')!.position[1]).toBeCloseTo(15, 6);
        const lost = await run('mates_add', { mates: [{ type: 'coincident', refs: [face('plate', 9), face('pin', 4)] }] });
        expect(lost).toMatch(/ERROR: One of the entities of this mate is suppressed, invalid, or no longer present/);
    });

    it('fixes and floats, suppresses, folders and deletes', async () => {
        await run('mates_add', { mates: [{ type: 'coincident', refs: [face('plate', 3), face('block', 5)] }], newFolder: 'Base' });
        expect(store.get().assembly!.folders).toEqual([{ id: 'mate-folder-1', name: 'Base', mates: ['mate-1'] }]);
        await run('components_fix', { ids: ['block'], fixed: true });
        expect(store.get().assembly!.fixed).toEqual(['plate', 'block']);
        await run('components_fix', { ids: ['plate'], fixed: false });
        expect(store.get().assembly!.fixed).toEqual(['block']);
        await run('mates_update', { updates: [{ id: 'mate-1', suppressed: true }] });
        expect(await run('mates_get', {})).toContain('Coincident1 (mate-1, coincident): suppressed');
        await run('mate_folders', { action: 'rename', id: 'mate-folder-1', name: 'Bottom' });
        expect(store.get().assembly!.folders![0].name).toBe('Bottom');
        await run('mates_remove', { ids: ['Coincident1'] });
        expect(store.get().assembly!.mates).toEqual([]);
        expect(store.get().assembly!.folders![0].mates).toEqual([]);
    });

    it('drops the mates of a deleted part', async () => {
        await run('mates_add', { mates: [{ type: 'coincident', refs: [face('plate', 3), face('block', 5)] }] });
        store.mutate((draft) => {
            draft.parts = draft.parts.filter((p) => p.id !== 'block');
        });
        expect(store.get().assembly!.mates).toEqual([]);
    });

    it('moves a component within its freedom', async () => {
        await run('mates_add', { mates: [{ type: 'coincident', refs: [face('plate', 3), face('block', 5)] }] });
        const text = await run('components_move', { id: 'block', position: [20, 99, 7] });
        expect(text).toContain('Moved: block.');
        const block = store.get().parts.find((p) => p.id === 'block')!;
        expect(block.position[0]).toBeCloseTo(20, 3);
        expect(block.position[1]).toBeCloseTo(15, 6);
        expect(block.position[2]).toBeCloseTo(7, 3);
    });
});

describe('mate service', () => {
    it('solves the mates again when a mated face moves with its part\'s edit, as part of that change', async () => {
        vi.useFakeTimers();
        try {
            await run('mates_add', { mates: [{ type: 'coincident', refs: [face('plate', 3), face('block', 5)] }] });
            const service = new MateService(store, kernel);
            const stop = store.subscribe(() => service.check());
            // The plate gets thicker: its top face is now at y = 12.
            faces[3] = { type: 'plane', origin: [0, 12, 0], normal: [0, 1, 0] };
            store.mutate((draft) => {
                draft.parts[0].name = 'plate (thicker)';
            });
            await vi.advanceTimersByTimeAsync(100);
            await vi.advanceTimersByTimeAsync(100);
            stop();
            service.stop();
            expect(store.get().parts.find((p) => p.id === 'block')!.position[1]).toBeCloseTo(17, 6);
            expect(store.get().assembly!.mates[0].refs[0].found).toEqual(faces[3]);
            // One undo takes back the edit and what followed from it.
            store.undo();
            expect(store.get().parts[0].name).toBe('plate');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('a drag in the view', () => {
    it('is saved as one parts_update, so one undo puts back every part it moved', async () => {
        await run('mates_add', { mates: [{ type: 'concentric', refs: [face('plate', 1), face('pin', 2)] }] });
        const before = JSON.stringify(store.get().parts);
        // What the view sends on release: the dragged part and the parts its mates moved with it.
        const update = createTools(store).find((t) => t.name === 'parts_update')!;
        update.run({ updates: [{ id: 'pin', position: [10, 55, 0], rotation: [0, 40, 0] }, { id: 'block', position: [1, 2, 3], rotation: [0, 0, 0] }] });
        expect(store.get().parts.find((p) => p.id === 'pin')!.position).toEqual([10, 55, 0]);
        store.undo();
        expect(JSON.stringify(store.get().parts)).toBe(before);
    });
});
