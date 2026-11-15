// Instant2D (SolidWorks: with Instant2D on, clicking a dimension shows its handles; dragging a handle changes the
// value, the geometry following, and an on-screen ruler appears to measure the change; on the ruler the value steps
// along its marks). Handles are offered for driving lengths, distances, radii, diameters and angles between lines.

import { create } from 'zustand';
import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, curveRadius, isDimension, measure, pointOf, solveGeometry, solverReady } from './solver';
import { dist, type Pt } from './sketchMath';
import { dimensionAnchor, useSketcher } from './sketcher';
import { sketchToggle } from './sketchToggles';

type Dimension = Extract<SketchConstraint, { value: number }>;

/**
 * How a dimension is dragged. Linear: the value is measured from `zero` along `dir` (the ruler's line runs through the
 * handle). Angular: the value is the angle at `zero` from `dir` to the pointer (0 to 180 degrees).
 */
export interface Handle {
    id: string;
    kind: 'linear' | 'angular';
    /** Where the handle is drawn. */
    at: Pt;
    /** The ruler's zero: the fixed end (linear), or the vertex (angular). */
    zero: Pt;
    /** Unit direction of the ruler (linear), or of the fixed side (angular). */
    dir: Pt;
    /** The value is this many times the measured length (2 for a diameter). */
    factor: number;
    /** Points of the fixed side, held still while dragging when they can be. */
    hold: string[];
}

const P = (g: SketchGeometry, id: string): Pt | null => {
    if (id === ORIGIN) {
        return [0, 0];
    }
    const p = pointOf(g, id);
    return p ? [p.u, p.v] : null;
};
const unit = (d: Pt): Pt | null => {
    const l = Math.hypot(d[0], d[1]);
    return l > 1e-9 ? [d[0] / l, d[1] / l] : null;
};
const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];

function lineEnds(g: SketchGeometry, id: string): [Pt, Pt, string[]] | null {
    const line = curveOf(g, id);
    if (line?.kind !== 'line') {
        return null;
    }
    const [a, b] = [P(g, line.a), P(g, line.b)];
    return a && b ? [a, b, [line.a, line.b]] : null;
}

function linear(id: string, zero: Pt, at: Pt, hold: string[], fallback?: Pt): Handle | null {
    const dir = unit(sub(at, zero)) ?? fallback ?? null;
    return dir ? { id, kind: 'linear', at, zero, dir, factor: 1, hold } : null;
}

