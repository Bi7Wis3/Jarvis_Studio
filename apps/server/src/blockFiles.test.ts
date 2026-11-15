import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A projects folder of its own, so nothing is written next to real projects.
const scratch = mkdtempSync(join(tmpdir(), 'jarvis-blocks-'));
let files: typeof import('./blockFiles.js');

beforeAll(async () => {
    process.env.JARVIS_PROJECTS_DIR = scratch;
    files = await import('./blockFiles.js');
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('block files', () => {
    const geometry = { points: [{ id: 'a', u: 0, v: 0 }, { id: 'b', u: 5, v: 0 }], curves: [{ id: 'l', kind: 'line' as const, a: 'a', b: 'b' }], constraints: [] };

    it('saves a block under its name in the projects folder, lists it and reads it back', () => {
        expect(files.BLOCKS_DIR).toBe(join(scratch, 'blocks'));
        expect(files.saveBlockFile({ name: ' Bracket 2 ', geometry })).toBe('Bracket 2');
        expect(files.listBlockFiles()).toEqual(['Bracket 2']);
        expect(files.readBlockFile('Bracket 2')).toEqual({ name: 'Bracket 2', geometry });
        // Saving under the same name replaces the file.
        files.saveBlockFile({ name: 'Bracket 2', geometry: { ...geometry, curves: [] } });
        expect(files.readBlockFile('Bracket 2')?.geometry.curves).toEqual([]);
    });

    it('keeps text, block instances, the nested definitions and the colour; drops other keys', () => {
        const inner = { id: 'blk1', name: 'Pin', geometry };
        const outer = {
            ...geometry,
            texts: [{ id: 't1', text: 'A', font: 'DejaVu Sans', height: 5, at: [0, 0] as [number, number], curves: [], points: [] }],
            inserts: [{ id: 'ins1', block: 'blk1', at: [1, 2] as [number, number], angle: 0, scale: 1, curves: [], points: [] }],
            pictures: [{ id: 'x' }],
        };
        files.saveBlockFile({ name: 'Arm', geometry: outer, colour: '#ff0000', blocks: [inner] });
        const back = files.readBlockFile('Arm')!;
        expect(back.colour).toBe('#ff0000');
        expect(back.blocks).toEqual([inner]);
        expect(back.geometry.texts).toEqual(outer.texts);
        expect(back.geometry.inserts).toEqual(outer.inserts);
        expect('pictures' in back.geometry).toBe(false);
        expect(() => files.saveBlockFile({ name: 'Bad', geometry, colour: 'red' })).toThrow(/Expected/);
    });

    it('refuses names that could leave the folder, and bad bodies', () => {
        expect(() => files.saveBlockFile({ name: '../escape', geometry })).toThrow(/letters, digits/);
        expect(() => files.saveBlockFile({ name: 'x' })).toThrow(/Expected/);
        expect(files.readBlockFile('../../etc/passwd')).toBeNull();
        expect(files.readBlockFile('No such block')).toBeNull();
    });
});
