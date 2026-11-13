import { describe, expect, it } from 'vitest';
import type { P3 } from './picking';
import {
    circleOfEdge, edgeEnds, edgeOfPick, edgePick, edgePolyline, faceOfPick, facePick, lineOfEdge, nearestVertex,
    positionFromPick,
} from './pickRefs';

// Hand-built kernel mesh: face 0 = top square y = 1 (0..10 in x and z), face 1 = front wall z = 0 (y 0..1),
// sharing the edge (0,1,0)-(10,1,0). Edge 0 = that shared edge (two segments), edge 1 = a full circle of radius 3
// around (5, 1, 5) in the top face (segments out of order), edge 2 = a quarter arc of radius 2 around (0, 1, 10),
// edge 3 = a parabola-like curve (neither line nor circle).
const positions = new Float32Array([
    0, 1, 0, 10, 1, 0, 10, 1, 10, 0, 1, 10, // top 0..3
    0, 0, 0, 10, 0, 0, 10, 1, 0, 0, 1, 0, // front 4..7
]);
const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1]);
// Counter-clockwise seen from outside.
const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6]);
const triFace = new Uint32Array([0, 0, 1, 1]);

const edgeList: number[] = [];
const segEdgeList: number[] = [];
const seg = (a: P3, b: P3, edge: number): void => {
    edgeList.push(...a, ...b);
    segEdgeList.push(edge);
};
seg([0, 1, 0], [4, 1, 0], 0);
seg([4, 1, 0], [10, 1, 0], 0);
const circle = Array.from({ length: 24 }, (_, i): P3 => {
    const a = (i / 24) * 2 * Math.PI;
    return [5 + 3 * Math.cos(a), 1, 5 + 3 * Math.sin(a)];
});
for (const i of [5, 0, 17, 3, 9, 1, 2, 4, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 22, 23]) {
    seg(circle[i], circle[(i + 1) % 24], 1);
}
for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * (Math.PI / 2);
    const a1 = ((i + 1) / 6) * (Math.PI / 2);
    seg([2 * Math.cos(a0), 1, 10 - 2 * Math.sin(a0)], [2 * Math.cos(a1), 1, 10 - 2 * Math.sin(a1)], 2);
}
for (let i = 0; i < 8; i++) {
    seg([i, 1 + (i * i) / 10, 3], [i + 1, 1 + ((i + 1) * (i + 1)) / 10, 3], 3);
}
const edges = new Float32Array(edgeList);
const segEdge = new Uint32Array(segEdgeList);

const close = (a: P3 | null | undefined, b: P3, digits = 4): void => {
    expect(a).not.toBeNull();
    a!.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
};

describe('edge picks', () => {
    it('chains segments in order and round-trips every edge', () => {
        const ring = edgePolyline(edges, segEdge, 1);
        expect(ring).toHaveLength(25);
        close(ring[24], ring[0]);
        for (const edge of [0, 1, 2, 3]) {
            const pick = edgePick(edges, segEdge, edge);
            expect(edgeOfPick(edges, segEdge, pick!, 0.01)).toBe(edge);
        }
        close(edgePick(edges, segEdge, 0), [5, 1, 0]);
        expect(edgeOfPick(edges, segEdge, [5, 4, 5], 0.5)).toBeNull();
        expect(edgePick(edges, segEdge, 9)).toBeNull();
    });

    it('recognises circles, arcs and lines', () => {
        const full = circleOfEdge(edges, segEdge, 1)!;
        close(full.centre, [5, 1, 5]);
        expect(full.radius).toBeCloseTo(3, 4);
        expect(Math.abs(full.normal[1])).toBeCloseTo(1, 6);
        expect(full.full).toBe(true);
        const arc = circleOfEdge(edges, segEdge, 2)!;
        close(arc.centre, [0, 1, 10]);
        expect(arc.radius).toBeCloseTo(2, 4);
        expect(arc.full).toBe(false);
        expect(circleOfEdge(edges, segEdge, 0)).toBeNull();
        expect(circleOfEdge(edges, segEdge, 3)).toBeNull();
        const line = lineOfEdge(edges, segEdge, 0)!;
        close(line.mid, [5, 1, 0]);
        close(line.direction, [1, 0, 0]);
        expect(lineOfEdge(edges, segEdge, 1)).toBeNull();
        expect(lineOfEdge(edges, segEdge, 3)).toBeNull();
    });

    it('finds edge ends and the nearest vertex', () => {
        const ends = edgeEnds(edges, segEdge, 0)!;
        expect([ends[0][0], ends[1][0]].sort((a, b) => a - b)).toEqual([0, 10]);
        expect(edgeEnds(edges, segEdge, 1)).toBeNull();
        close(nearestVertex(edges, segEdge, [9.8, 1.1, 0], 0.5), [10, 1, 0]);
        expect(nearestVertex(edges, segEdge, [5, 1, 0], 0.5)).toBeNull();
    });
});

describe('face picks', () => {
    it('round-trips each face and decides a shared-edge pick by the normal', () => {
        const top = facePick(positions, normals, indices, triFace, 0)!;
        close(top.normal!, [0, 1, 0]);
        expect(faceOfPick(positions, indices, triFace, top, 0.01)).toBe(0);
        const front = facePick(positions, normals, indices, triFace, 1)!;
        close(front.normal!, [0, 0, -1]);
        expect(faceOfPick(positions, indices, triFace, front, 0.01)).toBe(1);
        expect(faceOfPick(positions, indices, triFace, { at: [5, 1, 0], normal: [0, 1, 0] }, 0.01)).toBe(0);
        expect(faceOfPick(positions, indices, triFace, { at: [5, 1, 0], normal: [0, 0, -1] }, 0.01)).toBe(1);
        expect(faceOfPick(positions, indices, triFace, { at: [5, 6, 5] }, 0.5)).toBeNull();
    });
});

describe('positionFromPick', () => {
    it('places tools at centres, midpoints, projections, vertices and face points', () => {
        const hole = positionFromPick('edge', { edges, segEdge, edge: 1, point: [8, 1, 5] });
        close(hole.position, [5, 1, 5]);
        expect(hole.radius).toBeCloseTo(3, 4);
        close(positionFromPick('edge', { edges, segEdge, edge: 0, point: [5.8, 1.05, 0] }).position, [5, 1, 0]);
        close(positionFromPick('edge', { edges, segEdge, edge: 0, point: [8, 1.05, 0.1] }).position, [8, 1, 0]);
        close(positionFromPick('edge', { edges, segEdge, edge: 3, point: [2, 1.4, 3.2] }).position, [2, 1.4, 3], 3);
        close(positionFromPick('vertex', { point: [10, 1, 0] }).position, [10, 1, 0]);
        const onFace = positionFromPick('face', { point: [2, 1, 2], normal: [0, 2, 0] });
        close(onFace.position, [2, 1, 2]);
        close(onFace.normal!, [0, 1, 0]);
    });
});
