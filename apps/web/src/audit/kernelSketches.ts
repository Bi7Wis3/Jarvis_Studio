// The sketches the kernel audit (apps/server/src/cad/audit.kernel.test.ts) extrudes: one per tool group, drawn with
// the toolbar's tools. Kept on the web side so the server's typecheck does not follow the web modules; the server test
// loads this file at run time.

import { expect } from 'vitest';
import type { Sketch } from '@jarvis/core';
import type { ModelCurve } from '@jarvis/core/projection';
import { loadSolver } from '../solver';
import { applyDimension, commitGeometry, currentSketch, setDimText, sketchMove, startEditTool, toggleLineArc, useSketcher } from '../sketcher';
import { addModelCurves } from '../sketchModel';
import { addRect, EMPTY_GEOMETRY } from '../sketchGeometry';
import { buildText } from '../sketchTextItems';
import { buildEquation } from '../sketchEquation';
import { makeBlock, placeInsert } from '../sketchBlocks';
import { begin, click, clicks, FONT, geo, press, solvesCleanly } from './harness';

export const ready = (): Promise<void> => loadSolver();

/** Draw: line, tangent arc and lines round a plate with a circle and an ellipse hole. Area 800 + 50π − 9π − 8π. */
export function drawSketch(): Sketch {
    begin();
    press('sk-line', 'line');
    clicks([0, 0], [40, 0]);
    // A switches the next piece of the chain to a tangent arc.
    sketchMove([41, 1], 0.05);
    expect(toggleLineArc()).toBe(true);
    clicks([40, 20], [0, 20], [0, 0]);
    press('sk-circle', 'circle');
    clicks([20, 10], [23, 10]);
    press('sk-ellipse');
    clicks([8, 10], [12, 10], [8, 12]);
    solvesCleanly();
    return currentSketch();
}

/**
 * Modify: a tilted 13 x 13 square filleted (R2) and chamfered (1.5), with a hole of radius 1.5 patterned twice along
 * its side. Area 169 − 4(1 − π/4) − 1.125 − 4.5π.
 */
export async function modifySketch(): Promise<Sketch> {
    begin();
    press('sk-rect3', 'rect3');
    clicks([2, 1], [14, 6], [9, 18]);
    let form = press('sk-fillet');
    startEditTool('fillet');
    form.change('filletRadius', '2');
    click([14, 6]);
    form = press('sk-chamfer');
    startEditTool('chamfer');
    form.change('chamferDistance', '1.5');
    click([-3, 13]);
    press('sk-circle', 'circle');
    clicks([6, 8], [7.5, 8]);
    const hole = geo().curves.find((c) => c.kind === 'circle')!.id;
    useSketcher.setState({ selection: [{ type: 'curve', id: hole }] });
    const pattern = press('sk-pattern-linear');
    pattern.values = { ...pattern.values, count: '2', spacing: '4', angle: String((Math.atan2(5, 12) * 180) / Math.PI) };
    expect((await pattern.apply()).isError).toBe(false);
    solvesCleanly();
    return currentSketch();
}

/** Dimensions: a rectangle on the origin dimensioned to 40.0001 x 20.0002, fully defined. */
export function dimensionSketch(): Sketch {
    begin();
    press('sk-rect', 'rect');
    clicks([0, 0], [37, 18]);
    press('sk-dimension');
    clicks([20, 0]);
    click([20, -5]);
    setDimText('40.0001');
    applyDimension();
    // The right side, where the first dimension left it.
    clicks([40.0001, 9]);
    click([45, 9]);
    setDimText('20.0002');
    applyDimension();
    expect(solvesCleanly()).toBe(0);
    return currentSketch();
}

/** Model: curves the kernel gave, converted (locked) into a new sketch. */
export function modelSketch(curves: ModelCurve[]): Sketch {
    begin();
    const r = addModelCurves(EMPTY_GEOMETRY, curves, { lock: true, construction: false });
    expect(commitGeometry(r.g)).toBe(true);
    expect(solvesCleanly()).toBe(0);
    return currentSketch();
}

/** Items: text "O" 10 high (8 x 10 less 4 x 6), a 5 x 5 block instance, a parametric circle of radius 4. */
export function itemsSketch(): Sketch {
    const t = buildText(EMPTY_GEOMETRY, { id: 't1', text: 'O', font: 'Test Sans', height: 10, at: [0, 0], curves: [], points: [] }, { regular: FONT });
    if (typeof t === 'string') {
        throw new Error(t);
    }
    const e = buildEquation(t.g, { id: 'e1', type: 'parametric', x: '4*cos(t) + 50', y: '4*sin(t)', from: '0', to: '2*pi', tolerance: 0.0001, curves: [], points: [] });
    if (typeof e === 'string') {
        throw new Error(e);
    }
    const square = addRect(e.g, [30, 0], [35, 5]);
    const b = makeBlock(square.g, square.lines, [30, 0], 'Square');
    if (typeof b === 'string') {
        throw new Error(b);
    }
    begin(b.g);
    solvesCleanly();
    return currentSketch();
}

/**
 * Blocks: a block holding text "O" 10 high and a 5 x 5 block (nested), placed at scale 1.5 and turned 30 degrees, then
 * moved as one rigid body by a relation (its insertion point coincident with a fixed point). Area 2.25 x (56 + 25).
 */
export function blocksSketch(): Sketch {
    const t = buildText(EMPTY_GEOMETRY, { id: 't1', text: 'O', font: 'Test Sans', height: 10, at: [0, 0], curves: [], points: [] }, { regular: FONT });
    if (typeof t === 'string') {
        throw new Error(t);
    }
    const square = addRect(t.g, [30, 0], [35, 5]);
    const inner = makeBlock(square.g, square.lines, [30, 0], 'Square');
    if (typeof inner === 'string') {
        throw new Error(inner);
    }
    const panel = makeBlock(inner.g, [inner.insert.curves[0], t.item.curves[0]], [0, 0], 'Panel');
    if (typeof panel === 'string') {
        throw new Error(panel);
    }
    const turned = placeInsert(panel.g, panel.insert.id, { at: [0, 0], angle: 30, scale: 1.5 });
    if (typeof turned === 'string') {
        throw new Error(turned);
    }
    const origin = turned.inserts![0].origin!;
    begin(turned);
    commitGeometry({
        ...geo(),
        points: [...geo().points, { id: 'q', u: 100.0001, v: -20 }],
        constraints: [...geo().constraints, { id: 'kq', kind: 'fix', point: 'q' }, { id: 'kc', kind: 'coincident', a: origin, b: 'q' }],
    });
    const at = geo().inserts![0].at;
    expect(Math.hypot(at[0] - 100.0001, at[1] + 20)).toBeLessThan(1e-9);
    return currentSketch();
}
