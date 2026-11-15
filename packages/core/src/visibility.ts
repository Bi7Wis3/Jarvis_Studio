// What the view shows of a part's history: sketch, reference and thread steps hidden one by one, and the sketches a
// later step is built from, which are hidden as SolidWorks hides an absorbed sketch once its feature is made (its eye
// shows it again). Bodies hidden or see-through one by one. Shared by the server, which keeps the lists and builds
// hidden threads plainly for the view, and the browser, which draws what is shown.

import type { Feature, Part, SketchSource, ViewState } from './index';

/** "partId/featureId": how a step is named in the view lists. */
export const stepKey = (partId: string, featureId: string): string => `${partId}/${featureId}`;

function sourceRef(source: SketchSource | undefined): string[] {
    return source?.sketchRef ? [source.sketchRef] : [];
}

/** The sketch steps a feature is built from (its profile, sections or path), as the feature tree nests them. */
export function consumedSketches(feature: Feature): string[] {
    switch (feature.op) {
        case 'extrude':
        case 'revolve':
            return sourceRef(feature);
        case 'loft':
            return feature.sections.flatMap(sourceRef);
        case 'sweep':
            return [...sourceRef(feature.profile), ...('helix' in feature.path ? [] : sourceRef(feature.path))];
        default:
            return [];
    }
}

/** Sketch steps that a later step of the part is built from. */
export function absorbedSketches(features: readonly Feature[]): Set<string> {
    const sketches = new Set<string>();
    const absorbed = new Set<string>();
    for (const f of features) {
        for (const id of consumedSketches(f)) {
            if (sketches.has(id)) {
                absorbed.add(id);
            }
        }
        if (f.op === 'sketch') {
            sketches.add(f.id);
        }
    }
    return absorbed;
}

type StepLists = Pick<ViewState, 'hiddenSketches' | 'shownSketches'>;

let memo: { hidden: unknown; shown: unknown; parts: unknown; keys: Set<string> } | null = null;

/**
 * Keys ("partId/featureId") of the steps the view leaves out: those hidden one by one, and absorbed sketches that
 * were not shown one by one. Instances have no steps of their own (their source's keys apply).
 */
export function hiddenSteps(view: StepLists | undefined, parts: readonly Part[]): Set<string> {
    // A project without view settings (made by a tool, or older) hides nothing one by one.
    const hiddenList = view?.hiddenSketches;
    const shownList = view?.shownSketches;
    if (memo && memo.hidden === hiddenList && memo.shown === shownList && memo.parts === parts) {
        return memo.keys;
    }
    const keys = new Set(hiddenList ?? []);
    const shown = new Set(shownList ?? []);
    for (const part of parts) {
        for (const id of absorbedSketches(part.features ?? [])) {
            const key = stepKey(part.id, id);
            if (!shown.has(key)) {
                keys.add(key);
            }
        }
    }
    memo = { hidden: hiddenList, shown: shownList, parts, keys };
    return keys;
}

/** The view lists after the eye of one step is clicked: an absorbed sketch is shown by name, any step hidden by name. */
export function setStepHidden(view: StepLists, part: Part, featureId: string, hidden: boolean): Required<StepLists> {
    const key = stepKey(part.id, featureId);
    const hiddenKeys = new Set(view.hiddenSketches ?? []);
    const shown = new Set(view.shownSketches ?? []);
    if (hidden) {
        hiddenKeys.add(key);
        shown.delete(key);
    } else {
        hiddenKeys.delete(key);
        if (absorbedSketches(part.features ?? []).has(featureId)) {
            shown.add(key);
        }
    }
    return { hiddenSketches: [...hiddenKeys], shownSketches: [...shown] };
}

/**
 * The shown-sketch list after `steps` of a part were added or changed: the sketches they are built from are hidden
 * again (SolidWorks hides a sketch when the feature made from it is confirmed).
 */
export function hideConsumed(shownSketches: readonly string[], partId: string, steps: readonly Feature[]): string[] {
    const used = new Set(steps.flatMap(consumedSketches).map((id) => stepKey(partId, id)));
    return shownSketches.filter((key) => !used.has(key));
}

/**
 * The part as the view builds it: thread steps hidden in the view are marked cosmetic, so the kernel leaves the hole
 * or shaft plain and only marks where the thread runs. Exports and mass properties build the part as it is.
 * `designId` is the part whose steps these are (an instance's source).
 */
export function viewPart<P extends Pick<Part, 'features'>>(part: P, designId: string, view: Pick<ViewState, 'hiddenSketches'> | undefined): P {
    const hidden = view?.hiddenSketches;
    if (!hidden?.length || !part.features?.some((f) => f.op === 'thread' && hidden.includes(stepKey(designId, f.id)))) {
        return part;
    }
    return {
        ...part,
        features: part.features.map((f) => (f.op === 'thread' && hidden.includes(stepKey(designId, f.id)) ? { ...f, cosmetic: true } : f)),
    };
}

/** A body of a part as the kernel reports it, see BodyRecord in the server's cad/bodies.ts. */
export interface BodyInfo {
    /** Stays with the body while later steps change it (the step that made it, `#n` when it made several). */
    key: string;
    /** The step that changed the body last, which names it; '' for the part's base shape. */
    by: string;
    /** 1, 2, ... when that step changed several bodies: SolidWorks then names them Feature[1], Feature[2]. */
    n?: number;
}

/** "partId/bodyKey": how a body is named in the view lists. */
export const bodyKey = (partId: string, key: string): string => `${partId}/${key}`;

/** The body lists after a body's eye or transparency is toggled (true / false sets, undefined leaves it). */
export function setBodyView(view: Pick<ViewState, 'hiddenBodies' | 'seeThroughBodies'>, partId: string, key: string,
    change: { hidden?: boolean; seeThrough?: boolean }): Required<Pick<ViewState, 'hiddenBodies' | 'seeThroughBodies'>> {
    const id = bodyKey(partId, key);
    const toggle = (list: string[] | undefined, on: boolean | undefined): string[] => {
        const set = new Set(list ?? []);
        if (on === true) {
            set.add(id);
        } else if (on === false) {
            set.delete(id);
        }
        return [...set];
    };
    return { hiddenBodies: toggle(view.hiddenBodies, change.hidden), seeThroughBodies: toggle(view.seeThroughBodies, change.seeThrough) };
}
