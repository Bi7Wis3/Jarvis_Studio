import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Part, Project } from '@jarvis/core';
import { captureToolCalls } from './preview';
import { useStudio } from './state';
import { arrangedItems, arrangeToolbars } from './toolbarLayout';
import { ASSEMBLY_GROUPS, editorFor, PART_GROUPS, SKETCH_GROUPS, type Ctx, type ToolDef, type Values } from './toolDefs';
import { placeOfPick, primitiveFeatureTools } from './primitiveToolDefs';

// The sketcher's wasm URL only resolves in the browser.
vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

const part = {
    id: 'p1', name: 'Plate', shape: { kind: 'box', size: [40, 10, 40] }, position: [5, 0, 0], rotation: [0, 0, 0],
    material: { color: '#999999', metalness: 0, roughness: 0.6 }, features: [{ id: 'cyl', op: 'add', name: 'Cylinder1', shape: { kind: 'cylinder', radius: 1, height: 1 } }],
} as unknown as Part;
const ctx: Ctx = { part, project: null, edit: null };
const tool = (kind: string): ToolDef => primitiveFeatureTools.find((t) => t.id === `prim-${kind}`)!;

/** The calls OK would make, captured instead of sent. */
function calls(t: ToolDef, values: Values, c: Ctx = ctx) {
    const captured = captureToolCalls(() => t.apply!(values, c));
    void Promise.resolve(captured.result).catch(() => undefined);
    return captured.calls;
}

beforeEach(() => {
    useStudio.setState({ history: { parts: [part] } as unknown as Project, workspace: 'part' });
});

describe('the toolbars', () => {
    it('the part toolbar has the primitives as one pulldown next to Sketch; the assembly Insert toolbar has none', () => {
        const [sketch] = arrangeToolbars('part', PART_GROUPS, {});
        const items = arrangedItems(sketch).map((i) => ('family' in i ? `${i.family.label}: ${i.tools.map((t) => t.label).join(', ')}` : i.tool.id));
        expect(items.slice(0, 2)).toEqual(['sketch', 'Primitives: Box, Cylinder, Sphere, Cone, Torus, Tube, Wedge, Capsule']);
        const insert = ASSEMBLY_GROUPS.find((g) => g.id === 'insert')!.tools.map((t) => t.id);
        expect(insert).toEqual(['fastener', 'new-part']);
        expect(PART_GROUPS.map((g) => g.label)).toContain('Features');
    });

    it('the sketch mode has Draw, Modify, Dimensions and Relations toolbars of their own', () => {
        expect(SKETCH_GROUPS.map((g) => g.id)).toEqual(['sketch', 'draw', 'modify', 'dimensions', 'relations', 'view', '2d-to-3d', 'history']);
    });
});

