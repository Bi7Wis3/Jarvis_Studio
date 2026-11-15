// Toolbar entries and left-panel forms of the whole-sketch tools: the Shaded Sketch Contours and Instant2D toggles
// (SolidWorks: Sketch toolbar, Tools > Sketch Settings), Close Sketch to Model (Tools > Sketch Tools), and Derived
// Sketch with Underive (Insert > Derived Sketch; the FeatureManager's right-click menu).

import { useEffect, useMemo } from 'react';
import type { Feature, SketchGeometry } from '@jarvis/core';
import type { PopupApi, ToolDef } from './toolDefs';
import type { MenuEntry } from './menus';
import { showError } from './menus';
import { startDerivedSketch, underive, watchDerived } from './sketchDerived';
import { watchRapid } from './sketchRapid';
import { setSketchToggle, sketchToggle } from './sketchToggles';
import { commitGeometry, setTool, useSketcher } from './sketcher';
import { closeSketchWith, findClosing, planeFacesNow, planeFacesStatus, usePlaneFaces, type Closing } from './sketchModelContours';
import { curveEntity } from './sketchModel';
import { geometryEntities } from './sketchGeometry';
import type { NewEntity, Pt } from './sketchMath';

function toggleTool(id: string, label: string, icon: string, key: 'shadedContours' | 'instant2d' | 'rapidSketch', hint: string, on: string, off: string): ToolDef {
    return {
        id,
        label,
        icon,
        hint,
        instant: () => {
            const next = !sketchToggle(key);
            setSketchToggle(key, next);
            useSketcher.setState({ message: next ? on : off });
        },
        active: () => sketchToggle(key),
    };
}

/** In the sketch's View and snaps group. */
export const sketchToggleTools: ToolDef[] = [
    toggleTool('sk-shaded-contours', 'Shaded sketch contours', 'shaded-contours', 'shadedContours',
        'shade closed contours; drag one to move it, Alt-click one to extrude it',
        'Shaded sketch contours on: closed areas are shaded; drag one to move it, Alt-click one to extrude it.',
        'Shaded sketch contours off.'),
    toggleTool('sk-instant2d', 'Instant2D', 'instant2d', 'instant2d',
        'click a dimension, then drag its handle to change the value along a ruler',
        'Instant2D on: click a dimension, then drag its handle to change the value.',
        'Instant2D off.'),
];

watchRapid();

/** Rapid Sketch: in the part's Sketch group and the sketch's View group. */
export const rapidSketchTool: ToolDef = toggleTool('rapid-sketch', 'Rapid sketch', 'rapid-sketch', 'rapidSketch',
    'with a draw tool on, a click on another flat face of the part opens a sketch there and starts drawing',
    'Rapid sketch on: with a draw tool on, click another flat face of the part to sketch on it next.',
    'Rapid sketch off.');

// ---- Close sketch to model ------------------------------------------------------------------------------------

const middle = (e: NewEntity): Pt | null => (e.kind === 'line' ? [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2] : e.kind === 'arc' || e.kind === 'curve' ? e.m : null);

/** The closing piece shown in the view, with an arrow from the profile toward the side it closes. */
function showClosing(g: SketchGeometry, closing: Closing | null, reverse: boolean): void {
    if (!closing) {
        useSketcher.setState({ editPreview: [] });
        return;
    }
    const path = closing.paths[reverse ? 1 : 0].map(curveEntity);
    const chainMid = geometryEntities(g).filter((e) => closing.chain.includes(e.id)).map((e) => middle(e as NewEntity)).filter((p): p is Pt => !!p);
    const from = chainMid[Math.floor(chainMid.length / 2)];
    const to = middle(path[Math.floor(path.length / 2)]);
    const arrow: NewEntity[] = [];
    if (from && to) {
        const d: Pt = [to[0] - from[0], to[1] - from[1]];
        const l = Math.hypot(d[0], d[1]);
        if (l > 1e-9) {
            const [ux, uy] = [d[0] / l, d[1] / l];
            const tip: Pt = [from[0] + ux * l * 0.35, from[1] + uy * l * 0.35];
            const s = Math.min(l * 0.08, 4);
            arrow.push(
                { kind: 'line', a: from, b: tip },
                { kind: 'line', a: tip, b: [tip[0] - ux * s - uy * s * 0.6, tip[1] - uy * s + ux * s * 0.6] },
                { kind: 'line', a: tip, b: [tip[0] - ux * s + uy * s * 0.6, tip[1] - uy * s - ux * s * 0.6] },
            );
        }
    }
    useSketcher.setState({ editPreview: [...path, ...arrow] });
}

