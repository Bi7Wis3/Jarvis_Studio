import { describe, expect, it } from 'vitest';
import { Quaternion, Ray, Vector3 } from 'three';
import { normaliseSettings, type DirectionalLight, type LightingSettings, type PointLight, type SpotLight } from '@jarvis/core/settings';
import {
    anglesOf, directionalWorld, domeDirection, dragLighting, fromView, lightKey, lockDirectional, lockPoint, lockSpot, movePoint, moveTarget,
    parseLightKey, planePoint, pointWorld, targetWorld, toView, type Grab, type V3,
} from './lightMath';

/** The view turned a quarter right about the vertical: the camera on +X looking towards -X. */
const SIDE = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
const FRONT = new Quaternion();

const lighting = (raw: unknown): LightingSettings => normaliseSettings({ lighting: raw }).lighting;
const close = (a: number[], b: number[], digits = 9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
const ray = (origin: V3, direction: V3) => new Ray(new Vector3(...origin), new Vector3(...direction).normalize());

describe('where the lights stand', () => {
    it('reads azimuth and elevation of a direction, keeping the azimuth straight up', () => {
        expect(anglesOf([1, 0, 0])).toEqual({ azimuth: 90, elevation: 0 });
        expect(anglesOf([0, 0, -1])).toEqual({ azimuth: 180, elevation: 0 });
        expect(anglesOf([0, 1, 0], 33.3)).toEqual({ azimuth: 33.3, elevation: 90 });
        const d = new Vector3(1, 1, 1).normalize();
        expect(anglesOf([d.x, d.y, d.z])).toEqual({ azimuth: 45, elevation: 35.264390 });
    });

    it('turns a light that is not locked to the model with the view, as seen from the front view', () => {
        // Straight from the viewer (longitude 0, latitude 0): from wherever the camera stands.
        const head = lighting({ directional: [{ azimuth: 0, elevation: 0, lockToModel: false }] }).directional[0];
        close(directionalWorld(head, FRONT), [0, 0, 1]);
        close(directionalWorld(head, SIDE), [1, 0, 0]);
        // Locked: the view does not move it.
        close(directionalWorld({ ...head, lockToModel: true }, SIDE), [0, 0, 1]);
        close(toView(fromView([1, 2, 3], SIDE), SIDE), [1, 2, 3]);
        const lamp = lighting({ point: [{ coordinates: 'cartesian', x: 0, y: 50, z: 100, lockToModel: false }] }).point[0];
        close(pointWorld(lamp, SIDE), [100, 50, 0]);
        close(pointWorld({ ...lamp, lockToModel: true }, SIDE), [0, 50, 100]);
        const spot = lighting({ spot: [{ targetX: 0, targetY: 0, targetZ: -10, lockToModel: false }] }).spot[0];
        close(targetWorld(spot, SIDE), [-10, 0, 0]);
    });

    it('finds where a ray meets the dome: near side, far side, or the rim when it passes by', () => {
        close(domeDirection(ray([0, 0, 10], [0, 0, -1]), [0, 0, 0], 2, false), [0, 0, 1]);
        close(domeDirection(ray([0, 0, 10], [0, 0, -1]), [0, 0, 0], 2, true), [0, 0, -1]);
        close(domeDirection(ray([5, 0, 10], [0, 0, -1]), [0, 0, 0], 2, false), [1, 0, 0]);
        // About a centre off the origin.
        close(domeDirection(ray([10, 3, 0], [-1, 0, 0]), [0, 3, 0], 1, false), [1, 0, 0]);
        // From inside the dome: the side the ray goes out on.
        close(domeDirection(ray([0, 0, 0], [0, 1, 0]), [0, 0, 0], 2, false), [0, 1, 0]);
        close(planePoint(ray([0, 0, 10], [0, 0, -1]), [3, 3, 2], [0, 0, -1])!, [0, 0, 2]);
        expect(planePoint(ray([0, 0, 10], [1, 0, 0]), [0, 0, 0], [0, 0, 1])).toBeNull();
    });
});

describe('dragging in the overview', () => {
    const base = lighting({
        directional: [{ id: 'key', azimuth: 10, elevation: 20 }, { id: 'head', azimuth: 0, elevation: 0, lockToModel: false }],
        point: [{ id: 'lamp', longitude: 0, latitude: 0, distance: 100 }, { id: 'box', coordinates: 'cartesian', x: 1, y: 2, z: 3 }],
        spot: [{ id: 'spot', coordinates: 'cartesian', x: 0, y: 100, z: 0, targetX: 0, targetY: 0, targetZ: 0 }],
        environment: { formers: [{ id: 'top', azimuth: 0, elevation: 75 }] },
    });
    const grab = (key: string, extra: Partial<Grab> = {}): Grab => ({ key, target: false, radius: 2, back: false, point: [0, 0, 0], normal: [0, 0, -1], ...extra });
    const centre: V3 = [0, 0, 0];

    it('moves a directional light over the dome to the point under the pointer', () => {
        // Looking down -Z at the dome's side point +X.
        const next = dragLighting(base, grab(lightKey('directional', 'key')), ray([2, 0, 10], [0, 0, -1]), centre, FRONT);
        expect(next.directional[0]).toMatchObject({ azimuth: 90, elevation: 0 });
        expect(next.directional[1]).toBe(base.directional[1]);
        // Over the top of the dome, from in front and above.
        const up = dragLighting(base, grab(lightKey('directional', 'key')), ray([0, 10, 0], [0, -1, 0]), centre, FRONT);
        expect(up.directional[0]).toMatchObject({ azimuth: 10, elevation: 90 });
    });

    it('gives a light that turns with the view its angles as seen from the front view', () => {
        // The camera on +X: a light dragged to where the camera stands is straight from the viewer.
        const next = dragLighting(base, grab(lightKey('directional', 'head')), ray([10, 0, 0], [-1, 0, 0]), centre, SIDE);
        expect(next.directional[1]).toMatchObject({ azimuth: 0, elevation: 0, lockToModel: false });
        const panel = dragLighting(base, grab(lightKey('panel', 'top')), ray([0, 0, 10], [0, 0, -1]), centre, SIDE);
        expect(panel.environment.formers[0]).toMatchObject({ azimuth: 0, elevation: 0 });
    });

    it('moves a point light in the plane square to the view, keeping how its position is given', () => {
        // Grabbed at its place (0, 0, 100), dragged up 30 mm on screen.
        const g = grab(lightKey('point', 'lamp'), { point: [0, 0, 100], normal: [0, 0, -1] });
        const next = dragLighting(base, g, ray([0, 30, 500], [0, 0, -1]), centre, FRONT).point[0];
        expect(next).toMatchObject({ coordinates: 'spherical', longitude: 0, latitude: 16.699244, distance: 104.403065 });
        close([next.x, next.y, next.z], [0, 30, 100], 5);
        const box = dragLighting(base, grab(lightKey('point', 'box'), { point: [1, 2, 3] }), ray([1.1234567891, 2, 9], [0, 0, -1]), centre, FRONT).point[1];
        expect(box).toMatchObject({ coordinates: 'cartesian', x: 1.123457, y: 2, z: 3 });
    });

    it("moves a spot light or its target, each on its own handle", () => {
        const light = dragLighting(base, grab(lightKey('spot', 'spot'), { point: [0, 100, 0], normal: [0, 0, -1] }), ray([20, 100, 50], [0, 0, -1]), centre, FRONT);
        expect(light.spot[0]).toMatchObject({ x: 20, y: 100, z: 0, targetX: 0 });
        const aim = dragLighting(base, grab(lightKey('spot', 'spot'), { target: true, normal: [0, 0, -1] }), ray([-5, 7, 50], [0, 0, -1]), centre, FRONT);
        expect(aim.spot[0]).toMatchObject({ x: 0, y: 100, targetX: -5, targetY: 7, targetZ: 0 });
    });

    it('leaves the lighting as it is for an unknown light', () => {
        expect(dragLighting(base, grab('nothing'), ray([0, 0, 10], [0, 0, -1]), centre, FRONT)).toBe(base);
        expect(dragLighting(base, grab(lightKey('point', 'lamp')), ray([0, 0, 10], [1, 0, 0]), centre, FRONT)).toBe(base);
    });

    it('names lights by kind and id', () => {
        expect(parseLightKey(lightKey('spot', 'a:b'))).toEqual({ kind: 'spot', id: 'a:b' });
        expect(parseLightKey('lamp:x')).toBeNull();
        expect(parseLightKey(null)).toBeNull();
    });
});

describe('locking a light to the model', () => {
    it('keeps the light where it is for the view as it is now', () => {
        const l = lighting({
            directional: [{ azimuth: 30, elevation: 40 }],
            point: [{ longitude: 20, latitude: 10, distance: 150, lockToModel: false }],
            spot: [{ coordinates: 'cartesian', x: 10, y: 80, z: 40, targetX: 1, targetY: 2, targetZ: 3 }],
        });
        const d: DirectionalLight = l.directional[0];
        const freed = lockDirectional(d, false, SIDE);
        expect(freed.lockToModel).toBe(false);
        close(directionalWorld(freed, SIDE), directionalWorld(d, SIDE), 5);
        expect(freed.azimuth).toBeCloseTo(-60, 5);
        const p: PointLight = l.point[0];
        const locked = lockPoint(p, true, SIDE);
        expect(locked).toMatchObject({ lockToModel: true, coordinates: 'spherical' });
        close(pointWorld(locked, SIDE), pointWorld(p, SIDE), 5);
        expect(locked.longitude).toBeCloseTo(110, 5);
        const s: SpotLight = l.spot[0];
        const turned = lockSpot(s, false, SIDE);
        close(pointWorld(turned, SIDE), pointWorld(s, SIDE), 5);
        close(targetWorld(turned, SIDE), targetWorld(s, SIDE), 5);
        expect(turned).toMatchObject({ x: -40, y: 80, z: 10, targetX: -3, targetY: 2, targetZ: 1 });
        // Moved back by itself with the view at the front, nothing changes.
        expect(movePoint(p, pointWorld(p, FRONT), FRONT)).toMatchObject({ longitude: 20, latitude: 10, distance: 150 });
        expect(moveTarget(s, [1, 2, 3], FRONT)).toEqual(s);
    });
});
