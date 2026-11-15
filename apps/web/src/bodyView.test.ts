import { describe, expect, it } from 'vitest';
import type { Feature } from '@jarvis/core';
import { setBodyView } from '@jarvis/core/visibility';
import { bodiesLabel, bodyLooks, bodyName, bodyRows, maskedEdges, maskedIndex, shownMarks, triangleLooks } from './bodyView';
import { decode } from './meshes';

const features = [
    { id: 'e1', name: 'Boss-Extrude1', op: 'extrude', mode: 'add', distance: 5, sketchRef: 's1' },
    { id: 'c1', name: 'Cut-Extrude1', op: 'extrude', mode: 'cut', distance: 5, sketchRef: 's2' },
] as unknown as Feature[];

describe('Solid Bodies folder', () => {
    it('names each body after the step that changed it last, numbered when one step changed several', () => {
        expect(bodyName({ key: 'e1', by: 'e1' }, features)).toBe('Boss-Extrude1');
        expect(bodyName({ key: 'e1', by: 'c1', n: 2 }, features)).toBe('Cut-Extrude1[2]');
        expect(bodyName({ key: 'base', by: '' }, features)).toBe('Base body');
        expect(bodiesLabel(1)).toBe('Solid Bodies(1)');
    });

    it('lists the bodies with their hidden and see-through state from the view', () => {
        const view = { ...setBodyView({}, 'p1', 'b', { hidden: true }), seeThroughBodies: ['p1/a', 'p2/b'] };
        const rows = bodyRows([{ key: 'a', by: 'e1' }, { key: 'b', by: 'c1', n: 1 }], features, 'p1', view);
        expect(rows).toEqual([
            { key: 'a', index: 0, name: 'Boss-Extrude1', hidden: false, seeThrough: true },
            { key: 'b', index: 1, name: 'Cut-Extrude1[1]', hidden: true, seeThrough: false },
        ]);
        // Showing it again and making it opaque clear the lists.
        expect(setBodyView(view, 'p1', 'b', { hidden: false })).toEqual({ hiddenBodies: [], seeThroughBodies: ['p1/a', 'p2/b'] });
    });
});

describe('bodies in the view', () => {
    // Two triangles on face 0 (body 0) and one on face 1 (body 1).
    const index = [0, 1, 2, 2, 1, 3, 4, 5, 6];
    const triFace = [0, 0, 1];
    const faceBody = [0, 1];

    it('collapses the triangles of a body drawn otherwise, so triangle numbers still name the same faces', () => {
        const looks = bodyLooks([{ key: 'a', by: '' }, { key: 'b', by: 'x' }], 'p1', { seeThroughBodies: ['p1/b'] });
        expect(looks).toEqual([0, 1]);
        const tri = triangleLooks(triFace, faceBody, looks);
        expect([...tri]).toEqual([0, 0, 1]);
        expect([...maskedIndex(index, tri, 0)]).toEqual([0, 1, 2, 2, 1, 3, 4, 4, 4]);
        expect([...maskedIndex(index, tri, 1)]).toEqual([0, 0, 0, 2, 2, 2, 4, 5, 6]);
    });

    it('drops the edges and cosmetic thread marks of a hidden body', () => {
        const looks = bodyLooks([{ key: 'a', by: '' }, { key: 'b', by: 'x' }], 'p1', { hiddenBodies: ['p1/a'] });
        expect(looks).toEqual([2, 0]);
        // Segment 0 on edge 0 (body 0), segment 1 on edge 1 (body 1).
        const edges = [0, 0, 0, 1, 0, 0, 5, 5, 5, 6, 5, 5];
        expect([...maskedEdges(edges, [0, 1], [0, 1], looks)]).toEqual([0, 0, 0, 0, 0, 0, 5, 5, 5, 6, 5, 5]);
        const marks = Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]);
        expect([...shownMarks(marks, [0, 1], looks)]).toEqual([2, 2, 2, 3, 3, 3]);
        // Nothing hidden: the marks as they are.
        expect(shownMarks(marks, [0, 1], [0, 1])).toBe(marks);
    });
});

describe('mesh3 responses', () => {
    it('read the bodies, which body each face and edge is on, and the cosmetic thread marks', () => {
        const json = new TextEncoder().encode(JSON.stringify({ bodies: [{ key: 'base', by: '' }, { key: 'b2', by: 'b2', n: 1 }] }));
        const padded = Math.ceil(json.length / 4) * 4;
        // One triangle on face 0 of body 1, one edge segment on edge 0 of body 1, one cosmetic segment on body 1.
        const counts = [9, 3, 6, 1, 1, 6, padded];
        const words = [...counts, ...Array(9).fill(0), ...Array(9).fill(0), 0, 1, 2, ...Array(6).fill(0), 0, 0, 1, 1];
        const buffer = new ArrayBuffer(words.length * 4 + 6 * 4 + 4 + padded);
        const view = new DataView(buffer);
        words.forEach((w, i) => view.setUint32(i * 4, w, true));
        let at = words.length * 4;
        [1, 2, 3, 4, 5, 6].forEach((v) => {
            view.setFloat32(at, v, true);
            at += 4;
        });
        view.setUint32(at, 1, true);
        new Uint8Array(buffer, at + 4, padded).fill(0x20).set(json);
        const mesh = decode(buffer);
        expect(mesh.bodies).toEqual([{ key: 'base', by: '' }, { key: 'b2', by: 'b2', n: 1 }]);
        expect([...mesh.faceBody]).toEqual([1]);
        expect([...mesh.edgeBody]).toEqual([1]);
        expect([...mesh.cosmetic]).toEqual([1, 2, 3, 4, 5, 6]);
        expect([...mesh.cosmeticBody]).toEqual([1]);
        expect(mesh.surface.getIndex()!.count).toBe(3);
    });
});
