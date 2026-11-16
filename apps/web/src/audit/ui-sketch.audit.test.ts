// Defects found by trying the sketcher for real in the running app (scripts/ui-audit), shown at module level.
// Each `it.fails` passes while the defect is there; fixing it makes the test fail, and it then becomes a plain `it`.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSolver, solveGeometry } from '../solver';
import { enterKey, sketchDown, sketchMove, sketchUp, startEditTool, useSketcher } from '../sketcher';
import { ALL_TOOLS, ASSEMBLY_GROUPS, discardSketch, PART_GROUPS } from '../toolDefs';
import { confirmDiscard, isSketchForm, keepSketch, sketchPlaneText, sketchStatusText, useDiscardAsk } from '../sketchBar';
import { lastSketchCommand } from '../sketchRepeat';
import { begin, clicks, press } from './harness';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

beforeEach(() => begin());
afterEach(() => vi.unstubAllGlobals());

describe('leaving a sketch', () => {
    // CLAUDE.md: no popups; everything is asked in the app's own panels. Seen in the app: Discard after drawing a
    // circle opens the browser's native "Discard this sketch?" dialog (scripts/ui-audit/r2-view.mjs, step 10).
    it('Discard on a sketch with curves asks inside the app, not with a native browser dialog', () => {
        const confirm = vi.fn(() => false);
        vi.stubGlobal('window', { confirm });
        press('sk-line', 'line');
        clicks([10, 10], [30, 12]);
        discardSketch();
        expect(confirm).not.toHaveBeenCalled();
    });

    it('the sketch bar asks: Keep sketching stays in the sketch, Discard leaves it and then goes on', () => {
        press('sk-line', 'line');
        clicks([10, 10], [30, 12]);
        const then = vi.fn();
        discardSketch(then);
        expect(useDiscardAsk.getState().asking).not.toBeNull();
        expect(useSketcher.getState().active).toBe(true);
        keepSketch();
        expect(useDiscardAsk.getState().asking).toBeNull();
        expect(useSketcher.getState().active).toBe(true);
        expect(then).not.toHaveBeenCalled();
        discardSketch(then);
        confirmDiscard();
        expect(useSketcher.getState().active).toBe(false);
        expect(then).toHaveBeenCalledOnce();
        expect(useDiscardAsk.getState().asking).toBeNull();
    });

    // Seen in the app (r2-view.mjs, step 9): a dimension selected (its form open), then Exit sketch: the left panel in
    // part mode still shows the Dimension form. The toolbar closes every sketch form when the sketch ends.
    it('every form only the sketcher has counts as a sketch form, and no tool of the part or assembly does', () => {
        const model = new Set([...PART_GROUPS, ...ASSEMBLY_GROUPS].flatMap((g) => g.tools.map((t) => t.id)));
        expect(ALL_TOOLS.filter((t) => model.has(t.id) && isSketchForm(t)).map((t) => t.id)).toEqual([]);
        // Import opens from the File menu, not a toolbar.
        const sketchOnly = ALL_TOOLS.filter((t) => !model.has(t.id) && t.id !== 'no-edit' && t.id !== 'import');
        expect(sketchOnly.filter((t) => !isSketchForm(t)).map((t) => t.id)).toEqual([]);
        expect(sketchOnly.map((t) => t.id)).toEqual(expect.arrayContaining(['sk-pm-dimension', 'sk-finish', 'sk-relations']));
    });

    it('an empty sketch is left without a question', () => {
        discardSketch();
        expect(useDiscardAsk.getState().asking).toBeNull();
        expect(useSketcher.getState().active).toBe(false);
    });
});

