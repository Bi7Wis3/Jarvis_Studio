// Rapid Sketch: with a draw tool waiting, a click through the sketch plane onto another face of the part opens the
// next sketch on that face (after saving a sketch with something in it), the click placing the tool's first point.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@jarvis/core';
import { loadSolver } from './solver';
import { addLine, EMPTY_GEOMETRY } from './sketchGeometry';
import { closeSketch, setTool, startSketch, choosePlane, useSketcher } from './sketcher';
import { useStudio } from './state';
import { rapidClick, watchRapid } from './sketchRapid';
import { setSketchToggle } from './sketchToggles';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
    watchRapid();
});

const tick = () => new Promise((r) => setTimeout(r, 5));
const state = () => useSketcher.getState();
/** The side face x = 40 of a box, seen through the top plane. */
const side = { normal: [1, 0, 0] as [number, number, number], point: [40, 5, -10] as [number, number, number], distance: 120 };

function sketching(): void {
    useStudio.setState({ history: { parts: [{ id: 'p1', name: 'Part', features: [] }] } as unknown as Project });
    startSketch('p1', 'sketch');
    choosePlane('top', 10);
    setTool('line');
}

beforeEach(() => {
    closeSketch();
    setSketchToggle('rapidSketch', true);
});

describe('rapid sketch', () => {
    it('opens the next sketch on the face clicked, the tool going on from the click', async () => {
        sketching();
        setTool('circle');
        expect(rapidClick(side, 100, 0.5)).toBe(true);
        await tick();
        expect(state().stage).toBe('draw');
        expect(state().plane).toBe('right');
        expect(state().offset).toBe(40);
        expect(state().tool).toBe('circle');
        expect(state().draft).toHaveLength(1);
    });

    it('leaves clicks on the sketch plane itself, with nothing waiting, or with Rapid sketch off to the sketch', () => {
        sketching();
        expect(rapidClick({ ...side, distance: 100 }, 100, 0.5)).toBe(false);
        expect(rapidClick(null, 100, 0.5)).toBe(false);
        setTool('select');
        expect(rapidClick(side, 100, 0.5)).toBe(false);
        setTool('line');
        setSketchToggle('rapidSketch', false);
        expect(rapidClick(side, 100, 0.5)).toBe(false);
    });

    it('saves a sketch with something in it first, then moves on', async () => {
        sketching();
        useSketcher.setState({ geometry: addLine(EMPTY_GEOMETRY, { at: [0, 0] }, { at: [10, 0] }).g });
        expect(rapidClick(side, 100, 0.5)).toBe(true);
        // Saving closes the sketch; the next one opens on the face.
        expect(state().plane).toBe('top');
        closeSketch();
        await tick();
        expect(state().active).toBe(true);
        expect(state().plane).toBe('right');
    });

    it('does not move on from a sketch started for a feature', () => {
        sketching();
        useSketcher.setState({ intent: 'extrude' });
        expect(rapidClick(side, 100, 0.5)).toBe(true);
        expect(state().message).toMatch(/plain sketch only/);
        expect(state().plane).toBe('top');
    });
});
