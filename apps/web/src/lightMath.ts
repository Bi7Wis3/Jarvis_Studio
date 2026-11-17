// Where the lights of Options > Lighting stand in the world, and how a drag in the Lighting page's overview moves one.
// A light that is not locked to the model turns with the view: its settings give it as seen from the front view, so
// its place in the world depends on how the view camera is turned (`view`, the camera's world rotation).

import { Plane, Quaternion, Vector3, type Ray } from 'three';
import {
    placedLight, sphericalOf, sphericalPoint, lightPoint, type DirectionalLight, type Lightformer, type LightingSettings, type PointLight,
    type SpotLight,
} from '@jarvis/core/settings';
import { roundTo } from './numberText';

export type V3 = [number, number, number];

export type LightKind = 'directional' | 'point' | 'spot' | 'panel';

/** A light of the page (`panel`: a light panel of the environment), as one string: `kind:id`. */
export const lightKey = (kind: LightKind, id: string): string => `${kind}:${id}`;

export function parseLightKey(key: string | null): { kind: LightKind; id: string } | null {
    const at = key?.indexOf(':') ?? -1;
    const kind = key?.slice(0, at);
    return key && at > 0 && (kind === 'directional' || kind === 'point' || kind === 'spot' || kind === 'panel')
        ? { kind, id: key.slice(at + 1) } : null;
}

const toV3 = (v: Vector3): V3 => [v.x, v.y, v.z];

/** A vector given as seen from the front view, in the world, for the view turned by `view`. */
export function fromView(v: V3, view: Quaternion): V3 {
    return toV3(new Vector3(...v).applyQuaternion(view));
}

/** A world vector as seen from the front view, for the view turned by `view`. */
export function toView(v: V3, view: Quaternion): V3 {
    return toV3(new Vector3(...v).applyQuaternion(view.clone().invert()));
}

/** Unit vector from the model towards a directional light, in the world. */
export function directionalWorld(light: DirectionalLight, view: Quaternion): V3 {
    const d = sphericalPoint(light.azimuth, light.elevation, 1);
    return light.lockToModel ? d : fromView(d, view);
}

/** Unit vector from the model towards a light panel (the environment does not turn with the view). */
export const panelWorld = (former: Lightformer): V3 => sphericalPoint(former.azimuth, former.elevation, 1);

/** Where a point or spot light stands in the world, mm. */
export function pointWorld(light: PointLight, view: Quaternion): V3 {
    const p = lightPoint(light);
    return light.lockToModel ? p : fromView(p, view);
}

/** Where a spot light points in the world, mm. */
export function targetWorld(light: SpotLight, view: Quaternion): V3 {
    const t: V3 = [light.targetX, light.targetY, light.targetZ];
    return light.lockToModel ? t : fromView(t, view);
}

/** Azimuth and elevation (degrees, to 0.000001) of a direction; straight up or down keeps `azimuth`. */
export function anglesOf(d: V3, azimuth = 0): { azimuth: number; elevation: number } {
    const s = sphericalOf(...d);
    return {
        azimuth: Math.hypot(d[0], d[2]) > 1e-9 * s.distance ? roundTo(s.longitude) : azimuth,
        elevation: roundTo(s.latitude),
    };
}

/**
 * Where a ray meets a dome (a sphere about `centre`), as the unit direction from the centre to that point: on the near
 * side, or on the far side for a light that was grabbed there (`back`). A ray that passes the dome takes the dome's
 * point nearest to it, so a drag past the edge slides along the rim.
 */
export function domeDirection(ray: Ray, centre: V3, radius: number, back: boolean): V3 {
    const c = new Vector3(...centre);
    const oc = ray.origin.clone().sub(c);
    const b = oc.dot(ray.direction);
    const disc = b * b - (oc.lengthSq() - radius * radius);
    let t: number;
    if (disc < 0) {
        t = -b;
    } else {
        const root = Math.sqrt(disc);
        t = back || -b - root < 0 ? -b + root : -b - root;
    }
    const d = ray.origin.clone().addScaledVector(ray.direction, t).sub(c);
    return d.lengthSq() > 0 ? toV3(d.normalize()) : toV3(ray.direction.clone().negate());
}

