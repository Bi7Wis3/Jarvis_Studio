import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, type Feature, type Project } from '@jarvis/core';
import { hiddenSteps } from '@jarvis/core/visibility';
import { encodeMesh3 } from './meshes.js';
import { ProjectStore } from './store.js';
import { createTools } from './tools.js';

const sketch = (id: string): Feature => ({
    id, name: id, op: 'sketch', sketch: { plane: 'top', profiles: [{ kind: 'rect', center: [0, 0], width: 10, height: 10 }] },
});

function project(): Project {
    return {
        name: 'Sketches',
        parts: [{
            id: 'p1', name: 'Block', shape: { kind: 'empty' }, position: [0, 0, 0], rotation: [0, 0, 0],
            material: { color: '#cccccc', metalness: 0, roughness: 0.5 }, features: [sketch('s1'), sketch('s2')],
        }],
        // Sketch1 was shown by its eye before any feature used it.
        view: { ...DEFAULT_VIEW, shownSketches: ['p1/s1', 'p1/s2'] },
    };
}

describe('sketch visibility on OK', () => {
    it('hides the sketch a new feature is built from, and only that one', () => {
        const store = ProjectStore.scratch(project());
        const tools = createTools(store);
        const run = (name: string, args: unknown) => tools.find((t) => t.name === name)!.run(args);
        expect(hiddenSteps(store.get().view, store.get().parts).has('p1/s1')).toBe(false);
        run('features_add', { partId: 'p1', features: [{ op: 'extrude', mode: 'add', distance: 5, sketchRef: 's1' }] });
        const { view, parts } = store.get();
        expect(view.shownSketches).toEqual(['p1/s2']);
        expect(hiddenSteps(view, parts).has('p1/s1')).toBe(true);
        expect(hiddenSteps(view, parts).has('p1/s2')).toBe(false);
    });

    it('hides a sketch a feature is given to build from instead', () => {
        const store = ProjectStore.scratch(project());
        const tools = createTools(store);
        const run = (name: string, args: unknown) => tools.find((t) => t.name === name)!.run(args);
        run('features_add', { partId: 'p1', features: [{ id: 'e1', op: 'extrude', mode: 'add', distance: 5, sketchRef: 's1' }] });
        run('features_update', { partId: 'p1', updates: [{ id: 'e1', sketchRef: 's2' }] });
        expect(store.get().view.shownSketches).toEqual([]);
        // A plain change of value leaves a sketch shown since.
        store.mutate((draft) => {
            draft.view.shownSketches = ['p1/s2'];
        });
        run('features_update', { partId: 'p1', updates: [{ id: 'e1', distance: 7 }] });
        expect(store.get().view.shownSketches).toEqual(['p1/s2']);
    });
});

describe('mesh3 wire format', () => {
    it('carries the bodies, their faces and edges, and the cosmetic thread marks', () => {
        const buffer = encodeMesh3({
            positions: new Float32Array(9), normals: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), edges: new Float32Array(6),
            triFace: new Uint32Array(1), segEdge: new Uint32Array(1), faceBody: Uint32Array.from([1]), edgeBody: Uint32Array.from([1]),
            bodies: [{ key: 'base', by: '' }, { key: 'b2', by: 'b2' }], cosmetic: new Float32Array(12), cosmeticBody: Uint32Array.from([0, 1]),
        });
        const words = new Uint32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length));
        expect([...words.slice(0, 6)]).toEqual([9, 3, 6, 1, 1, 12]);
        // Header, positions, normals, indices, edges, triFace, segEdge, then faceBody, edgeBody, cosmetic, cosmeticBody, JSON.
        const faceBody = 7 + 9 + 9 + 3 + 6 + 1 + 1;
        expect([words[faceBody], words[faceBody + 1]]).toEqual([1, 1]);
        expect([...words.slice(faceBody + 2 + 12, faceBody + 2 + 12 + 2)]).toEqual([0, 1]);
        const json = faceBody + 2 + 12 + 2;
        expect(JSON.parse(buffer.subarray(json * 4).toString('utf8'))).toEqual({ bodies: [{ key: 'base', by: '' }, { key: 'b2', by: 'b2' }] });
        expect(buffer.length % 4).toBe(0);
    });
});
