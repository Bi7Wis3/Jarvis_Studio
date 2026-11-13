import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, type Part, type Project, type Shape, type Vec3 } from '@jarvis/core';
import { exportStl } from './exportStl.js';
import type { MeshData } from './cad/kernel.js';

interface Facet {
    normal: Vec3;
    vertices: [Vec3, Vec3, Vec3];
}

interface ParsedStl {
    count: number;
    facets: Facet[];
}

function parseStl(buffer: Buffer): ParsedStl {
    const count = buffer.readUInt32LE(80);
    const facets: Facet[] = [];
    let offset = 84;
    const vec = (): Vec3 => {
        const v: Vec3 = [buffer.readFloatLE(offset), buffer.readFloatLE(offset + 4), buffer.readFloatLE(offset + 8)];
        offset += 12;
        return v;
    };
    while (offset + 50 <= buffer.length) {
        const normal = vec();
        const vertices: [Vec3, Vec3, Vec3] = [vec(), vec(), vec()];
        offset += 2;
        facets.push({ normal, vertices });
    }
    return { count, facets };
}

function bounds(stl: ParsedStl): { min: Vec3; max: Vec3; size: Vec3 } {
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const facet of stl.facets) {
        for (const v of facet.vertices) {
            for (let i = 0; i < 3; i++) {
                min[i] = Math.min(min[i], v[i]);
                max[i] = Math.max(max[i], v[i]);
            }
        }
    }
    return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

function part(id: string, shape: Shape, position: Vec3 = [0, 0, 0], rotation: Vec3 = [0, 0, 0]): Part {
    return {
        id,
        name: id,
        shape,
        position,
        rotation,
        material: { color: '#cccccc', metalness: 0, roughness: 0.5 },
    };
}

function project(parts: Part[]): Project {
    return { name: 'test', parts, view: { ...DEFAULT_VIEW } };
}

function expectVec(actual: Vec3, expected: Vec3): void {
    for (let i = 0; i < 3; i++) {
        expect(actual[i]).toBeCloseTo(expected[i], 4);
    }
}

const box = (size: Vec3): Shape => ({ kind: 'box', size, radius: 0 });

// Generous timeouts: the CAD kernel tests load the CPU when the suite runs in parallel.
describe('exportStl', { timeout: 30_000 }, () => {
    it('writes a binary STL whose length matches the triangle count in the header', () => {
        const buffer = exportStl(project([part('a', box([10, 20, 30])), part('b', { kind: 'sphere', radius: 5 })]));
        const count = buffer.readUInt32LE(80);
        expect(count).toBeGreaterThan(12);
        expect(buffer.length).toBe(84 + 50 * count);
        expect(parseStl(buffer).facets).toHaveLength(count);
    });

    it('converts Y-up to Z-up and applies the part position', () => {
        const stl = parseStl(exportStl(project([part('a', box([10, 20, 30]), [0, 10, 0])])));
        expect(stl.count).toBe(12);
        const { min, max, size } = bounds(stl);
        expectVec(size, [10, 30, 20]);
        expectVec(min, [-5, -15, 0]);
        expectVec(max, [5, 15, 20]);
    });

    it('applies part rotation in degrees', () => {
        const stl = parseStl(exportStl(project([part('a', box([10, 20, 30]), [0, 0, 0], [0, 0, 90])])));
        // Rotating 90 degrees about app Z swaps the app X and Y extents; app Y becomes STL Z.
        expectVec(bounds(stl).size, [20, 30, 10]);
    });

    it('exports only the requested parts', () => {
        const parts = [part('a', box([10, 10, 10])), part('b', box([40, 40, 40]), [100, 0, 0])];
        const all = parseStl(exportStl(project(parts)));
        const onlyB = parseStl(exportStl(project(parts), () => null, ['b']));
        expect(all.count).toBe(24);
        expect(onlyB.count).toBe(12);
        expectVec(bounds(onlyB).size, [40, 40, 40]);
        expectVec(bounds(onlyB).min, [80, -20, -20]);
    });

    it('throws when there is nothing to export', () => {
        expect(() => exportStl(project([]))).toThrow(/no parts/);
        expect(() => exportStl(project([part('a', box([1, 1, 1]))]), () => null, ['missing'])).toThrow(/Nothing to export/);
    });

    it('writes unit-length normals that follow the right-hand winding', () => {
        const shapes: Shape[] = [
            box([10, 20, 30]),
            { kind: 'cylinder', radius: 5, height: 10 },
            { kind: 'tube', outerRadius: 10, innerRadius: 8, height: 5 },
            { kind: 'torus', radius: 10, tube: 2 },
            { kind: 'lathe', profile: [[0, -5], [5, -5], [5, 5], [0, 5]] },
        ];
        const stl = parseStl(exportStl(project(shapes.map((s, i) => part(`p${i}`, s, [i * 50, 0, 0], [30, 45, 60])))));
        expect(stl.facets.length).toBeGreaterThan(0);
        for (const { normal, vertices: [a, b, c] } of stl.facets) {
            expect(Math.hypot(...normal)).toBeCloseTo(1, 4);
            const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
            const dot = cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2];
            expect(dot).toBeGreaterThan(0);
        }
    });
});

