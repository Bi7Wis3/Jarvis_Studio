import { describe, expect, it } from 'vitest';
import type { AxisDefinition, Feature, PlaneDefinition, Vec3 } from '@jarvis/core';
import { resolvePlane, sketchFrameOf } from '@jarvis/core/reference';
import { pickItems, type PickItem } from './pickField';
import {
    axisDefaults, axisDefinition, axisValues, boxListPatch, checkReference, lineKey, linePickTarget, planeAutoPatch, planeCount,
    planeAngleAxisPatch, planeAngleHandle,
    planeDefaults, planeDefinition, planeValues, pointDefaults, pointPositions, pointSteps, pointValues, refItem, refLabel, refPickPatch,
    referenceStatus, type RefValues,
} from './referenceDefs';

// Picks on a 40 x 10 x 20 block (x 0..40, y 0..10, z 0..20) as the view makes them (pickRefs.modelPick).
const face = (origin: Vec3, normal: Vec3): PickItem => ({
    kind: 'face', at: origin, normal, model: { geom: { type: 'plane', origin, normal }, click: origin, centre: origin },
});
const topFace = face([20, 10, 10], [0, 1, 0]);
const bottomFace = face([20, 0, 10], [0, -1, 0]);
const vertex = (at: Vec3): PickItem => ({ kind: 'vertex', at, model: { geom: { type: 'vertex', at }, click: at } });
const edge = (a: Vec3, b: Vec3): PickItem => ({ kind: 'edge', at: a, model: { geom: { type: 'line', a, b }, click: a } });
const frontTopEdge = edge([0, 10, 20], [40, 10, 20]);
const cylinder: PickItem = {
    kind: 'face', at: [5, 3, 0],
    model: { geom: { type: 'cylinder', point: [0, 3, 0], direction: [0, 1, 0], radius: 5 }, click: [4.9, 3, 0.2] },
};

/** The form after picking `items` into the boxes in turn, constraints set as a click sets them. */
function picked(...items: PickItem[]): RefValues {
    let v = planeDefaults();
    items.forEach((item, i) => {
        v = { ...v, [`r${i + 1}`]: [item] };
        v = { ...v, ...planeAutoPatch(`r${i + 1}`, v) };
    });
    return v;
}