describe('sketch chamfer on an ellipse', () => {
    // Seen in the app (r10-retest.mjs, ellipse chamfer): an ellipse (centre (0, 0), axes 16 and 8) crossed by a line at
    // u = 8; Chamfer, distance 2, a click on the ellipse and one on the line: the sketch turns Over defined and
    // SketchXpert opens by itself. The fillet in the same place solves.
    it('a chamfer between an ellipse and a crossing line leaves a sketch that solves', () => {
        press('sk-ellipse', 'ellipse');
        clicks([0, 0], [16, 0], [0, 8]);
        press('sk-line', 'line');
        clicks([8, -15], [8, 15]);
        useSketcher.setState({ draft: [] });
        const form = press('sk-chamfer');
        startEditTool('chamfer');
        form.change('chamferDistance', '2');
        clicks([-12.69365, 4.87009], [8, -6]);
        const g = useSketcher.getState().geometry;
        expect(g.curves.filter((c) => c.kind === 'line' && !c.construction).length).toBe(2);
        const r = solveGeometry(g);
        expect(r.conflicting).toEqual([]);
        expect(r.redundant).toEqual([]);
        expect(useSketcher.getState().conflicting.length + useSketcher.getState().redundant.length).toBe(0);
    });
});

describe('Enter in an idle sketch', () => {
    // Seen in the app (r8-dims.mjs path length, r4-relations.mjs horizontal dimension): a value typed when nothing took
    // it, then Enter, saved and left the sketch. The help's keyboard shortcuts (c_time_saving_keyboard_shortcuts):
    // "Enter: Repeats the last command." enterKey() answering 'exit' is what makes the toolbar run Exit sketch.
    it('Enter with nothing in progress does not leave the sketch', () => {
        press('sk-line', 'line');
        clicks([10, 10], [30, 12]);
        useSketcher.setState({ draft: [], tool: 'select' });
        expect(enterKey()).not.toBe('exit');
    });

    it('Enter with nothing in progress repeats the last command (the toolbar opens it again)', () => {
        press('sk-circle', 'circle');
        clicks([0, 0], [5, 0]);
        useSketcher.setState({ draft: [], tool: 'select' });
        expect(enterKey()).toBe('repeat');
        expect(lastSketchCommand()).toBe('sk-circle');
        expect(useSketcher.getState().active).toBe(true);
    });
});

describe('sketch status', () => {
    // Seen in the app (r2-view.mjs, step 1): a rectangle and a free line show "Under defined · 8 DOF"; after dragging a
    // corner with the Select tool the bar says "Under defined · 2 DOF" with the same relations. The drag solves with
    // the other points held and that held solve's DOF is kept after the release.
    it('after dragging a rectangle corner the bar shows the sketch DOF, not the DOF of the solve that held the rest', () => {
        press('sk-rect', 'rect');
        clicks([-20, -10], [10, 12]);
        press('sk-line', 'line');
        clicks([16, -10], [26, 8]);
        useSketcher.setState({ tool: 'select', draft: [] });
        const before = useSketcher.getState().dof;
        expect(before).toBe(8);
        expect(sketchDown([10, 12], 0.05)).toBe(true);
        sketchMove([12, 14], 0.05);
        sketchMove([14, 16], 0.05);
        sketchUp();
        expect(solveGeometry(useSketcher.getState().geometry).dof).toBe(8);
        expect(useSketcher.getState().dof).toBe(8);
    });

    it('a sketch of points only has degrees of freedom, and the bar says so instead of "empty"', () => {
        press('sk-point', 'point');
        clicks([5, 5], [-5, 8]);
        const s = useSketcher.getState();
        expect(s.geometry.curves.length).toBe(0);
        expect(s.dof).toBeGreaterThan(0);
        expect(sketchStatusText(s.geometry, s.dof, false)).toBe(`Under defined · ${s.dof} DOF`);
        begin();
        expect(sketchStatusText(useSketcher.getState().geometry, 0, false)).toBe('empty');
    });

    it('the plane label keeps the unit as written: TOP +5 mm', () => {
        expect(sketchPlaneText('top', 5)).toBe('TOP +5 mm');
        expect(sketchPlaneText('front', -2.5)).toBe('FRONT -2.5 mm');
        expect(sketchPlaneText('right', 0)).toBe('RIGHT');
    });
});
