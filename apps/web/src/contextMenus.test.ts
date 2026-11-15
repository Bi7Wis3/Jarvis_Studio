import { describe, expect, it, vi } from 'vitest';
import type { Feature, Part, SketchGeometry } from '@jarvis/core';
import {
    allLocked, componentMenu, drawToolIds, drillFace, edgeMenu, emptyMenu, faceMenu, fittingRelations, referenceMenu, sketchMenu,
    sketchSpaceMenu, sketchStepEntries, tidy, viewMenu, type MenuActions, type MenuContext, type PartListActions, type SketchMenuActions,
    type ViewTarget,
} from './contextMenus';
import type { MenuEntry } from './menus';

// The sketcher's wasm URL only resolves in the browser.
vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

type Item = Extract<MenuEntry, { onSelect: () => void }>;

/** Actions that record what was called, by name and arguments. */
function recorder<T extends object>(): { actions: T; calls: [string, unknown[]][] } {
    const calls: [string, unknown[]][] = [];
    const actions = new Proxy({}, { get: (_, name) => (...args: unknown[]) => calls.push([String(name), args]) }) as T;
    return { actions, calls };
}

const labels = (items: MenuEntry[]): string[] => items.map((i) => (i === 'separator' ? '—' : 'header' in i ? `[${i.header}]` : i.label));
const entry = (items: MenuEntry[], label: string): Item => {
    const found = items.find((i): i is Item => typeof i === 'object' && 'onSelect' in i && i.label === label);
    if (!found) {
        throw new Error(`no entry "${label}" in ${labels(items).join(', ')}`);
    }
    return found;
};
const has = (items: MenuEntry[], label: string): boolean => labels(items).includes(label);

const sketchStep = (id: string, name: string): Feature => ({ id, name, op: 'sketch', sketch: { plane: 'front', offset: 5, profiles: [] } });
const part = {
    id: 'p1',
    name: 'Bracket',
    shape: { kind: 'empty' },
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    material: { color: '#cccccc', metalness: 0, roughness: 0.5 },
    features: [
        sketchStep('s1', 'Sketch1'),
        { id: 'e1', name: 'Boss-Extrude1', op: 'extrude', distance: 10, mode: 'add', sketchRef: 's1' },
        { id: 'pl1', name: 'Plane1', op: 'plane', definition: { kind: 'offset', ref: 'top', distance: 10 } },
    ],
} as unknown as Part;

const context = (over: Partial<MenuContext> = {}): MenuContext => ({
    workspace: 'part',
    part,
    parts: [part],
    hiddenSketches: [],
    hiddenParts: [],
    settings: { grid: true, edges: false, sketches: true, others: false, labels: false },
    ...over,
});

const facePick = { partId: 'p1', kind: 'face' as const, index: 3 };
const spot = { point: [1, 20, 3] as [number, number, number], normal: [0, 1, 0] as [number, number, number], curved: false };
const face = (geom: 'plane' | 'cylinder' | 'cone' | 'surface', normal: [number, number, number] = [0, 1, 0]): Extract<ViewTarget, { kind: 'face' }> => ({
    kind: 'face', partId: 'p1', picks: [facePick], geom, spot: { ...spot, normal, curved: geom !== 'plane' }, worldNormal: [0, 1, 0],
});
const edgePick = { partId: 'p1', kind: 'edge' as const, index: 7 };
const edge = (geom: 'line' | 'circle' | 'curve', full = false): Extract<ViewTarget, { kind: 'edge' }> => ({
    kind: 'edge', partId: 'p1', picks: [edgePick], geom, full, spot: null,
});

