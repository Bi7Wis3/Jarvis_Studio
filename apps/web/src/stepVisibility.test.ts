import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, type Feature, type Part, type Project, type Sketch } from '@jarvis/core';
import { absorbedSketches, hiddenSteps, hideConsumed, setStepHidden, viewPart } from '@jarvis/core/visibility';
import { shownSketchSteps, stepDrawing } from './sketchStepView';
import { otherSketches } from './sketchOthers';
import { assemblySketches } from './sketchAssemblySnaps';

const square: Sketch = {
    plane: 'front',
    profiles: [],
    geometry: {
        points: [
            { id: 'origin', u: 0, v: 0 }, { id: 'a', u: 0, v: 0 }, { id: 'b', u: 10, v: 0 }, { id: 'c', u: 10, v: 10 },
            { id: 'd', u: 0, v: 10 }, { id: 'm', u: 5, v: -5 }, { id: 'n', u: 5, v: 15 }, { id: 'lone', u: 20, v: 20 },
        ],
        curves: [
            { id: 'l1', kind: 'line', a: 'a', b: 'b' }, { id: 'l2', kind: 'line', a: 'b', b: 'c' },
            { id: 'l3', kind: 'line', a: 'c', b: 'd' }, { id: 'l4', kind: 'line', a: 'd', b: 'a' },
            // An open line and a centre line: neither is part of a closed profile.
            { id: 'open', kind: 'line', a: 'b', b: 'lone' },
            { id: 'axis', kind: 'line', a: 'm', b: 'n', construction: true },
        ],
        constraints: [],
    },
};

const steps = (): Feature[] => [
    { id: 's1', name: 'Sketch1', op: 'sketch', sketch: square },
    { id: 's2', name: 'Sketch2', op: 'sketch', sketch: square },
    { id: 'e1', name: 'Boss-Extrude1', op: 'extrude', mode: 'add', distance: 5, sketchRef: 's1' },
    { id: 't1', name: 'Thread1', op: 'thread', kind: 'internal', pitch: 1, length: 5, at: [0, 0, 0] },
] as Feature[];

const part = (id = 'p1', features = steps()): Part => ({
    id, name: id, shape: { kind: 'empty' }, position: [0, 0, 0], rotation: [0, 0, 0], material: { color: '#cccccc', metalness: 0, roughness: 0.5 },
    features,
});

describe('which steps the view shows', () => {
    it('hides a sketch once a feature is built from it, and keeps an unused one shown', () => {
        expect([...absorbedSketches(steps())]).toEqual(['s1']);
        const hidden = hiddenSteps({}, [part()]);
        expect(hidden.has('p1/s1')).toBe(true);
        expect(hidden.has('p1/s2')).toBe(false);
    });

    it('shows an absorbed sketch by its eye, and hides it again when another feature is built from it', () => {
        const p = part();
        const shown = setStepHidden({}, p, 's1', false);
        expect(shown).toEqual({ hiddenSketches: [], shownSketches: ['p1/s1'] });
        expect(hiddenSteps(shown, [p]).has('p1/s1')).toBe(false);
        // An unused sketch is hidden and shown by name only.
        const off = setStepHidden(shown, p, 's2', true);
        expect(hiddenSteps(off, [p]).has('p1/s2')).toBe(true);
        expect(setStepHidden(off, p, 's2', false)).toEqual({ hiddenSketches: [], shownSketches: ['p1/s1'] });
        // A cut made from Sketch1 too hides it again (SolidWorks does on OK).
        const cut = { id: 'c1', op: 'extrude', mode: 'cut', distance: 2, sketchRef: 's1' } as Feature;
        expect(hideConsumed(shown.shownSketches, 'p1', [cut])).toEqual([]);
        expect(hideConsumed(['p1/s1', 'p2/s1'], 'p2', [cut])).toEqual(['p1/s1']);
    });

    it('marks a hidden thread cosmetic for the view build only', () => {
        const p = part();
        expect(viewPart(p, 'p1', {})).toBe(p);
        const view = viewPart(p, 'p1', { hiddenSketches: ['p1/t1'] });
        expect(view.features!.find((f) => f.id === 't1')).toMatchObject({ cosmetic: true });
        expect(p.features!.find((f) => f.id === 't1')).not.toHaveProperty('cosmetic');
        // An instance builds its source's steps, named by the source.
        expect(viewPart(p, 'other', { hiddenSketches: ['p1/t1'] })).toBe(p);
    });

    it('draws a hidden sketch only while a form works with it', () => {
        const features = steps();
        const hidden = hiddenSteps({}, [part('p1', features)]);
        expect(shownSketchSteps(features, 'p1', hidden, null).map((f) => f.id)).toEqual(['s2']);
        expect(shownSketchSteps(features, 'p1', hidden, 's2').map((f) => f.id)).toEqual([]);
        expect(shownSketchSteps(features, 'p1', hidden, null, (id) => id === 's1').map((f) => f.id)).toEqual(['s1', 's2']);
    });
});

describe('a shown sketch step', () => {
    it('draws every curve, its construction lines dashed and its own points', () => {
        const drawing = stepDrawing(square);
        // The four sides and the open line; the centre line apart.
        expect(drawing.curves).toHaveLength(5);
        expect(drawing.construction).toEqual([[[5, -5, 0], [5, 15, 0]]]);
        // "lone" ends the open line: no point stands on its own here.
        expect(drawing.points).toEqual([]);
        const dotted = stepDrawing({ ...square, geometry: { ...square.geometry!, points: [...square.geometry!.points, { id: 'p', u: 3, v: 3 }] } });
        expect(dotted.points).toEqual([[3, 3, 0]]);
        expect(drawing.dash).toBeGreaterThan(0);
    });

    it('is snapped to from a sketch on another part of the assembly, in that part\'s placement', () => {
        // Part p2 sits 100 mm along X; its sketch on its front plane. A sketch on p1's front plane sees it 100 mm along u.
        const p1 = part('p1', []);
        const p2 = { ...part('p2', [{ id: 's1', name: 'Sketch1', op: 'sketch', sketch: square }] as Feature[]), position: [100, 0, 0] as [number, number, number] };
        const project: Project = { name: 'A', parts: [p1, p2], view: { ...DEFAULT_VIEW } };
        const others = assemblySketches(project, project.parts, 'p1', new Set());
        expect(others).toHaveLength(1);
        const g = otherSketches([], 'front', 0, () => false, others);
        const corner = g.points.find((p) => p.id === 'p2:s1/c')!;
        expect([corner.u, corner.v].map((x) => Math.round(x * 1e6) / 1e6)).toEqual([110, 10]);
        // The centre line is there to snap to too.
        expect(g.curves.some((c) => c.id === 'p2:s1/axis')).toBe(true);
        // Hidden on p2, nothing of it is offered.
        expect(otherSketches([], 'front', 0, () => false, assemblySketches(project, project.parts, 'p1', new Set(['p2/s1']))).points).toEqual([]);
    });
});
