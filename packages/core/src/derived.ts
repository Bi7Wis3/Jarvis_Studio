// Derived Sketch (SolidWorks: a sketch that follows another sketch of the part, placed on another plane or face):
// its entities, profiles and regions are the parent's, on its own plane. Shared by the CAD kernel, which builds from
// it, and the sketcher, which shows it.

import type { Feature, Sketch } from './index';

/** The derived sketch as it is now: the parent's contents on the child's plane. */
export function derivedSketch(child: Sketch, parent: Sketch | undefined): Sketch {
    const from = child.derived?.from;
    if (!from) {
        return child;
    }
    if (!parent) {
        throw new Error(`the sketch it is derived from ("${from}") is not an earlier sketch step of this part`);
    }
    const { plane: _plane, offset: _offset, view: _view, derived: _derived, ...contents } = parent;
    return { ...contents, plane: child.plane, ...(child.offset ? { offset: child.offset } : {}), derived: child.derived };
}

/** A sketch step's sketch with its derivation resolved against the steps before it (derived of derived too). */
export function resolvedSketch(features: readonly Feature[], index: number): Sketch | null {
    const f = features[index];
    if (!f || f.op !== 'sketch') {
        return null;
    }
    const from = f.sketch.derived?.from;
    if (!from) {
        return f.sketch;
    }
    const at = features.findIndex((x, i) => i < index && x.id === from);
    const parent = at >= 0 ? resolvedSketch(features, at) : null;
    try {
        return derivedSketch(f.sketch, parent ?? undefined);
    } catch {
        // The parent is gone: the copy kept in the step stands in.
        return f.sketch;
    }
}
