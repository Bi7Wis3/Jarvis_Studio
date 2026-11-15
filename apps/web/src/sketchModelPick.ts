// Clicks on the model while a sketch is open: which tool wants model faces and edges now, and what a pick does.
// Forms (Convert entities, Intersection curve, Pierce point) collect picks; the Offset tool takes a model face as its
// base (its loops are copied in as locked construction). Model edges seen on the sketch plane are picked in the plane
// itself (sketcher.ts, bringModelUnder), so mirror lines, pattern directions and offset bases work there too.

import { useSketcher, commitGeometry } from './sketcher';
import { curveAt, pickAt, type Pick } from './sketchGeometry';
import {
    addModelCurves, fetchModelSketch, loadedModel, modelTarget, otherSketchCurves, pickKey, snapGeometryOf, useSketchModel, type ModelPick,
} from './sketchModel';
import { useStudio } from './state';
import type { Pt } from './sketchMath';

export type PickKind = 'edge' | 'face';

/** Forms that collect model picks, and what each takes. */
const FORM_TAKES: Record<string, PickKind[]> = {
    convert: ['edge', 'face'],
    section: ['face'],
    pierce: ['edge'],
    silhouette: [],
};

type Wanted = { allow: PickKind[]; use: 'form' | 'offset' };

/** What model picks the open sketch wants now, or null. */
export function modelPickWanted(): Wanted | null {
    const s = useSketcher.getState();
    if (!s.active || s.stage !== 'draw' || !modelTarget(s)) {
        return null;
    }
    const picking = useSketchModel.getState().picking;
    if (picking) {
        return { allow: FORM_TAKES[picking] ?? ['edge', 'face'], use: 'form' };
    }
    return s.tool === 'offset' && !s.offsetCurve ? { allow: ['face'], use: 'offset' } : null;
}

/** The pick kinds the open sketch takes from part `partId` now (re-renders on change), or null. */
export function useModelPickKinds(partId: string): PickKind[] | null {
    useSketchModel((s) => s.picking);
    useSketcher((s) => `${s.tool} ${!!s.offsetCurve} ${s.stage} ${s.edit?.partId ?? s.partId}`);
    const s = useSketcher.getState();
    const wanted = modelPickWanted();
    return wanted && (s.edit?.partId ?? s.partId) === partId ? wanted.allow : null;
}

/** Whether sketch geometry lies under the pointer: then a click there is for the sketch, not the model. */
export function sketchUnder(p: Pt | null, tolerance: number): boolean {
    return !!p && !!pickAt(useSketcher.getState().geometry, p, tolerance);
}

const say = (message: string | null) => useSketcher.setState({ message });

/** A message for a kernel error about picks. */
function pickError(e: unknown): string {
    const text = e instanceof Error ? e.message : String(e);
    return /no longer exists/.test(text)
        ? 'That edge or face is made after this sketch in the history, so the sketch cannot use it.'
        : text;
}

/** A face or edge of the model was clicked while the open sketch wants one. */
export function modelEntityClick(pick: ModelPick): void {
    const wanted = modelPickWanted();
    if (!wanted || !wanted.allow.includes(pick.kind)) {
        return;
    }
    if (wanted.use === 'form') {
        useSketchModel.setState((m) => {
            const key = pickKey(pick);
            const picks = m.picks.some((p) => pickKey(p) === key) ? m.picks.filter((p) => pickKey(p) !== key) : [...m.picks, pick];
            return { picks, version: m.version + 1 };
        });
        return;
    }
    void offsetFromModel(pick);
}

/** Copies the picked edge or the loops of the picked face into the sketch as locked construction, for the offset. */
async function offsetFromModel(pick: ModelPick): Promise<void> {
    const target = modelTarget(useSketcher.getState());
    if (!target) {
        return;
    }
    try {
        const model = await fetchModelSketch(target, pick.kind === 'edge'
            ? { kind: 'convert', edges: [pick.at], faces: [] }
            : { kind: 'convert', edges: [], faces: [{ at: pick.at, normal: pick.normal }] });
        if (!model.curves.length) {
            say(model.skipped.length ? `It cannot be converted yet: ${model.skipped[0].why}.` : 'That is seen end-on from this plane: nothing to offset.');
            return;
        }
        const s = useSketcher.getState();
        if (s.tool !== 'offset') {
            return;
        }
        const r = addModelCurves(s.geometry, model.curves, { construction: true, lock: true });
        if (commitGeometry(r.g)) {
            useSketcher.setState({
                offsetCurve: r.ids[0], picks: r.ids.map((id): Pick => ({ type: 'curve', id })),
                message: 'The model edges are copied in as locked construction; click the side for the offset, or press OK.',
            });
        }
    } catch (e) {
        say(pickError(e));
    }
}

/**
 * A click on the sketch plane while a form collects picks: picks the curve of another sketch under it (Convert
 * entities, Pierce point). True when it took the click.
 */
export function modelPlaneClick(p: Pt, tolerance: number): boolean {
    const picking = useSketchModel.getState().picking;
    if (picking !== 'convert' && picking !== 'pierce') {
        return false;
    }
    const s = useSketcher.getState();
    const target = modelTarget(s);
    if (!target) {
        return false;
    }
    const hidden = (useStudio.getState().project?.view.hiddenSketches ?? []).filter((key) => key.startsWith(`${target.partId}/`));
    const curves = otherSketchCurves(s.context, target.frame, (id) => hidden.includes(`${target.partId}/${id}`));
    const made = addModelCurves({ points: [], curves: [], constraints: [] }, curves.map((c) => c.curve));
    const hit = curveAt(made.g, p, tolerance);
    const index = hit ? made.ids.indexOf(hit.id) : -1;
    if (index < 0) {
        return picking === 'convert' && pickModelCurve(target, p, tolerance);
    }
    const id = curves[index].id;
    useSketchModel.setState((m) => ({
        sketchPicks: m.sketchPicks.includes(id) ? m.sketchPicks.filter((x) => x !== id) : [...m.sketchPicks, id],
        version: m.version + 1,
    }));
    return true;
}

/** Convert entities: a model edge seen on the plane is picked there as its projected curve (toggles). */
function pickModelCurve(target: NonNullable<ReturnType<typeof modelTarget>>, p: Pt, tolerance: number): boolean {
    const model = loadedModel(target, useStudio.getState().meshes.keys[target.partId] ?? null);
    if (!model) {
        return false;
    }
    const g = snapGeometryOf(model);
    const hit = curveAt(g, p, tolerance, 0);
    const n = hit ? Number(/^model\/c(\d+)$/.exec(hit.id)?.[1]) : 0;
    const curve = n ? model.curves[n - 1] : null;
    if (!curve) {
        return false;
    }
    const key = JSON.stringify(curve);
    useSketchModel.setState((m) => ({
        curvePicks: m.curvePicks.some((c) => JSON.stringify(c) === key) ? m.curvePicks.filter((c) => JSON.stringify(c) !== key) : [...m.curvePicks, curve],
        version: m.version + 1,
    }));
    return true;
}

/**
 * A form that collects model picks opened (mode) or closed (null). A face or edge right-clicked just before (the
 * sketch's right-click menu) starts the list.
 */
export function setModelPicking(mode: string | null): void {
    useSketchModel.setState((m) => ({
        picking: mode, picks: mode && m.pendingPick && (FORM_TAKES[mode] ?? []).includes(m.pendingPick.kind) ? [m.pendingPick] : [],
        sketchPicks: [], curvePicks: [], preview: [], pendingPick: null, version: m.version + 1,
    }));
}
