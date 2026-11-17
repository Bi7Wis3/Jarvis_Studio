import { describe, expect, it } from 'vitest';
import type { Part, Vec3 } from '../index';
import {
    eulerToMat, fitAssembly, matToEuler, measureMate, MateSystem, nextMateName, prepareMate, repairAssembly, sideNow, solveAssembly,
    validMateTypes, withFixed, withFolder, withMate, withoutMates, type AssemblyMates, type Mate, type MateGeom, type MateRef,
    type MateType,
} from './index';

const part = (id: string, position: Vec3 = [0, 0, 0], rotation: Vec3 = [0, 0, 0]): Part => ({
    id, name: id, shape: { kind: 'empty' }, position, rotation, material: { color: '#888888', metalness: 0, roughness: 1 },
});

/** A face reference whose geometry is given (as the kernel would have found it). */
const face = (p: string, found: MateGeom): MateRef => ({ part: p, pick: { kind: 'face', at: [0, 0, 0] }, found });
const plane = (origin: Vec3, normal: Vec3): MateGeom => ({ type: 'plane', origin, normal });
const cyl = (point: Vec3, direction: Vec3, radius: number, inside = false): MateGeom => ({ type: 'cylinder', point, direction, radius, inside });

let ids = 0;
function mate(type: MateType, a: MateRef, b: MateRef, extra: Partial<Mate> = {}): Mate {
    ids++;
    return { id: `m${ids}`, name: `${type}${ids}`, type, refs: [a, b], ...extra };
}

/** World point of a part-frame point after the parts are placed by `placements`. */
function worldOf(p: Part, placements: Record<string, { position: Vec3; rotation: Vec3 }>, local: Vec3): Vec3 {
    const place = placements[p.id] ?? p;
    const R = eulerToMat(place.rotation);
    return [0, 1, 2].map((i) => R[i * 3] * local[0] + R[i * 3 + 1] * local[1] + R[i * 3 + 2] * local[2] + place.position[i]) as Vec3;
}

function dirOf(p: Part, placements: Record<string, { position: Vec3; rotation: Vec3 }>, local: Vec3): Vec3 {
    const place = placements[p.id] ?? p;
    const R = eulerToMat(place.rotation);
    return [0, 1, 2].map((i) => R[i * 3] * local[0] + R[i * 3 + 1] * local[1] + R[i * 3 + 2] * local[2]) as Vec3;
}

