// Model edges as contour boundaries: the face loops joined into rings, cut where sketch points lie on them; Close
// Sketch to Model (both ways round), and the areas a profile and the face's edges close together.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import type { ModelSketch, TaggedCurve } from '@jarvis/core/projection';
import { loadSolver, solveGeometry } from './solver';
import { addLine, EMPTY_GEOMETRY, geometryProfiles } from './sketchGeometry';
import { closeSketchWith, findClosing, openProfiles, ringPath, ringPosition, ringsOf, regionsWithModel } from './sketchModelContours';
import { regionAt, regionsOf } from './regionPick';
import { isModelLock } from './sketchModel';
import { area, profilePoints } from './sketchMath';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

/** A 40 x 20 face: its outline as four lines, out of order and some reversed, as the kernel may give them. */
const face: ModelSketch = {
    curves: [
        { kind: 'line', a: [40, 20], b: [40, 0], face: 0, loop: 0 },
        { kind: 'line', a: [0, 0], b: [40, 0], face: 0, loop: 0 },
        { kind: 'line', a: [0, 20], b: [0, 0], face: 0, loop: 0 },
        { kind: 'line', a: [40, 20], b: [0, 20], face: 0, loop: 0 },
    ] as TaggedCurve[],
    points: [], skipped: [], loops: [1],
};

/** A U standing on the bottom edge: (10, 0) up to (10, 10), across to (30, 10), down to (30, 0). */
function u(): SketchGeometry {
    let r = addLine(EMPTY_GEOMETRY, { at: [10, 0] }, { at: [10, 10] });
    r = addLine(r.g, { at: [10, 10], point: r.b }, { at: [30, 10] });
    r = addLine(r.g, { at: [30, 10], point: r.b }, { at: [30, 0] });
    return r.g;
}

describe('face loops as rings', () => {
    it('joins the loop end to end and finds where points lie on it', () => {
        const [ring] = ringsOf(face);
        expect(ring.pieces).toHaveLength(4);
        const a = ringPosition(ring, [10, 0])!;
        const b = ringPosition(ring, [30, 0])!;
        expect(Math.floor(a)).toBe(Math.floor(b));
        expect(ringPosition(ring, [20, 5])).toBeNull();
        // One way is the piece of the bottom edge between them, the other the rest of the loop.
        const ways = [ringPath(ring, a, b), ringPath(ring, b, a)] as unknown[][];
        const short = ways.find((w) => w.length === 1) as { a: number[]; b: number[] }[];
        expect([short[0].a, short[0].b].sort((x, y) => x[0] - y[0])).toEqual([[10, 0], [30, 0]]);
        expect(ways.map((w) => w.length).sort()).toEqual([1, 5]);
    });
});

describe('close sketch to model', () => {
    it('finds the open profile ending on the face edges, and closes it the shorter way', () => {
        const g = u();
        expect(openProfiles(g)).toHaveLength(1);
        const closing = findClosing(g, face);
        if ('error' in closing) {
            throw new Error(closing.error);
        }
        expect(closing.paths[0]).toHaveLength(1);
        expect(closing.paths[0][0]).toMatchObject({ kind: 'line' });
        const closed = closeSketchWith(g, closing);
        const { profiles, open } = geometryProfiles(closed);
        expect(open).toBe(0);
        expect(profiles).toHaveLength(1);
        // The edge piece is locked where it is, like a converted entity, and joined to the profile's ends.
        expect(closed.curves).toHaveLength(4);
        expect(closed.points).toHaveLength(g.points.length);
        expect(closed.constraints.some(isModelLock)).toBe(true);
        expect(solveGeometry(closed).ok).toBe(true);
    });

    it('closes it the other way round the face when reversed', () => {
        const g = u();
        const closing = findClosing(g, face);
        if ('error' in closing) {
            throw new Error(closing.error);
        }
        const closed = closeSketchWith(g, closing, true);
        expect(geometryProfiles(closed).open).toBe(0);
        expect(closed.curves).toHaveLength(3 + 5);
        const regions = regionsOf(closed);
        // The area outside the U, inside the face.
        expect(regionAt(regions, [5, 15])).toBeGreaterThanOrEqual(0);
        expect(regionAt(regions, [20, 5])).toBe(-1);
    });

    it('says why when there is nothing to close or the ends are off the face', () => {
        expect(findClosing(EMPTY_GEOMETRY, face)).toMatchObject({ error: expect.stringMatching(/no open profile/) });
        const off = addLine(EMPTY_GEOMETRY, { at: [10, 5] }, { at: [30, 5] }).g;
        expect(findClosing(off, face)).toMatchObject({ error: expect.stringMatching(/do not lie on the edges/) });
        expect(findClosing(u(), { curves: [], points: [], skipped: [] })).toMatchObject({ error: expect.stringMatching(/No face/) });
    });

    it('splits a round face: a chord closes with half the circle', () => {
        const disc: ModelSketch = { curves: [{ kind: 'circle', center: [0, 0], radius: 10, face: 0, loop: 0 }], points: [], skipped: [] };
        const chord = addLine(EMPTY_GEOMETRY, { at: [-10, 0] }, { at: [10, 0] }).g;
        const closing = findClosing(chord, disc);
        if ('error' in closing) {
            throw new Error(closing.error);
        }
        const [arc] = closing.paths[0];
        expect(arc.kind).toBe('arc');
        const closed = closeSketchWith(chord, closing);
        expect(geometryProfiles(closed)).toMatchObject({ open: 0 });
        expect(solveGeometry(closed).ok).toBe(true);
    });
});

describe('contours bounded by model edges', () => {
    it('adds the areas the profile and the face edges close, after the sketch own ones', () => {
        const g = u();
        expect(regionsOf(g)).toEqual([]);
        const regions = regionsWithModel(g, regionsOf(g), face);
        expect(regions).toHaveLength(2);
        const inside = regionAt(regions, [20, 5]);
        const outside = regionAt(regions, [5, 15]);
        expect(inside).toBeGreaterThanOrEqual(0);
        expect(outside).toBeGreaterThanOrEqual(0);
        expect(inside).not.toBe(outside);
        // The area inside the U is 20 x 10, its fourth side the piece of the face's bottom edge; outside, the rest.
        const size = (i: number) => Math.abs(area(profilePoints(regions[i].loops[0])));
        expect(size(inside)).toBeCloseTo(200, 6);
        expect(size(outside)).toBeCloseTo(800 - 200, 6);
        // Nothing changes without a model.
        expect(regionsWithModel(g, [], null)).toEqual([]);
    });

    it('keeps the sketch own regions first and does not repeat them', () => {
        let r = addLine(EMPTY_GEOMETRY, { at: [5, 5] }, { at: [15, 5] });
        r = addLine(r.g, { at: [15, 5], point: r.b }, { at: [15, 15] });
        r = addLine(r.g, { at: [15, 15], point: r.b }, { at: [5, 15] });
        const first = r.g.curves[0] as { a: string };
        r = addLine(r.g, { at: [5, 15], point: r.b }, { at: [5, 5], point: first.a });
        const own = regionsOf(r.g);
        const regions = regionsWithModel(r.g, own, face);
        expect(regions.slice(0, own.length)).toEqual(own);
        // The face around the square, with the square as its hole.
        expect(regions).toHaveLength(2);
        expect(regions[1].loops).toHaveLength(2);
    });

    it('leaves out edges a sketch curve crosses between points', () => {
        const across = addLine(EMPTY_GEOMETRY, { at: [20, -5] }, { at: [20, 25] }).g;
        expect(regionsWithModel(across, [], face)).toEqual([]);
    });
});
