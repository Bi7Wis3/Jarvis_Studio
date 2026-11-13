import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Part, Project } from '@jarvis/core';
import { addRect, EMPTY_GEOMETRY } from './sketchGeometry';
import { useSketcher } from './sketcher';
import { useStudio } from './state';
import { finishPreviewCalls, type Ctx, type Values } from './toolDefs';

// The sketcher's wasm URL only resolves in the browser.
vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

const part = {
    id: 'p1', name: 'Plate', shape: { kind: 'box', size: [40, 10, 40] }, position: [0, 0, 0], rotation: [0, 0, 0],
    material: { color: '#999999', metalness: 0, roughness: 0.6 }, features: [],
} as unknown as Part;
const ctx: Ctx = { part, project: null, edit: null };

const values = (patch: Values = {}): Values => ({
    op: 'cut', result: 'add', distance: '10', direction: 'reverse', axis: 'v', angle: '360', end: 'upToNext', through: false,
    from: 'offset', fromOffset: '2', draft: true, draftAngle: '3', draftOutward: false, flipSide: false, second: false,
    end2: 'blind', distance2: '5', draft2: false, draftAngle2: '1', draftOutward2: false, ...patch,
});

describe('sketch finish preview', () => {
    beforeEach(() => {
        useStudio.setState({ history: { parts: [part] } as unknown as Project });
        useSketcher.setState({
            active: true, stage: 'draw', plane: 'top', offset: 5, partId: 'p1', intent: 'cut', edit: null,
            geometry: addRect(EMPTY_GEOMETRY, { at: [-5, -5] }, { at: [5, 5] }).g, labels: {},
        });
    });

    it('previews the calls OK would make, with every option, and leaves the sketch open', () => {
        const calls = finishPreviewCalls(values(), ctx);
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe('features_add');
        const [sketch, cut] = (calls[0].args as { features: Record<string, unknown>[] }).features;
        expect(sketch).toMatchObject({ op: 'sketch' });
        // End condition, From offset and draft reach the server preview (the client box ignored them).
        expect(cut).toMatchObject({ op: 'extrude', mode: 'cut', direction: 'reverse', end: 'upToNext', from: 2, draft: 3 });
        expect(useSketcher.getState().active).toBe(true);
    });

    it('previews nothing for a plain sketch', () => {
        expect(finishPreviewCalls(values({ op: 'sketch' }), ctx)).toEqual([]);
    });
});
