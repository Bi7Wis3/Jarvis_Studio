import { beforeAll, describe, expect, it } from 'vitest';
import opencascade from 'replicad-opencascadejs';
import { makeBox, measureVolume, setOC, type Shape3D } from 'replicad';
import { blendTap, chamferEdges, filletEdges, type BlendWay } from './applied.js';
import { falselySmooth, withJoinFlags } from './edgeContinuity.js';
import { resolveEdges } from './refs.js';

const SLOW = 120_000;
let box: Shape3D;

beforeAll(async () => {
    setOC(await opencascade({ print: () => {}, printErr: () => {} }));
    box = makeBox([0, 0, 0], [40, 10, 20]);
}, SLOW);

function way(make: () => Shape3D): { shape: Shape3D; way: BlendWay | null } {
    let made: BlendWay | null = null;
    blendTap.made = (w) => {
        made = w;
    };
    try {
        return { shape: make(), way: made };
    } finally {
        blendTap.made = null;
    }
}

describe('edge continuity flags', () => {
    it('clears a smooth-join flag left on a real corner, so OpenCascade blends the edge again', () => {
        const edge = resolveEdges(box, [[20, 10, 0]]);
        // A body whose edge says its faces join smoothly, as earlier steps sometimes leave it.
        const flagged = withJoinFlags(box, edge, 'G1', edge)!;
        expect(flagged).not.toBeNull();
        expect(falselySmooth(flagged.shape, flagged.edges)).toHaveLength(1);
        expect(falselySmooth(box, edge)).toHaveLength(0);
        // OpenCascade's own builder refuses the edge.
        expect(() => flagged.shape.chamfer(2, (f) => f.inList(flagged.edges))).toThrow();
        const chamfered = way(() => chamferEdges(flagged.shape, flagged.edges, { distance: 2 }));
        expect(chamfered.way).toBe('kernel after flags');
        expect(measureVolume(chamfered.shape)).toBeCloseTo(40 * 10 * 20 - 2 * 40, 6);
        const filleted = way(() => filletEdges(flagged.shape, flagged.edges, { radius: 2 }));
        expect(filleted.way).toBe('kernel after flags');
        expect(measureVolume(filleted.shape)).toBeCloseTo(40 * 10 * 20 - (4 - Math.PI) * 40, 4);
    }, SLOW);
});