describe('kernel meshes', { timeout: 30_000 }, () => {
    // A unit right-angled tetrahedron standing in for a CAD kernel mesh.
    const tetra: MeshData = {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
        normals: new Float32Array(12),
        indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
        edges: new Float32Array(0),
        triFace: new Uint32Array([0, 1, 2, 3]),
        segEdge: new Uint32Array(0),
    };

    it('uses the kernel mesh when there is one, with placement and repeats', () => {
        const a: Part = { ...part('a', box([10, 10, 10]), [5, 0, 0]), repeat: { kind: 'linear', count: 2, step: [10, 0, 0] } };
        const b = part('b', box([2, 2, 2]), [-50, 0, 0]);
        const stl = parseStl(exportStl(project([a, b]), (p) => (p.id === 'a' ? tetra : null)));
        expect(stl.count).toBe(4 * 2 + 12);
        const onlyA = parseStl(exportStl(project([a, b]), (p) => (p.id === 'a' ? tetra : null), ['a']));
        // App Y (0..1) becomes STL Z; app Z (0..1) becomes STL -Y.
        expectVec(bounds(onlyA).min, [5, -1, 0]);
        expectVec(bounds(onlyA).max, [16, 0, 1]);
    });
});

describe('patterns and new shapes', { timeout: 30_000 }, () => {
    it('exports every copy of a radial pattern around the vertical axis', () => {
        const foot: Part = { ...part('foot', box([4, 2, 4]), [20, 1, 0]), repeat: { kind: 'radial', count: 4 } };
        const stl = parseStl(exportStl(project([foot])));
        expect(stl.count).toBe(48);
        expectVec(bounds(stl).min, [-22, -22, 0]);
        expectVec(bounds(stl).max, [22, 22, 2]);
    });

    it('exports every copy of a linear pattern', () => {
        const key: Part = {
            ...part('key', box([4, 2, 4]), [0, 1, 0]),
            repeat: { kind: 'linear', count: 3, step: [10, 0, 0] },
        };
        const stl = parseStl(exportStl(project([key])));
        expect(stl.count).toBe(36);
        expectVec(bounds(stl).max, [22, 2, 2]);
    });

    it('keeps the outline size and height of a bevelled extrusion', () => {
        const plate: Shape = { kind: 'extrude', outline: [[-10, -5], [10, -5], [10, 5], [0, 12], [-10, 5]], height: 4 };
        const stl = parseStl(exportStl(project([part('plate', plate, [0, 2, 0])])));
        // App +Z maps to STL -Y.
        expectVec(bounds(stl).min, [-10, -12, 0]);
        expectVec(bounds(stl).max, [10, 5, 4]);
    });

    it('keeps the bounds of a cylinder when its rim is rounded', () => {
        const stl = parseStl(exportStl(project([part('c', { kind: 'cylinder', radius: 10, height: 6 }, [0, 3, 0])])));
        expectVec(bounds(stl).min, [-10, -10, 0]);
        expectVec(bounds(stl).max, [10, 10, 6]);
    });
});
