// Derived sketch in the sketcher: the copy of the parent opens on the picked plane, keeps the parent's entities (a
// change of them is refused, a move of the whole sketch is not), saves its link, and Underive keeps the entities.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Project } from '@jarvis/core';
import { loadSolver } from './solver';
import { addLine, addRect, EMPTY_GEOMETRY } from './sketchGeometry';
import { choosePlane, closeSketch, commitGeometry, currentSketch, useSketcher } from './sketcher';
import { useStudio } from './state';
import { contentKey, derivedSession, parentGeometry, sketchOutputExtras, startDerivedSketch, underive, watchDerived } from './sketchDerived';
import { moveSketchFrame } from './sketchMoreTools';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));
const calls: { name: string; args: Record<string, unknown> }[] = [];
vi.mock('./state', async (original) => ({
    ...(await original<typeof import('./state')>()),
    runTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { text: 'ok', isError: false };
    },
}));

beforeAll(async () => {
    await loadSolver();
    watchDerived();
});

const parent = addRect(EMPTY_GEOMETRY, [0, 0], [30, 10]).g;
const features: Feature[] = [
    { id: 'a', op: 'sketch', name: 'Sketch1', sketch: { plane: 'top', profiles: [], geometry: parent } },
    { id: 'b', op: 'sketch', name: 'Sketch2', sketch: { plane: 'front', profiles: [], geometry: EMPTY_GEOMETRY, derived: { from: 'a' } } },
];

beforeEach(() => {
    calls.length = 0;
    closeSketch();
    useStudio.setState({ history: { parts: [{ id: 'p1', name: 'Part', features }] } as unknown as Project });
});

describe('derived sketch', () => {
    it('opens a copy of the parent on the picked plane and saves the link', () => {
        expect(startDerivedSketch('p1', 'nothing')).toMatch(/Pick a sketch step/);
        expect(startDerivedSketch('p1', 'a')).toBeNull();
        expect(useSketcher.getState().stage).toBe('plane');
        choosePlane('right', 5);
        expect(derivedSession()?.from).toBe('a');
        expect(contentKey(useSketcher.getState().geometry)).toBe(contentKey(parent));
        const sketch = currentSketch();
        expect(sketch).toMatchObject({ plane: 'right', offset: 5, derived: { from: 'a' } });
        expect(sketch.profiles).toHaveLength(1);
    });

    it('refuses a change of its entities but moves as a whole', () => {
        startDerivedSketch('p1', 'a');
        choosePlane('right', 0);
        const g = useSketcher.getState().geometry;
        commitGeometry(addLine(g, { at: [50, 0] }, { at: [60, 0] }).g);
        expect(useSketcher.getState().geometry.curves).toHaveLength(4);
        expect(useSketcher.getState().message).toMatch(/Derived sketch/);
        expect(moveSketchFrame([5, 0])).toBeNull();
        expect(useSketcher.getState().plane).not.toBe('right');
        expect(useSketcher.getState().geometry.curves).toHaveLength(4);
    });

    it('opens an existing derived sketch on its parent as it is now', () => {
        useSketcher.setState({ active: true, stage: 'draw', partId: 'p1', edit: { partId: 'p1', featureId: 'b' }, geometry: EMPTY_GEOMETRY });
        expect(derivedSession()?.from).toBe('a');
        expect(useSketcher.getState().geometry.curves).toHaveLength(4);
        expect(sketchOutputExtras()).toEqual({ derived: { from: 'a' } });
        closeSketch();
        expect(derivedSession()).toBeNull();
    });

    it('underives: the step keeps its parent entities as its own, without the link', async () => {
        expect(parentGeometry(features, 'a')).toBe(parent);
        expect((await underive('p1', 'a')).isError).toBe(true);
        await underive('p1', 'b');
        const update = (calls[0].args.updates as { id: string; sketch: { plane: string; derived?: unknown; geometry: unknown } }[])[0];
        expect(update).toMatchObject({ id: 'b', sketch: { plane: 'front', geometry: parent } });
        expect(update.sketch.derived).toBeUndefined();
    });
});
