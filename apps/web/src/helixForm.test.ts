import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Part, Project, Sketch } from '@jarvis/core';
import { consumedSketches } from '@jarvis/core/visibility';
import { captureToolCalls } from './preview';
import { useStudio } from './state';
import { editorFor, PART_GROUPS, type Ctx, type ToolDef, type Values } from './toolDefs';
import { derivedPatch, draftHelix, helixFeature, helixStatus, helixValues, splitRow, sweepPathValue, type HelixValues } from './helixForm';
import { buildFeatureTree } from './featureTree';
import { featureIcon, featureSummary, sketchEdits, stepRefs } from './historyText';

// The sketcher's wasm URL only resolves in the browser.
vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

const ring: Sketch = { plane: 'top', profiles: [{ kind: 'circle', center: [0, 0], radius: 10 }] };
const wire: Sketch = { plane: 'front', profiles: [{ kind: 'circle', center: [10, 0], radius: 1 }] };
const features: Feature[] = [
    { id: 'ring', name: 'Sketch1', op: 'sketch', sketch: ring },
    { id: 'helix', name: 'Helix/Spiral1', op: 'helix', sketchRef: 'ring', definedBy: 'pitchRevolution', pitch: 4, revolutions: 10 },
    { id: 'wire', name: 'Sketch2', op: 'sketch', sketch: wire },
    { id: 'spring', name: 'Sweep1', op: 'sweep', mode: 'add', profile: { sketchRef: 'wire' }, path: { curveRef: 'helix' } },
];
const part = {
    id: 'p1', name: 'Spring', shape: { kind: 'empty' }, position: [0, 0, 0], rotation: [0, 0, 0],
    material: { color: '#999999', metalness: 0, roughness: 0.6 }, features: features.slice(0, 1),
} as unknown as Part;
const ctx: Ctx = { part, project: null, edit: null };
const helixTool = (): ToolDef => PART_GROUPS.find((g) => g.id === 'reference')!.tools.find((t) => t.id === 'helix')!;

function calls(t: ToolDef, values: Values, c: Ctx = ctx) {
    const captured = captureToolCalls(() => t.apply!(values, c));
    void Promise.resolve(captured.result).catch(() => undefined);
    return captured.calls;
}

beforeEach(() => {
    useStudio.setState({ history: { parts: [part] } as unknown as Project, workspace: 'part' });
});