/** What the form knows: the faces in the sketch plane (loaded on opening) and how the open profile would close. */
function useClosing(): { closing: Closing | null; note: string } {
    const g = useSketcher((s) => s.geometry);
    const known = usePlaneFaces((f) => f.known);
    const model = useMemo(() => planeFacesNow(), [known]);
    const found = useMemo(() => (model ? findClosing(g, model) : null), [g, model]);
    if (!model) {
        const s = useSketcher.getState();
        const status = planeFacesStatus();
        const newPart = !s.partId && !s.edit;
        return {
            closing: null,
            note: newPart ? 'This sketch starts a new part: there is no model to close it with.'
                : status.error ?? 'Reading the faces of the model in the sketch plane…',
        };
    }
    return found && 'error' in found ? { closing: null, note: found.error } : { closing: found, note: '' };
}

function CloseToModelForm({ api }: { api: PopupApi }) {
    const { closing, note } = useClosing();
    const reverse = !!api.values.reverse;
    const g = useSketcher((s) => s.geometry);
    useEffect(() => {
        setTool('select');
        return () => useSketcher.setState({ editPreview: [] });
    }, []);
    useEffect(() => {
        showClosing(g, closing, reverse);
    }, [closing, reverse]);
    return (
        <p className={`tb-note ${closing ? '' : 'pm-pick-note'}`}>
            {closing
                ? `The open profile (${closing.chain.length} entit${closing.chain.length === 1 ? 'y' : 'ies'}) closes along the face's edges where the arrow points; the dashed curves are the edges it takes.`
                : note}
        </p>
    );
}

const closeToModelTool: ToolDef = {
    id: 'sk-close-to-model',
    label: 'Close sketch to model',
    icon: 'close-to-model',
    hint: 'close an open profile whose ends lie on the edges of a face with those edges',
    panel: true,
    width: 300,
    fields: () => [{ key: 'reverse', label: 'Reverse direction to close the sketch', kind: 'check', section: 'Direction' }],
    defaults: () => ({ reverse: false }),
    top: (api) => <CloseToModelForm api={api} />,
    applyLabel: 'Close it',
    apply: async (v) => {
        const model = planeFacesNow();
        const s = useSketcher.getState();
        const closing = model ? findClosing(s.geometry, model) : { error: 'The faces of the model are not read yet; try again in a moment.' };
        if ('error' in closing) {
            return { text: closing.error, isError: true };
        }
        useSketcher.setState({ editPreview: [] });
        if (!commitGeometry(closeSketchWith(s.geometry, closing, !!v.reverse))) {
            return { text: useSketcher.getState().message ?? 'The closed sketch does not solve.', isError: true };
        }
        useSketcher.setState({ message: 'Closed with the edges of the model: leave the sketch with Extrude or Cut to use it.' });
        return { text: '', isError: false };
    },
};

/** In the sketch's Modify group. */
export const wholeModifyTools: ToolDef[] = [closeToModelTool];

// ---- Derived sketch -------------------------------------------------------------------------------------------

watchDerived();

/** Insert Derived Sketch (part workspace): the sketch to follow is chosen here, then the plane or face in the view. */
export const derivedSketchTool: ToolDef = {
    id: 'derived-sketch',
    label: 'Derived sketch',
    icon: 'derived-sketch',
    hint: 'a copy of a sketch that follows it, on another plane or face',
    needsPart: true,
    panel: true,
    width: 300,
    fields: (ctx) => [{
        key: 'sketch', label: 'Sketch to derive from', kind: 'select',
        options: (ctx.part?.features ?? []).filter((f) => f.op === 'sketch').map((f) => ({ value: f.id, label: f.name ?? f.id })),
    }],
    defaults: (ctx) => {
        const steps = (ctx.part?.features ?? []).filter((f) => f.op === 'sketch');
        const picked = useSketcher.getState().picked?.id;
        return { sketch: steps.some((f) => f.id === picked) ? picked! : steps[steps.length - 1]?.id ?? '' };
    },
    top: () => <p className="tb-note">After OK, click the plane or flat face to put it on, then drag or type it into place with Modify sketch.</p>,
    applyLabel: 'OK',
    apply: async (v, ctx) => {
        const error = ctx.part && v.sketch ? startDerivedSketch(ctx.part.id, String(v.sketch)) : 'Pick the sketch to derive from.';
        return { text: error ?? '', isError: !!error };
    },
};

/** The tree's right-click entries for a sketch step: derive a sketch from it, and Underive a derived one. */
export function derivedEntries(partId: string, feature: Feature): MenuEntry[] {
    if (feature.op !== 'sketch') {
        return [];
    }
    return [
        { label: 'Derived sketch', title: 'A copy of this sketch that follows it, on another plane or face', onSelect: () => {
            const error = startDerivedSketch(partId, feature.id);
            if (error) {
                showError(error);
            }
        } },
        ...(feature.sketch.derived ? [{
            label: 'Underive', title: 'Keep the entities as they are now and stop following the parent sketch',
            onSelect: () => void underive(partId, feature.id).then((r) => r.isError && showError(r.text)),
        }] : []),
    ];
}
