import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, type Feature, type Project } from '@jarvis/core';
import { resolvePlane, sketchFrameOf } from '@jarvis/core/reference';
import { withFollowed } from './followedRefs';

// A plane 5 above a block's top face, as picked (top at y = 10) and as the kernel found it after the block grew (y = 20).
const plane = (y: number, distance = 5): Feature => ({
    id: 'p', name: 'Plane1', op: 'plane', definition: {
        kind: 'offset', distance,
        base: { fixedPlane: { origin: [0, y, 0], normal: [0, 1, 0], xDir: [1, 0, 0] }, from: 'face', pick: { face: { at: [3, 10, 2], normal: [0, 1, 0] } } },
    },
});
const sketch: Feature = { id: 's', op: 'sketch', sketch: { plane: { planeRef: 'p' }, profiles: [] } };
const project = (features: Feature[]): Project => ({
    name: 'Test', view: DEFAULT_VIEW,
    parts: [{ id: 'part', name: 'Block', shape: { kind: 'empty' }, position: [0, 0, 0], rotation: [0, 0, 0], material: { color: '#888888', metalness: 0, roughness: 1 }, features }],
});

describe('reference steps drawn where the kernel found them', () => {
    it('takes the kernel\'s copy of a step that differs only in where its references were found', () => {
        const mine = project([plane(10), sketch]);
        const shown = withFollowed(mine, { part: { p: plane(20) } });
        const features = shown.parts[0].features!;
        expect(resolvePlane({ planeRef: 'p' }, features).origin).toEqual([0, 25, 0]);
        // A sketch on the plane is drawn there too.
        expect(sketchFrameOf({ plane: { planeRef: 'p' } }, features).origin).toEqual([0, 25, 0]);
        // A renamed step keeps its new name.
        const renamed = withFollowed(project([{ ...plane(10), name: 'Top offset' }]), { part: { p: plane(20) } });
        expect(renamed.parts[0].features![0]).toMatchObject({ name: 'Top offset', definition: { base: { fixedPlane: { origin: [0, 20, 0] } } } });
    });

    it('keeps a step changed since that rebuild, and the same project when nothing changes', () => {
        const edited = project([plane(10, 8)]);
        expect(withFollowed(edited, { part: { p: plane(20) } })).toBe(edited);
        const same = project([plane(20)]);
        expect(withFollowed(same, { part: { p: plane(20) } })).toBe(same);
        expect(withFollowed(same, undefined)).toBe(same);
        // Point steps: the position where the kernel found it, when the definition is the same.
        const point = (x: number): Feature => ({
            id: 'v', op: 'point', position: [x, 20, 10], definition: { kind: 'vertex', vertex: { vertex: [10, 10, 10] } },
        });
        const moved = withFollowed(project([point(10)]), { part: { v: point(12) } });
        expect(moved.parts[0].features![0]).toMatchObject({ position: [12, 20, 10] });
    });
});
