// Picking one piece of a curve between its crossings (Alt + click), and Delete, Construction geometry and the
// relations acting on just that piece; Trim from the right-click menu and the Modify toolbar.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SketchCurve, SketchGeometry } from '@jarvis/core';
import { loadSolver, pointOf } from './solver';
import { addCircle, addLine, EMPTY_GEOMETRY, geometryEntities } from './sketchGeometry';
import { constraintTool, deleteSelected, toggleConstructionSelected, undoSketch, useSketcher } from './sketcher';
import { clearPieces, onPickedPiece, pieceClick, pieceHover, pieceUnder, usePieces } from './sketchPieces';
import { sketchSpaceMenu, type SketchMenuActions } from './contextMenus';
import { SKETCH_GROUPS } from './toolDefs';
import { DEFAULT_SKETCH_SETTINGS } from './sketchSettings';
import type { MenuEntry } from './menus';
import { entityPoints, type Pt } from './sketchMath';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const state = () => useSketcher.getState();

/** A line from (0, 0) to (30, k) crossed by two lines across it at u = 10 and u = 20 (no shared points). */
function crossed(k = 0): { g: SketchGeometry; line: string } {
    const l = addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [30, k] });
    let g = addLine(l.g, { at: [10, -5] }, { at: [10, 5] }).g;
    g = addLine(g, { at: [20, -5] }, { at: [20, 5] }).g;
    return { g, line: l.id };
}

function begin(g: SketchGeometry): void {
    clearPieces();
    useSketcher.setState({
        active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], picks: [], tool: 'select', drag: null, dragFrom: null,
        finishing: null, message: null, settings: { ...DEFAULT_SKETCH_SETTINGS }, edit: null, intent: 'sketch', labels: {},
    });
}

const at = (g: SketchGeometry, id: string): Pt => {
    const p = pointOf(g, id)!;
    return [p.u, p.v];
};
/** The lines along v = 0 (the crossed line and its pieces), as [u from, u to], sorted. */
const along = (g: SketchGeometry): [number, number][] => g.curves.flatMap((c) => {
    if (c.kind !== 'line') {
        return [];
    }
    const [a, b] = [at(g, c.a), at(g, c.b)];
    return Math.abs(a[1]) < 1e-6 && Math.abs(b[1]) < 1e-6 ? [[Math.min(a[0], b[0]), Math.max(a[0], b[0])] as [number, number]] : [];
}).sort((p, q) => p[0] - q[0]);
const lineOf = (g: SketchGeometry, from: number, to: number): SketchCurve | undefined => g.curves.find((c) => {
    if (c.kind !== 'line') {
        return false;
    }
    const [a, b] = [at(g, c.a), at(g, c.b)];
    return Math.abs(Math.min(a[0], b[0]) - from) < 1e-6 && Math.abs(Math.max(a[0], b[0]) - to) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 * 30;
});

beforeEach(() => clearPieces());