describe('Helix and spiral form', () => {
    it('is on the reference geometry toolbar and adds a Helix/Spiral step on the circle sketch', async () => {
        const t = helixTool();
        const v = t.defaults!(ctx);
        expect(v).toMatchObject({ sketch: 'ring', definedBy: 'pitchRevolution', direction: 'clockwise' });
        const [call] = calls(t, { ...v, pitch: '2.5', revolutions: '8.0001', startAngle: '30' });
        expect(call.name).toBe('features_add');
        const [step] = (call.args as { features: Record<string, unknown>[] }).features;
        expect(step).toMatchObject({
            op: 'helix', name: 'Helix/Spiral1', sketchRef: 'ring', definedBy: 'pitchRevolution', pitch: 2.5, revolutions: 8.0001,
            startAngle: 30, clockwise: true, reverse: false,
        });
        expect(step.height).toBeUndefined();
    });

    it('works out the third value, so changing Defined by keeps the curve', () => {
        let v = helixValues(null, 'ring', 20);
        v = { ...v, pitch: '4', revolutions: '10' };
        v = { ...v, ...derivedPatch(v) };
        expect(v.height).toBe('40');
        v = { ...v, definedBy: 'heightPitch' };
        v = { ...v, ...derivedPatch(v) };
        expect(v.revolutions).toBe('10');
        const { shape } = draftHelix(v, features, null);
        expect(helixStatus(shape!)).toMatch(/^Height 40 mm · 10 revolutions · pitch 4 mm · length 6/);
        expect(helixFeature(v, false)).toMatchObject({ definedBy: 'heightPitch', height: 40, pitch: 4 });
        // An edit clears what the form does not use.
        expect(helixFeature(v, true)).toMatchObject({ revolutions: null, variablePitch: null, taper: null });
    });

    it('fills the variable pitch table\'s worked-out cells and stores only the typed ones', () => {
        const v: HelixValues = { ...helixValues(null, 'ring', 20), pitchType: 'variable', rows: ['1|||', '1|1||', '4|3||8'] };
        const patch = derivedPatch(v, 20);
        // Heights: 1, then 1 + (1 + 4) / 2 x 2 = 6; the first row is at the start, on the circle. An empty diameter
        // stays empty (the row before's).
        expect((patch.rows as string[]).map(splitRow)).toEqual([['1', '0', '0', '20'], ['1', '1', '1', ''], ['4', '3', '6', '8']]);
        const step = helixFeature({ ...v, ...patch }, false);
        expect(step.variablePitch).toEqual([{ pitch: 1 }, { pitch: 1, revolutions: 1 }, { pitch: 4, revolutions: 3, diameter: 8 }]);
        expect(step.pitch).toBeUndefined();
        // The stored step opens again as it was.
        const back = helixValues({ id: 'h', op: 'helix', sketchRef: 'ring', ...(step as object) } as Extract<Feature, { op: 'helix' }>, 'ring', 20);
        expect(back.pitchType).toBe('variable');
        expect((back.rows as string[])[2]).toBe('4|3|6|8');
    });

    it('says why a curve cannot be made', () => {
        expect(draftHelix({ ...helixValues(null, '', null) }, features, null).error).toMatch(/Pick a sketch/);
        const spiral = { ...helixValues(null, 'ring', 20), definedBy: 'spiral', pitch: '5', revolutions: '3', reverse: true };
        expect(draftHelix(spiral, features, null).error).toMatch(/^The spiral runs into its centre/);
    });

    it('opens a helix step in its own form, and a sweep along it in the Sweep form with the curve as its path', () => {
        const full = { ...part, features } as Part;
        useStudio.setState({ history: { parts: [full] } as unknown as Project, workspace: 'part' });
        expect((editorFor(full, features[1]) as ToolDef).id).toBe('helix');
        const sweep = editorFor(full, features[3]) as ToolDef;
        expect(sweep.id).toBe('sweep');
        const edit: Ctx = { part: full, project: null, edit: { partId: 'p1', feature: features[3] } };
        const v = sweep.defaults!(edit);
        expect(v.path).toBe('helix');
        expect(sweep.fields!(edit).find((f) => f.key === 'path')!.options).toContainEqual({ value: 'helix', label: 'Helix/Spiral1' });
        const [update] = calls(sweep, v, edit);
        const [fields] = (update.args as { updates: Record<string, unknown>[] }).updates;
        expect(fields).toMatchObject({ id: 'spring', path: { curveRef: 'helix' }, profile: { sketchRef: 'wire' }, twist: 0 });
        // A new sweep starts on the newest path: here the helix.
        expect(sweep.defaults!({ part: full, project: null, edit: null }).path).toBe('helix');
        expect(sweepPathValue({ curveRef: 'helix' })).toBe('helix');
    });

    it('nests the circle sketch under the helix; the helix stays a step of its own under the sweep', () => {
        const tree = buildFeatureTree(features);
        expect(tree.map((n) => n.key)).toEqual(['helix', 'spring']);
        expect(tree[0].children.map((c) => c.stepId)).toEqual(['ring']);
        expect(tree[1].children.map((c) => c.stepId)).toEqual(['wire']);
        expect(stepRefs(features[3])).toEqual(['wire', 'helix']);
        expect(stepRefs(features[1])).toEqual(['ring']);
        expect(consumedSketches(features[1])).toEqual(['ring']);
        expect(consumedSketches(features[3])).toEqual(['wire']);
        expect(featureIcon(features[1])).toBe('helix');
        expect(featureSummary(features[1], { ...part, features } as Part)).toBe('Helix · pitch 4 · 10 revolutions · counterclockwise · from Sketch1');
        expect(featureSummary(features[3], { ...part, features } as Part)).toMatch(/along Helix\/Spiral1/);
        expect(sketchEdits(features[1])).toEqual([{ label: 'Edit sketch', id: 'ring' }]);
    });
});