/** The handle of a dimension, or null when it has none (driven, measured to a midpoint or a circle's edge, ...). */
export function handleOf(g: SketchGeometry, c: SketchConstraint, label?: Pt): Handle | null {
    if (!isDimension(c) || c.driven || c.suppressed) {
        return null;
    }
    switch (c.kind) {
        case 'length': {
            const ends = lineEnds(g, c.line);
            return ends ? linear(c.id, ends[0], ends[1], [ends[2][0]]) : null;
        }
        case 'distance': {
            if (c.aMid || c.bMid || c.aCond || c.bCond || c.doubled || c.ordinate) {
                return null;
            }
            const a = P(g, c.a);
            if (!a) {
                return null;
            }
            const b = P(g, c.b);
            if (b) {
                if (c.axis) {
                    const i = c.axis === 'u' ? 0 : 1;
                    const sign = Math.sign(b[i] - a[i]) || 1;
                    const dir: Pt = i === 0 ? [sign, 0] : [0, sign];
                    const zero: Pt = i === 0 ? [a[0], b[1]] : [b[0], a[1]];
                    return { id: c.id, kind: 'linear', at: b, zero, dir, factor: 1, hold: [c.a] };
                }
                return linear(c.id, a, b, [c.a]);
            }
            // A point to an axis or a line: the point moves square to it.
            if (c.b === AXIS_U || c.b === AXIS_V) {
                const foot: Pt = c.b === AXIS_U ? [a[0], 0] : [0, a[1]];
                return linear(c.id, foot, a, [], c.b === AXIS_U ? [0, 1] : [1, 0]);
            }
            const ends = lineEnds(g, c.b);
            if (!ends) {
                return null;
            }
            const along = unit(sub(ends[1], ends[0]));
            if (!along) {
                return null;
            }
            const foot: Pt = [ends[0][0] + along[0] * dot(sub(a, ends[0]), along), ends[0][1] + along[1] * dot(sub(a, ends[0]), along)];
            return linear(c.id, foot, a, ends[2], [-along[1], along[0]]);
        }
        case 'radius':
        case 'diameter': {
            const curve = curveOf(g, c.curve);
            const r = curveRadius(g, c.curve);
            const centre = curve && 'center' in curve ? P(g, curve.center) : null;
            if (!centre || r === null || !curve || (curve.kind !== 'circle' && curve.kind !== 'arc')) {
                return null;
            }
            const toward = unit(sub(label ?? dimensionAnchor(g, c), centre)) ?? [Math.SQRT1_2, Math.SQRT1_2];
            const at: Pt = [centre[0] + toward[0] * r, centre[1] + toward[1] * r];
            return { id: c.id, kind: 'linear', at, zero: centre, dir: toward, factor: c.kind === 'diameter' ? 2 : 1, hold: [curve.center] };
        }
        case 'angle': {
            const [la, lb] = [lineEnds(g, c.a), lineEnds(g, c.b)];
            if (!la || !lb) {
                return null;
            }
            const [da, db] = [unit(sub(la[1], la[0])), unit(sub(lb[1], lb[0]))];
            const cross = da && db ? da[0] * db[1] - da[1] * db[0] : 0;
            if (!da || !db || Math.abs(cross) < 1e-9) {
                return null;
            }
            // Where the lines cross.
            const t = (sub(lb[0], la[0])[0] * db[1] - sub(lb[0], la[0])[1] * db[0]) / cross;
            const vertex: Pt = [la[0][0] + da[0] * t, la[0][1] + da[1] * t];
            // Of the four directions pairs, those that make the angle as dimensioned; of them, the one facing the label.
            const toward = unit(sub(label ?? dimensionAnchor(g, c), vertex));
            let best: { a: Pt; b: Pt; score: number } | null = null;
            for (const sa of [1, -1]) {
                for (const sb of [1, -1]) {
                    const a: Pt = [da[0] * sa, da[1] * sa];
                    const b: Pt = [db[0] * sb, db[1] * sb];
                    const angle = (Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180) / Math.PI;
                    const mid = unit([a[0] + b[0], a[1] + b[1]]) ?? [-a[1], a[0]];
                    const score = Math.abs(angle - c.value) * 1000 - (toward ? dot(mid, toward) : 0);
                    if (!best || score < best.score) {
                        best = { a, b, score };
                    }
                }
            }
            const reach = Math.max(4, ...[la[0], la[1], lb[0], lb[1]].map((p) => dist(p, vertex))) * 0.6;
            const at: Pt = [vertex[0] + best!.b[0] * reach, vertex[1] + best!.b[1] * reach];
            return { id: c.id, kind: 'angular', at, zero: vertex, dir: best!.a, factor: 1, hold: la[2] };
        }
        default:
            return null;
    }
}

/** The ruler's marks for a drag at `perPx` mm per pixel: a minor step at least 8 px apart, and labelled every `major`. */
export function rulerStep(perPx: number, angular: boolean): { minor: number; major: number } {
    if (angular) {
        return { minor: 1, major: 15 };
    }
    const want = perPx * 8;
    const power = 10 ** Math.floor(Math.log10(want));
    const minor = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= want - 1e-12) ?? power * 10;
    return { minor, major: minor * (String(minor).includes('2') ? 5 : 10) };
}

/**
 * The value the pointer at `p` asks for. Within `snap` mm of the ruler the value steps along its minor marks; elsewhere
 * it follows the pointer exactly.
 */
