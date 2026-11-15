// The 2D to 3D toolbar's entries (SolidWorks: 2D to 3D toolbar, Tools > Sketch Tools > 2D to 3D): Create Sketch
// from Selections, Add to Front / Top / Right / Left / Bottom / Back Sketch and Auxiliary Sketch take the selected
// entities of the sketch being edited into a sketch step of their own (the views folded into place); Align Sketch
// moves this sketch so an entity of it meets one of another sketch; Convert to Extrusion and Convert to Cut extrude or
// cut the selected entities (a copy of them, as the feature's own sketch) without the rest of the sketch.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Feature, Sketch, SketchGeometry, SketchView, Vec3 } from '@jarvis/core';
import type { PopupApi, Result, ToolDef } from './toolDefs';
import { commitGeometry, setViewPicker, useSketcher } from './sketcher';
import { runTool, useStudio } from './state';
import { curveOf, pointOf } from './solver';
import { pickAt } from './sketchGeometry';
import { otherSketches } from './sketchOthers';
import { planeFrame, type NewEntity, type Pt } from './sketchMath';
import { moveSketchFrame } from './sketchMoreTools';
import { PickBoxes } from './sketchMoreForms';
import { setModelPicking } from './sketchModelPick';
import { useSketchModel } from './sketchModel';
import { nextFeatureName } from './featureNames';
import {
    VIEW_NAMES, alignMotion, alignRef, auxiliaryPlane, boundsOf, extractCurves, frontBounds, sketchOfGeometry, sketchStepId, viewDepth,
    viewName, viewPlane,
} from './sketch2d3d';
import { valueText } from './numberText';

const ok = (text = ''): Result => ({ text, isError: false });
const fail = (text: string): Result => ({ text, isError: true });

/** The part of the open sketch and its history (the sketch being edited left out). */
function partNow(): { partId: string | null; features: Feature[] } {
    const s = useSketcher.getState();
    const partId = s.edit?.partId ?? s.partId;
    const part = partId ? useStudio.getState().history?.parts.find((p) => p.id === partId) : undefined;
    return { partId, features: (part?.features ?? []).filter((f) => f.id !== s.edit?.featureId) };
}

const selectedCurves = (): string[] => {
    const s = useSketcher.getState();
    return s.selection.filter((x) => x.type === 'curve' && curveOf(s.geometry, x.id)).map((x) => x.id);
};

const drawingFrame = () => {
    const s = useSketcher.getState();
    return planeFrame(s.plane, s.offset, s.context);
};

/** Adds sketch steps (and the steps after them) to the open sketch's part. */
async function addSteps(steps: Record<string, unknown>[]): Promise<Result> {
    const { partId } = partNow();
    if (!partId) {
        return fail('This sketch starts a new part: leave it first (the part is made then), then edit it again to take entities out of it.');
    }
    return runTool('features_add', { partId, features: steps });
}

/** Takes the selected entities out of the open sketch into a new sketch step (on `plane`, or the sketch's own plane). */
async function takeOut(name: (features: Feature[]) => string, place: (picked: SketchGeometry) => Sketch | { error: string }): Promise<Result> {
    const ids = selectedCurves();
    if (!ids.length) {
        return fail('Select the sketch entities first (box select or click them; Shift adds).');
    }
    const s = useSketcher.getState();
    const { picked, rest } = extractCurves(s.geometry, ids, s.labels);
    const sketch = place(picked);
    if ('error' in sketch) {
        return fail(sketch.error);
    }
    const allFeatures = useStudio.getState().history?.parts.find((p) => p.id === partNow().partId)?.features ?? [];
    const stepName = name(allFeatures);
    const result = await addSteps([{ id: sketchStepId(allFeatures), op: 'sketch', name: stepName, sketch }]);
    if (result.isError) {
        return result;
    }
    // The entities have become the new sketch: they leave this one (one undo step here; the new step stays).
    commitGeometry(rest);
    useSketcher.setState({ selection: [], message: `${ids.length} entit${ids.length === 1 ? 'y' : 'ies'} became the sketch "${stepName}".` });
    return ok();
}

