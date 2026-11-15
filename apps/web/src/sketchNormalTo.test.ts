// Standard views (Bottom, Trimetric, Dimetric) and Normal To in an open sketch: straight at the sketch plane, and
// from the other side when the view already looks straight at it.
import { describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';
import { normalToAngles } from './viewProjection';
import { sketchWorldNormal } from './sketchNormalTo';
import { useSketcher } from './sketcher';
import { VIEWS } from './toolDefs';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

/** The direction from the target to the camera for view angles, as the 3D view places it. */
function towardCamera(azimuth: number, elevation: number): Vector3 {
    const [a, e] = [azimuth, elevation].map((d) => (d * Math.PI) / 180);
    return new Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
}

/** How long a unit edge along each world axis looks on screen from that direction. */
function scales(azimuth: number, elevation: number): number[] {
    const d = towardCamera(azimuth, elevation);
    return [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].map((u) => Math.sqrt(1 - u.dot(d) ** 2));
}

const view = (id: string) => VIEWS.find((v) => v.id === id)!;

describe('standard views', () => {
    it('has Bottom: from below', () => {
        expect(towardCamera(view('bottom').azimuth, view('bottom').elevation).y).toBeLessThan(-0.99);
    });

    it('Isometric foreshortens all three axes alike, Dimetric two of them, Trimetric none alike', () => {
        const iso = scales(view('iso').azimuth, view('iso').elevation);
        expect(Math.max(...iso) - Math.min(...iso)).toBeLessThan(1e-3);
        const [dx, dy, dz] = scales(view('dimetric').azimuth, view('dimetric').elevation);
        expect(dx).toBeCloseTo(dy, 4);
        // ISO 5456-3 dimetric: the depth at half the scale of width and height.
        expect(dz / dx).toBeCloseTo(0.5, 4);
        const [tx, ty, tz] = scales(view('trimetric').azimuth, view('trimetric').elevation);
        for (const [p, q] of [[tx, ty], [ty, tz], [tx, tz]]) {
            expect(Math.abs(p - q)).toBeGreaterThan(0.05);
        }
    });
});

describe('normal to', () => {
    const unknown = { known: false, direction: new Vector3(0, 0, -1) };

    it('looks from the side the normal points to, and from the other side when already looking straight at it', () => {
        expect(normalToAngles([0, 0, 1], unknown)).toEqual({ azimuth: 0, elevation: 0 });
        const again = normalToAngles([0, 0, 1], { known: true, direction: new Vector3(0, 0, -1) });
        expect(Math.abs(again.azimuth)).toBeCloseTo(180, 9);
        expect(again.elevation).toBeCloseTo(0, 9);
        // Looking at it from an angle: straight at its front.
        expect(normalToAngles([0, 0, 1], { known: true, direction: new Vector3(-1, -1, -1).normalize() })).toEqual({ azimuth: 0, elevation: 0 });
    });

    it('looks down on a level plane (stopping just short of straight down), and up from below the second time', () => {
        expect(normalToAngles([0, 1, 0], unknown)).toEqual({ azimuth: 0, elevation: 89 });
        const down = towardCamera(0, 89).negate();
        expect(normalToAngles([0, 1, 0], { known: true, direction: down })).toEqual({ azimuth: 0, elevation: -89 });
    });

    it('takes the open sketch plane, turned with its part', () => {
        useSketcher.setState({ active: true, stage: 'draw', plane: 'front', offset: 0, context: [], partId: null });
        const n = sketchWorldNormal()!;
        expect(n.map((c) => Math.abs(c))).toEqual([0, 0, 1]);
        useSketcher.setState({ stage: 'plane' });
        expect(sketchWorldNormal()).toBeNull();
    });
});
