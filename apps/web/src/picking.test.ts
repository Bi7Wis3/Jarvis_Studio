import { describe, expect, it } from 'vitest';
import {
    countLabel, edgeLength, edgeSegments, faceArea, facePlane, faceSoup, faceTriangles, formatMeasure, nearestEdge, pixelSize,
    togglePick,
} from './picking';

// A unit square in z = 0 (face 0, two triangles) and a bent quad (face 1: one triangle in z = 0, one tilted).
const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    2, 0, 0, 3, 0, 0, 3, 1, 0, 2, 1, 1,
]);
const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
const triFace = new Uint32Array([0, 0, 1, 1]);

// Edge 0: two segments along y = 0 from x 0 to 2; edge 1: one segment up the z axis, 3 long.
const edges = new Float32Array([
    0, 0, 0, 1, 0, 0,
    1, 0, 0, 2, 0, 0,
    0, 0, 0, 0, 0, 3,
]);
const segEdge = new Uint32Array([0, 0, 1]);

describe('faces', () => {
    it('lists the triangles of one face', () => {
        expect([...faceTriangles(indices, triFace, 0)]).toEqual([0, 1, 2, 0, 2, 3]);
        expect([...faceTriangles(indices, triFace, 1)]).toEqual([4, 5, 6, 4, 6, 7]);
        expect(faceTriangles(indices, triFace, 7).length).toBe(0);
    });

    it('gives a face as unindexed positions', () => {
        const soup = faceSoup(positions, indices, triFace, 0);
        expect(soup.length).toBe(18);
        expect([...soup.slice(0, 9)]).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0]);
    });

    it('measures the area', () => {
        expect(faceArea(positions, indices, triFace, 0)).toBeCloseTo(1, 6);
        expect(faceArea(positions, indices, triFace, 1)).toBeCloseTo(0.5 + Math.sqrt(3) / 2, 6);
    });

    it('tells planar faces and their normal', () => {
        const flat = facePlane(positions, indices, triFace, 0);
        expect(flat.planar).toBe(true);
        expect(flat.normal![2]).toBeCloseTo(1, 6);
        expect(facePlane(positions, indices, triFace, 1)).toEqual({ planar: false, normal: null });
        expect(facePlane(positions, indices, triFace, 9)).toEqual({ planar: false, normal: null });
    });
});

describe('edges', () => {
    it('lists the segments of one edge', () => {
        expect(edgeSegments(edges, segEdge, 0).length).toBe(12);
        expect([...edgeSegments(edges, segEdge, 1)]).toEqual([0, 0, 0, 0, 0, 3]);
    });

    it('measures the length', () => {
        expect(edgeLength(edges, segEdge, 0)).toBeCloseTo(2, 6);
        expect(edgeLength(edges, segEdge, 1)).toBeCloseTo(3, 6);
    });

    it('finds the nearest edge within the tolerance', () => {
        expect(nearestEdge(edges, segEdge, [1.5, 0.05, 0], 0.1)).toBe(0);
        expect(nearestEdge(edges, segEdge, [0.02, 0, 2], 0.1)).toBe(1);
        // Past the end of a segment counts the distance to its end point.
        expect(nearestEdge(edges, segEdge, [2.2, 0, 0], 0.1)).toBeNull();
        expect(nearestEdge(edges, segEdge, [0.5, 0.5, 0.5], 0.1)).toBeNull();
        // Near both: the closer one wins.
        expect(nearestEdge(edges, segEdge, [0.01, 0, 0.03], 0.1)).toBe(1);
    });
});

describe('screen tolerance', () => {
    it('sizes a pixel for perspective and orthographic cameras', () => {
        // 90° vertical field of view: the view is 2 * depth tall.
        expect(pixelSize({ kind: 'perspective', fov: 90, zoom: 1 }, 100, 200)).toBeCloseTo(1, 6);
        expect(pixelSize({ kind: 'perspective', fov: 90, zoom: 2 }, 100, 200)).toBeCloseTo(0.5, 6);
        expect(pixelSize({ kind: 'orthographic', top: 50, bottom: -50, zoom: 1 }, 1234, 100)).toBeCloseTo(1, 6);
    });
});

describe('pick list and readout', () => {
    const a = { partId: 'p', kind: 'face' as const, index: 1 };
    const b = { partId: 'p', kind: 'edge' as const, index: 1 };

    it('replaces, adds and removes picks', () => {
        expect(togglePick([a], b, false)).toEqual([b]);
        expect(togglePick([a], b, true)).toEqual([a, b]);
        expect(togglePick([a, b], a, true)).toEqual([b]);
    });

    it('formats measures and counts', () => {
        expect(formatMeasure(1200)).toBe('1 200');
        expect(formatMeasure(40)).toBe('40');
        expect(formatMeasure(3.14159)).toBe('3.1');
        expect(formatMeasure(123456.7)).toBe('123 457');
        expect(countLabel([a, a, a, b, b])).toBe('3 faces, 2 edges');
        expect(countLabel([a, a])).toBe('2 faces');
        expect(countLabel([b])).toBe('1 edge');
    });
});