describe('plane form from picks', () => {
    it('offsets from a picked face (the owner\'s main case), flips, makes several, and a sketch goes on it', () => {
        const v = { ...picked(topFace), d1: '2.5', n1: '3' };
        const d = planeDefinition(v);
        // The face as it is now, and the pick the kernel finds again at every rebuild (so the plane follows the face).
        expect(d).toEqual({
            kind: 'offset', distance: 2.5,
            base: { fixedPlane: { origin: [20, 10, 10], normal: [0, 1, 0], xDir: [1, 0, 0] }, from: 'face', pick: { face: { at: [20, 10, 10], normal: [0, 1, 0] } } },
        });
        expect(planeCount(v)).toBe(3);
        expect(planeDefinition(v, 3)).toMatchObject({ distance: 7.5 });
        expect(planeDefinition({ ...v, f1: true })).toMatchObject({ distance: -2.5 });
        expect(planeDefinition({ ...v, flipNormal: true })).toMatchObject({ flipNormal: true });
        // Stored as a step, it resolves and carries a sketch.
        const steps: Feature[] = [{ id: 'p', op: 'plane', definition: d }];
        const frame = sketchFrameOf({ plane: { planeRef: 'p' } }, steps);
        expect(frame.origin).toEqual([20, 12.5, 10]);
        expect(frame.normal).toEqual([0, 1, 0]);
        // Fine values keep their precision.
        expect(planeDefinition({ ...v, d1: '0.0001' })).toMatchObject({ distance: 0.0001 });
    });

    it('offsets from a base plane chosen in the list', () => {
        let v = planeDefaults();
        v = { ...v, r1list: 'front' };
        v = { ...v, ...boxListPatch('r1list', v, [])! };
        v = { ...v, ...planeAutoPatch('r1', v) };
        expect(planeDefinition(v)).toEqual({ kind: 'offset', base: 'front', distance: 10 });
        expect(refLabel('top')).toBe('Top plane (XZ)');
        expect(refLabel('right')).toBe('Right plane (YZ)');
        expect(refLabel('front')).toBe('Front plane (XY)');
        // A click in the view shows "picked" in the list again.
        expect(boxListPatch('r1', { ...v, r1: [topFace] }, [])).toEqual({ r1list: '' });
    });

    it('turns a plane at once when At angle is chosen: about its own axis, shown in the next box', () => {
        let v = planeDefaults();
        v = { ...v, r1list: 'top' };
        v = { ...v, ...boxListPatch('r1list', v, [])! };
        v = { ...v, ...planeAutoPatch('r1', v) };
        v = { ...v, c1plane: 'angle', a1: '30.0001' };
        const patch = planeAngleAxisPatch('c1plane', v);
        expect(patch).toMatchObject({ r2list: 'u', c2line: 'coincident' });
        v = { ...v, ...patch };
        expect(planeDefinition(v)).toEqual({ kind: 'angle', base: 'top', about: 'u', angle: 30.0001 });
        expect(referenceStatus('plane', v, []).ok).toBe(true);
        // The arc to drag: about the plane's own axis, starting in the plane and square to that axis.
        const base = resolvePlane('top', []);
        const arc = planeAngleHandle(v, [])!;
        expect(arc).toMatchObject({ key: 'a1', value: 30.0001, origin: base.origin, axis: base.xDir });
        expect(arc.start.reduce((sum, x, i) => sum + x * base.normal[i], 0)).toBeCloseTo(0);
        expect(arc.start.reduce((sum, x, i) => sum + x * base.xDir[i], 0)).toBeCloseTo(0);
        // Flipped, it turns the other way: the same arc about the opposite axis.
        expect(planeAngleHandle({ ...v, f1: true }, [])!.axis.map((x) => x + 0)).toEqual(base.xDir.map((x) => -x + 0));
        // With an edge already picked to turn about, nothing is put in a box.
        expect(planeAngleAxisPatch('c1plane', { ...v, r2: [frontTopEdge] })).toEqual({});
        expect(planeAngleHandle({ ...v, c1plane: 'offset' }, [])).toBeNull();
    });

    it('makes a mid plane between two picked faces', () => {
        const v = picked(topFace, bottomFace);
        expect(v.c1plane).toBe('mid');
        expect(v.c2plane).toBe('mid');
        const d = planeDefinition(v);
        expect(d.kind).toBe('midplane');
        const p = resolvePlane({ planeRef: 'm' }, [{ id: 'm', op: 'plane', definition: d }]);
        expect(p.origin[1]).toBeCloseTo(5, 9);
    });

    it('makes a plane through three picked vertices', () => {
        const v = picked(vertex([0, 10, 0]), vertex([40, 10, 0]), vertex([0, 0, 20]));
        const d = planeDefinition(v);
        const at = (p: Vec3) => ({ fixedPoint: p, from: 'vertex', pick: { vertex: p } });
        expect(d).toEqual({ kind: 'threePoints', points: [at([0, 10, 0]), at([40, 10, 0]), at([0, 0, 20])] });
        const frame = sketchFrameOf({ plane: { planeRef: 't' } }, [{ id: 't', op: 'plane', definition: d }]);
        expect(frame.origin).toEqual([0, 10, 0]);
        expect(() => planeDefinition(picked(vertex([0, 10, 0]), vertex([40, 10, 0])))).toThrow(/third point/);
    });

    it('makes parallel, at angle and perpendicular planes from a face with a vertex or an edge', () => {
        expect(planeDefinition(picked(topFace, vertex([0, 0, 20])))).toMatchObject({ kind: 'parallel', point: { fixedPoint: [0, 0, 20] } });
        const angled = picked(topFace, frontTopEdge);
        expect(angled.c1plane).toBe('angle');
        expect(planeDefinition({ ...angled, a1: '30' })).toMatchObject({
            kind: 'angle', angle: 30, throughAxis: true, about: { fixedAxis: { point: [20, 10, 20], direction: [1, 0, 0] }, from: 'edge' },
        });
        expect(planeDefinition({ ...angled, a1: '30', n1: '2' }, 2)).toMatchObject({ angle: 60 });
        expect(planeDefinition({ ...angled, c1plane: 'perpendicular' })).toMatchObject({ kind: 'perpendicular' });
    });

    it('makes a plane through an edge and a point, and normal to an edge at a point', () => {
        const alone = picked(frontTopEdge);
        expect(alone.c1line).toBe('perpendicular');
        expect(planeDefinition(alone)).toMatchObject({ kind: 'normal' });
        const both = picked(frontTopEdge, vertex([0, 0, 20]));
        expect(planeDefinition(both)).toMatchObject({ kind: 'normal', point: { fixedPoint: [0, 0, 20] } });
        expect(planeDefinition({ ...both, c1line: 'coincident' })).toMatchObject({ kind: 'linePoint', point: { fixedPoint: [0, 0, 20] } });
    });

    it('makes planes tangent to a picked cylinder: where clicked, through a point, parallel or at an angle to a plane', () => {
        const at = planeDefinition(picked(cylinder));
        expect(at).toMatchObject({ kind: 'tangent', cylinder: { point: [0, 3, 0], direction: [0, 1, 0], radius: 5 } });
        // The click is moved onto the surface.
        const p = (at as Extract<PlaneDefinition, { kind: 'tangent' }>).point as Vec3;
        expect(Math.hypot(p[0], p[2])).toBeCloseTo(5, 9);
        expect(planeDefinition({ ...picked(cylinder, vertex([10, 0, 0])), f1: true })).toMatchObject({ point: { fixedPoint: [10, 0, 0] }, flip: true });
        expect(at).toMatchObject({ cylinder: { pick: { face: { at: [5, 3, 0] } } } });
        let v = picked(cylinder);
        v = { ...v, r2list: 'front' };
        v = { ...v, ...boxListPatch('r2list', v, [])! };
        v = { ...v, ...planeAutoPatch('r2', v) };
        expect(v.c2plane).toBe('parallel');
        expect(planeDefinition(v)).toMatchObject({ kind: 'tangent', plane: 'front' });
        expect(planeDefinition({ ...v, c2plane: 'angle', a2: '20' })).toMatchObject({ plane: 'front', angle: 20 });
        // Coincident: through its axis, at an angle to a plane (the SolidWorks example).
        expect(planeDefinition({ ...v, c1cyl: 'coincident', c2plane: 'angle', a2: '30' })).toMatchObject({
            kind: 'angle', base: 'front', angle: 30, about: { fixedAxis: { point: [0, 3, 0] }, from: 'cylinder' },
        });
    });

    it('keeps each pick so the kernel can follow the model; a reopened step saves its own pick again, an older one stays by value', () => {
        // An edge keeps the faces that meet at it, as the view found them.
        const faces = [{ at: [20, 10, 19] as Vec3, normal: [0, 1, 0] as Vec3 }, { at: [20, 9, 20] as Vec3, normal: [0, 0, 1] as Vec3 }];
        const withFaces = { ...frontTopEdge, model: { geom: { type: 'line', a: [0, 10, 20], b: [40, 10, 20] }, click: [0, 10, 20], faces } } as PickItem;
        expect(planeDefinition(picked(withFaces))).toMatchObject({ kind: 'normal', axis: { from: 'edge', pick: { edge: [0, 10, 20], faces } } });
        // Where the kernel found the face later (the block made 10 taller): the step reopens there and saves the same pick.
        const found: PlaneDefinition = {
            kind: 'offset', distance: 2,
            base: { fixedPlane: { origin: [20, 20, 10], normal: [0, 1, 0], xDir: [1, 0, 0] }, from: 'face', pick: { face: { at: [3, 10, 2], normal: [0, 1, 0] } } },
        };
        const v = planeValues(found);
        expect(pickItems(v.r1)[0]).toMatchObject({ kind: 'face', at: [3, 20, 2] });
        expect(planeDefinition(v)).toEqual(found);
        const circle: PlaneDefinition = {
            kind: 'offset', distance: 1, base: {
                fixedPlane: { origin: [0, 10, 0], normal: [0, 1, 0], xDir: [1, 0, 0] }, from: 'circle',
                pick: { edge: [4, 10, 0], shape: { type: 'circle', centre: [0, 10, 0], normal: [0, 1, 0], radius: 4, full: true, start: [4, 10, 0], end: [4, 10, 0] } },
            },
        };
        expect(planeDefinition(planeValues(circle))).toEqual(circle);
        // An older step's face, kept by value: it reopens and saves by value, and its box says so.
        const old: PlaneDefinition = { kind: 'offset', distance: 2, base: { fixedPlane: { origin: [20, 10, 10], normal: [0, 1, 0], xDir: [1, 0, 0] }, from: 'face' } };
        expect(pickItems(planeValues(old).r1)[0]).toMatchObject({ model: { fixed: true } });
        expect(planeDefinition(planeValues(old))).toEqual(old);
    });

    it('says what is missing or over-defined, and checks against the steps before', () => {
        expect(() => planeDefinition(planeDefaults())).toThrow(/first reference/);
        expect(() => planeDefinition({ ...picked(topFace), c1plane: 'mid' })).toThrow(/second plane/);
        expect(() => planeDefinition(picked(topFace, vertex([0, 0, 0]), vertex([1, 0, 0])))).toThrow(/over-defined/);
        expect(() => planeDefinition({ ...picked(topFace), d1: 'x' })).toThrow(/Distance must be a number/);
        expect(referenceStatus('plane', picked(topFace), [])).toEqual({ ok: true, text: 'Fully defined' });
        expect(referenceStatus('plane', picked(topFace, face([0, 5, 10], [-1, 0, 0])), [])).toMatchObject({ ok: false });
        const steps: Feature[] = [{ id: 'p', op: 'plane', definition: { kind: 'offset', base: 'top', distance: 5 } }];
        expect(() => checkReference('plane', { kind: 'midplane', a: 'top', b: 'front' }, steps)).toThrow(/^A midplane needs two parallel planes/);
        expect(() => checkReference('plane', { kind: 'midplane', a: 'top', b: { planeRef: 'p' } }, steps)).not.toThrow();
    });

    it('round-trips every plane definition through the form values', () => {
        const fixed = { fixedPlane: { origin: [20, 10, 10] as Vec3, normal: [0, 1, 0] as Vec3, xDir: [1, 0, 0] as Vec3 }, from: 'face' as const };
        const fixedEdge = { fixedAxis: { point: [20, 10, 20] as Vec3, direction: [1, 0, 0] as Vec3 }, from: 'edge' as const };
        const definitions: PlaneDefinition[] = [
            { kind: 'offset', base: { planeRef: 'p1' }, distance: -12.5 },
            { kind: 'offset', base: fixed, distance: 3, flipNormal: true },
            { kind: 'angle', base: 'front', about: { axisRef: 'ax' }, angle: 30 },
            { kind: 'angle', base: 'top', about: 'u', angle: -45 },
            { kind: 'angle', base: fixed, about: fixedEdge, angle: 15, throughAxis: true },
            { kind: 'midplane', a: 'top', b: { planeRef: 'p2' } },
            { kind: 'parallel', base: 'right', point: { pointRef: 'pt' } },
            { kind: 'threePoints', points: [[0, 0, 0], { pointRef: 'pt' }, [0, 5, 1]] },
            { kind: 'normal', axis: 'y', point: [1, 2, 3] },
            { kind: 'normal', axis: { axisRef: 'ax' } },
            { kind: 'pointNormal', point: [1, 2, 3], normal: [0, 0, 1] },
            { kind: 'perpendicular', base: fixed, axis: fixedEdge },
            { kind: 'linePoint', axis: fixedEdge, point: [0, 0, 20] },
            { kind: 'tangent', cylinder: { point: [0, 3, 0], direction: [0, 1, 0], radius: 5 }, point: [5, 7, 0] },
            { kind: 'tangent', cylinder: { point: [0, 3, 0], direction: [0, 1, 0], radius: 5 }, point: [10, 7, 0], flip: true },
            { kind: 'tangent', cylinder: { point: [0, 3, 0], direction: [0, 1, 0], radius: 5 }, plane: 'front', angle: -20 },
        ];
        for (const d of definitions) {
            expect(planeDefinition(planeValues(d))).toEqual(d);
        }
        expect(planeValues({ kind: 'offset', base: { planeRef: 'p1' }, distance: 1 }, [{ id: 'p1', name: 'Plane1', op: 'plane', definition: { kind: 'offset', base: 'top', distance: 1 } }]).r1)
            .toEqual([refItem('plane:p1', [{ id: 'p1', name: 'Plane1' } as Feature])]);
    });
});

