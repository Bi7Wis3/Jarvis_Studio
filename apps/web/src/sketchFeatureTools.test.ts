import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Part, Project, Sketch } from '@jarvis/core';
import { captureToolCalls, useStudio } from './state';
import { editorFor, noEditTool, type Ctx, type ToolDef, type Values } from './toolDefs';
import type { PickItem } from './pickField';
import { useRegionPick } from './regionPick';

// The sketcher's wasm URL only resolves in the browser.
vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));
// A part built from sketches: its body (from the kernel mesh) spans x -10..10, y 0..20, z -5..5.
vi.mock('./meshes', async (original) => ({
    ...(await original<typeof import('./meshes')>()),
    loadedMeshBounds: () => [[-10, 0, -5], [10, 20, 5]],
}));

const profileSketch: Sketch = { plane: 'top', profiles: [{ kind: 'circle', center: [0, 0], radius: 2 }] };
const pathSketch: Sketch = { plane: 'front', profiles: [], open: [{ kind: 'path', start: [0, 0], segments: [{ kind: 'line', to: [0, 20] }] }] };

function part(features: Feature[]): Part {
    return {
        id: 'p1', name: 'Body', shape: { kind: 'empty' }, position: [0, 0, 0], rotation: [0, 0, 0],
        material: { color: '#999999', metalness: 0, roughness: 0.6 }, features,
    } as Part;
}

const steps: Feature[] = [
    { id: 'sketch-1', op: 'sketch', name: 'Sketch1', sketch: profileSketch },
    { id: 'sketch-2', op: 'sketch', name: 'Sketch2', sketch: pathSketch },
];

/** The calls the tool's apply makes (captured, not sent). */
function callsOf(tool: ToolDef, v: Values, ctx: Ctx) {
    const { calls, result } = captureToolCalls(() => tool.apply!(v, ctx));
    void result.catch(() => undefined);
    return calls;
}

async function errorOf(tool: ToolDef, v: Values, ctx: Ctx): Promise<string> {
    const { result } = captureToolCalls(() => tool.apply!(v, ctx));
    return (await result).text;
}

const ctxFor = (p: Part, feature: Feature | null = null): Ctx =>
    ({ part: p, project: null, edit: feature ? { partId: p.id, feature } : null });

beforeEach(() => {
    useRegionPick.setState({ active: false, sketchKey: null, picked: [] });
});

describe('sweep tool', () => {
    const sweep: Feature = { id: 'sw', op: 'sweep', name: 'Sweep1', mode: 'add', profile: { sketchRef: 'sketch-1' }, path: { sketchRef: 'sketch-2' } };

    it('is the editor of sweeps along sketch steps, not of coils', () => {
        const p = part([...steps, sweep]);
        expect(editorFor(p, sweep)).not.toBe(noEditTool);
        expect((editorFor(p, sweep) as ToolDef).id).toBe('sweep');
        const coil: Feature = { ...sweep, path: { helix: { axis: 'y', pitch: 4, turns: 5 } } } as Feature;
        expect(editorFor(p, coil)).toBe(noEditTool);
    });

    it('defaults to the latest closed sketch as the profile and the latest open one as the path', () => {
        const p = part(steps);
        const tool = editorFor(part([...steps, sweep]), sweep) as ToolDef;
        const v = tool.defaults!(ctxFor(p));
        expect(v).toMatchObject({ profileType: 'sketch', sketch: 'sketch-1', path: 'sketch-2', mode: 'add' });
        useRegionPick.setState({ picked: [[0, 0]] });
        const [call] = callsOf(tool, { ...v, twist: 'angle', twistAngle: '45' }, ctxFor(p));
        expect(call.name).toBe('features_add');
        expect((call.args.features as Record<string, unknown>[])[0]).toMatchObject({
            op: 'sweep', name: 'Sweep1', profile: { sketchRef: 'sketch-1' }, path: { sketchRef: 'sketch-2' }, twist: 45, regions: [[0, 0]],
        });
    });

    it('makes a circular profile with no sketch, and edits back to a sketch profile', async () => {
        const p = part([...steps, sweep]);
        const tool = editorFor(p, sweep) as ToolDef;
        const v = tool.defaults!(ctxFor(p, sweep));
        const circular: Values = { ...v, ...tool.onChange!('profileType', { ...v, profileType: 'circular' }, ctxFor(p, sweep)) as Values, profileType: 'circular', diameter: '3' };
        expect(circular.sketch).toBe('');
        const [call] = callsOf(tool, circular, ctxFor(p, sweep));
        expect(call.name).toBe('features_update');
        expect((call.args.updates as Record<string, unknown>[])[0]).toMatchObject({ id: 'sw', diameter: 3, profile: null, orientation: 'followPath' });
        // A path sketch of several closed areas is refused before it reaches the kernel.
        const two: Feature = { id: 'sketch-3', op: 'sketch', name: 'Sketch3', sketch: { plane: 'top', profiles: [
            { kind: 'circle', center: [0, 0], radius: 2 }, { kind: 'circle', center: [10, 0], radius: 2 }] } };
        const q = part([...steps, two, sweep]);
        expect(await errorOf(tool, { ...v, path: 'sketch-3' }, ctxFor(q, sweep))).toMatch(/not a path/);
    });
});