describe('primitive steps', () => {
    it('Join adds a named step at the point, turned to the axis, with exact sizes', () => {
        const t = tool('box');
        const v = { ...t.defaults!(ctx), w: '10.0001', pos0: '1', pos1: '5', pos2: '0', dir0: '1', dir1: '0', dir2: '0' };
        const [call] = calls(t, v);
        expect(call.name).toBe('features_add');
        const [step] = (call.args as { features: Record<string, unknown>[] }).features;
        expect(step).toMatchObject({ id: 'prim-box', op: 'add', name: 'Box1', shape: { kind: 'box', size: [10.0001, 20, 30], radius: 0 } });
        // Base on (1, 5, 0), axis +X: the centre is half the height (20) along X.
        expect(step.position).toEqual([11, 5, 0]);
        // Local X (the width) ends up along +Z: spin 0 for an axis along X.
        expect(step.rotation).toEqual([-90, 0, -90]);
    });

    it('Cut is named after the primitive and goes into the face; New body makes a new part placed like this one', () => {
        const t = tool('cylinder');
        let v = { ...t.defaults!(ctx), result: 'cut' };
        v = { ...v, ...(t.onChange!('result', v, ctx) ?? {}) };
        const [cut] = calls(t, v);
        const [step] = (cut.args as { features: Record<string, unknown>[] }).features;
        expect(step).toMatchObject({ op: 'cut', name: 'Cut-Cylinder1', position: [0, -15, 0] });
        const [made] = calls(t, { ...t.defaults!(ctx), result: 'new' });
        expect(made.name).toBe('parts_add');
        const [added] = (made.args as { parts: Record<string, unknown>[] }).parts;
        expect(added).toMatchObject({ name: 'Plate body', shape: { kind: 'empty' }, position: [5, 0, 0] });
        expect((added.features as Feature[])[0]).toMatchObject({ op: 'add', name: 'Cylinder1', shape: { kind: 'cylinder' } });
    });

    it('editing a step opens its own form with its values and writes them back in place', () => {
        const step = {
            id: 'prim-cone-2', op: 'cut', name: 'Cut-Cone3', shape: { kind: 'cone', radius: 4, height: 6 }, position: [2, 3, 0], rotation: [0, 0, 90],
        } as Feature;
        const editor = editorFor(part, step) as ToolDef;
        expect(editor.id).toBe('prim-cone');
        const edit: Ctx = { part, project: null, edit: { partId: 'p1', feature: step } };
        const v = editor.defaults!(edit);
        expect(v).toMatchObject({ dia: '8', h: '6', pos0: '5', pos1: '3', pos2: '0', dir0: '-1', dir1: '0', dir2: '0', anchor: 'base' });
        const [update] = calls(editor, v, edit);
        expect(update.name).toBe('features_update');
        const [fields] = (update.args as { updates: Record<string, unknown>[] }).updates;
        expect(fields).toMatchObject({ id: 'prim-cone-2', shape: { kind: 'cone', radius: 4, height: 6 }, position: [2, 3, 0], rotation: [0, 0, 90] });
    });

    it('box and cylinder cuts not made here stay Cut pocket steps; other add and cut steps open a primitive form', () => {
        const pocket = { id: 'cut1', op: 'cut', shape: { kind: 'box', size: [1, 1, 1] } } as Feature;
        expect((editorFor(part, pocket) as ToolDef).id).toBe('pocket');
        expect((editorFor(part, { id: 'boss1', op: 'add', shape: { kind: 'torus', radius: 5, tube: 1 } } as Feature) as ToolDef).id).toBe('prim-torus');
        expect((editorFor(part, { id: 'x', op: 'add', shape: { kind: 'lathe', profile: [[1, 0], [1, 1]] } } as Feature) as ToolDef).id).toBe('no-edit');
    });

    it('a pick puts the base on the clicked spot of a flat face, a plane, or a circle centre facing out of its face', () => {
        const face = placeOfPick({
            kind: 'face', at: [0, 5, 0], normal: [0, 1, 0],
            model: { geom: { type: 'plane', origin: [0, 5, 0], normal: [0, 1, 0] }, click: [3.25, 4.9999995, -2] },
        }, []);
        expect(face).toEqual({ point: [3.25, 5, -2], normal: [0, 1, 0] });
        expect(placeOfPick({ kind: 'ref', ref: 'front', label: 'Front plane' }, [])).toMatchObject({ point: [0, 0, 0], normal: [0, 0, 1] });
        const circle = placeOfPick({
            kind: 'edge', at: [2, 5, 0],
            model: {
                geom: { type: 'circle', centre: [0, 5, 0], normal: [0, -1, 0], radius: 2, full: true, start: [2, 5, 0], end: [2, 5, 0] },
                click: [2, 5, 0], faces: [{ at: [0, 5, 1], normal: [0, 1, 0] }, { at: [2, 4, 0], normal: [1, 0, 0] }],
            },
        }, []);
        expect(circle).toEqual({ point: [0, 5, 0], normal: [0, 1, 0] });
        expect(placeOfPick({ kind: 'ref', ref: 'axis:a', label: 'Axis1' }, [])).toBeNull();
    });
});