export function createFromSelections(): Promise<Result> {
    const s = useSketcher.getState();
    return takeOut((features) => nextFeatureName(features, { op: 'sketch' }), (picked) => sketchOfGeometry(picked, s.plane, s.offset));
}

export function addToView(view: Exclude<SketchView, 'auxiliary'>): Promise<Result> {
    const s = useSketcher.getState();
    return takeOut((features) => viewName(features, view), (picked) => {
        if (view === 'front') {
            return sketchOfGeometry(picked, s.plane, s.offset, { view });
        }
        const { features } = partNow();
        const front = frontBounds(features, drawingFrame());
        if ('error' in front) {
            return front;
        }
        const plane = viewPlane(view, drawingFrame(), front, boundsOf(picked)!, viewDepth(features));
        return 'error' in plane ? plane : sketchOfGeometry(picked, plane, 0, { view });
    });
}

const say = (r: Result) => useSketcher.setState({ message: r.text || null });

function instantTool(id: string, label: string, icon: string, hint: string, run: () => Promise<Result>): ToolDef {
    return { id, label, icon, hint, instant: () => void run().then(say) };
}

// ---- Picking an entity of another sketch ---------------------------------------------------------------------------

type OtherKind = 'line' | 'point' | 'any';

/** The part's other sketches seen in this sketch's coordinates (hidden ones left out). */
function othersHere(): SketchGeometry {
    const s = useSketcher.getState();
    const { partId, features } = partNow();
    const hidden = new Set(useStudio.getState().project?.view.hiddenSketches ?? []);
    return otherSketches(features, s.plane, s.offset, (id) => hidden.has(`${partId}/${id}`));
}

/** How a picked entity of another sketch is drawn: a line as it is, a point as a small cross. */
function ghostOf(g: SketchGeometry, id: string, size: number): NewEntity[] {
    const c = curveOf(g, id);
    const at = (pid: string): Pt | null => {
        const p = pointOf(g, pid);
        return p ? [p.u, p.v] : null;
    };
    if (c?.kind === 'line') {
        const [a, b] = [at(c.a), at(c.b)];
        return a && b ? [{ kind: 'line', a, b }] : [];
    }
    const p = at(id);
    return p ? [{ kind: 'line', a: [p[0] - size, p[1] - size], b: [p[0] + size, p[1] + size] }, { kind: 'line', a: [p[0] - size, p[1] + size], b: [p[0] + size, p[1] - size] }] : [];
}

/**
 * A selection box for an entity of another sketch of the part (`<step>/<id>`): while it is active, a click in the view
 * picks the line or point of another sketch under the pointer.
 */
function OtherPick({ label, kind, value, onPick, active, setActive }: {
    label: string; kind: OtherKind; value: string; onPick: (id: string) => void; active: boolean; setActive: (on: boolean) => void;
}) {
    const others = useMemo(() => othersHere(), []);
    const latest = useRef(onPick);
    latest.current = onPick;
    useEffect(() => {
        if (!active) {
            return;
        }
        setViewPicker({
            click: (raw, tolerance) => {
                const pick = pickAt(others, raw, tolerance);
                const isLine = pick?.type === 'curve' && curveOf(others, pick.id)?.kind === 'line';
                const fits = pick && (kind === 'any' ? pick.type === 'point' || isLine : kind === 'line' ? isLine : pick.type === 'point');
                if (!pick || !fits) {
                    useSketcher.setState({ message: `Click a ${kind === 'any' ? 'line or point' : kind} of another sketch.` });
                    return true;
                }
                useSketcher.setState({ message: null });
                latest.current(pick.id);
                return true;
            },
        });
        return () => setViewPicker(null);
    }, [active, others]);
    useEffect(() => {
        useSketcher.setState({ editPreview: value ? ghostOf(others, value, 1.5) : [] });
    }, [value, others]);
    useEffect(() => () => useSketcher.setState({ editPreview: [] }), []);
    const [step, local] = value.split('/');
    const stepName = partNow().features.find((f) => f.id === step)?.name ?? step;
    return (
        <div className="tb-field pm-pick">
            <span>{label}</span>
            <ul className={`pm-contours pm-pick-list ${active ? 'active' : ''}`} tabIndex={0} aria-label={label} onClick={() => setActive(true)} onFocus={() => setActive(true)}>
                {!value && <li className="pm-contours-all">{active ? 'Click it in the view' : 'Click here, then in the view'}</li>}
                {value && (
                    <li>
                        <span>{`${curveOf(others, value) ? 'Line' : 'Point'} ${local} of ${stepName}`}</span>
                        <button
                            type="button"
                            title="Remove from the selection"
                            aria-label="Remove"
                            onClick={(e) => {
                                e.stopPropagation();
                                onPick('');
                                setActive(true);
                            }}
                        >
                            ×
                        </button>
                    </li>
                )}
            </ul>
        </div>
    );
}

