// Model edges and vertices in an open sketch, as SolidWorks has them: a click selects one (lit up) so a relation or a
// dimension can use it, and the sketch changes only when one is made with it (the reference then stays, drawn
// quietly) or when it is converted. Right-click (or the Modify toolbar): Convert entities (locked where the model
// is) or Copy as sketch entities (plain entities, free to edit), for the selected edges and vertices, or the face or
// edge of the part under the pointer (a face gives its loops).

import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import type { ModelCurve, P2 } from '@jarvis/core/projection';
import { commitGeometry, useSketcher } from './sketcher';
import { constraintRefs, newId, type Pick } from './sketchGeometry';
import {
    addModelCurves, fetchModelSketch, isModelReference, MODEL_LOCK, modelCurveOf, modelTarget, sketchLockSource, useSketchModel,
    withoutLooseReferences, type ModelPick,
} from './sketchModel';
import { curvePointIds } from './sketchCurves';
import type { MenuEntry } from './menus';

type State = ReturnType<typeof useSketcher.getState>;

export type ConvertMode = 'convert' | 'copy';

// ---- References that nothing uses go again ----------------------------------------------------------------

/** What the open sketch is holding on to besides its relations: the selection, the picks, a dimension being placed. */
function held(s: State): Set<string> {
    const ids = new Set<string>([...s.selection.map((x) => x.id), ...s.picks.map((x) => x.id), ...(s.dimDrag?.picks ?? []).map((x) => x.id), ...s.highlight]);
    if (s.dimDraft) {
        constraintRefs({ ...s.dimDraft.constraint, id: 'draft' } as SketchConstraint).forEach((id) => ids.add(id));
    }
    if (s.offsetCurve) {
        ids.add(s.offsetCurve);
    }
    return ids;
}

/** Takes the model references that are no longer selected or picked, and that nothing uses, out of the sketch. */
export function dropLooseReferences(): void {
    const s = useSketcher.getState();
    if (!s.active || s.drag || s.trimStroke) {
        return;
    }
    const g = withoutLooseReferences(s.geometry, held(s));
    if (g !== s.geometry) {
        // Not an undo step: picking a model edge was not one either.
        useSketcher.setState({ geometry: g });
    }
}

let queued = false;

// After whatever changed the selection, the picks or the sketch has finished (a click brings an edge in, then picks it).
useSketcher.subscribe((s, before) => {
    if (queued || (s.geometry === before.geometry && s.selection === before.selection && s.picks === before.picks
        && s.dimDraft === before.dimDraft && s.dimDrag === before.dimDrag && s.active === before.active)) {
        return;
    }
    queued = true;
    queueMicrotask(() => {
        queued = false;
        dropLooseReferences();
    });
});

// ---- Convert entities, Copy as sketch entities ------------------------------------------------------------

/** The selected model edges and vertices. */
export function selectedReferences(s: State = useSketcher.getState()): Pick[] {
    return s.selection.filter((x): x is Pick => x.type !== 'constraint' && isModelReference(x.id));
}

/**
 * Adds the curves and points: locked where they are (convert; curves of another sketch say so in their locks) or
 * free (copy); they become the selection.
 */
function addToSketch(curves: ModelCurve[], points: P2[], mode: ConvertMode, construction: boolean, from: (string | undefined)[] = []): string | null {
    const s = useSketcher.getState();
    const lock = mode === 'convert';
    // One call per source, so the ends the curves share are shared in the sketch too.
    const sources = lock ? [...new Set(curves.map((_, i) => from[i]))] : [undefined];
    let g: SketchGeometry = s.geometry;
    const made: string[] = [];
    for (const source of sources) {
        const these = curves.filter((_, i) => !lock || from[i] === source);
        const r = addModelCurves(g, these, { lock, construction, ...(source ? { lockFrom: source } : {}) });
        g = r.g;
        made.push(...r.ids);
    }
    const ends = new Set(made.flatMap((id) => {
        const c = g.curves.find((x) => x.id === id);
        return c ? curvePointIds(c) : [];
    }));
    const pointIds: string[] = [];
    for (const p of points) {
        // A vertex at the end of a curve brought in with it is that end.
        if (g.points.some((q) => ends.has(q.id) && Math.abs(q.u - p[0]) < 1e-9 && Math.abs(q.v - p[1]) < 1e-9)) {
            continue;
        }
        const id = newId('p', g);
        g = { ...g, points: [...g.points, { id, u: p[0], v: p[1] }] };
        if (lock) {
            let n = 1;
            while (g.constraints.some((c) => c.id === `${MODEL_LOCK}${n}`)) {
                n++;
            }
            g = { ...g, constraints: [...g.constraints, { id: `${MODEL_LOCK}${n}`, kind: 'fix', point: id }] };
        }
        pointIds.push(id);
    }
    if (!commitGeometry(g)) {
        return useSketcher.getState().message ?? 'They could not be added to the sketch.';
    }
    useSketcher.setState({
        selection: [...made.map((id) => ({ type: 'curve' as const, id })), ...pointIds.map((id) => ({ type: 'point' as const, id }))],
        message: null,
    });
    return null;
}