describe('axis form', () => {
    it('makes axes from a picked edge, a cylindrical face, two vertices, a vertex and a face, two faces', () => {
        expect(axisDefinition({ ...axisDefaults(), ln: [frontTopEdge] })).toEqual({
            kind: 'along', axis: {
                fixedAxis: { point: [20, 10, 20], direction: [1, 0, 0] }, from: 'edge',
                pick: { edge: [0, 10, 20], shape: { type: 'line', a: [0, 10, 20], b: [40, 10, 20] } },
            },
        });
        expect(axisDefinition({ ...axisDefaults(), kind: 'cylinder', cy: [cylinder] })).toEqual({
            kind: 'along', axis: { fixedAxis: { point: [0, 3, 0], direction: [0, 1, 0] }, from: 'cylinder', pick: { face: { at: [5, 3, 0] } } },
        });
        expect(axisDefinition({ ...axisDefaults(), kind: 'twoPoints', qa: [vertex([0, 0, 0])], qb: [vertex([0, 0, 20])] })).toEqual({
            kind: 'twoPoints', a: { fixedPoint: [0, 0, 0], from: 'vertex', pick: { vertex: [0, 0, 0] } },
            b: { fixedPoint: [0, 0, 20], from: 'vertex', pick: { vertex: [0, 0, 20] } },
        });
        expect(axisDefinition({ ...axisDefaults(), kind: 'pointPlane', qa: [vertex([1, 10, 1])], pa: [topFace] }))
            .toMatchObject({ kind: 'pointPlane', point: { fixedPoint: [1, 10, 1] }, plane: { from: 'face' } });
        expect(axisDefinition({ ...axisDefaults(), kind: 'planeIntersection', pa: [topFace], pb: [refItem('front')] }))
            .toMatchObject({ kind: 'planeIntersection', b: 'front' });
        expect(() => axisDefinition({ ...axisDefaults(), kind: 'twoPoints' })).toThrow(/first point/);
    });

    it('round-trips every axis definition through the form values', () => {
        const definitions: AxisDefinition[] = [
            { kind: 'sketchLine', sketchRef: 'sk', line: 'c1' },
            { kind: 'planeIntersection', a: 'top', b: { planeRef: 'p' } },
            { kind: 'twoPoints', a: { pointRef: 'pt' }, b: [1, 2, 3] },
            { kind: 'pointPlane', point: [0, 0, 1], plane: 'front' },
            { kind: 'pointDirection', point: [0, 0, 1], direction: [1, 0, 0] },
            { kind: 'along', axis: { axisRef: 'ax' } },
            { kind: 'along', axis: 'z' },
            { kind: 'along', axis: { fixedAxis: { point: [0, 3, 0], direction: [0, 1, 0] }, from: 'cylinder' } },
            { kind: 'along', axis: { fixedAxis: { point: [0, 3, 0], direction: [0, 1, 0] }, from: 'edge' } },
        ];
        for (const d of definitions) {
            expect(axisDefinition(axisValues(d))).toEqual(d);
        }
        expect(() => axisDefinition({ ...axisDefaults(), kind: 'sketchLine', sketch: 'sk' })).toThrow(/Pick a sketch and one of its lines/);
        expect(() => checkReference('axis', { kind: 'planeIntersection', a: 'top', b: 'top' }, [])).toThrow(/parallel/);
    });
});