/** What the form's first box says of `count` selected entities: `one` and `many` are the verb for one and for more. */
export function selectedNoteText(count: number, one: string, many: string): string {
    return count === 1 ? `1 selected entity ${one}.` : `${count} selected entities ${many}.`;
}

/** The selected entities, as the form's first box shows them. */
function SelectedNote({ one, many }: { one: string; many: string }) {
    const count = useSketcher((s) => s.selection.filter((x) => x.type === 'curve').length);
    return (
        <p className={`tb-note ${count ? '' : 'pm-pick-note'}`}>
            {count ? selectedNoteText(count, one, many) : 'Select the sketch entities first (box select or click them; Shift adds), then open this again.'}
        </p>
    );
}

// ---- Auxiliary sketch ------------------------------------------------------------------------------------------------

function AuxiliaryForm({ api }: { api: PopupApi }) {
    const [active, setActive] = useState(true);
    return (
        <>
            <SelectedNote one="becomes the Auxiliary view" many="become the Auxiliary view" />
            <OtherPick
                label="Line in another view (the angle of the Auxiliary view)"
                kind="line"
                value={String(api.values.line ?? '')}
                onPick={(id) => {
                    api.set({ line: id });
                    setActive(!id);
                }}
                active={active}
                setActive={setActive}
            />
        </>
    );
}

const auxiliaryTool: ToolDef = {
    id: 'sk-add-auxiliary',
    label: 'Auxiliary sketch',
    icon: 'add-auxiliary',
    hint: 'the selected entities become an auxiliary view, folded about a line of another view',
    panel: true,
    width: 300,
    defaults: () => ({ line: '' }),
    top: (api) => <AuxiliaryForm api={api} />,
    applyLabel: 'OK',
    apply: async (v) => {
        const id = String(v.line ?? '');
        const others = othersHere();
        const line = id ? alignRef(others, id) : null;
        if (!line || line.kind !== 'line') {
            return fail('Pick a line of another view for the angle of the Auxiliary view.');
        }
        return takeOut((features) => viewName(features, 'auxiliary'), (picked) => {
            const plane = auxiliaryPlane(drawingFrame(), line.a, line.b, picked);
            return 'error' in plane ? plane : sketchOfGeometry(picked, plane, 0, { view: 'auxiliary' });
        });
    },
};

// ---- Align sketch ----------------------------------------------------------------------------------------------------

const lineOrPoint = (g: SketchGeometry, pick: { type: string; id: string }) => (
    (pick.type === 'point' && pointOf(g, pick.id)) || (pick.type === 'curve' && curveOf(g, pick.id)?.kind === 'line') ? null : 'Pick a line or a point of this sketch.'
);