export function valueAt(h: Handle, p: Pt, step: number, snap: number): number {
    const rel = sub(p, h.zero);
    if (h.kind === 'angular') {
        const angle = (Math.acos(Math.max(-1, Math.min(1, dot(unit(rel) ?? h.dir, h.dir)))) * 180) / Math.PI;
        const r = Math.hypot(rel[0], rel[1]);
        const onRuler = Math.abs(r - dist(h.at, h.zero)) <= snap;
        return onRuler ? Math.round(angle / step) * step : angle;
    }
    const along = Math.max(0, dot(rel, h.dir));
    const off = Math.abs(rel[0] * h.dir[1] - rel[1] * h.dir[0]);
    const value = along * h.factor;
    return off <= snap ? Math.max(0, Math.round(value / step) * step) : value;
}

/** The sketch with the dimension at `value`, solved with its fixed side held where possible; null when it cannot be. */
export function withValue(g: SketchGeometry, h: Handle, value: number): SketchGeometry | null {
    if (!(value > 1e-9) || !solverReady()) {
        return null;
    }
    const next = { ...g, constraints: g.constraints.map((c) => (c.id === h.id ? { ...c, value } as SketchConstraint : c)) };
    for (const hold of [new Set(h.hold.filter(Boolean)), undefined]) {
        const r = solveGeometry(next, hold ? { targets: [], hold } : undefined);
        const c = r.ok ? r.geometry.constraints.find((k) => k.id === h.id) : null;
        const now = c ? measure(r.geometry, c) : null;
        if (r.ok && now !== null && Math.abs(now - value) < 1e-6 * Math.max(1, value)) {
            return r.geometry;
        }
    }
    return null;
}

// ---- The drag ---------------------------------------------------------------------------------------------

interface Instant2dState {
    drag: { handle: Handle; from: SketchGeometry; value: number; step: number; snap: number; perPx: number; pointer: Pt } | null;
}

export const useInstant2d = create<Instant2dState>(() => ({ drag: null }));

/** The handle shown now: Instant2D on, the select tool, one driving dimension selected. */
export function shownHandle(s: ReturnType<typeof useSketcher.getState>): Handle | null {
    if (!sketchToggle('instant2d') || !s.active || s.stage !== 'draw' || s.tool !== 'select' || s.selection.length !== 1
        || s.selection[0].type !== 'constraint' || s.dimDraft) {
        return null;
    }
    const c = s.geometry.constraints.find((k) => k.id === s.selection[0].id);
    return c ? handleOf(s.geometry, c, s.labels[c.id]) : null;
}

/** A press at `p` (`perPx` mm per pixel): on the handle it starts dragging the value. */
export function instant2dDown(p: Pt, perPx: number): boolean {
    const s = useSketcher.getState();
    const h = shownHandle(s);
    if (!h || dist(p, h.at) > perPx * 10) {
        return false;
    }
    const c = s.geometry.constraints.find((k) => k.id === h.id) as Dimension;
    const { minor } = rulerStep(perPx, h.kind === 'angular');
    useInstant2d.setState({ drag: { handle: h, from: s.geometry, value: c.value, step: minor, snap: perPx * 10, perPx, pointer: p } });
    return true;
}

export function instant2dMove(p: Pt): void {
    const drag = useInstant2d.getState().drag;
    if (!drag) {
        return;
    }
    const value = valueAt(drag.handle, p, drag.step, drag.snap);
    const g = Math.abs(value - drag.value) > 1e-12 ? withValue(drag.from, drag.handle, value) : null;
    useInstant2d.setState({ drag: { ...drag, pointer: p, ...(g ? { value } : {}) } });
    if (g) {
        useSketcher.setState({ geometry: g, message: null });
    }
}

/** Released: the new value stays, as one undo step. */
export function instant2dUp(): void {
    const drag = useInstant2d.getState().drag;
    useInstant2d.setState({ drag: null });
    const s = useSketcher.getState();
    if (drag && s.geometry !== drag.from) {
        const r = solveGeometry(s.geometry);
        useSketcher.setState({ undo: [...s.undo.slice(-80), drag.from], redo: [], dof: r.ok ? r.dof : s.dof });
    }
}