describe('right-click menu on a face', () => {
    it('offers sketching, reference geometry and the face tools on a planar face, with the face preselected', () => {
        const { actions, calls } = recorder<MenuActions>();
        const items = faceMenu(face('plane'), context(), actions);
        expect(items[0]).toEqual({ header: 'Planar face of Bracket' });
        expect(labels(items)).toEqual([
            '[Planar face of Bracket]', 'Sketch', 'Extrude', 'Cut', 'Normal to', '—', 'Plane', 'Point', '—',
            'Fillet', 'Chamfer', 'Shell', 'Draft', 'Hole', '—', 'Measure', 'Material', '—', 'Zoom to fit',
        ]);
        expect(items.filter((i) => typeof i === 'object' && 'disabled' in i && i.disabled)).toEqual([]);
        entry(items, 'Sketch').onSelect();
        entry(items, 'Cut').onSelect();
        entry(items, 'Fillet').onSelect();
        entry(items, 'Normal to').onSelect();
        entry(items, 'Point').onSelect();
        expect(calls).toEqual([
            ['sketchOnFace', ['p1', { ...spot, curved: false }, 'sketch']],
            ['sketchOnFace', ['p1', { ...spot, curved: false }, 'cut']],
            ['openTool', ['fillet', { picks: [facePick] }]],
            ['lookAlong', [[0, 1, 0]]],
            ['openTool', ['point', { picks: [facePick], values: { kind: 'faceCentre' } }]],
        ]);
    });

    it('opens Hole on the face where it was clicked, drilling into it', () => {
        const { actions, calls } = recorder<MenuActions>();
        entry(faceMenu(face('plane'), context(), actions), 'Hole').onSelect();
        expect(calls).toEqual([['openTool', ['hole', { values: { face: 'top', pos0: '1', pos1: '20', pos2: '3' } }]]]);
        expect(drillFace([0, 0, -2])).toBe('back');
        expect(drillFace([0.6, 0.8, 0])).toBeNull();
    });

    it('greys Hole on a face at an angle and says why', () => {
        const { actions } = recorder<MenuActions>();
        const hole = entry(faceMenu(face('plane', [0.6, 0.8, 0]), context(), actions), 'Hole');
        expect(hole.disabled).toBe(true);
        expect(hole.title).toMatch(/X, Y or Z/);
    });

    it('on a cylinder: no flat-face tools, adds Axis through it and a greyed Thread pointing at the edge', () => {
        const { actions, calls } = recorder<MenuActions>();
        const items = faceMenu(face('cylinder'), context(), actions);
        expect(items[0]).toEqual({ header: 'Cylindrical face of Bracket' });
        expect(has(items, 'Sketch on tangent plane')).toBe(true);
        for (const flatOnly of ['Normal to', 'Draft', 'Hole']) {
            expect(has(items, flatOnly)).toBe(false);
        }
        entry(items, 'Axis').onSelect();
        expect(calls).toEqual([['openTool', ['axis', { picks: [facePick], values: { kind: 'cylinder' } }]]]);
        const thread = entry(items, 'Thread');
        expect(thread.disabled).toBe(true);
        expect(thread.title).toMatch(/circular edge/);
    });

    it('on a freeform face: Plane is greyed with the reason', () => {
        const { actions } = recorder<MenuActions>();
        const items = faceMenu(face('surface'), context(), actions);
        expect(items[0]).toEqual({ header: 'Face of Bracket' });
        expect(entry(items, 'Plane').disabled).toBe(true);
        expect(entry(items, 'Plane').title).toMatch(/flat face/);
        expect(has(items, 'Axis')).toBe(false);
    });
});

