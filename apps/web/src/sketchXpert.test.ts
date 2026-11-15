// SketchXpert Diagnose: the relations and dimensions whose removal makes an over defined or unsolvable sketch sound.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchConstraint } from '@jarvis/core';
import { loadSolver, solveGeometry } from './solver';
import { EMPTY_GEOMETRY, addConstraint, addRect } from './sketchGeometry';
import { diagnose, sketchProblems } from './sketchXpert';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

describe('SketchXpert', () => {
    it('finds the single items whose removal ends an over defined sketch', () => {
        const r = addRect(EMPTY_GEOMETRY, [0, 0], [40, 10]);
        let g = addConstraint(r.g, { kind: 'length', line: r.lines[0], value: 40 }).g;
        const second = addConstraint(g, { kind: 'length', line: r.lines[2], value: 40 });
        g = second.g;
        expect(sketchProblems(r.g).ok).toBe(true);
        const problems = sketchProblems(g);
        expect(problems.ok).toBe(false);
        const solutions = diagnose(g);
        expect(solutions.length).toBeGreaterThan(0);
        expect(solutions.every((s) => s.remove.length === 1)).toBe(true);
        expect(solutions.map((s) => s.remove[0])).toContain(second.id);
        // Each solution solves without redundancy.
        for (const s of solutions) {
            const left = { ...g, constraints: g.constraints.filter((c) => !s.remove.includes(c.id)) };
            expect(solveGeometry(left).redundant).toEqual([]);
        }
    });

    it('finds what to remove from a sketch that does not solve', () => {
        const r = addRect(EMPTY_GEOMETRY, [0, 0], [40, 10]);
        // Opposite sides of different lengths cannot both hold.
        const constraints: SketchConstraint[] = [
            ...r.g.constraints,
            { id: 'k90', kind: 'length', line: r.lines[0], value: 40 },
            { id: 'k91', kind: 'length', line: r.lines[2], value: 30 },
        ];
        const g = { ...r.g, constraints };
        expect(solveGeometry(g).ok).toBe(false);
        const removed = diagnose(g).map((s) => s.remove.join());
        expect(removed).toEqual(expect.arrayContaining(['k90', 'k91']));
    });
});