describe('loft tool', () => {
    it('edits a loft with its sections in order, and closes it', () => {
        const sections: Feature[] = [1, 2, 3].map((n) => ({ id: `s${n}`, op: 'sketch', name: `Sketch${n}`, sketch: { ...profileSketch, offset: n * 10 } }));
        const loft: Feature = { id: 'l', op: 'loft', name: 'Loft1', mode: 'add', sections: [{ sketchRef: 's3' }, { sketchRef: 's1' }, { sketchRef: 's2' }] };
        const p = part([...sections, loft]);
        const tool = editorFor(p, loft) as ToolDef;
        const v = tool.defaults!(ctxFor(p, loft));
        expect(v.sections).toEqual(['s3', 's1', 's2']);
        const [call] = callsOf(tool, { ...v, closed: true }, ctxFor(p, loft));
        expect((call.args.updates as Record<string, unknown>[])[0]).toMatchObject({
            sections: [{ sketchRef: 's3' }, { sketchRef: 's1' }, { sketchRef: 's2' }], closed: true,
        });
    });
});

describe('thread tool', () => {
    const shaft: Feature = { id: 'e', op: 'extrude', mode: 'add', distance: 20, sketchRef: 'sketch-1' };

    it('saves a thread on a picked edge: the kernel takes axis and diameter from it', async () => {
        const p = part([steps[0], shaft]);
        const thread: Feature = { id: 't', op: 'thread', kind: 'external', pitch: 1.25, length: 10, position: [0, 0, 0], diameter: 8 };
        const tool = editorFor(part([steps[0], shaft, thread]), thread) as ToolDef;
        const v = tool.defaults!(ctxFor(p));
        expect(v).toMatchObject({ start: 'edge', edges: [] });
        expect(await errorOf(tool, v, ctxFor(p))).toMatch(/Click the circular edge/);
        const picked = { ...v, edges: [{ kind: 'edge', at: [2, 20, 0] }] as PickItem[], end: 'revolutions', revolutions: '6', hand: 'left', starts: '2' };
        const [call] = callsOf(tool, picked, ctxFor(p));
        const saved = (call.args.features as Record<string, unknown>[])[0];
        expect(saved).toMatchObject({ op: 'thread', kind: 'external', at: [2, 20, 0], pitch: 1.25, revolutions: 6, leftHanded: true, starts: 2 });
        expect(saved).not.toHaveProperty('diameter');
        expect(saved).not.toHaveProperty('position');
        expect(saved).not.toHaveProperty('alsoAt');
    });

    it('threads several edges in one step: the first is the start edge, the others go with it', () => {
        const p = part([steps[0], shaft]);
        const thread: Feature = { id: 't', op: 'thread', kind: 'internal', pitch: 0.8, length: 10, at: [2, 20, 0], alsoAt: [[12, 20, 0]] };
        const tool = editorFor(part([steps[0], shaft, thread]), thread) as ToolDef;
        const v = tool.defaults!(ctxFor(p, thread));
        expect(v.edges).toEqual([{ kind: 'edge', at: [2, 20, 0] }, { kind: 'edge', at: [12, 20, 0] }]);
        const three = [...(v.edges as PickItem[]), { kind: 'edge', at: [22, 20, 0] }] as PickItem[];
        const [call] = callsOf(tool, { ...v, edges: three }, ctxFor(p, thread));
        expect((call.args.updates as Record<string, unknown>[])[0]).toMatchObject({ at: [2, 20, 0], alsoAt: [[12, 20, 0], [22, 20, 0]] });
        // Down to one edge: the others are cleared.
        const [one] = callsOf(tool, { ...v, edges: three.slice(0, 1) }, ctxFor(p, thread));
        expect((one.args.updates as Record<string, unknown>[])[0]).toMatchObject({ at: [2, 20, 0], alsoAt: null });
    });

    it('opens a stored thread with its preset and clears what the form drops', () => {
        const thread: Feature = { id: 't', op: 'thread', kind: 'external', pitch: 1.25, length: 10, position: [0, 0, 0], diameter: 8 };
        const p = part([steps[0], shaft, thread]);
        const tool = editorFor(p, thread) as ToolDef;
        const v = tool.defaults!(ctxFor(p, thread));
        expect(v).toMatchObject({ start: 'point', size: 'M8', diameter: '8', length: '10' });
        const [call] = callsOf(tool, { ...v, start: 'edge', edges: [{ kind: 'edge', at: [4, 20, 0] }] as PickItem[] }, ctxFor(p, thread));
        expect((call.args.updates as Record<string, unknown>[])[0]).toMatchObject({ at: [4, 20, 0], position: null, diameter: null, revolutions: null });
    });
});