describe('right-click menu on an edge', () => {
    it('straight edge: fillet, chamfer, plane, axis, midpoint, measure', () => {
        const { actions, calls } = recorder<MenuActions>();
        const items = edgeMenu(edge('line'), context(), actions);
        expect(labels(items)).toEqual([
            '[Straight edge of Bracket]', 'Fillet', 'Chamfer', '—', 'Plane', 'Axis', 'Point', '—', 'Measure', '—', 'Zoom to fit',
        ]);
        entry(items, 'Chamfer').onSelect();
        entry(items, 'Point').onSelect();
        expect(calls).toEqual([
            ['openTool', ['chamfer', { picks: [edgePick] }]],
            ['openTool', ['point', { picks: [edgePick], values: { kind: 'along', by: 'percent', amount: '50' } }]],
        ]);
    });

    it('full circle: adds Thread and Point at the centre, no Axis', () => {
        const { actions, calls } = recorder<MenuActions>();
        const items = edgeMenu(edge('circle', true), context(), actions);
        expect(items[0]).toEqual({ header: 'Circular edge of Bracket' });
        expect(has(items, 'Axis')).toBe(false);
        entry(items, 'Thread').onSelect();
        entry(items, 'Point').onSelect();
        expect(calls).toEqual([
            ['openTool', ['thread', { picks: [edgePick] }]],
            ['openTool', ['point', { picks: [edgePick], values: { kind: 'arcCentre' } }]],
        ]);
    });

    it('an arc that is not a full circle has no Thread; a free curve has no Plane or Point', () => {
        const { actions } = recorder<MenuActions>();
        const arc = edgeMenu(edge('circle', false), context(), actions);
        expect(arc[0]).toEqual({ header: 'Arc edge of Bracket' });
        expect(has(arc, 'Thread')).toBe(false);
        const curve = edgeMenu(edge('curve'), context(), actions);
        expect(labels(curve)).toEqual(['[Edge of Bracket]', 'Fillet', 'Chamfer', '—', 'Measure', '—', 'Zoom to fit']);
    });
});

describe('right-click menu on a sketch', () => {
    it('edits, builds from, hides and sketches on the plane of the sketch', () => {
        const { actions, calls } = recorder<MenuActions>();
        const items = sketchMenu({ kind: 'sketch', partId: 'p1', featureId: 's1' }, context(), actions);
        expect(labels(items)).toEqual([
            '[Sketch1]', 'Edit sketch', '—', 'Extrude', 'Cut', 'Revolve', 'Loft', 'Sweep', '—',
            'Sketch on the same plane', 'Normal to', 'Hide sketch', 'Copy sketch', '—', 'Zoom to fit',
        ]);
        // One sketch only: a loft cannot be made from it.
        expect(entry(items, 'Loft').disabled).toBe(true);
        expect(entry(items, 'Loft').title).toMatch(/two or more/);
        entry(items, 'Edit sketch').onSelect();
        entry(items, 'Extrude').onSelect();
        entry(items, 'Sketch on the same plane').onSelect();
        entry(items, 'Hide sketch').onSelect();
        expect(calls).toEqual([
            ['edit', ['p1', 's1']],
            ['openTool', ['extrude', { values: { sketch: 's1' } }]],
            ['sketchOnPlane', ['p1', 'front', 5, 'sketch']],
            ['setSketchHidden', ['p1', 's1', true]],
        ]);
    });

    it('in the tree: no Edit sketch (the tree has it), Show for a hidden sketch, Loft with two sketches', () => {
        const two = { ...part, features: [...part.features!, sketchStep('s2', 'Sketch2')] } as Part;
        const { actions, calls } = recorder<MenuActions>();
        const items = sketchStepEntries(two, 's2', context({ part: two, parts: [two], hiddenSketches: ['p1/s2'] }), actions, true);
        expect(has(items, 'Edit sketch')).toBe(false);
        expect(has(items, 'Zoom to fit')).toBe(false);
        entry(items, 'Show sketch').onSelect();
        entry(items, 'Loft').onSelect();
        expect(calls).toEqual([
            ['setSketchHidden', ['p1', 's2', false]],
            ['openTool', ['loft', { patch: { sections: ['s2'] } }]],
        ]);
    });
});

describe('right-click menu on reference geometry', () => {
    it('a plane: sketch on it, normal to, a plane offset from it, edit, hide', () => {
        const { actions, calls } = recorder<MenuActions>();
        const items = referenceMenu({ kind: 'reference', partId: 'p1', featureId: 'pl1' }, context(), actions);
        expect(labels(items)).toEqual([
            '[Plane1]', 'Sketch', 'Normal to', 'New plane from this one', '—', 'Edit plane', 'Hide', '—', 'Zoom to fit',
        ]);
        entry(items, 'Sketch').onSelect();
        entry(items, 'New plane from this one').onSelect();
        entry(items, 'Hide').onSelect();
        expect(calls).toEqual([
            ['sketchOnPlane', ['p1', { planeRef: 'pl1' }, 0, 'sketch']],
            ['openTool', ['plane', { patch: { r1list: 'plane:pl1' } }]],
            ['setSketchHidden', ['p1', 'pl1', true]],
        ]);
    });
});

