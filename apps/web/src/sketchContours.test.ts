// Shaded sketch contours: which entity a shaded area belongs to, dragging it as a whole, and Alt + click bringing up
// its context toolbar (Extruded Boss/Base).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import { loadSolver, pointOf } from './solver';
import { addCircle, addLine, addRect, EMPTY_GEOMETRY } from './sketchGeometry';
import { sketchMove, sketchUp, undoSketch, useSketcher } from './sketcher';
import { connectedSets, contourAltClick, contourAt, contourDown, extrudeContour, shadedRegions, useContourBar } from './sketchContours';
import { setSketchToggle } from './sketchToggles';
import { dueWhileDragging } from './sketchContourRegions';
import { DEFAULT_SKETCH_SETTINGS } from './sketchSettings';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

const state = () => useSketcher.getState();

/** A 40 x 20 rectangle with a circle in it, and a loose line. */
function sketch() {
    const r = addRect(EMPTY_GEOMETRY, [0, 0], [40, 20]);
    const c = addCircle(r.g, { at: [10, 10] }, 4);
    const l = addLine(c.g, { at: [60, 0] }, { at: [70, 10] });
    return { g: l.g, rect: r.lines, circle: c.id, line: l.id };
}

function begin(g: SketchGeometry): void {
    useSketcher.setState({
        active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], tool: 'select', drag: null, dragFrom: null, finishing: null,
        message: null, settings: { ...DEFAULT_SKETCH_SETTINGS }, edit: null, intent: 'sketch', labels: {},
    });
}

describe('shaded sketch contours', () => {
    it('shades every closed area: the ring of the rectangle and the disc of the circle', () => {
        const { g } = sketch();
        expect(shadedRegions(g)).toHaveLength(2);
    });

    it('tells which entity a shaded area belongs to, the innermost one', () => {
        const { g, rect, circle } = sketch();
        expect(connectedSets(g)).toHaveLength(3);
        expect(contourAt(g, [10, 10])).toEqual([circle]);
        expect(contourAt(g, [30, 10])?.sort()).toEqual([...rect].sort());
        expect(contourAt(g, [50, 10])).toBeNull();
    });

    it('drags a shaded area as a whole with the select tool, as one undo step', () => {
        const { g, circle } = sketch();
        begin(g);
        setSketchToggle('shadedContours', true);
        // On an entity, or with Alt held, the press is not the contour's.
        expect(contourDown([14, 10], 0.5)).toBe(false);
        expect(contourDown([30, 10], 0.5, true)).toBe(false);
        expect(contourDown([11, 11], 0.5)).toBe(true);
        expect(state().selection).toEqual([{ type: 'curve', id: circle }]);
        sketchMove([13, 14], 0.5);
        sketchUp();
        const centre = g.curves.find((c) => c.id === circle) as { center: string };
        expect(pointOf(state().geometry, centre.center)).toMatchObject({ u: 12, v: 13 });
        expect(state().undo).toHaveLength(1);
        undoSketch();
        expect(state().geometry).toBe(g);
    });

    it('does nothing with the setting off', () => {
        const { g } = sketch();
        begin(g);
        setSketchToggle('shadedContours', false);
        expect(contourDown([10, 10], 0.5)).toBe(false);
        expect(contourAltClick([10, 10])).toBe(false);
        setSketchToggle('shadedContours', true);
    });

    it('brings up the context toolbar on Alt + click, and its extrude offers the feature for a plain sketch', () => {
        const { g } = sketch();
        begin(g);
        expect(contourAltClick([50, 10])).toBe(false);
        expect(contourAltClick([30, 10])).toBe(true);
        expect(useContourBar.getState().at).toEqual([30, 10]);
        extrudeContour([30, 10]);
        expect(useContourBar.getState().at).toBeNull();
        expect(state().intent).toBe('extrude');
    });

    it('works the shaded areas out on every move of a drag while that is quick, else now and then', () => {
        // 2 ms: every move. 40 ms: again only once four times as long has passed since.
        expect(dueWhileDragging(2, 1000, 1001)).toBe(true);
        expect(dueWhileDragging(40, 1000, 1100)).toBe(false);
        expect(dueWhileDragging(40, 1000, 1160)).toBe(true);
    });
});