/**
 * Convert entities or Copy as sketch entities for the selected model edges and vertices, each as the entity it is
 * (a line, circle, arc, ellipse... as the kernel found it). Null when done, else what is wrong.
 */
export function convertSelected(mode: ConvertMode, construction = false): string | null {
    const s = useSketcher.getState();
    const refs = selectedReferences(s);
    if (!refs.length) {
        return 'Select model edges or vertices first, or pick them in the form.';
    }
    const g = s.geometry;
    const curves: ModelCurve[] = [];
    const from: (string | undefined)[] = [];
    const points: P2[] = [];
    // An entity of another sketch keeps saying where it came from.
    const sourceOf = (ids: string[]): string | undefined => g.constraints.map((k) => (k.kind === 'fix' && ids.includes(k.point) ? sketchLockSource(k) : null)).find((x) => !!x) ?? undefined;
    for (const ref of refs) {
        if (ref.type === 'curve') {
            const c = g.curves.find((x) => x.id === ref.id);
            const m = c ? modelCurveOf(g, c) : null;
            if (c && m) {
                curves.push(m);
                from.push(sourceOf(curvePointIds(c)));
            }
        } else {
            const p = g.points.find((x) => x.id === ref.id);
            if (p) {
                points.push([p.u, p.v]);
            }
        }
    }
    return addToSketch(curves, points, mode, construction, from);
}

/** The same for faces and edges of the part picked on the model: the kernel projects them (a face gives its loops). */
export async function convertModelPicks(picks: ModelPick[], mode: ConvertMode, construction = false): Promise<string | null> {
    const target = modelTarget(useSketcher.getState());
    if (!target) {
        return 'This sketch starts a new part: there is no model to take geometry from yet.';
    }
    try {
        const model = await fetchModelSketch(target, {
            kind: 'convert',
            edges: picks.filter((p) => p.kind === 'edge').map((p) => p.at),
            faces: picks.filter((p) => p.kind === 'face').map((p) => ({ at: p.at, ...(p.normal ? { normal: p.normal } : {}) })),
        });
        if (!model.curves.length) {
            return model.skipped.length ? `It cannot be converted yet: ${model.skipped[0].why}.` : 'That is seen end-on from this plane: nothing to convert.';
        }
        return addToSketch(model.curves, [], mode, construction);
    } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        return /no longer exists/.test(text) ? 'That edge or face is made after this sketch in the history, so the sketch cannot use it.' : text;
    }
}

/** The Modify toolbar buttons with model edges selected: they act at once, as SolidWorks does with a preselection. */
export function convertNow(mode: ConvertMode): void {
    if (selectedReferences().length) {
        useSketcher.setState({ message: convertSelected(mode) });
    }
}

// ---- The right-click menu ----------------------------------------------------------------------------------

export interface ModelMenu {
    header: string;
    entries: MenuEntry[];
    /** Only model edges and vertices are selected: the entries that edit sketch entities do not apply. */
    only: boolean;
}

const say = (text: string | null) => useSketcher.setState({ message: text });

/**
 * The open sketch's right-click menu entries for the model: for the selected model edges and vertices, else for the
 * face or edge of the part under the pointer (`pending`). Null when there is neither.
 */
export function modelMenu(selection: Pick[], pending: ModelPick | null): ModelMenu | null {
    const refs = selection.filter((p) => isModelReference(p.id));
    const entries = (run: (mode: ConvertMode) => void): MenuEntry[] => [
        { label: 'Convert entities', icon: 'convert', title: 'Bring it into the sketch where the model is, locked there', onSelect: () => run('convert') },
        { label: 'Copy as sketch entities', icon: 'copy-model', title: 'Bring it in as plain sketch entities, free to edit', onSelect: () => run('copy') },
    ];
    if (refs.length) {
        const header = refs.length === 1 ? (refs[0].type === 'point' ? 'Model vertex' : 'Model edge') : `${refs.length} model items`;
        return { header, entries: entries((mode) => say(convertSelected(mode))), only: refs.length === selection.length };
    }
    if (!pending) {
        return null;
    }
    return {
        header: pending.kind === 'face' ? 'Model face' : 'Model edge',
        entries: entries((mode) => void convertModelPicks([pending], mode).then(say)),
        only: true,
    };
}

/** A right-click press in the view: what the part's own handler leaves for this press only. */
export function forgetPendingPick(): void {
    useSketchModel.setState({ pendingPick: null });
}