const close = (a: Vec3, b: Vec3, digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe('rotations', () => {
    it('turns Euler XYZ angles into a matrix and back', () => {
        for (const r of [[10, 20, 30], [-45, 80, 170], [0, 90, 0], [123.456, -12.5, 0.001]] as Vec3[]) {
            const back = matToEuler(eulerToMat(r));
            const m1 = eulerToMat(r);
            const m2 = eulerToMat(back);
            m1.forEach((v, i) => expect(m2[i]).toBeCloseTo(v, 12));
        }
    });
});

describe('valid mates per entity pair', () => {
    it('follows the Standard Mates by Entity table', () => {
        const p = plane([0, 0, 0], [0, 1, 0]);
        const c = cyl([0, 0, 0], [0, 1, 0], 2);
        const point: MateGeom = { type: 'point', point: [0, 0, 0] };
        const sphere: MateGeom = { type: 'sphere', centre: [0, 0, 0], radius: 2 };
        const circle: MateGeom = { type: 'circle', centre: [0, 0, 0], normal: [0, 1, 0], radius: 2 };
        const line: MateGeom = { type: 'line', point: [0, 0, 0], direction: [1, 0, 0] };
        expect(validMateTypes(p, p)).toEqual(['coincident', 'parallel', 'perpendicular', 'lock', 'distance', 'angle']);
        expect(validMateTypes(p, c)).toEqual(['tangent', 'lock', 'distance']);
        expect(validMateTypes(c, c)).toEqual(['parallel', 'perpendicular', 'tangent', 'concentric', 'lock', 'distance', 'angle']);
        expect(validMateTypes(circle, circle)).toEqual(['concentric', 'lock']);
        expect(validMateTypes(point, sphere)).toEqual(['coincident', 'concentric', 'lock', 'distance']);
        expect(validMateTypes(line, c)).toEqual(['coincident', 'parallel', 'perpendicular', 'tangent', 'concentric', 'lock', 'distance', 'angle']);
        expect(validMateTypes(circle, p)).toEqual(['coincident', 'lock']);
        expect(validMateTypes({ type: 'surface' }, p)).toEqual(['lock']);
        expect(validMateTypes(p, p, true)).toEqual([]);
    });
});

describe('standard mates', () => {
    const base = part('base');
    it('coincident faces: anti-aligned faces touch, the block keeps its freedom in the plane', () => {
        const block = part('block', [5, 20, 3], [10, 0, 5]);
        const m = mate('coincident', face('base', plane([0, 10, 0], [0, 1, 0])), face('block', plane([0, -5, 0], [0, -1, 0])), { alignment: 'antiAligned' });
        const r = solveAssembly([base, block], { mates: [m] }, { analyse: true });
        expect(r.mates[m.id].state).toBe('ok');
        close(worldOf(block, r.placements, [0, -5, 0]).map((v, i) => (i === 1 ? v : 0)) as Vec3, [0, 10, 0]);
        close(dirOf(block, r.placements, [0, -1, 0]), [0, -1, 0]);
        expect(r.dof.block).toBe(3);
        expect(r.components.block).toBe('under');
        expect(r.components.base).toBe('fixed');
        expect(r.placements.base).toBeUndefined();
    });

    it('aligned faces point the same way', () => {
        const block = part('block', [0, 30, 0]);
        const m = mate('coincident', face('base', plane([0, 10, 0], [0, 1, 0])), face('block', plane([0, -5, 0], [0, -1, 0])), { alignment: 'aligned' });
        const r = solveAssembly([base, block], { mates: [m] }, { analyse: true });
        expect(r.mates[m.id].state).toBe('ok');
        close(dirOf(block, r.placements, [0, -1, 0]), [0, 1, 0]);
    });

    it('distance between planes, on either side with Flip dimension', () => {
        const block = part('block', [0, 30, 0]);
        const make = (flip: boolean) => mate('distance', face('base', plane([0, 10, 0], [0, 1, 0])), face('block', plane([0, -5, 0], [0, -1, 0])),
            { alignment: 'antiAligned', value: 7.5, flip });
        const up = solveAssembly([base, block], { mates: [make(false)] });
        expect(worldOf(block, up.placements, [0, -5, 0])[1]).toBeCloseTo(17.5, 8);
        const down = solveAssembly([base, block], { mates: [make(true)] });
        expect(worldOf(block, down.placements, [0, -5, 0])[1]).toBeCloseTo(2.5, 8);
    });

    it('concentric pin in a hole: slides and turns; with lock rotation it only slides', () => {
        const pin = part('pin', [12, 40, -3], [20, 0, 10]);
        const hole = face('base', cyl([10, 0, 0], [0, 1, 0], 3, true));
        const shank = face('pin', cyl([0, 0, 0], [0, 1, 0], 2.9));
        const m = mate('concentric', hole, shank, { alignment: 'aligned' });
        const r = solveAssembly([base, pin], { mates: [m] }, { analyse: true });
        expect(r.mates[m.id].state).toBe('ok');
        const axisPoint = worldOf(pin, r.placements, [0, 0, 0]);
        expect(axisPoint[0]).toBeCloseTo(10, 8);
        expect(axisPoint[2]).toBeCloseTo(0, 8);
        close(dirOf(pin, r.placements, [0, 1, 0]), [0, 1, 0]);
        expect(r.dof.pin).toBe(2);
        const locked = prepareMate({ ...m, lockRotation: true }, [base, pin]);
        const r2 = solveAssembly([base, pin], { mates: [locked] }, { analyse: true });
        expect(r2.dof.pin).toBe(1);
    });

    it('concentric and coincident leave the pin only its turn about the axis', () => {
        const pin = part('pin', [12, 40, -3], [20, 0, 10]);
        const mates = [
            mate('concentric', face('base', cyl([10, 0, 0], [0, 1, 0], 3, true)), face('pin', cyl([0, 0, 0], [0, 1, 0], 2.9)), { alignment: 'aligned' }),
            mate('coincident', face('base', plane([0, 10, 0], [0, 1, 0])), face('pin', plane([0, 5, 0], [0, -1, 0])), { alignment: 'antiAligned' }),
        ];
        const r = solveAssembly([base, pin], { mates }, { analyse: true });
        expect(r.converged).toBe(true);
        expect(worldOf(pin, r.placements, [0, 5, 0])[1]).toBeCloseTo(10, 8);
        expect(r.dof.pin).toBe(1);
    });

    it('parallel, perpendicular and angle between faces', () => {
        const block = part('block', [30, 0, 0], [0, 25, 0]);
        const a = face('base', plane([0, 0, 5], [0, 0, 1]));
        const b = face('block', plane([0, 0, 5], [0, 0, 1]));
        const par = solveAssembly([base, block], { mates: [mate('parallel', a, b, { alignment: 'aligned' })] });
        close(dirOf(block, par.placements, [0, 0, 1]), [0, 0, 1]);
        const per = solveAssembly([base, block], { mates: [mate('perpendicular', a, b)] });
        expect(Math.abs(dirOf(block, per.placements, [0, 0, 1])[2])).toBeLessThan(1e-7);
        const hinge = mate('concentric', face('base', { type: 'line', point: [0, 0, 0], direction: [0, 1, 0] }),
            face('block', { type: 'line', point: [-30, 0, 0], direction: [0, 1, 0] }), { alignment: 'aligned' });
        const angle = prepareMate(mate('angle', a, b, { value: 30 }), [base, block]);
        const r = solveAssembly([base, block], { mates: [hinge, angle] }, { analyse: true });
        expect(r.mates[angle.id].state).toBe('ok');
        const n = dirOf(block, r.placements, [0, 0, 1]);
        expect((Math.acos(n[2]) * 180) / Math.PI).toBeCloseTo(30, 6);
        const flipped = solveAssembly([base, block], { mates: [hinge, { ...angle, flip: true }] });
        const m = dirOf(block, flipped.placements, [0, 0, 1]);
        expect((Math.acos(m[2]) * 180) / Math.PI).toBeCloseTo(30, 6);
        expect(Math.sign(m[0])).toBe(-Math.sign(n[0]));
    });

    it('tangent: a shaft on a face, a ball on a face, a shaft against a shaft and in a hole', () => {
        const shaft = part('shaft', [0, 20, 0]);
        const onFace = solveAssembly([base, shaft], {
            mates: [mate('tangent', face('base', plane([0, 0, 0], [0, 1, 0])), face('shaft', cyl([0, 0, 0], [1, 0, 0], 4)), { alignment: 'antiAligned' })],
        });
        expect(worldOf(shaft, onFace.placements, [0, 0, 0])[1]).toBeCloseTo(4, 8);
        const ball = part('ball', [3, 9, 1]);
        const rolled = solveAssembly([base, ball], {
            mates: [mate('tangent', face('base', plane([0, 0, 0], [0, 1, 0])), face('ball', { type: 'sphere', centre: [0, 0, 0], radius: 2.5 }))],
        });
        expect(worldOf(ball, rolled.placements, [0, 0, 0])[1]).toBeCloseTo(2.5, 8);
        const other = part('other', [9, 0, 0]);
        const touching = solveAssembly([base, other], {
            mates: [mate('tangent', face('base', cyl([0, 0, 0], [0, 1, 0], 3)), face('other', cyl([0, 0, 0], [0, 1, 0], 2)))],
        });
        const c = worldOf(other, touching.placements, [0, 0, 0]);
        expect(Math.hypot(c[0], c[2])).toBeCloseTo(5, 8);
        const inHole = solveAssembly([base, other], {
            mates: [mate('tangent', face('base', cyl([0, 0, 0], [0, 1, 0], 6, true)), face('other', cyl([0, 0, 0], [0, 1, 0], 2)))],
        });
        const d = worldOf(other, inHole.placements, [0, 0, 0]);
        expect(Math.hypot(d[0], d[2])).toBeCloseTo(4, 8);
    });

    it('points, lines, circles, cones, spheres and origins', () => {
        const b = part('b', [7, 8, 9], [10, 20, 30]);
        const pt = (p: string, at: Vec3): MateRef => ({ part: p, pick: { kind: 'vertex', at }, found: { type: 'point', point: at } });
        const pp = solveAssembly([base, b], { mates: [mate('coincident', pt('base', [1, 2, 3]), pt('b', [0, 0, 0]))] });
        close(worldOf(b, pp.placements, [0, 0, 0]), [1, 2, 3]);
        const line = (p: string, point: Vec3, direction: Vec3): MateRef => ({ part: p, pick: { kind: 'edge', at: point }, found: { type: 'line', point, direction } });
        const ll = solveAssembly([base, b], { mates: [mate('coincident', line('base', [0, 0, 0], [1, 0, 0]), line('b', [0, 0, 0], [0, 0, 1]), { alignment: 'aligned' })] });
        close(dirOf(b, ll.placements, [0, 0, 1]), [1, 0, 0]);
        const onLine = worldOf(b, ll.placements, [0, 0, 5]);
        expect(Math.hypot(onLine[1], onLine[2])).toBeCloseTo(0, 7);
        const circle: MateGeom = { type: 'circle', centre: [0, 0, 0], normal: [0, 1, 0], radius: 3 };
        const cp = solveAssembly([base, b], { mates: [mate('coincident', face('base', plane([0, 4, 0], [0, 1, 0])), { part: 'b', pick: { kind: 'edge', at: [3, 0, 0] }, found: circle }, { alignment: 'aligned' })] });
        expect(worldOf(b, cp.placements, [0, 0, 0])[1]).toBeCloseTo(4, 8);
        const cone: MateGeom = { type: 'cone', apex: [0, 0, 0], direction: [0, 1, 0], halfAngle: 45 };
        const cc = solveAssembly([base, b], { mates: [mate('coincident', face('base', cone), { part: 'b', pick: { kind: 'edge', at: [2, 0, 0] }, found: { type: 'circle', centre: [0, 0, 0], normal: [0, 1, 0], radius: 2 } }, { alignment: 'aligned' })] });
        close(worldOf(b, cc.placements, [0, 0, 0]), [0, 2, 0]);
        const ball = solveAssembly([base, b], { mates: [mate('concentric', face('base', { type: 'sphere', centre: [5, 5, 5], radius: 1 }), pt('b', [1, 0, 0]))] });
        close(worldOf(b, ball.placements, [1, 0, 0]), [5, 5, 5]);
        const origin = (p: string): MateRef => ({ part: p, pick: { kind: 'point', point: 'origin' } });
        const placed = part('placed', [3, 4, 5], [10, 20, 30]);
        const shifted = { ...part('anchor', [10, 0, 0], [0, 90, 0]) };
        const al = solveAssembly([shifted, placed], { mates: [mate('coincident', origin('anchor'), origin('placed'), { alignAxes: true })] }, { analyse: true });
        close(al.placements.placed.position, [10, 0, 0]);
        close(al.placements.placed.rotation, [0, 90, 0]);
        expect(al.dof.placed).toBe(0);
        expect(al.components.placed).toBe('defined');
    });

    it('lock keeps two floating components together', () => {
        const a = part('a', [0, 0, 0]);
        const f1 = part('f1', [10, 0, 0], [0, 0, 30]);
        const f2 = part('f2', [20, 5, 0], [10, 0, 0]);
        const lock = prepareMate(mate('lock', { part: 'f1', pick: { kind: 'component' } }, { part: 'f2', pick: { kind: 'component' } }), [a, f1, f2]);
        const sys = new MateSystem([a, f1, f2], { mates: [lock] });
        const moved = sys.drag({ part: 'f1', placement: { position: [50, 0, 0], rotation: [0, 0, 30] } });
        const p1 = moved.f1;
        const p2 = moved.f2;
        expect(p1.position[0]).toBeCloseTo(50, 3);
        expect(p2.position[0] - p1.position[0]).toBeCloseTo(10, 3);
    });
});

describe('clusters, freedom and errors', () => {
    it('solves only the clusters asked for and never moves a fixed part', () => {
        const parts = [part('base'), part('a', [0, 50, 0]), part('b', [100, 50, 0]), part('fixedC', [0, 80, 0])];
        const assembly: AssemblyMates = {
            fixed: ['base', 'fixedC'],
            mates: [
                mate('coincident', face('base', plane([0, 0, 0], [0, 1, 0])), face('a', plane([0, 0, 0], [0, -1, 0])), { alignment: 'antiAligned' }),
                mate('coincident', face('base', plane([100, 0, 0], [0, 1, 0])), face('b', plane([0, 0, 0], [0, -1, 0])), { alignment: 'antiAligned' }),
                mate('distance', face('fixedC', plane([0, 0, 0], [0, 1, 0])), face('base', plane([0, 0, 0], [0, 1, 0])), { value: 3 }),
            ],
        };
        const r = solveAssembly(parts, assembly, { only: ['a'], analyse: true });
        expect(Object.keys(r.placements)).toEqual(['a']);
        expect(r.placements.fixedC).toBeUndefined();
        // Two fixed parts 80 mm apart cannot be 3 mm apart: red.
        expect(r.mates[assembly.mates[2].id].state).toBe('error');
    });

    it('marks a conflicting mate red, the mates it fights yellow, and the component over defined', () => {
        const base = part('base');
        const block = part('block', [0, 30, 0]);
        const first = mate('coincident', face('base', plane([0, 10, 0], [0, 1, 0])), face('block', plane([0, -5, 0], [0, -1, 0])), { alignment: 'antiAligned' });
        const second = mate('coincident', face('base', plane([0, 0, 0], [0, 1, 0])), face('block', plane([0, -5, 0], [0, -1, 0])), { alignment: 'antiAligned' });
        const r = solveAssembly([base, block], { mates: [first, second] }, { analyse: true });
        expect(r.mates[first.id].state).toBe('warning');
        expect(r.mates[second.id].state).toBe('error');
        expect(r.mates[second.id].reason).toBe('conflict');
        expect(r.mates[second.id].message).toContain(first.name);
        expect(r.components.block).toBe('over');
        // The first one still holds.
        expect(worldOf(block, r.placements, [0, -5, 0])[1]).toBeCloseTo(10, 8);
    });

    it('marks a distance that repeats what other mates set as over defining (yellow), but tolerates a repeated coincident', () => {
        const base = part('base');
        const block = part('block', [0, 30, 0]);
        const coincident = mate('coincident', face('base', plane([0, 10, 0], [0, 1, 0])), face('block', plane([0, -5, 0], [0, -1, 0])), { alignment: 'antiAligned' });
        const distance = mate('distance', face('base', plane([0, 0, 0], [0, 1, 0])), face('block', plane([0, -5, 0], [0, -1, 0])), { alignment: 'antiAligned', value: 10 });
        const r = solveAssembly([base, block], { mates: [coincident, distance] }, { analyse: true });
        expect(r.mates[distance.id].state).toBe('warning');
        expect(r.mates[distance.id].reason).toBe('redundant');
        expect(r.components.block).toBe('over');
        const twice = mate('coincident', face('base', plane([0, 0, 0], [0, 1, 0])), face('block', plane([0, 5, 0], [0, -1, 0])), { alignment: 'antiAligned' });
        const coincidentAgain = solveAssembly([base, block], { mates: [coincident, { ...twice, refs: [face('base', plane([0, 10, 0], [0, 1, 0])), face('block', plane([0, -5, 0], [0, -1, 0]))] }] }, { analyse: true });
        expect(Object.values(coincidentAgain.mates).every((s) => s.state === 'ok')).toBe(true);
    });

    it('reports a reference that no longer resolves as an error, without failing', () => {
        const parts = [part('base'), part('block', [0, 30, 0])];
        const m = mate('coincident', { part: 'base', pick: { kind: 'face', at: [0, 0, 0] } }, face('block', plane([0, 0, 0], [0, 1, 0])));
        const gone = mate('coincident', face('nothere', plane([0, 0, 0], [0, 1, 0])), face('block', plane([0, 0, 0], [0, 1, 0])));
        const r = solveAssembly(parts, { mates: [m, gone] }, { analyse: true });
        expect(r.mates[m.id]).toMatchObject({ state: 'error', reason: 'missing' });
        expect(r.mates[gone.id]).toMatchObject({ state: 'error', reason: 'missing' });
        expect(r.components.block).toBe('under');
    });

    it('drags a pin within its freedom: turns about the hole and slides along it, never off the axis', () => {
        const base = part('base');
        const pin = part('pin', [10, 20, 0]);
        const concentric = mate('concentric', face('base', cyl([10, 0, 0], [0, 1, 0], 3, true)), face('pin', cyl([0, 0, 0], [0, 1, 0], 2.9)), { alignment: 'aligned' });
        const sys = new MateSystem([base, pin], { mates: [concentric] });
        // Pull a point on the pin's side towards a ray off to the side and up.
        const out = sys.drag({ part: 'pin', grab: [2.9, 0, 0], ray: { origin: [40, 35, 30], direction: [0, 0, -1] } });
        const placed = { ...pin, ...out.pin };
        const axis = worldOf(placed, {}, [0, 0, 0]);
        expect(axis[0]).toBeCloseTo(10, 6);
        expect(axis[2]).toBeCloseTo(0, 6);
        expect(axis[1]).toBeCloseTo(35, 1);
        close(dirOf(placed, {}, [0, 1, 0]), [0, 1, 0]);
        const grab = worldOf(placed, {}, [2.9, 0, 0]);
        // Turned towards the pull (+X side, then towards +Z where the ray is).
        expect(grab[0] - 10).toBeGreaterThan(0);
        // Fixed parts do not move.
        expect(sys.drag({ part: 'base', grab: [0, 0, 0], ray: { origin: [0, 50, 0], direction: [0, 0, -1] } })).toEqual({});
    });

    it('drags a 20 part assembly fast enough for every frame', () => {
        const parts = [part('p0')];
        const mates: Mate[] = [];
        for (let i = 1; i < 20; i++) {
            parts.push(part(`p${i}`, [i * 12 + 1, 3, 0.5], [2, 1, 3]));
            mates.push(mate('concentric', face(`p${i - 1}`, cyl([5, 0, 0], [0, 0, 1], 2, true)), face(`p${i}`, cyl([-5, 0, 0], [0, 0, 1], 2)), { alignment: 'aligned' }));
            mates.push(mate('coincident', face(`p${i - 1}`, plane([0, 0, 1], [0, 0, 1])), face(`p${i}`, plane([0, 0, 0], [0, 0, -1])), { alignment: 'antiAligned' }));
        }
        const assembly = { mates };
        const settled = solveAssembly(parts, assembly);
        const placed = parts.map((p) => ({ ...p, ...(settled.placements[p.id] ?? {}) }));
        const sys = new MateSystem(placed, assembly);
        const frames = 30;
        const t0 = performance.now();
        for (let f = 0; f < frames; f++) {
            sys.drag({ part: 'p19', grab: [5, 0, 0], ray: { origin: [150 + f, 40 + f, 50], direction: [0, 0, -1] } });
        }
        const perFrame = (performance.now() - t0) / frames;
        console.log(`drag of a 20 part chain: ${perFrame.toFixed(1)} ms per frame`);
        // Every link still holds after the drag.
        for (const m of mates) {
            expect(sys.offBy(m.id)!).toBeLessThan(1e-5);
        }
        expect(perFrame).toBeLessThan(60);
    });
});

describe('editing mates', () => {
    it('names mates per type, and folders, fixed parts and deleted parts follow', () => {
        const parts = [part('a'), part('b', [0, 20, 0]), part('c', [0, 40, 0])];
        let assembly = withMate(undefined, { type: 'coincident', refs: [face('a', plane([0, 0, 0], [0, 1, 0])), face('b', plane([0, 0, 0], [0, -1, 0]))] });
        assembly = withMate(assembly, { type: 'coincident', refs: [face('b', plane([0, 0, 0], [0, 1, 0])), face('c', plane([0, 0, 0], [0, -1, 0]))] });
        assembly = withMate(assembly, { type: 'distance', value: 5, refs: [face('a', plane([0, 0, 0], [1, 0, 0])), face('c', plane([0, 0, 0], [1, 0, 0]))] });
        expect(assembly.mates.map((m) => m.name)).toEqual(['Coincident1', 'Coincident2', 'Distance1']);
        expect(nextMateName(assembly.mates, 'coincident')).toBe('Coincident3');
        const foldered = withFolder(assembly, 'Folder1', [assembly.mates[0].id, assembly.mates[2].id]);
        expect(foldered.assembly.folders).toEqual([{ id: foldered.id, name: 'Folder1', mates: [assembly.mates[0].id, assembly.mates[2].id] }]);
        const fewer = withoutMates(foldered.assembly, [assembly.mates[0].id]);
        expect(fewer.folders![0].mates).toEqual([assembly.mates[2].id]);
        const floated = withFixed(fewer, parts, ['a'], false);
        expect(floated.fixed).toEqual([]);
        const fixedB = withFixed(fewer, parts, ['b'], true);
        expect(fixedB.fixed).toEqual(['a', 'b']);
        const project = { parts: parts.filter((p) => p.id !== 'c'), assembly: fixedB };
        fitAssembly({ parts }, project);
        expect(project.assembly.mates).toEqual([]);
        expect(project.assembly.fixed).toEqual(['a', 'b']);
        expect(project.assembly.folders![0].mates).toEqual([]);
    });

    it('starts a new mate aligned the way the parts stand, with the distance they are apart', () => {
        const parts = [part('a'), part('b', [0, 22, 0])];
        const m = prepareMate({ id: 'x', name: 'Distance1', type: 'distance', refs: [face('a', plane([0, 10, 0], [0, 1, 0])), face('b', plane([0, -5, 0], [0, -1, 0]))] }, parts);
        expect(m.alignment).toBe('antiAligned');
        expect(m.value).toBeCloseTo(7, 10);
        expect(m.flip).toBeUndefined();
        const below = prepareMate({ ...m, value: undefined, flip: undefined, alignment: undefined }, [parts[0], part('b', [0, 0, 0])]);
        expect(below.value).toBeCloseTo(15, 10);
        expect(below.flip).toBe(true);
        const a = sideNow(m.refs[0], parts)!;
        const b = sideNow(m.refs[1], parts)!;
        expect(measureMate(m, a, b)!.value).toBeCloseTo(7, 10);
    });

    it('repairs what it reads', () => {
        const project = {
            parts: [part('a'), part('b')],
            assembly: {
                mates: [
                    { id: 'm1', name: 'Coincident1', type: 'coincident', refs: [face('a', plane([0, 0, 0], [0, 1, 0])), face('b', plane([0, 0, 0], [0, 1, 0]))] },
                    { id: 'm1', name: 'Coincident1', type: 'coincident', refs: [face('a', plane([0, 0, 0], [0, 1, 0])), face('b', plane([0, 0, 0], [0, 1, 0]))] },
                    { id: 'm3', name: 'Odd1', type: 'gizmo', refs: [] },
                    null,
                ],
                folders: [{ id: 'f', name: 'F', mates: ['m1', 'zzz'] }],
                fixed: ['a', 'gone'],
            } as unknown as AssemblyMates,
        };
        repairAssembly(project);
        expect(project.assembly.mates.map((m) => m.name)).toEqual(['Coincident1', 'Coincident2']);
        expect(project.assembly.mates[0].id).toBe('m1');
        expect(project.assembly.mates[1].id).not.toBe('m1');
        expect(project.assembly.folders).toEqual([{ id: 'f', name: 'F', mates: ['m1'] }]);
        expect(project.assembly.fixed).toEqual(['a']);
    });
});