describe('point form', () => {
    const circle = (full: boolean, start: Vec3, end: Vec3): PickItem => ({
        kind: 'edge', at: start, model: { geom: { type: 'circle', centre: [0, 10, 0], normal: [0, 1, 0], radius: 4, full, start, end }, click: start },
    });

    it('places points at arc centres, face centres, vertices and edge intersections', () => {
        expect(pointPositions({ ...pointDefaults(), kind: 'arcCentre', arc: [circle(true, [4, 10, 0], [4, 10, 0])] })).toEqual([[0, 10, 0]]);
        expect(pointPositions({ ...pointDefaults(), kind: 'faceCentre', fc: [topFace] })).toEqual([[20, 10, 10]]);
        expect(pointPositions({ ...pointDefaults(), kind: 'vertex', vx: [vertex([40, 10, 0])] })).toEqual([[40, 10, 0]]);
        const meet = pointPositions({ ...pointDefaults(), kind: 'intersection', e1: [edge([0, 10, 0], [40, 10, 0])], e2: [edge([5, 0, 0], [5, 3, 0])] });
        meet[0].forEach((c, i) => expect(c).toBeCloseTo([5, 10, 0][i], 9));
        expect(() => pointPositions({ ...pointDefaults(), kind: 'intersection', e1: [edge([0, 10, 0], [40, 10, 0])], e2: [edge([0, 0, 5], [40, 0, 5])] }))
            .toThrow(/parallel/);
        expect(() => pointPositions({ ...pointDefaults(), kind: 'intersection', e1: [edge([0, 10, 0], [40, 10, 0])], e2: [edge([5, 0, 3], [5, 3, 3])] }))
            .toThrow(/do not meet/);
        expect(pointPositions({ ...pointDefaults([1.000001, 2, 3]) })).toEqual([[1.000001, 2, 3]]);
    });

    it('spaces points along straight and circular edges by distance or percentage', () => {
        const line = edge([0, 10, 0], [40, 10, 0]);
        expect(pointPositions({ ...pointDefaults(), kind: 'along', ed: [line], amount: '10', count: '3' })).toEqual([[10, 10, 0], [20, 10, 0], [30, 10, 0]]);
        expect(pointPositions({ ...pointDefaults(), kind: 'along', ed: [line], by: 'percent', amount: '25', reverse: true })).toEqual([[30, 10, 0]]);
        expect(() => pointPositions({ ...pointDefaults(), kind: 'along', ed: [line], amount: '15', count: '3' })).toThrow(/past the end/);
        // A quarter arc from (4, 10, 0) counter-clockwise about +Y (toward -Z) to (0, 10, -4).
        const arc = circle(false, [4, 10, 0], [0, 10, -4]);
        const [half] = pointPositions({ ...pointDefaults(), kind: 'along', ed: [arc], by: 'percent', amount: '50' });
        [4 * Math.SQRT1_2, 10, -4 * Math.SQRT1_2].forEach((c, i) => expect(half[i]).toBeCloseTo(c, 9));
    });

    it('keeps how a point was taken from the model, so it follows it, and reopens it as it was made', () => {
        const [centre] = pointSteps({ ...pointDefaults(), kind: 'arcCentre', arc: [circle(true, [4, 10, 0], [4, 10, 0])] });
        expect(centre).toEqual({
            position: [0, 10, 0], definition: {
                kind: 'arcCentre',
                edge: { edge: [4, 10, 0], shape: { type: 'circle', centre: [0, 10, 0], normal: [0, 1, 0], radius: 4, full: true, start: [4, 10, 0], end: [4, 10, 0] } },
            },
        });
        const row = pointSteps({ ...pointDefaults(), kind: 'along', ed: [edge([0, 10, 0], [40, 10, 0])], amount: '10', count: '3' });
        expect(row.map((s) => s.definition)).toMatchObject([{ kind: 'along', index: 1, amount: 10, by: 'distance' }, { index: 2 }, { index: 3 }]);
        // The third point reopens as the third of its row and saves as it was.
        const v = pointValues({ id: 'p3', op: 'point', ...row[2] });
        expect(v.kind).toBe('along');
        expect(pointSteps(v, true)).toEqual([row[2]]);
        const made = [
            ...pointSteps({ ...pointDefaults(), kind: 'faceCentre', fc: [topFace] }),
            ...pointSteps({ ...pointDefaults(), kind: 'vertex', vx: [vertex([40, 10, 0])] }),
            ...pointSteps({ ...pointDefaults(), kind: 'intersection', e1: [edge([0, 10, 0], [40, 10, 0])], e2: [edge([5, 0, 0], [5, 3, 0])] }),
            centre,
        ];
        expect(made.map((s) => s.definition?.kind)).toEqual(['faceCentre', 'vertex', 'intersection', 'arcCentre']);
        for (const s of made) {
            expect(pointSteps(pointValues({ id: 'p', op: 'point', ...s }), true)).toEqual([s]);
        }
        // Coordinates stay coordinates, and so does an older step kept by value.
        expect(pointSteps(pointDefaults([1, 2, 3]))).toEqual([{ position: [1, 2, 3] }]);
        expect(pointValues({ id: 'p', op: 'point', position: [40, 10, 0] })).toMatchObject({ kind: 'xyz', pos0: '40', pos1: '10', pos2: '0' });
    });
});

describe('picks in the view for other tools', () => {
    it('sets the Revolve axis from a clicked axis step', () => {
        expect(refPickPatch('revolve', { sketch: 'sk' }, 'axis', 'ax')).toEqual({ axis_sk: 'axis:ax' });
        expect(refPickPatch('fillet', {}, 'plane', 'p')).toBeNull();
    });

    it('offers the sketch lines to click for Revolve and for the Axis tool', () => {
        expect(linePickTarget('revolve', { sketch: 'sk' })).toEqual({ sketch: 'sk', key: 'axis_sk', prefix: 'line:' });
        expect(linePickTarget('axis', { kind: 'sketchLine', sketch: 'sk' })).toEqual({ sketch: 'sk', key: lineKey('sk'), prefix: '' });
        expect(linePickTarget('axis', { kind: 'twoPoints', sketch: 'sk' })).toBeNull();
        expect(linePickTarget('extrude', { sketch: 'sk' })).toBeNull();
    });
});