describe('picking one piece of a crossed curve', () => {
    it('finds the piece between the crossings nearest the pointer, and the whole curve when nothing crosses it', () => {
        const { g, line } = crossed();
        const middle = pieceUnder(g, [15, 0.1], 0.5)!;
        expect(middle.id).toBe(line);
        expect(middle.piece!.entity).toMatchObject({ kind: 'line', a: [10, 0], b: [20, 0] });
        expect(pieceUnder(g, [4, -0.1], 0.5)!.piece!.entity).toMatchObject({ kind: 'line', a: [0, 0], b: [10, 0] });
        const lone = addLine(g, { at: [0, 20] }, { at: [10, 20] });
        const whole = pieceUnder(lone.g, [5, 20], 0.5)!;
        expect(whole.piece).toBeNull();
        expect(whole.whole).toMatchObject({ kind: 'line', a: [0, 20], b: [10, 20] });
        expect(pieceUnder(g, [50, 50], 0.5)).toBeNull();
    });

    it('lights the piece only while Alt is held, and Alt + click selects it; Shift adds and removes; a plain click lets go', () => {
        const { g } = crossed();
        begin(g);
        pieceHover([15, 0.1], 0.5, false);
        expect(usePieces.getState().hover).toBeNull();
        pieceHover([15, 0.1], 0.5, true);
        expect(usePieces.getState().hover).toMatchObject({ kind: 'line', a: [10, 0], b: [20, 0] });
        pieceHover([15, 0.1], 0.5, false);
        expect(usePieces.getState().hover).toBeNull();
        useSketcher.setState({ selection: [{ type: 'curve', id: g.curves[1].id }] });
        expect(pieceClick([15, 0.1], 0.5, true, false)).toBe(true);
        // The piece replaces the selection; nothing in the sketch changed.
        expect(state().selection).toEqual([]);
        expect(state().geometry).toBe(g);
        expect(usePieces.getState().picked).toHaveLength(1);
        expect(onPickedPiece([12, 0], 0.5)).toBe(true);
        expect(onPickedPiece([25, 0], 0.5)).toBe(false);
        expect(pieceClick([25, 0], 0.5, true, true)).toBe(true);
        expect(usePieces.getState().picked).toHaveLength(2);
        expect(pieceClick([26, 0], 0.5, true, true)).toBe(true);
        expect(usePieces.getState().picked).toHaveLength(1);
        // A plain click goes on to the sketcher and lets the pieces go; Escape (an empty selection) does too.
        expect(pieceClick([40, 40], 0.5, false, false)).toBe(false);
        expect(usePieces.getState().picked).toHaveLength(0);
        pieceClick([15, 0], 0.5, true, false);
        useSketcher.setState({ selection: [] });
        expect(usePieces.getState().picked).toHaveLength(0);
    });

    it('selects the whole curve with Alt + click when nothing crosses it', () => {
        const { g } = crossed();
        const lone = addLine(g, { at: [0, 20] }, { at: [10, 20] });
        begin(lone.g);
        expect(pieceClick([5, 20], 0.5, true, false)).toBe(true);
        expect(state().selection).toEqual([{ type: 'curve', id: lone.id }]);
        expect(usePieces.getState().picked).toHaveLength(0);
    });

    it('deletes just the piece, as Trim to closest does, in one undo step', () => {
        const { g } = crossed();
        begin(g);
        pieceClick([15, 0], 0.5, true, false);
        deleteSelected();
        expect(along(state().geometry)).toEqual([[0, 10], [20, 30]]);
        expect(state().undo).toHaveLength(1);
        expect(usePieces.getState().picked).toHaveLength(0);
        undoSketch();
        expect(state().geometry).toBe(g);
    });

    it('deletes two pieces of one curve and a selected curve together', () => {
        const { g } = crossed();
        const extra = addLine(g, { at: [0, 20] }, { at: [10, 20] });
        begin(extra.g);
        pieceClick([5, 0], 0.5, true, false);
        pieceClick([25, 0], 0.5, true, true);
        useSketcher.setState({ selection: [{ type: 'curve', id: extra.id }] });
        expect(usePieces.getState().picked).toHaveLength(2);
        deleteSelected();
        expect(along(state().geometry)).toEqual([[10, 20]]);
        expect(state().geometry.curves.some((c) => c.id === extra.id)).toBe(false);
        expect(state().undo).toHaveLength(1);
        undoSketch();
        expect(state().geometry).toBe(extra.g);
    });

    it('makes just the piece construction geometry: the curve is split there, the rest stays as it was', () => {
        const { g, line } = crossed();
        begin(g);
        pieceClick([15, 0], 0.5, true, false);
        toggleConstructionSelected();
        const out = state().geometry;
        expect(along(out)).toEqual([[0, 10], [10, 20], [20, 30]]);
        expect(lineOf(out, 10, 20)?.construction).toBe(true);
        expect(lineOf(out, 0, 10)?.construction).toBeFalsy();
        expect(lineOf(out, 20, 30)?.construction).toBeFalsy();
        // The crossed line keeps its id on its first part; the split piece is selected.
        expect(lineOf(out, 0, 10)?.id).toBe(line);
        expect(state().undo).toHaveLength(1);
        undoSketch();
        expect(state().geometry).toBe(g);
    });

    it('turns a piece of a construction line back into normal geometry, the rest staying construction', () => {
        const { g, line } = crossed();
        const flagged = { ...g, curves: g.curves.map((c) => (c.id === line ? { ...c, construction: true } : c)) };
        begin(flagged);
        pieceClick([15, 0], 0.5, true, false);
        toggleConstructionSelected();
        const out = state().geometry;
        expect(lineOf(out, 10, 20)?.construction).toBeFalsy();
        expect(lineOf(out, 0, 10)?.construction).toBe(true);
        expect(lineOf(out, 20, 30)?.construction).toBe(true);
    });

    it('applies a relation to the piece alone, after splitting it out (one undo step); its ends stay on the crossing lines', () => {
        const { g } = crossed(3);
        begin(g);
        pieceClick([15, 1.5], 0.5, true, false);
        constraintTool('horizontal');
        const out = state().geometry;
        const horizontal = out.constraints.find((k) => k.kind === 'horizontal');
        expect(horizontal).toBeTruthy();
        const piece = out.curves.find((c) => horizontal!.kind === 'horizontal' && c.id === horizontal!.line)!;
        expect(piece.kind).toBe('line');
        if (piece.kind === 'line') {
            const ends = [at(out, piece.a), at(out, piece.b)].sort((p, q) => p[0] - q[0]);
            expect(ends[0][1]).toBeCloseTo(ends[1][1], 9);
            // Each end on one of the crossing lines (the solve may move them all a little).
            const across = [g.curves[1].id, g.curves[2].id].map((id) => out.curves.find((c) => c.id === id)!) as Extract<SketchCurve, { kind: 'line' }>[];
            ends.forEach((p, i) => {
                const [q, r] = [at(out, across[i].a), at(out, across[i].b)];
                const off = Math.abs((r[0] - q[0]) * (p[1] - q[1]) - (r[1] - q[1]) * (p[0] - q[0])) / Math.hypot(r[0] - q[0], r[1] - q[1]);
                expect(off).toBeLessThan(1e-6);
            });
            expect(ends[1][0] - ends[0][0]).toBeGreaterThan(9);
        }
        expect(state().undo).toHaveLength(1);
        undoSketch();
        expect(state().geometry).toBe(g);
    });

    it('keeps the split when a relation tool waits for more picks, and puts the sketch back when nothing applies', () => {
        const { g } = crossed();
        begin(g);
        pieceClick([15, 0], 0.5, true, false);
        // Tangent needs a second entity: the tool waits with the piece picked.
        constraintTool('tangent');
        expect(state().tool).toBe('c:tangent');
        expect(state().picks).toHaveLength(1);
        expect(along(state().geometry)).toHaveLength(3);
        expect(state().undo).toHaveLength(1);
        undoSketch();
        expect(state().geometry).toBe(g);
    });

    it('takes pieces of circles and splines too', () => {
        const c = addCircle(EMPTY_GEOMETRY, { at: [0, 0] }, 5);
        const g = addLine(c.g, { at: [-8, 0] }, { at: [8, 0] }).g;
        begin(g);
        const top = pieceUnder(g, [0, 5], 0.5)!;
        expect(top.piece!.entity.kind).toBe('arc');
        pieceClick([0, 5], 0.5, true, false);
        deleteSelected();
        const left = state().geometry.curves.find((k) => k.id === c.id)!;
        expect(left.kind).toBe('arc');
        const spline: SketchGeometry = {
            points: [{ id: 'a', u: 0, v: -5 }, { id: 'b', u: 3, v: 0 }, { id: 'd', u: 0, v: 5 }, { id: 'e', u: -6, v: 0 }, { id: 'f', u: 6, v: 0 }],
            curves: [{ id: 's', kind: 'spline', points: ['a', 'b', 'd'] }, { id: 'l', kind: 'line', a: 'e', b: 'f' }],
            constraints: [],
        };
        begin(spline);
        // A point on the spline between the line and its end.
        const onSpline = entityPoints(geometryEntities(spline).find((e) => e.id === 's')!).find((p) => p[1] > 2.5)!;
        expect(pieceUnder(spline, onSpline, 0.5)!.piece).not.toBeNull();
        pieceClick(onSpline, 0.5, true, false);
        toggleConstructionSelected();
        const parts = state().geometry.curves.filter((k) => k.kind === 'spline');
        expect(parts).toHaveLength(2);
        expect(parts.filter((k) => k.construction)).toHaveLength(1);
    });
});