function AlignForm({ api }: { api: PopupApi }) {
    const mine = String(api.values.mine ?? '');
    const [active, setActive] = useState(false);
    // The first box filled hands over to the second.
    useEffect(() => {
        if (mine && !api.values.other) {
            setActive(true);
        }
    }, [mine]);
    return (
        <>
            <PickBoxes api={api} boxes={[{ key: 'mine', label: 'Line or point of this sketch (it moves)', accept: lineOrPoint }]} />
            <OtherPick
                label="Line or point of the other sketch (it stays)"
                kind="any"
                value={String(api.values.other ?? '')}
                onPick={(id) => {
                    api.set({ other: id });
                    setActive(!id);
                }}
                active={active}
                setActive={setActive}
            />
            <p className="tb-note">This sketch slides and turns in its own plane until its line or point meets the other one as seen from it.</p>
        </>
    );
}

const alignTool: ToolDef = {
    id: 'sk-align-sketch',
    label: 'Align sketch',
    icon: 'align-sketch',
    hint: 'move this sketch so a line or point of it meets one of another sketch',
    panel: true,
    width: 300,
    defaults: () => ({ mine: '', other: '' }),
    top: (api) => <AlignForm api={api} />,
    applyLabel: 'OK',
    apply: async (v) => {
        const g = useSketcher.getState().geometry;
        const mine = alignRef(g, String(v.mine ?? ''));
        const other = alignRef(othersHere(), String(v.other ?? ''));
        if (!mine || !other) {
            return fail('Pick a line or point of this sketch, then one of the other sketch.');
        }
        const m = alignMotion(mine, other);
        if ('error' in m) {
            return fail(m.error);
        }
        const error = moveSketchFrame(m.by, m.centre, m.angle);
        return error ? fail(error) : ok();
    },
};

// ---- Convert to extrusion and cut ------------------------------------------------------------------------------------

type V3 = [number, number, number];

/** The true length of a line of another sketch (`<step>/<line>`), measured in its own sketch. */
function lineLength(id: string): number | null {
    const [stepId, local] = id.split('/');
    const { features } = partNow();
    const i = features.findIndex((f) => f.id === stepId);
    const f = features[i];
    const g = f?.op === 'sketch' ? f.sketch.geometry : undefined;
    const c = g ? curveOf(g, local) : undefined;
    if (!g || c?.kind !== 'line') {
        return null;
    }
    const frame = planeFrame(f.op === 'sketch' ? f.sketch.plane : 'top', f.op === 'sketch' ? f.sketch.offset ?? 0 : 0, features.slice(0, i));
    const at = (pid: string): V3 | null => {
        const p = pointOf(g, pid);
        return p ? [0, 1, 2].map((k) => frame.origin[k] + frame.u[k] * p.u + frame.v[k] * p.v) as V3 : null;
    };
    const [a, b] = [at(c.a), at(c.b)];
    return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) : null;
}

/** How far a part-frame point is from this sketch's plane along its normal. */
function heightOf(p: Vec3): number {
    const f = drawingFrame();
    return (p[0] - f.origin[0]) * f.n[0] + (p[1] - f.origin[1]) * f.n[1] + (p[2] - f.origin[2]) * f.n[2];
}

/** A point of another sketch (`<step>/<point>`) in the part frame. */
function otherPoint3(id: string): Vec3 | null {
    const p = pointOf(othersHere(), id);
    const f = drawingFrame();
    if (!p) {
        return null;
    }
    // Seen in this sketch's plane; its height comes from the sketch it belongs to.
    const [stepId, local] = id.split('/');
    const { features } = partNow();
    const i = features.findIndex((x) => x.id === stepId);
    const step = features[i];
    const g = step?.op === 'sketch' ? step.sketch.geometry : undefined;
    const q = local === 'origin' ? { u: 0, v: 0 } : g ? pointOf(g, local) : undefined;
    if (!q || step?.op !== 'sketch') {
        return [0, 1, 2].map((k) => f.origin[k] + f.u[k] * p.u + f.v[k] * p.v) as Vec3;
    }
    const there = planeFrame(step.sketch.plane, step.sketch.offset ?? 0, features.slice(0, i));
    return [0, 1, 2].map((k) => there.origin[k] + there.u[k] * q.u + there.v[k] * q.v) as Vec3;
}