describe('right-click menu on empty space', () => {
    it('part workspace: new sketch, views, fit, the view toggles with their state, undo and redo', () => {
        const { actions, calls } = recorder<MenuActions>();
        const items = emptyMenu(context(), actions);
        expect(labels(items)).toEqual([
            '[Bracket]', 'Sketch', '—', 'View orientation', 'Zoom to fit', '—', 'Show sketches', 'Show other parts', 'Grid', 'Edges', '—',
            'Undo', 'Redo',
        ]);
        expect(entry(items, 'Grid').checked).toBe(true);
        expect(entry(items, 'Edges').checked).toBe(false);
        const views = items.find((i) => typeof i === 'object' && 'items' in i);
        expect(views && typeof views === 'object' && 'items' in views && labels(views.items))
            .toEqual(['Isometric', 'Front', 'Top', 'Right', 'Left', 'Back', 'Bottom', 'Trimetric', 'Dimetric']);
        entry(items, 'Sketch').onSelect();
        entry(items, 'Edges').onSelect();
        expect(calls).toEqual([['newSketch', ['p1']], ['toggle', ['edges']]]);
    });

    it('assembly: new part and the insert tools', () => {
        const { actions } = recorder<MenuActions>();
        const items = emptyMenu(context({ workspace: 'assembly', part: null }), actions);
        expect(labels(items).slice(0, 2)).toEqual(['New part', 'Insert']);
        const insert = items[1];
        expect(typeof insert === 'object' && 'items' in insert && labels(insert.items)).toContain('Fastener');
        expect(has(items, 'Labels')).toBe(true);
        expect(has(items, 'Show sketches')).toBe(false);
    });

    it('a click on another part than the one edited counts as empty space', () => {
        const { actions } = recorder<MenuActions>();
        const list = recorder<PartListActions>().actions;
        const items = viewMenu({ ...face('plane'), partId: 'other' }, context(), actions, list);
        expect(has(items, 'View orientation')).toBe(true);
    });
});

describe('right-click menu on a part in the assembly', () => {
    const instance = { ...part, id: 'p2', name: 'Bracket 2', instanceOf: 'p1' } as Part;
    const ctx = context({ workspace: 'assembly', part: null, parts: [part, instance] });

    it('is the components list menu, with a sketch on the face that was clicked', () => {
        const { actions, calls } = recorder<MenuActions>();
        const list = recorder<PartListActions>();
        const items = viewMenu(face('plane'), ctx, actions, list.actions);
        expect(labels(items)).toEqual([
            '[Bracket]', 'Edit part', 'Edit in place', 'Sketch on this face', 'Insert instance', 'Pattern this part', '—',
            'Move', 'Rotate', 'Mirror copy', 'Material', 'Add picture', '—',
            'Rename', 'Duplicate as new part', 'Hide', 'Zoom to part', '—', 'Delete with all instances',
        ]);
        entry(items, 'Sketch on this face').onSelect();
        entry(items, 'Move').onSelect();
        entry(items, 'Rename').onSelect();
        expect(calls).toEqual([
            ['sketchOnFace', ['p1', { ...spot, curved: false }, 'sketch']],
            ['openTool', ['move', { select: 'p1' }]],
        ]);
        expect(list.calls).toEqual([['rename', [part]]]);
        // The list's own menu: the same, without the face.
        expect(labels(componentMenu(part, ctx, actions, list.actions))).toEqual(labels(items).filter((l) => l !== 'Sketch on this face'));
    });

    it('an instance edits the shared design and sketches on it; a hidden part offers Show', () => {
        const { actions, calls } = recorder<MenuActions>();
        const list = recorder<PartListActions>().actions;
        const items = componentMenu(instance, { ...ctx, hiddenParts: ['p2'] }, actions, list, spot);
        expect(labels(items)).toContain('Edit the shared design');
        expect(labels(items)).toContain('Delete instance');
        expect(has(items, 'Insert instance')).toBe(false);
        expect(has(items, 'Duplicate as new part')).toBe(false);
        entry(items, 'Sketch on this face').onSelect();
        entry(items, 'Show').onSelect();
        expect(calls).toEqual([['sketchOnFace', ['p1', spot, 'sketch']], ['setHidden', ['p2', false]]]);
    });
});