type Item = Extract<MenuEntry, { onSelect: () => void }>;
const labels = (items: MenuEntry[]): string[] => items.map((i) => (i === 'separator' ? '—' : 'header' in i ? `[${i.header}]` : i.label));

describe('menus and toolbar', () => {
    const recorder = () => {
        const calls: [string, unknown[]][] = [];
        const actions = new Proxy({}, { get: (_, name) => (...args: unknown[]) => calls.push([String(name), args]) }) as SketchMenuActions;
        return { actions, calls };
    };

    it('offers Delete, Construction geometry and the fitting relations for a picked piece on right-click', () => {
        const { g } = crossed();
        begin(g);
        pieceClick([15, 0], 0.5, true, false);
        const { actions, calls } = recorder();
        const items = sketchSpaceMenu({ stage: 'draw', tool: 'select', geometry: g, draft: 0, selection: [], lastUsed: {} }, actions);
        expect(items[0]).toEqual({ header: 'Piece of a line' });
        expect(labels(items)).toEqual(expect.arrayContaining(['Delete', 'Construction geometry', 'Horizontal', 'Lock', 'Trim']));
        // The menu works out what fits without changing the sketch.
        expect(state().geometry).toBe(g);
        (items.find((i) => typeof i === 'object' && 'label' in i && i.label === 'Delete') as Item).onSelect();
        expect(calls).toEqual([['deleteSelected', []]]);
    });

    it('offers Trim in each of its modes on a curve, opening the Trim form in that mode', () => {
        const { g, line } = crossed();
        begin(g);
        const { actions, calls } = recorder();
        const items = sketchSpaceMenu({ stage: 'draw', tool: 'select', geometry: g, draft: 0, selection: [{ type: 'curve', id: line }], lastUsed: {} }, actions);
        const trim = items.find((i): i is Extract<MenuEntry, { items: MenuEntry[] }> => typeof i === 'object' && 'items' in i && i.label === 'Trim')!;
        expect(labels(trim.items)).toEqual(['Power trim', 'Corner', 'Trim away inside', 'Trim away outside', 'Trim to closest']);
        (trim.items[4] as Item).onSelect();
        expect(state().editOptions.trimMode).toBe('closest');
        expect(calls).toEqual([['openTool', ['sk-trim']]]);
    });

    it('has Trim with all five modes in the Modify group of the sketch toolbar', () => {
        const modify = SKETCH_GROUPS.find((g) => g.id === 'modify')!;
        const trim = modify.tools.find((t) => t.id === 'sk-trim')!;
        // The form's fields do not depend on the context.
        const mode = (trim.fields?.({} as never) ?? []).find((f) => f.key === 'trimMode')!;
        expect(mode.options?.map((o) => o.value)).toEqual(['power', 'corner', 'inside', 'outside', 'closest']);
    });
});
