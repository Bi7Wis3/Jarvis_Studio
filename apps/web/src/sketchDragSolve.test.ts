import { beforeAll, describe, expect, it } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import { loadSolver, solveGeometry } from './solver';
import { curvePoints } from './sketchEdit';
import { addArc, addCircle, addConstraint, addLine, addRect, EMPTY_GEOMETRY } from './sketchGeometry';
import { joinedPart, solveDrag } from './sketchDragSolve';

beforeAll(async () => {
    await loadSolver();
});

/**
 * Three rectangles (one with a width), two circles made equal across two of them, a circle on its own with a free
 * radius, a loose point, and a line from a locked point.
 */
function sketch(): SketchGeometry {
    let g = EMPTY_GEOMETRY;
    const rects: string[][] = [];
    for (const [u, v] of [[0, 0], [40, 0], [80, 0]]) {
        const r = addRect(g, [u, v], [u + 20, v + 10]);
        g = r.g;
        rects.push(r.lines);
    }
    g = addConstraint(g, { kind: 'length', line: rects[0][0], value: 20 }).g;
    // Driven (reference) sizes follow the geometry: one in each part.
    g = addConstraint(g, { kind: 'length', line: rects[0][1], value: 10, driven: true }).g;
    g = addConstraint(g, { kind: 'length', line: rects[1][0], value: 20, driven: true }).g;
    const c1 = addCircle(g, { at: [10, 30] }, 3);
    g = c1.g;
    const c2 = addCircle(g, { at: [50, 30] }, 4);
    g = c2.g;
    g = addConstraint(g, { kind: 'equal', a: c1.id, b: c2.id }).g;
    // The first circle's centre on the first rectangle's top side: the circles join it to the second rectangle's group.
    g = addConstraint(g, { kind: 'distance', a: c1.center, b: rects[0][2], value: 20 }).g;
    g = addCircle(g, { at: [120, 30] }, 5).g;
    g = { ...g, points: [...g.points, { id: 'loose', u: 130, v: -20 }, { id: 'locked', u: -20, v: -20, fixed: true }] };
    g = addLine(g, { at: [-20, -10] }, { at: [-20, -20], point: 'locked' }).g;
    const solved = solveGeometry(g);
    expect(solved.ok).toBe(true);
    return solved.geometry;
}

const near = (a: SketchGeometry, b: SketchGeometry) => {
    for (const p of a.points) {
        const q = b.points.find((x) => x.id === p.id)!;
        expect(Math.hypot(p.u - q.u, p.v - q.v)).toBeLessThan(1e-6);
    }
    for (const k of a.constraints) {
        const l = b.constraints.find((x) => x.id === k.id)!;
        if ('value' in k && 'value' in l) {
            expect(Math.abs(k.value - l.value)).toBeLessThan(1e-6);
        }
    }
    for (const c of a.curves) {
        const d = b.curves.find((x) => x.id === c.id)!;
        if (c.kind === 'circle' && d.kind === 'circle') {
            expect(Math.abs(c.radius - d.radius)).toBeLessThan(1e-6);
        }
    }
};

describe('drag solve of the joined part only', () => {
    it('stops at held and fixed points and keeps apart what shares nothing', () => {
        const g = sketch();
        const corner = g.curves.find((c) => c.kind === 'line')!;
        const part = joinedPart(g, [corner.kind === 'line' ? corner.a : '']);
        // The first rectangle, the circle placed from it and the circle made equal to that one; not the other rectangles.
        expect(part.curves.size).toBe(6);
        const held = new Set(g.points.map((p) => p.id).filter((id) => corner.kind === 'line' && id !== corner.a));
        const alone = joinedPart(g, [corner.kind === 'line' ? corner.a : ''], held);
        expect([...alone.points].filter((id) => !alone.edge.has(id))).toEqual([corner.kind === 'line' ? corner.a : '']);
    });

    it('gives what a solve of the whole sketch gives, freedom included', () => {
        const g = sketch();
        let tried = 0;
        // A corner of the first rectangle (its width is held) and of the third (free to change size).
        for (const line of g.curves.filter((c) => c.kind === 'line').filter((_, i) => i === 0 || i === 8)) {
            const dragged = line.kind === 'line' ? line.a : '';
            const p = g.points.find((q) => q.id === dragged)!;
            const attached = new Set(g.curves.filter((c) => curvePoints(c).includes(dragged)).flatMap((c) => curvePoints(c)));
            const others = g.points.map((q) => q.id).filter((id) => id !== dragged);
            // As a drag tries them: everything else held, then only the far ends, then nothing.
            const key = {};
            for (const hold of [new Set(others), new Set(others.filter((id) => !attached.has(id))), undefined]) {
                for (const [du, dv] of [[3, 2], [-4, 5]]) {
                    const drag = { targets: [{ point: dragged, u: p.u + du, v: p.v + dv }], hold };
                    const whole = solveGeometry(g, drag);
                    const part = solveDrag(g, drag, key);
                    expect(part.ok).toBe(whole.ok);
                    // A solve that fails leaves the sketch as it was (a drag goes on to its next try).
                    if (whole.ok) {
                        expect(part.dof).toBe(whole.dof);
                        tried += 1;
                    }
                    near(part.geometry, whole.geometry);
                }
            }
        }
        expect(tried).toBeGreaterThan(4);
        // The loose point and the circle on its own moved with nothing.
        const free = solveDrag(g, { targets: [{ point: 'loose', u: 140, v: -25 }] }, {});
        expect(free.dof).toBe(solveGeometry(g, { targets: [{ point: 'loose', u: 140, v: -25 }] }).dof);
        expect(free.geometry.points.find((q) => q.id === 'loose')).toMatchObject({ u: 140, v: -25 });
        expect(free.geometry.curves.filter((c) => c.kind === 'line').length).toBe(g.curves.filter((c) => c.kind === 'line').length);
    });
});

