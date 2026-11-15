// System Options > Sketch > Use fully defined sketches: with it on, a feature is made only from sketches that are
// fully defined. Checked on the tool calls that add or change features (state.ts runTool), so every tool that builds
// from a sketch is covered. Kept free of the sketcher's state (it reads the stored setting) so state.ts can use it.

import type { Feature, Project, Sketch } from '@jarvis/core';
import { solveGeometry, solverReady } from './solver';
import { loadSketchSettings } from './sketchSettings';

type Loose = Record<string, unknown>;

const isSketch = (v: unknown): v is Sketch => !!v && typeof v === 'object' && 'plane' in v && 'profiles' in v;

/** The sketches a feature (or base shape) builds from: embedded ones, and sketch steps by id. */
function sketchesOf(o: unknown, refs: string[], sketches: Sketch[], top = true): void {
    if (!o || typeof o !== 'object') {
        return;
    }
    if (Array.isArray(o)) {
        o.forEach((x) => sketchesOf(x, refs, sketches, false));
        return;
    }
    const r = o as Loose;
    // A sketch step itself builds nothing.
    if (top && r.op === 'sketch') {
        return;
    }
    if (typeof r.sketchRef === 'string') {
        refs.push(r.sketchRef);
    }
    for (const [key, value] of Object.entries(r)) {
        if (key === 'sketch' && isSketch(value)) {
            sketches.push(value);
        } else if (value && typeof value === 'object') {
            sketchesOf(value, refs, sketches, false);
        }
    }
}

/** Whether a sketch is fully defined; null when that cannot be told (no editable geometry, or the solver not loaded). */
export function sketchFullyDefined(sketch: Sketch): boolean | null {
    if (!sketch.geometry || !solverReady()) {
        return null;
    }
    const r = solveGeometry(sketch.geometry);
    return r.ok && r.dof === 0;
}

/** Why a tool call is refused under Use fully defined sketches, or null to let it run. */
export function undefinedSketchRefusal(name: string, args: Loose, history: Project | null): string | null {
    const names = ['features_add', 'features_update', 'parts_add', 'parts_update'];
    if (!loadSketchSettings().useFullyDefined || !names.includes(name)) {
        return null;
    }
    const list = (v: unknown): Loose[] => (Array.isArray(v) ? v as Loose[] : []);
    if (name === 'parts_add' && Array.isArray(args.parts)) {
        // New parts: each one's own features and base shape.
        return list(args.parts).map((p) => undefinedSketchRefusal('parts_add', { features: p.features, shape: p.shape }, null)).find(Boolean) ?? null;
    }
    const part = history?.parts.find((p) => p.id === args.partId);
    const known: Feature[] = [...(part?.features ?? []), ...(list(args.features) as unknown as Feature[])];
    const updates = (Array.isArray(args.updates) ? args.updates : []) as Loose[];
    // Sketch steps changed by the same call build with their new sketch.
    const changed = new Map(updates.flatMap((u) => (isSketch(u.sketch) ? [[String(u.id), u.sketch] as const] : [])));
    const refs: string[] = [];
    const sketches: Sketch[] = [];
    if (name === 'parts_update') {
        // A base body built from a sketch.
        updates.forEach((u) => sketchesOf(u.shape ?? null, refs, sketches, false));
    } else if (name === 'features_update') {
        // A changed sketch step counts when a feature builds from it; a changed feature, by what it builds from.
        for (const u of updates) {
            const was = known.find((f) => f.id === u.id);
            const used = was?.op === 'sketch' && known.some((f) => f.op !== 'sketch' && JSON.stringify(f).includes(`"sketchRef":"${String(u.id)}"`));
            if (was?.op === 'sketch' && used && isSketch(u.sketch)) {
                sketches.push(u.sketch);
            } else if (was && was.op !== 'sketch') {
                sketchesOf({ ...was, ...u }, refs, sketches);
            }
        }
    } else {
        for (const f of (Array.isArray(args.features) ? args.features : []) as Loose[]) {
            if (f.op === 'sketch') {
                // The step is not a feature, but the features of the same call may build from it (by its id).
                continue;
            }
            sketchesOf(f, refs, sketches);
        }
        sketchesOf((args.shape as Loose | undefined) ?? null, refs, sketches, false);
    }
    for (const id of refs) {
        const step = known.find((f) => f.id === id);
        const sketch = changed.get(id) ?? (step?.op === 'sketch' ? step.sketch : null);
        if (sketch) {
            sketches.push(sketch);
        }
    }
    const open = sketches.filter((s) => sketchFullyDefined(s) === false);
    return open.length
        ? 'Use fully defined sketches is on (Sketch settings): fully define the sketch first (Fully define, or add the missing dimensions and relations).'
        : null;
}
