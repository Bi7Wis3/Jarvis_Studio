// The 2D to 3D toolbar's actions on the open sketch: the selected entities leave it and become a sketch step (a view
// folded into place), and nothing changes when the part refuses the step.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomSketchPlane, Feature, Project, SketchGeometry } from '@jarvis/core';
import { loadSolver } from './solver';
import { addRect, EMPTY_GEOMETRY } from './sketchGeometry';
import { useSketcher } from './sketcher';
import { useStudio } from './state';
import { addToView, createFromSelections, selectedNoteText } from './sketch2d3dForms';
import { sketchOfGeometry } from './sketch2d3d';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));
const calls: { name: string; args: Record<string, unknown> }[] = [];
let answer = { text: 'ok', isError: false };
vi.mock('./state', async (original) => ({
    ...(await original<typeof import('./state')>()),
    runTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return answer;
    },
}));

beforeAll(async () => {
    await loadSolver();
});

function drawing() {
    const f = addRect(EMPTY_GEOMETRY, [0, 0], [40, 20]);
    const t = addRect(f.g, [0, 30], [40, 45]);
    return { g: t.g, front: f.lines, top: t.lines };
}

function begin(g: SketchGeometry, selected: string[], features: Feature[] = []): void {
    useStudio.setState({ history: { parts: [{ id: 'p1', name: 'Part', features }] } as unknown as Project });
    useSketcher.setState({
        active: true, stage: 'draw', partId: 'p1', edit: { partId: 'p1', featureId: 'drawing' }, plane: 'front', offset: 0, context: [],
        geometry: g, undo: [], redo: [], labels: {}, message: null, selection: selected.map((id) => ({ type: 'curve' as const, id })),
    });
}

beforeEach(() => {
    calls.length = 0;
    answer = { text: 'ok', isError: false };
});

describe('2D to 3D on the open sketch', () => {
    it('makes the Front view from the selection, on the sketch plane, and takes it out of the sketch', async () => {
        const d = drawing();
        begin(d.g, d.front);
        expect(await addToView('front')).toEqual({ text: '', isError: false });
        const [call] = calls;
        expect(call.name).toBe('features_add');
        const [step] = call.args.features as { name: string; sketch: { plane: unknown; view: string; profiles: unknown[] } }[];
        expect(step).toMatchObject({ name: 'Front', sketch: { plane: 'front', view: 'front' } });
        expect(step.sketch.profiles).toHaveLength(1);
        expect(useSketcher.getState().geometry.curves).toHaveLength(4);
        expect(useSketcher.getState().selection).toEqual([]);
    });

    it('folds the Top view about the Front view of the part', async () => {
        const d = drawing();
        const front = { id: 'f', op: 'sketch', name: 'Front', sketch: sketchOfGeometry(addRect(EMPTY_GEOMETRY, [0, 0], [40, 20]).g, 'front', 0, { view: 'front' }) } as Feature;
        begin(d.g, d.top, [front]);
        expect((await addToView('top')).isError).toBe(false);
        const [step] = calls[0].args.features as { name: string; sketch: { plane: CustomSketchPlane } }[];
        expect(step.name).toBe('Top');
        expect(step.sketch.plane.normal).toEqual([0, 1, 0]);
        expect(step.sketch.plane.origin).toEqual([0, 20, 30]);
    });

    it('asks for the Front view first, the selection, and keeps the sketch when the part refuses', async () => {
        const d = drawing();
        begin(d.g, d.top);
        expect(await addToView('top')).toMatchObject({ isError: true, text: expect.stringMatching(/Add the Front view first/) });
        begin(d.g, []);
        expect(await createFromSelections()).toMatchObject({ isError: true, text: expect.stringMatching(/Select the sketch entities/) });
        begin(d.g, d.top);
        answer = { text: 'Refused.', isError: true };
        expect(await createFromSelections()).toEqual({ text: 'Refused.', isError: true });
        expect(useSketcher.getState().geometry).toBe(d.g);
    });

    it('creates a plain sketch from the selection', async () => {
        const d = drawing();
        begin(d.g, d.top);
        expect((await createFromSelections()).isError).toBe(false);
        const [step] = calls[0].args.features as { name: string; sketch: { plane: unknown; view?: string } }[];
        expect(step.name).toBe('Sketch1');
        expect(step.sketch.plane).toBe('front');
        expect(step.sketch.view).toBeUndefined();
    });

    it('says one selected entity "is extruded" and more "are extruded"', () => {
        expect(selectedNoteText(1, 'is extruded', 'are extruded')).toBe('1 selected entity is extruded.');
        expect(selectedNoteText(3, 'is extruded', 'are extruded')).toBe('3 selected entities are extruded.');
    });
});
