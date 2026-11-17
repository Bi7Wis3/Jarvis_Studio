import { describe, expect, it, vi } from 'vitest';
import type { Feature, Part, SketchGeometry, Vec3 } from '@jarvis/core';
import { resolvePlane } from '@jarvis/core/reference';
import { curveItem, curveLabel, curvePointItem, curvePointOf } from './curvePicks';
import {
    planeAutoPatch, planeDefaults, planeDefinition, planeValues, pointDefaults, pointSteps, pointValues, referenceStatus, refOptions, stepItem,
    type RefValues,
} from './referenceDefs';
import { featureSummary, stepRefs } from './historyText';
import { helixPierce, helixSnapPoints, pierceHelixPoint } from './sketchHelixPierce';
import { pierceCurves } from './sketchPierce';
import { planeFrame } from './sketchMath';
import { otherSketches } from './sketchOthers';
import { curveOf, type CurveNormalDefinition } from '@jarvis/core/curveRefs';

// The sketcher's wasm URL only resolves in the browser.
vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

const close = (a: readonly number[], b: readonly number[], digits = 9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

// A circle of radius 10 about the Y axis on the top plane, and a 6-turn helix of pitch 5 on it.
const steps = (pitch = 5, radius = 10): Feature[] => [
    { id: 'ring', name: 'Sketch1', op: 'sketch', sketch: { plane: 'top', profiles: [{ kind: 'circle', center: [0, 0], radius }] } },
    { id: 'coil', name: 'Helix/Spiral1', op: 'helix', sketchRef: 'ring', definedBy: 'pitchRevolution', pitch, revolutions: 6 },
];

describe('picks on a helix', () => {
    it('names the curve and its ends, and offers them in the lists', () => {
        const f = steps();
        expect(curveLabel('curve:coil', f)).toBe('Helix/Spiral1');
        expect(curveLabel('curvept:coil:start', f)).toBe('Helix/Spiral1 start');
        expect(curveLabel('curvept:coil:0.25', f)).toBe('Helix/Spiral1 at 25%');
        expect(curvePointOf('curvept:coil:end')).toEqual({ curveRef: 'coil', at: 'end' });
        expect(curvePointOf('curvept:coil:x')).toBeNull();
        expect(stepItem(f[1])).toEqual({ kind: 'ref', ref: 'curve:coil', label: 'Helix/Spiral1' });
        const options = refOptions(['plane', 'line', 'point', 'curve'], f).map((o) => o.value);
        expect(options).toContain('curve:coil');
        expect(options).toContain('curvept:coil:start');
        expect(options).toContain('curvept:coil:end');
    });

    it('makes a plane perpendicular to the helix through its start, and reopens it as made', () => {
        const f = steps();
        let v: RefValues = { ...planeDefaults(), r1: [curveItem('coil', f)] };
        v = { ...v, ...planeAutoPatch('r1', v) };
        expect(v.c1curve).toBe('perpendicular');
        expect(referenceStatus('plane', v, f).text).toMatch(/pick a point/);
        v = { ...v, r2: [curvePointItem({ curveRef: 'coil', at: 'start' }, f)] };
        v = { ...v, ...planeAutoPatch('r2', v) };
        const d = planeDefinition(v);
        expect(d).toEqual({ kind: 'curveNormal', curve: { curveRef: 'coil' }, point: { curveRef: 'coil', at: 'start' } });
        expect(referenceStatus('plane', v, f)).toEqual({ ok: true, text: 'Fully defined' });
        const plane = resolvePlane({ planeRef: 'p' }, [...f, { id: 'p', op: 'plane', definition: d }]);
        close(plane.origin, [10, 0, 0]);
        close(plane.xDir, [-1, 0, 0]);
        // Reopened, then with Set origin on curve.
        const back = planeValues({ ...(d as CurveNormalDefinition), originOnCurve: true }, f);
        expect(back.c1curve).toBe('perpendicular');
        expect(back.originOnCurve).toBe(true);
        expect(planeDefinition(back)).toEqual({ ...d, originOnCurve: true });
    });

    it('makes points at the helix end and along it, kept by the helix id', () => {
        const f = steps();
        const end = pointSteps({ ...pointDefaults(), kind: 'vertex', vx: [curvePointItem({ curveRef: 'coil', at: 'end' }, f)] }, false, f);
        expect(end).toHaveLength(1);
        close(end[0].position, [10, 30, 0]);
        expect(end[0].definition).toEqual({ kind: 'onCurve', curve: { curveRef: 'coil', at: 'end' } });
        const along = pointSteps({ ...pointDefaults(), kind: 'along', ed: [curveItem('coil', f)], by: 'percent', amount: '25', count: '3' }, false, f);
        expect(along.map((s) => s.definition)).toEqual([1, 2, 3].map((index) => ({ kind: 'alongCurve', curve: { curveRef: 'coil' }, by: 'percent', amount: 25, index })));
        // A constant pitch helix runs evenly: a quarter of its length is 1.5 turns, 7.5 up, on the far side.
        close(along[0].position, [-10, 7.5, 0], 6);
        const reopened = pointValues({ id: 'tip', op: 'point', position: end[0].position, definition: end[0].definition }, f);
        expect(reopened).toMatchObject({ kind: 'vertex', vxlist: 'curvept:coil:end' });
    });

    it('describes and orders planes and points made on the helix', () => {
        const f = steps();
        const plane: Feature = { id: 'p', op: 'plane', definition: { kind: 'curveNormal', curve: { curveRef: 'coil' }, point: { curveRef: 'coil', at: 'start' } } };
        const point: Feature = { id: 't', op: 'point', position: [10, 30, 0], definition: { kind: 'onCurve', curve: { curveRef: 'coil', at: 'end' } } };
        const part = { features: [...f, plane, point] } as Part;
        expect(stepRefs(plane)).toEqual(['coil']);
        expect(stepRefs(point)).toEqual(['coil']);
        expect(featureSummary(plane, part)).toBe('Perpendicular to Helix/Spiral1 at the start of Helix/Spiral1');
        expect(featureSummary(point, part)).toBe('On the end of Helix/Spiral1, at (10, 30, 0)');
    });
});

describe('the helix seen from a sketch', () => {
    const square: Feature = { id: 'p', op: 'plane', definition: { kind: 'curveNormal', curve: { curveRef: 'coil' }, point: { curveRef: 'coil', at: 'start' } } };

    it('offers its start and end to snap to', () => {
        const f = steps();
        const here = planeFrame('front', 0, f);
        const g = otherSketches(f, 'front', 0);
        expect(g.points.filter((p) => p.id.startsWith('coil/'))).toEqual([
            { id: 'coil/start', u: 10, v: 0 }, { id: 'coil/end', u: 10, v: 30 },
        ]);
        expect(helixSnapPoints(f, here, (id) => id === 'coil')).toEqual([]);
    });

    it('finds where it pierces a plane, and ties a point there to the origin of a plane made on it', () => {
        const f = [...steps(), square];
        const here = planeFrame({ planeRef: 'p' }, 0, f);
        const s = curveOf('coil', f);
        const crossings = helixPierce(s, here);
        // Through the start (the plane's origin), and further crossings up the coil.
        expect(crossings[0]).toEqual([0, 0]);
        expect(crossings.length).toBeGreaterThan(1);
        expect(pierceCurves(f, here, ['coil/curve']).points[0]).toEqual([0, 0]);
        // A circle's centre near the origin: tied to the origin (it follows the helix with the plane).
        const g: SketchGeometry = {
            points: [{ id: 'p1', u: 0.3, v: -0.2 }], curves: [{ id: 'c1', kind: 'circle', center: 'p1', radius: 1 }],
            constraints: [{ id: 'k1', kind: 'fix', point: 'p1' }],
        };
        const tied = pierceHelixPoint(g, ['p1'], ['coil/curve'], f, here, { planeRef: 'p' }, 0)!;
        expect(tied.points[0]).toMatchObject({ u: 0, v: 0 });
        expect(tied.constraints).toEqual([{ id: expect.any(String), kind: 'coincident', a: 'p1', b: 'origin' }]);
        // On the front plane the crossing is locked where it is (by value).
        const front = planeFrame('front', 0, f);
        const locked = pierceHelixPoint({ ...g, points: [{ id: 'p1', u: 9, v: 1 }] }, ['p1'], ['coil/curve'], f, front, 'front', 0)!;
        const at = locked.points[0];
        close([at.u, at.v], [10, 0]);
        expect(locked.constraints.map((c) => c.kind)).toEqual(['fix']);
    });

    it('a plane on the helix and what pierces it follow a change of pitch and diameter', () => {
        const changed = [...steps(8, 14), square];
        const here = planeFrame({ planeRef: 'p' }, 0, changed);
        close(here.origin as Vec3, [14, 0, 0]);
        expect(helixPierce(curveOf('coil', changed), here)[0]).toEqual([0, 0]);
    });
});
