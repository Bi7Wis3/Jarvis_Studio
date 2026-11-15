import { describe, expect, it, vi } from 'vitest';
import type { Feature, Part } from '@jarvis/core';
import {
    chamferSide, edgePoints, entityOf, faceRefs, itemFor, itemLabel, itemsOf, nextBox, pickItems, pickTolerance, togglePickItem,
    type PickBox, type PickItem, type PickMesh,
} from './pickField';
import { chamferFeature, draftFeature, filletFeature, shellFeature } from './pickFeatures';
import { featureSummary } from './historyText';
import { editorFor, PART_GROUPS, type ToolDef } from './toolDefs';

// The sketcher's wasm URL only resolves in the browser; with none, the solver finds its own file.
vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

// Two faces of a box corner: face 0 = top (y = 1), face 1 = front (z = 0), edge 0 = their shared edge, edge 1 = the
// top face's back edge.
const mesh: PickMesh = {
    positions: new Float32Array([0, 1, 0, 10, 1, 0, 10, 1, 10, 0, 1, 10, 0, 0, 0, 10, 0, 0, 10, 1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6]),
    triFace: new Uint32Array([0, 0, 1, 1]),
    edges: new Float32Array([0, 1, 0, 10, 1, 0, 0, 1, 10, 10, 1, 10]),
    segEdge: new Uint32Array([0, 1]),
};
const tol = pickTolerance(20);

describe('selection box items', () => {
    it('names rows per kind, SolidWorks style', () => {
        const items: PickItem[] = [{ kind: 'edge', at: [0, 0, 0] }, { kind: 'face', at: [1, 0, 0] }, { kind: 'edge', at: [2, 0, 0] }];
        expect(items.map((_, i) => itemLabel(items, i))).toEqual(['Edge<1>', 'Face<1>', 'Edge<2>']);
    });

    it('adds, removes by a second click, and replaces in a single box', () => {
        const a: PickItem = { kind: 'edge', at: [5, 1, 0] };
        const b: PickItem = { kind: 'edge', at: [5, 1, 10] };
        const sameAs = (x: PickItem) => (i: PickItem) => 'at' in i && 'at' in x && i.at.join() === x.at.join();
        const one = togglePickItem([], a, sameAs(a), true);
        expect(one).toEqual({ items: [a], advance: false });
        const two = togglePickItem(one.items, b, sameAs(b), true);
        expect(two.items).toEqual([a, b]);
        expect(togglePickItem(two.items, a, sameAs(a), true).items).toEqual([b]);
        // A single box takes one entry and hands over to the next box.
        expect(togglePickItem([a], b, sameAs(b), false)).toEqual({ items: [b], advance: true });
        const boxes: PickBox[] = [
            { key: 'neutral', label: 'Neutral plane', entities: ['face'], multi: false },
            { key: 'faces', label: 'Faces to draft', entities: ['face'], multi: true },
        ];
        expect(nextBox(boxes, 'neutral')).toBe('faces');
        expect(nextBox(boxes, 'faces')).toBeNull();
    });

    it('turns mesh entities into stored refs and finds them again', () => {
        const edge = itemFor(mesh, { kind: 'edge', index: 0 }, [0, 0, -1]);
        expect(edge).toEqual({ kind: 'edge', at: [5, 1, 0], side: [0, 0, -1] });
        expect(entityOf(mesh, edge!, tol)).toEqual({ kind: 'edge', index: 0 });
        const face = itemFor(mesh, { kind: 'face', index: 1 });
        expect(face?.kind).toBe('face');
        expect(entityOf(mesh, face!, tol)).toEqual({ kind: 'face', index: 1 });
        // A ref that is not in this mesh resolves to nothing (its row stays, unhighlighted).
        expect(entityOf(mesh, { kind: 'edge', at: [5, 40, 0] }, tol)).toBeNull();
    });

    it('converts between box items and the stored feature fields', () => {
        const items = itemsOf([[5, 1, 0]], [{ at: [5, 1, 5], normal: [0, 1, 0] }]);
        expect(edgePoints(items)).toEqual([[5, 1, 0]]);
        expect(faceRefs(items)).toEqual([{ at: [5, 1, 5], normal: [0, 1, 0] }]);
        expect(pickItems('top')).toEqual([]);
    });

    it('takes the chamfer side from the face clicked next to the first edge, and flips it', () => {
        const items: PickItem[] = [{ kind: 'edge', at: [5, 1, 0] }, { kind: 'edge', at: [5, 1, 10], side: [0, 1, 0] }];
        expect(chamferSide(items, null, false)).toEqual([0, 1, 0]);
        expect(chamferSide(items, null, true)).toEqual([0, -1, 0]);
        expect(chamferSide([{ kind: 'face', at: [0, 0, 0], normal: [1, 0, 0] }], [0, 1, 0], false)).toEqual([1, 0, 0]);
        expect(chamferSide([], [0, 1, 0], true)).toEqual([0, -1, 0]);
    });
});