/** Where a ray meets the plane through `point` square to `normal`, or null when it does not. */
export function planePoint(ray: Ray, point: V3, normal: V3): V3 | null {
    const plane = new Plane().setFromNormalAndCoplanarPoint(new Vector3(...normal).normalize(), new Vector3(...point));
    const hit = ray.intersectPlane(plane, new Vector3());
    return hit ? toV3(hit) : null;
}

/** A directional light turned to the world direction `d`. */
export function aimDirectional(light: DirectionalLight, d: V3, view: Quaternion): DirectionalLight {
    return { ...light, ...anglesOf(light.lockToModel ? d : toView(d, view), light.azimuth) };
}

/** A light panel moved to the world direction `d`. */
export function aimPanel(former: Lightformer, d: V3): Lightformer {
    return { ...former, ...anglesOf(d, former.azimuth) };
}

/** A point or spot light moved to the world point `p`, its position still given the way it was (to 0.000001). */
export function movePoint<T extends PointLight>(light: T, p: V3, view: Quaternion): T {
    const [x, y, z] = (light.lockToModel ? p : toView(p, view)).map((v) => roundTo(v));
    if (light.coordinates === 'cartesian') {
        return placedLight({ ...light, x, y, z });
    }
    const s = sphericalOf(x, y, z);
    const longitude = Math.hypot(x, z) > 1e-9 ? roundTo(s.longitude) : light.longitude;
    return placedLight({ ...light, longitude, latitude: roundTo(s.latitude), distance: roundTo(s.distance) });
}

/** A spot light aimed at the world point `p` (to 0.000001). */
export function moveTarget(light: SpotLight, p: V3, view: Quaternion): SpotLight {
    const [targetX, targetY, targetZ] = (light.lockToModel ? p : toView(p, view)).map((v) => roundTo(v));
    return { ...light, targetX, targetY, targetZ };
}

// Lock to model switched on or off keeps the light where it is for the view as it is now: only its numbers change.

export function lockDirectional(light: DirectionalLight, lockToModel: boolean, view: Quaternion): DirectionalLight {
    return aimDirectional({ ...light, lockToModel }, directionalWorld(light, view), view);
}

export function lockPoint(light: PointLight, lockToModel: boolean, view: Quaternion): PointLight {
    return movePoint({ ...light, lockToModel }, pointWorld(light, view), view);
}

export function lockSpot(light: SpotLight, lockToModel: boolean, view: Quaternion): SpotLight {
    return moveTarget(movePoint({ ...light, lockToModel }, pointWorld(light, view), view), targetWorld(light, view), view);
}

/** What the pointer took hold of in the overview. */
export interface Grab {
    key: string;
    /** A spot light's target rather than the light. */
    target: boolean;
    /** Lights on the dome (directional lights, panels): its radius, and whether it was taken on the far side. */
    radius: number;
    back: boolean;
    /** Point and spot lights and targets move in the plane through where they were taken, square to the view. */
    point: V3;
    normal: V3;
}

/** The lighting with the grabbed light moved to where the pointer's ray points; the same lighting when it cannot be. */
export function dragLighting(l: LightingSettings, grab: Grab, ray: Ray, centre: V3, view: Quaternion): LightingSettings {
    const which = parseLightKey(grab.key);
    if (!which) {
        return l;
    }
    const { kind, id } = which;
    if (kind === 'directional' || kind === 'panel') {
        const d = domeDirection(ray, centre, grab.radius, grab.back);
        return kind === 'directional'
            ? { ...l, directional: l.directional.map((x) => (x.id === id ? aimDirectional(x, d, view) : x)) }
            : { ...l, environment: { ...l.environment, formers: l.environment.formers.map((x) => (x.id === id ? aimPanel(x, d) : x)) } };
    }
    const p = planePoint(ray, grab.point, grab.normal);
    if (!p) {
        return l;
    }
    if (kind === 'point') {
        return { ...l, point: l.point.map((x) => (x.id === id ? movePoint(x, p, view) : x)) };
    }
    return { ...l, spot: l.spot.map((x) => (x.id !== id ? x : grab.target ? moveTarget(x, p, view) : movePoint(x, p, view))) };
}
