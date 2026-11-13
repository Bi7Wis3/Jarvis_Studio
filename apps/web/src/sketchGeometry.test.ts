import { beforeAll, describe, expect, it } from 'vitest';
import type { SketchProfile } from '@jarvis/core';
import { loadSolver, solveGeometry } from './solver';
import {
    addArc, addLine, addPolygon, addRect, addSlot, dimensionFromPicks, evaluate, geometryProfiles, profilesToGeometry, removeItems,
    EMPTY_GEOMETRY,
} from './sketchGeometry';
import { area, profilePoints } from './sketchMath';

beforeAll(async () => {
    await loadSolver();
});

const areaOf = (p: SketchProfile) => Math.abs(area(profilePoints(p)));

describe('sketch geometry', () => {
    it('converts old profile-only sketches into editable geometry and back', () => {
        const profiles: SketchProfile[] = [
            { kind: 'rect', center: [0, 0], width: 40, height: 20 },
            { kind: 'circle', center: [5, 0], radius: 3 },
            { kind: 'slot', from: [-10, 0], to: [10, 0], radius: 2 },
            { kind: 'path', start: [50, 0], segments: [{ kind: 'line', to: [70, 0] }, { kind: 'arc', to: [50, 0], through: [60, 10] }] },
        ];
        const g = profilesToGeometry(profiles);
        expect(g.curves.filter((c) => c.kind === 'line')).toHaveLength(4 + 2 + 1);
        const solved = solveGeometry(g);
        expect(solved.ok).toBe(true);
        const back = geometryProfiles(solved.geometry);
        expect(back.open).toBe(0);
        expect(back.profiles).toHaveLength(4);
        const areas = back.profiles.map(areaOf).sort((a, b) => a - b);
        const expected = profiles.map(areaOf).sort((a, b) => a - b);
        areas.forEach((a, i) => expect(a).toBeCloseTo(expected[i], 0));
    });

    it('keeps a drawn rectangle connected and fully constrains it with dimensions', () => {
        const r = addRect(EMPTY_GEOMETRY, [2, 3], [30, 18]);
        let g = r.g;
        const bottom = r.lines[0];
        const corner = g.curves.find((c) => c.id === bottom)!;
        g = { ...g, constraints: [...g.constraints,
            { id: 'w', kind: 'length', line: bottom, value: 40 },
            { id: 'h', kind: 'length', line: r.lines[1], value: 20 },
            { id: 'x', kind: 'distance', a: 'origin', b: corner.kind === 'line' ? corner.a : '', axis: 'u', value: 5 },
            { id: 'y', kind: 'distance', a: corner.kind === 'line' ? corner.a : '', b: 'axis-u', value: 10 },
        ] };
        const solved = solveGeometry(g);
        expect(solved.ok).toBe(true);
        expect(solved.dof).toBe(0);
        const [profile] = geometryProfiles(solved.geometry).profiles;
        expect(areaOf(profile)).toBeCloseTo(800);
    });

    it('builds slots, polygons and chained lines that solve', () => {
        let g = addSlot(EMPTY_GEOMETRY, [0, 0], [20, 0], 3).g;
        g = addPolygon(g, { at: [50, 0] }, [60, 0], 6).g;
        const l1 = addLine(g, { at: [0, 30] }, { at: [20, 30] }, 'horizontal');
        const l2 = addLine(l1.g, { at: [20, 30], point: l1.b }, { at: [10, 45] });
        const first = l1.g.curves.find((c) => c.id === l1.id) as { a: string };
        g = addArc(l2.g, { at: [10, 45], point: l2.b }, { at: [0, 30], point: first.a }, [2, 40]).g;
        const solved = solveGeometry(g);
        expect(solved.ok).toBe(true);
        const { profiles, open } = geometryProfiles(solved.geometry);
        expect(open).toBe(0);
        expect(profiles).toHaveLength(3);
        expect(areaOf(profiles[0])).toBeCloseTo(20 * 6 + Math.PI * 9, 0);
    });

    it('removes a curve with its constraints and orphan points', () => {
        const r = addRect(EMPTY_GEOMETRY, [0, 0], [10, 10]);
        const g = removeItems(r.g, [r.lines[0]]);
        expect(g.curves).toHaveLength(3);
        expect(g.constraints.filter((c) => c.kind === 'horizontal')).toHaveLength(1);
        expect(g.points).toHaveLength(4);
    });

    it('chooses horizontal, vertical or aligned distances by where the dimension is placed', () => {
        const g = { points: [{ id: 'a', u: 0, v: 0 }, { id: 'b', u: 10, v: 5 }], curves: [], constraints: [] };
        const picks = [{ type: 'point' as const, id: 'a' }, { type: 'point' as const, id: 'b' }];
        expect(dimensionFromPicks(g, picks, [5, 12])).toMatchObject({ kind: 'distance', axis: 'u' });
        expect(dimensionFromPicks(g, picks, [15, 2])).toMatchObject({ kind: 'distance', axis: 'v' });
        expect(dimensionFromPicks(g, picks, [5, 2])).not.toHaveProperty('axis');
    });

    it('evaluates typed expressions', () => {
        expect(evaluate('40/2')).toBe(20);
        expect(evaluate('25.4*2')).toBeCloseTo(50.8);
        expect(evaluate('(10+5)*2-1')).toBe(29);
        expect(evaluate('12,5')).toBe(12.5);
        expect(evaluate('alert(1)')).toBeNull();
    });
});