describe('hole tool', () => {
    const hole = (patch: Partial<Extract<Feature, { op: 'hole' }>>): Feature =>
        ({ id: 'h', op: 'hole', spec: { kind: 'clearance', size: 'M3' }, position: [1, 2, 3], ...patch } as Feature);

    it('enters from the top of a part built from sketches, not from its empty base shape', () => {
        const p = part(steps);
        const tool = editorFor(part([hole({})]), hole({})) as ToolDef;
        const v = tool.defaults!(ctxFor(p));
        expect([v.pos0, v.pos1, v.pos2]).toEqual(['0', '20', '0']);
        expect(tool.onChange!('face', { ...v, face: 'right' }, ctxFor(p))).toMatchObject({ pos0: '10', pos1: '10', pos2: '0' });
    });

    it('keeps a drilling direction that is along no axis', () => {
        const slanted = hole({ direction: [Math.SQRT1_2, -Math.SQRT1_2, 0] });
        const p = part([slanted]);
        const tool = editorFor(p, slanted) as ToolDef;
        const v = tool.defaults!(ctxFor(p, slanted));
        expect(v.face).toBe('other');
        const [call] = callsOf(tool, v, ctxFor(p, slanted));
        const direction = (call.args.updates as { direction: number[] }[])[0].direction;
        expect(direction[0]).toBeCloseTo(Math.SQRT1_2, 12);
        expect(direction[1]).toBeCloseTo(-Math.SQRT1_2, 12);
    });

    it('shows a heat-set hole as blind at the insert depth, never as through all', () => {
        const insert = hole({ spec: { kind: 'heatset', size: 'M3' } });
        const p = part([insert]);
        const tool = editorFor(p, insert) as ToolDef;
        const v = tool.defaults!(ctxFor(p, insert));
        const shown = tool.fields!(ctxFor(p, insert)).filter((f) => !f.show || f.show(v)).map((f) => f.key);
        expect(shown).not.toContain('through');
        expect(shown).toContain('depth');
        expect(Number(v.depth)).toBeGreaterThan(3);
        const [call] = callsOf(tool, v, ctxFor(p, insert));
        expect((call.args.updates as Record<string, unknown>[])[0].depth).toBe(Number(v.depth));
    });
});

beforeEach(() => {
    useStudio.setState({ history: { parts: [] } as unknown as Project, meshes: { keys: {}, errors: {} } });
});
