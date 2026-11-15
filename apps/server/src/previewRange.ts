// Which steps of a part a tool preview highlights: the ones the form adds or changes, so the view shows that feature's
// own material over the model as it is, rather than the whole part again (see cad/change.ts).

import type { Feature, Part } from '@jarvis/core';
import type { ChangeRange } from './cad/change.js';

/** A step as it decides the body: its name does not (as in the build's step cache). */
const stepText = ({ name: _name, ...step }: Feature): string => JSON.stringify(step);

/**
 * What a preview of `next` (as built: an instance as its source's design) highlights, compared with `old`:
 * - `whole`: the part as a whole (a new part, another base shape, a part moved or repeated);
 * - `none`: nothing, its steps build the same body (a step renamed);
 * - a range of steps (indices into `next`'s steps, both included): from the first step that differs to the last, the
 *   later steps that are the same as before left out; and the later steps that use a changed step (an extrude of an
 *   edited sketch, a pattern of an edited cut), which then lists the steps to show in `steps`.
 */
export function changeRange(old: Part | undefined, next: Part): ChangeRange | 'whole' | 'none' {
    if (!old || JSON.stringify(old.shape) !== JSON.stringify(next.shape)) {
        return 'whole';
    }
    const was = (old.features ?? []).map(stepText);
    const now = (next.features ?? []).map(stepText);
    let from = 0;
    while (from < now.length && from < was.length && now[from] === was[from]) {
        from++;
    }
    if (from === now.length) {
        // No step added or changed (steps may have been taken away, which shows nothing being made).
        return from === was.length && moved(old, next) ? 'whole' : 'none';
    }
    let to = now.length - 1;
    for (let k = was.length - 1; to > from && k >= from && now[to] === was[k]; k--) {
        to--;
    }
    // Later steps that name a changed step (by id) change with it, and so on down the history.
    const features = next.features ?? [];
    const changed = new Set(features.slice(from, to + 1).map((f) => f.id));
    const steps = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    for (let i = to + 1; i < features.length; i++) {
        if ([...changed].some((id) => now[i].includes(JSON.stringify(id)))) {
            changed.add(features[i].id);
            steps.push(i);
        }
    }
    const last = steps[steps.length - 1];
    return last === to ? { from, to } : { from, to: last, steps };
}

/** Placed elsewhere or repeated otherwise: the same body, shown where it would go. */
function moved(old: Part, next: Part): boolean {
    const place = (p: Part) => JSON.stringify([p.position, p.rotation, p.repeat ?? null]);
    return place(old) !== place(next);
}