describe('features saved by the pick forms', () => {
    const edgeAndFace = itemsOf([[5, 1, 0]], [{ at: [5, 1, 5], normal: [0, 1, 0] }]);

    it('saves a fillet\'s picks and tangent propagation, and empty lists so an edit can clear them', () => {
        expect(filletFeature({ r: '2', edges: 'all', items: edgeAndFace, tangent: true })).toMatchObject({
            op: 'fillet', radius: 2, at: [[5, 1, 0]], faces: [{ at: [5, 1, 5], normal: [0, 1, 0] }], tangent: true,
        });
        expect(filletFeature({ r: '2', edges: 'top', items: [], tangent: false })).toMatchObject({ edges: 'top', at: [], faces: [] });
        expect(() => filletFeature({ r: '0', items: [] })).toThrow(/greater than 0/);
    });

    it('saves each chamfer type, flips the side, and clears unused fields on edit', () => {
        const items: PickItem[] = [{ kind: 'edge', at: [5, 1, 0], side: [0, 1, 0] }];
        expect(chamferFeature({ type: 'equal', s: '1', items }, true)).toMatchObject({ size: 1, distance2: null, angle: null, side: null });
        expect(chamferFeature({ type: 'equal', s: '1', items }, false)).not.toHaveProperty('angle');
        expect(chamferFeature({ type: 'distance', s: '1', d2: '3', items }, true)).toMatchObject({ distance2: 3, angle: null, side: [0, 1, 0] });
        expect(chamferFeature({ type: 'angle', s: '1', angle: '30', items, flip: true }, false))
            .toMatchObject({ angle: 30, side: [0, -1, 0] });
        expect(() => chamferFeature({ type: 'angle', s: '1', angle: '90', items }, false)).toThrow(/less than 90/);
    });

    it('saves shell faces to remove in place of open sides', () => {
        expect(shellFeature({ t: '2', open: ['top'], remove: edgeAndFace, outward: true }))
            .toMatchObject({ thickness: 2, open: [], remove: [{ at: [5, 1, 5], normal: [0, 1, 0] }], outward: true });
        expect(shellFeature({ t: '2', open: ['top'], remove: [], outward: false })).toMatchObject({ open: ['top'], remove: [], outward: false });
    });

    it('saves a draft from a picked neutral face and faces, and asks for what is missing', () => {
        const neutral = itemsOf(undefined, [{ at: [5, 0, 5], normal: [0, -1, 0] }]);
        const faces = itemsOf(undefined, [{ at: [10, 0.5, 5], normal: [1, 0, 0] }]);
        expect(draftFeature({ angle: '5', neutral, faces, flip: true, propagation: 'tangent' }, null)).toMatchObject({
            op: 'draft', angle: 5, neutralFace: { at: [5, 0, 5], normal: [0, -1, 0] }, picked: [{ at: [10, 0.5, 5], normal: [1, 0, 0] }],
            flip: true, tangent: true,
        });
        expect(() => draftFeature({ angle: '5', neutral: [], faces }, null)).toThrow(/neutral plane/);
        expect(() => draftFeature({ angle: '5', neutral, faces: [] }, null)).toThrow(/faces to draft/);
        expect(() => draftFeature({ angle: '45', neutral, faces }, null)).toThrow(/less than 45/);
    });
});

describe('pick forms in the app', () => {
    const part = { id: 'p', name: 'P', shape: { kind: 'empty' }, position: [0, 0, 0], rotation: [0, 0, 0], features: [] } as unknown as Part;
    const solid = PART_GROUPS.find((g) => g.id === 'solid')!.tools;

    it('has a Draft tool that also edits drafts', () => {
        const draft: Feature = { id: 'd', op: 'draft', angle: 3, picked: [{ at: [1, 0, 0] }], neutralFace: { at: [0, 0, 0] } };
        expect(solid.map((t) => t.id)).toContain('draft');
        expect((editorFor(part, draft) as ToolDef).id).toBe('draft');
    });

    it('opens an edited fillet with its picks in the box', () => {
        const fillet: Feature = { id: 'f', op: 'fillet', radius: 1, at: [[5, 1, 0]], tangent: true };
        const tool = editorFor(part, fillet) as ToolDef;
        const values = tool.defaults!({ part, project: null, edit: { partId: 'p', feature: fillet } });
        expect(values).toMatchObject({ items: [{ kind: 'edge', at: [5, 1, 0] }], tangent: true });
        expect(tool.fields!({ part, project: null, edit: null }).find((f) => f.key === 'items')).toMatchObject({ kind: 'pick', multi: true });
    });

    it('summarizes picks in the tree', () => {
        expect(featureSummary({ id: 'f', op: 'fillet', radius: 1, at: [[0, 0, 0], [1, 0, 0]], faces: [{ at: [0, 0, 0] }], tangent: true }))
            .toBe('r 1 · 2 edges, 1 face, tangent');
        expect(featureSummary({ id: 'c', op: 'chamfer', size: 1, angle: 30, at: [[0, 0, 0]] })).toBe('1 mm × 30° · 1 edge');
        expect(featureSummary({ id: 's', op: 'shell', thickness: 2, remove: [{ at: [0, 0, 0] }], outward: true }))
            .toBe('Wall 2 mm outward · open 1 picked face');
    });
});