// ---- Open sketch -------------------------------------------------------------------------------------------------

const geometry: SketchGeometry = {
    points: [{ id: 'a', u: 0, v: 0 }, { id: 'b', u: 10, v: 1 }, { id: 'c', u: 0, v: 5 }, { id: 'd', u: 9, v: 7 }],
    curves: [{ id: 'l1', kind: 'line', a: 'a', b: 'b' }, { id: 'l2', kind: 'line', a: 'c', b: 'd', construction: true }],
    constraints: [{ id: 'k1', kind: 'fix', point: 'a' }, { id: 'k2', kind: 'fix', point: 'b' }],
};
const sketchState = (over: Partial<Parameters<typeof sketchSpaceMenu>[0]> = {}): Parameters<typeof sketchSpaceMenu>[0] => ({
    stage: 'draw', tool: 'select', geometry, draft: 0, selection: [], lastUsed: {}, ...over,
});

describe('right-click menu in an open sketch', () => {
    it('on two lines: delete, construction, the relations that fit, unlock or lock, dimension', () => {
        const { actions, calls } = recorder<SketchMenuActions>();
        const items = sketchSpaceMenu(sketchState({ selection: [{ type: 'curve', id: 'l1' }, { type: 'curve', id: 'l2' }] }), actions);
        expect(items[0]).toEqual({ header: '2 items' });
        expect(labels(items)).toEqual(expect.arrayContaining(['Delete', 'Construction geometry', 'Parallel', 'Perpendicular', 'Equal',
            'Collinear', 'Horizontal', 'Vertical', 'Lock', 'Dimension']));
        // Relations that two lines do not take are left out.
        for (const no of ['Coincident', 'Tangent', 'Concentric', 'Midpoint', 'Symmetric']) {
            expect(has(items, no)).toBe(false);
        }
        // One of the two is construction: not all are.
        expect(entry(items, 'Construction geometry').checked).toBe(false);
        entry(items, 'Parallel').onSelect();
        entry(items, 'Delete').onSelect();
        expect(calls).toEqual([['openTool', ['sk-c-parallel']], ['deleteSelected', []]]);
    });

    it('on one locked line: Unlock; a point alone cannot be construction geometry', () => {
        const { actions } = recorder<SketchMenuActions>();
        const line = sketchSpaceMenu(sketchState({ selection: [{ type: 'curve', id: 'l1' }] }), actions);
        expect(line[0]).toEqual({ header: 'Line' });
        expect(has(line, 'Unlock')).toBe(true);
        expect(allLocked(geometry, [{ type: 'curve', id: 'l2' }])).toBe(false);
        const point = sketchSpaceMenu(sketchState({ selection: [{ type: 'point', id: 'c' }] }), actions);
        expect(point[0]).toEqual({ header: 'Point' });
        expect(entry(point, 'Construction geometry').disabled).toBe(true);
        expect(entry(point, 'Construction geometry').title).toMatch(/lines, arcs and circles/);
        expect(has(point, 'Lock')).toBe(true);
    });

    it('on empty space: the draw tools last used, dimension, exit, discard, fit, undo and redo', () => {
        const { actions, calls } = recorder<SketchMenuActions>();
        const items = sketchSpaceMenu(sketchState({ lastUsed: { rectangle: 'sk-centerRect', arc: 'sk-tangentArc' } }), actions);
        expect(labels(items)).toEqual(expect.arrayContaining(['Line', 'Centre rectangle', 'Circle', 'Tangent arc', 'Slot', 'Dimension',
            'Exit sketch', 'Discard sketch', 'Zoom to fit', 'Normal to', 'Undo', 'Redo']));
        expect(has(items, 'Select')).toBe(false);
        entry(items, 'Centre rectangle').onSelect();
        entry(items, 'Exit sketch').onSelect();
        entry(items, 'Normal to').onSelect();
        expect(calls).toEqual([['openTool', ['sk-centerRect']], ['openTool', ['sk-finish']], ['openTool', ['sk-normal-to']]]);
        expect(drawToolIds({ line: 'sk-bogus' })[0]).toBe('sk-line');
    });

    it('while a tool is on, Select comes first to stop it', () => {
        const { actions } = recorder<SketchMenuActions>();
        const items = sketchSpaceMenu(sketchState({ tool: 'circle' }), actions);
        expect(labels(items)[0]).toBe('Select');
    });

    it('mid-command: ends the line chain (SolidWorks: right-click > End chain) instead of the full menu', () => {
        const { actions, calls } = recorder<SketchMenuActions>();
        const items = sketchSpaceMenu(sketchState({ tool: 'line', draft: 2 }), actions);
        expect(labels(items)).toEqual(['[Line]', 'End chain', 'Select', 'Quick snaps', '—', 'Undo', 'Redo']);
        entry(items, 'End chain').onSelect();
        expect(calls).toEqual([['endChain', []]]);
        expect(labels(sketchSpaceMenu(sketchState({ tool: 'circle', draft: 1 }), actions))[1]).toBe('Drop this shape');
    });

    it('while the plane is being chosen: cancel only', () => {
        const { actions } = recorder<SketchMenuActions>();
        expect(labels(sketchSpaceMenu(sketchState({ stage: 'plane' }), actions))).toEqual(['[Choose a plane or a flat face]', 'Cancel sketch']);
    });

    it('fittingRelations follows the relation buttons: nothing for no selection', () => {
        expect(fittingRelations(geometry, [])).toEqual([]);
        expect(fittingRelations(geometry, [{ type: 'point', id: 'c' }, { type: 'point', id: 'd' }]).map((r) => r.id))
            .toEqual(expect.arrayContaining(['coincident', 'horizontal', 'vertical']));
    });
});

