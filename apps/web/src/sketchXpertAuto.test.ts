// SketchXpert opening by itself: after a change that over defines the sketch, or a solve that cannot be met; not for
// a sketch opened over defined, a refused change, or with the option off.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SketchGeometry } from '@jarvis/core';
import { loadSolver } from './solver';
import { EMPTY_GEOMETRY, addConstraint, addRect } from './sketchGeometry';
import { commitGeometry, setSketchSettings, solveSketch, useSketcher } from './sketcher';
import { DEFAULT_SKETCH_SETTINGS } from './sketchSettings';
import { xpertShouldOpen } from './sketchXpertAuto';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

beforeAll(async () => {
    await loadSolver();
});

type State = ReturnType<typeof useSketcher.getState>;

function begin(g: SketchGeometry): void {
    useSketcher.setState({
        active: true, stage: 'draw', geometry: g, undo: [], redo: [], selection: [], picks: [], message: null, conflicting: [], redundant: [],
        settings: { ...DEFAULT_SKETCH_SETTINGS }, edit: null,
    });
}

/** The transitions `run` causes, and whether any of them opens SketchXpert. */
function opens(run: () => void, auto = true): boolean {
    const seen: [State, State][] = [];
    const stop = useSketcher.subscribe((s, prev) => seen.push([prev, s]));
    run();
    stop();
    return seen.some(([prev, s]) => xpertShouldOpen(prev, s, auto));
}

describe('SketchXpert opens by itself', () => {
    const r = addRect(EMPTY_GEOMETRY, [0, 0], [40, 10]);
    const sized = addConstraint(r.g, { kind: 'length', line: r.lines[0], value: 40 }).g;
    // The opposite side's length repeats what the rectangle and the first length hold.
    const repeat = addConstraint(sized, { kind: 'length', line: r.lines[2], value: 40 }).g;

    it('when a change leaves relations repeating others', () => {
        begin(sized);
        expect(opens(() => commitGeometry(repeat))).toBe(true);
        expect(useSketcher.getState().redundant.length).toBeGreaterThan(0);
    });

    it('not with the option off, and not for a change that over defines nothing', () => {
        begin(sized);
        expect(opens(() => commitGeometry(repeat), false)).toBe(false);
        begin(r.g);
        expect(opens(() => commitGeometry(sized))).toBe(false);
    });

    it('not for a change that was refused (the sketch stays as it was)', () => {
        begin(sized);
        const conflict = addConstraint(sized, { kind: 'length', line: r.lines[2], value: 30 }).g;
        expect(opens(() => commitGeometry(conflict))).toBe(false);
        expect(useSketcher.getState().geometry).toBe(sized);
    });

    it('when Solve cannot meet the relations kept with Automatic solve off', () => {
        begin(sized);
        setSketchSettings({ autoSolve: false });
        commitGeometry(addConstraint(sized, { kind: 'length', line: r.lines[2], value: 30 }).g);
        expect(opens(() => solveSketch())).toBe(true);
        setSketchSettings({ autoSolve: true });
    });

    it('not when a sketch is opened that is over defined already', () => {
        begin(sized);
        const prev = useSketcher.getState();
        // Loading puts the geometry in place without an undo step.
        useSketcher.setState({ geometry: repeat, redundant: ['k-any'] });
        expect(xpertShouldOpen(prev, useSketcher.getState(), true)).toBe(false);
    });
});