describe('held drag tries on the joined part', () => {
    // The tries of a drag of `dragged` by (du, dv): everything else held, then only what is not attached to it.
    const tries = (g: SketchGeometry, dragged: string, du: number, dv: number) => {
        const p = g.points.find((q) => q.id === dragged)!;
        const attached = new Set(g.curves.filter((c) => curvePoints(c).includes(dragged)).flatMap((c) => curvePoints(c)));
        const others = g.points.map((q) => q.id).filter((id) => id !== dragged);
        const targets = [{ point: dragged, u: p.u + du, v: p.v + dv }];
        return [new Set(others), new Set(others.filter((id) => !attached.has(id)))].map((hold) => ({ targets, hold }));
    };

    it('fails where the whole sketch fails: a pull that cannot be met, with relations among the held points elsewhere', () => {
        // A horizontal line, and a rectangle apart from it. Its end pulled up and across, everything else held: the
        // line alone takes the pull as far as it can, but the whole sketch judges the rectangle's relations (among held
        // points only) with the pull held exactly, and refuses.
        let g = addRect(EMPTY_GEOMETRY, [40, 0], [60, 10]).g;
        const line = addLine(g, { at: [0, 0] }, { at: [10, 0] }, 'horizontal');
        g = solveGeometry(line.g).geometry;
        const drag = tries(g, line.b, 3, 2)[0];
        expect(solveGeometry(g, drag).ok).toBe(false);
        expect(solveDrag(g, drag, {}).ok).toBe(false);
        // Along the line the pull is met: both keep the try.
        const along = tries(g, line.b, 3, 0)[0];
        const whole = solveGeometry(g, along);
        const part = solveDrag(g, along, {});
        expect([whole.ok, part.ok]).toEqual([true, true]);
        expect(part.dof).toBe(whole.dof);
        near(part.geometry, whole.geometry);
    });

    it('keeps a try the whole sketch keeps when only curves of the solver hold the rest (arcs) ', () => {
        // A right-angled triangle and an arc apart: the arc's own rules are redundant with its points held, never ours.
        let g = EMPTY_GEOMETRY;
        const a = addLine(g, { at: [0, 0] }, { at: [10, 0] });
        g = a.g;
        const b = addLine(g, { point: a.b, at: [10, 0] }, { at: [10, 8] });
        g = b.g;
        const first = g.curves.find((c) => c.id === a.id)!;
        g = addLine(g, { point: b.b, at: [10, 8] }, { point: first.kind === 'line' ? first.a : '', at: [0, 0] }).g;
        g = addConstraint(g, { kind: 'perpendicular', a: a.id, b: b.id }).g;
        g = addArc(g, { at: [30, 0] }, { at: [42, 0] }, [36, 5]).g;
        g = solveGeometry(g).geometry;
        const start = first.kind === 'line' ? first.a : '';
        for (const drag of tries(g, start, -1.5, 4)) {
            const whole = solveGeometry(g, drag);
            const part = solveDrag(g, drag, {});
            expect(part.ok).toBe(whole.ok);
            if (whole.ok) {
                expect(part.dof).toBe(whole.dof);
                near(part.geometry, whole.geometry);
            }
        }
        expect(solveDrag(g, tries(g, start, -1.5, 4)[0], {}).ok).toBe(true);
    });

    it('gives the whole solve\'s verdict, freedom and geometry on many sketches', () => {
        let seed = 7;
        const rnd = () => {
            seed = (seed * 16807) % 2147483647;
            return seed / 2147483647;
        };
        let compared = 0;
        let kept = 0;
        for (let k = 0; k < 25; k++) {
            let g = EMPTY_GEOMETRY;
            const sides: string[] = [];
            const circles: string[] = [];
            for (let s = 0; s < 4; s++) {
                const [u, v] = [(rnd() - 0.5) * 150, (rnd() - 0.5) * 100];
                if (rnd() < 0.6) {
                    const r = addRect(g, [u, v], [u + 5 + rnd() * 20, v + 4 + rnd() * 15]);
                    g = r.g;
                    sides.push(...r.lines);
                    if (rnd() < 0.5) {
                        g = addConstraint(g, { kind: 'length', line: r.lines[0], value: 12 }).g;
                    }
                    if (rnd() < 0.3) {
                        g = addConstraint(g, { kind: 'length', line: r.lines[1], value: 7, driven: true }).g;
                    }
                } else {
                    const c = addCircle(g, { at: [u, v] }, 1 + rnd() * 8);
                    g = c.g;
                    circles.push(c.id);
                }
            }
            if (circles.length > 1) {
                g = addConstraint(g, { kind: 'equal', a: circles[0], b: circles[1] }).g;
            }
            if (sides.length > 4) {
                g = addConstraint(g, { kind: 'parallel', a: sides[0], b: sides[sides.length - 1] }).g;
            }
            g = solveGeometry(g).geometry;
            const p = g.points[Math.floor(rnd() * g.points.length)];
            for (const drag of tries(g, p.id, 3, 2)) {
                const whole = solveGeometry(g, drag);
                const part = solveDrag(g, drag, {});
                compared += 1;
                expect(part.ok).toBe(whole.ok);
                if (whole.ok) {
                    kept += 1;
                    expect(part.dof).toBe(whole.dof);
                    near(part.geometry, whole.geometry);
                }
            }
        }
        expect(compared).toBe(50);
        expect(kept).toBeGreaterThan(5);
    });
});