describe('tidy', () => {
    it('drops left-over separators', () => {
        expect(tidy(['separator', { header: 'X' }, 'separator', false, { label: 'A', onSelect: () => undefined }, 'separator', 'separator']))
            .toEqual([{ header: 'X' }, { label: 'A', onSelect: expect.any(Function) }]);
    });
});

// Last: once a sketch is copied, faces and planes offer Paste sketch (SolidWorks: Copying and Pasting Entire Sketches).
describe('copy and paste of a whole sketch', () => {
    it('Copy sketch copies it; then a face and a plane offer Paste sketch', async () => {
        const { copyWholeSketch, hasCopiedSketch } = await import('./sketchPasteSketch');
        const { actions, calls } = recorder<MenuActions>();
        entry(sketchMenu({ kind: 'sketch', partId: 'p1', featureId: 's1' }, context(), actions), 'Copy sketch').onSelect();
        expect(calls).toEqual([['copySketch', ['p1', 's1']]]);
        expect(hasCopiedSketch()).toBe(false);
        expect(copyWholeSketch({ plane: 'front', profiles: [] }, 'Sketch1')).toMatch(/empty/);
        const geometry: SketchGeometry = { points: [{ id: 'a', u: 0, v: 0 }, { id: 'b', u: 10, v: 0 }], curves: [{ id: 'l', kind: 'line', a: 'a', b: 'b' }], constraints: [] };
        expect(copyWholeSketch({ plane: 'front', profiles: [], geometry }, 'Sketch1')).toBeNull();
        expect(hasCopiedSketch()).toBe(true);
        entry(faceMenu(face('plane'), context(), actions), 'Paste sketch').onSelect();
        entry(referenceMenu({ kind: 'reference', partId: 'p1', featureId: 'pl1' }, context(), actions), 'Paste sketch').onSelect();
        expect(calls.slice(1)).toEqual([
            ['pasteSketch', ['p1', { face: { ...spot, curved: false } }]],
            ['pasteSketch', ['p1', { plane: { planeRef: 'pl1' } }]],
        ]);
    });
});