function ConvertForm({ api, cut }: { api: PopupApi; cut: boolean }) {
    const [activeStart, setActiveStart] = useState(false);
    const [activeDepth, setActiveDepth] = useState(false);
    const start = String(api.values.start ?? 'plane');
    const picks = useSketchModel((m) => m.picks);
    const faces = picks.filter((p) => p.kind === 'face');
    // A face of the model as the start of a cut: the model takes face picks while that is chosen.
    useEffect(() => {
        if (start === 'face') {
            setModelPicking('convert-start');
            return () => setModelPicking(null);
        }
        return undefined;
    }, [start]);
    useEffect(() => {
        setActiveStart(start === 'point' && !api.values.point);
        setActiveDepth(false);
    }, [start]);
    useEffect(() => {
        if (api.values.depthFrom && !api.values.depthLine) {
            setActiveStart(false);
            setActiveDepth(true);
        }
    }, [api.values.depthFrom]);
    const length = api.values.depthLine ? lineLength(String(api.values.depthLine)) : null;
    return (
        <>
            <SelectedNote one={cut ? 'is cut' : 'is extruded'} many={cut ? 'are cut' : 'are extruded'} />
            {start === 'point' && (
                <OtherPick
                    label="Start point (a point of another sketch)"
                    kind="point"
                    value={String(api.values.point ?? '')}
                    onPick={(id) => {
                        api.set({ point: id });
                        setActiveStart(!id);
                    }}
                    active={activeStart}
                    setActive={(on) => {
                        setActiveStart(on);
                        if (on) {
                            setActiveDepth(false);
                        }
                    }}
                />
            )}
            {start === 'face' && (
                <p className={`tb-note ${faces.length ? '' : 'pm-pick-note'}`}>
                    {faces.length ? 'The cut starts at the picked face (the last one picked).' : 'Click a flat face of the model to start the cut at.'}
                </p>
            )}
            {!!api.values.depthFrom && (
                <OtherPick
                    label="Depth from a line of another sketch"
                    kind="line"
                    value={String(api.values.depthLine ?? '')}
                    onPick={(id) => {
                        api.set({ depthLine: id });
                        setActiveDepth(!id);
                    }}
                    active={activeDepth}
                    setActive={(on) => {
                        setActiveDepth(on);
                        if (on) {
                            setActiveStart(false);
                        }
                    }}
                />
            )}
            {length !== null && <p className="tb-note">Depth: {valueText(length)} mm (the line's length).</p>}
        </>
    );
}

function convertTool(cut: boolean): ToolDef {
    const isBlind = (v: Record<string, unknown>) => (v.end ?? 'blind') === 'blind';
    return {
        id: cut ? 'sk-convert-cut' : 'sk-convert-extrude',
        label: cut ? 'Convert to cut' : 'Convert to extrusion',
        icon: cut ? 'convert-cut' : 'convert-extrude',
        hint: cut ? 'cut with the selected entities only (a whole sketch is not needed)' : 'extrude the selected entities only (a whole sketch is not needed)',
        panel: true,
        width: 300,
        fields: () => [
            {
                key: 'start', label: 'Start', kind: 'select', section: 'From',
                options: [
                    { value: 'plane', label: 'Sketch plane' },
                    { value: 'point', label: 'A point of another sketch' },
                    ...(cut ? [{ value: 'face', label: 'A face of the model' }] : []),
                ],
            },
            {
                key: 'end', label: 'End condition', kind: 'select', section: 'Direction 1',
                options: [{ value: 'blind', label: 'Blind' }, { value: 'throughAll', label: 'Through all' }, { value: 'upToNext', label: 'Up to next' }],
            },
            { key: 'reverse', label: 'Reverse direction', kind: 'check', section: 'Direction 1' },
            { key: 'depthFrom', label: 'Depth from a sketch line', kind: 'check', section: 'Direction 1', show: isBlind },
            { key: 'distance', label: 'Depth', kind: 'number', unit: 'mm', min: 0, section: 'Direction 1', show: (v) => isBlind(v) && !v.depthFrom },
        ],
        defaults: () => ({ start: 'plane', end: cut ? 'throughAll' : 'blind', reverse: cut, depthFrom: false, distance: '10', point: '', depthLine: '' }),
        top: (api) => <ConvertForm api={api} cut={cut} />,
        applyLabel: 'OK',
        apply: async (v) => {
            const ids = selectedCurves();
            if (!ids.length) {
                return fail('Select the sketch entities first (box select or click them; Shift adds).');
            }
            const s = useSketcher.getState();
            const end = String(v.end ?? 'blind') as 'blind' | 'throughAll' | 'upToNext';
            let distance = 0;
            if (end === 'blind') {
                const d = v.depthFrom ? lineLength(String(v.depthLine ?? '')) : Number(v.distance);
                if (d === null || !Number.isFinite(d) || d <= 0) {
                    return fail(v.depthFrom ? 'Pick a line of another sketch for the depth.' : 'Depth must be more than 0.');
                }
                distance = d;
            }
            const sign = v.reverse ? -1 : 1;
            let from = 0;
            if (v.start === 'point') {
                const p = otherPoint3(String(v.point ?? ''));
                if (!p) {
                    return fail('Pick the start point in another sketch.');
                }
                from = heightOf(p) * sign;
            } else if (v.start === 'face') {
                const face = useSketchModel.getState().picks.filter((p) => p.kind === 'face').pop();
                if (!face) {
                    return fail('Click the face of the model the cut starts at.');
                }
                from = heightOf(face.at) * sign;
            }
            const { picked } = extractCurves(s.geometry, ids, s.labels);
            const sketch = sketchOfGeometry(picked, s.plane, s.offset);
            if (!sketch.profiles.length) {
                return fail('The selected entities make no closed area to extrude.');
            }
            const all = useStudio.getState().history?.parts.find((p) => p.id === partNow().partId)?.features ?? [];
            const sid = sketchStepId(all);
            const mode = cut ? 'cut' : 'add';
            const feature: Record<string, unknown> = {
                op: 'extrude', mode, sketchRef: sid, direction: v.reverse ? 'reverse' : 'normal', end,
                ...(end === 'blind' ? { distance } : {}), ...(end === 'throughAll' ? { through: true } : {}), ...(from ? { from } : {}),
            };
            const sketchName = nextFeatureName(all, { op: 'sketch' });
            const result = await addSteps([
                { id: sid, op: 'sketch', name: sketchName, sketch },
                { ...feature, name: nextFeatureName([...all, { name: sketchName } as Feature], { op: 'extrude', mode }) },
            ]);
            if (!result.isError) {
                useSketcher.setState({ message: `${cut ? 'Cut' : 'Extruded'} the ${ids.length} selected entit${ids.length === 1 ? 'y' : 'ies'} (their copy is the sketch "${sketchName}").` });
            }
            return result.isError ? result : ok();
        },
    };
}

/** The sketch's 2D to 3D group, in the order of the SolidWorks toolbar. */
export const twoDToThreeDTools: ToolDef[] = [
    ...(['front', 'top', 'right', 'left', 'bottom', 'back'] as const).map((view) => instantTool(
        `sk-add-${view}`, `Add to ${VIEW_NAMES[view].toLowerCase()} sketch`, `add-${view}`,
        view === 'front' ? 'the selected entities become the Front view (add it before the others)'
            : `the selected entities become the ${VIEW_NAMES[view]} view, folded into place about the Front view`,
        () => addToView(view),
    )),
    auxiliaryTool,
    instantTool('sk-from-selection', 'Create sketch from selections', 'sketch-from-selection',
        'the selected entities become a new sketch', createFromSelections),
    alignTool,
    convertTool(false),
    convertTool(true),
];
