// Sketch tools that take geometry from the model, as PropertyManager forms: Convert entities, Intersection curve,
// Silhouette entities and Pierce point. Picks are collected in sketchModelPick.ts; the kernel answers in
// sketchModel.ts. What is added is locked where it is and marked as from the model (references are by value).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Feature } from '@jarvis/core';
import type { ModelCurve, ModelQuery, ModelSketch } from '@jarvis/core/projection';
import type { PopupApi, Result, ToolDef, Values } from './toolDefs';
import { commitGeometry, setTool, useSketcher } from './sketcher';
import {
    addModelCurves, BY_VALUE_NOTE, chainOf, curveEntity, fetchModelSketch, modelTarget, otherSketchCurves, pickKey, useSketchModel,
    type ModelPick, type SourcedCurve,
} from './sketchModel';
import { setModelPicking } from './sketchModelPick';
import { useStudio } from './state';
import { hiddenStepsNow } from './stepVisibility';
import { pierceCurves } from './sketchPierce';

type Mode = 'convert' | 'section' | 'silhouette' | 'pierce';

/** What OK adds, kept up to date by the open form. */
let pending: { curves: ModelCurve[]; points: [number, number][]; error: string | null } = { curves: [], points: [], error: null };

const stepName = (features: Feature[], id: string): string => {
    const f = features.find((x) => x.id === id);
    return f?.name ?? id;
};

/** The other sketches' curves, projected onto the open sketch (hidden sketches left out). */
function sketchCurves(): SourcedCurve[] {
    const s = useSketcher.getState();
    const target = modelTarget(s);
    if (!target) {
        return [];
    }
    const hidden = hiddenStepsNow();
    return otherSketchCurves(s.context, target.frame, (id) => hidden.has(`${target.partId}/${id}`));
}

/** Asks the kernel when the picks or options change; the latest answer wins. */
function useModelAnswer(query: ModelQuery | null): { model: ModelSketch | null; error: string | null; loading: boolean } {
    const [state, setState] = useState<{ model: ModelSketch | null; error: string | null; loading: boolean }>({ model: null, error: null, loading: false });
    const ask = useRef(0);
    const key = JSON.stringify(query);
    useEffect(() => {
        const target = modelTarget(useSketcher.getState());
        if (!query || !target) {
            setState({ model: null, error: target ? null : 'This sketch starts a new part: there is no model to take geometry from yet.', loading: false });
            return;
        }
        const n = ++ask.current;
        setState((s) => ({ ...s, loading: true }));
        fetchModelSketch(target, query).then(
            (model) => n === ask.current && setState({ model, error: null, loading: false }),
            (e: unknown) => {
                const text = e instanceof Error ? e.message : String(e);
                n === ask.current && setState({
                    model: null, loading: false,
                    error: /no longer exists/.test(text) ? 'A pick is made after this sketch in the history, so the sketch cannot use it. Remove it.' : text,
                });
            },
        );
    }, [key]);
    return state;
}

/** Keeps the form's mode on while it is open, with the sketcher on Select. */
function useModelSession(mode: Mode): void {
    useEffect(() => {
        setTool('select');
        setModelPicking(mode);
        return () => {
            setModelPicking(null);
            pending = { curves: [], points: [], error: null };
        };
    }, [mode]);
}

function SkippedList({ model }: { model: ModelSketch | null }) {
    if (!model?.skipped.length) {
        return null;
    }
    return (
        <div className="sk-list">
            <p className="tb-note">Cannot be converted yet (no exact sketch curve):</p>
            {model.skipped.map((s, i) => (
                <div key={i} className="sk-row"><span className="sk-row-text"><b>{s.what}</b><small>{s.why}</small></span></div>
            ))}
        </div>
    );
}

function removePick(p: ModelPick): void {
    useSketchModel.setState((m) => ({ picks: m.picks.filter((x) => pickKey(x) !== pickKey(p)), version: m.version + 1 }));
}

const CURVE_NAME: Record<ModelCurve['kind'], string> = {
    line: 'line', circle: 'circle', arc: 'arc', ellipse: 'ellipse', ellipseArc: 'partial ellipse', bezier: 'spline', bspline: 'spline', conic: 'conic',
};

function removeCurvePick(c: ModelCurve): void {
    useSketchModel.setState((m) => ({ curvePicks: m.curvePicks.filter((x) => x !== c), version: m.version + 1 }));
}

function removeSketchPick(id: string): void {
    useSketchModel.setState((m) => ({ sketchPicks: m.sketchPicks.filter((x) => x !== id), version: m.version + 1 }));
}

const queryPoints = (picks: ModelPick[]) => ({
    edges: picks.filter((p) => p.kind === 'edge').map((p) => p.at),
    faces: picks.filter((p) => p.kind === 'face').map((p) => ({ at: p.at, ...(p.normal ? { normal: p.normal } : {}) })),
});

/** The picks of the form, and the loops of each picked face to convert. */
function ConvertPanel({ api }: { api: PopupApi }) {
    useModelSession('convert');
    const picks = useSketchModel((s) => s.picks);
    const sketchPicks = useSketchModel((s) => s.sketchPicks);
    const curvePicks = useSketchModel((s) => s.curvePicks);
    const context = useSketcher((s) => s.context);
    const query = useMemo<ModelQuery | null>(() => (picks.length ? { kind: 'convert', ...queryPoints(picks) } : null), [picks]);
    const { model, error, loading } = useModelAnswer(query);
    // Per picked face (by pick key): which loops are left out. Select all inner loops sets the default.
    const [loopsOff, setLoopsOff] = useState<Record<string, number[]>>({});
    const inner = api.values.inner !== false;
    useEffect(() => setLoopsOff({}), [inner]);
    const faces = picks.filter((p) => p.kind === 'face');
    const others = useMemo(sketchCurves, [context, sketchPicks]);
    const chosen = useMemo(() => {
        const keep = (face: number, loop: number): boolean => {
            const off = loopsOff[pickKey(faces[face])];
            return off ? !off.includes(loop) : loop === 0 || inner;
        };
        const fromModel = (model?.curves ?? []).filter((c) => c.face === undefined || keep(c.face, c.loop ?? 0));
        // Curves of other sketches: the picked ones, with Select chain everything joined to them end to end.
        const picked = new Set<number>();
        for (const id of sketchPicks) {
            others.forEach((c, i) => {
                if (c.id === id) {
                    for (const k of api.values.chain ? chainOf(others, i) : [i]) {
                        picked.add(k);
                    }
                }
            });
        }
        return [...fromModel, ...curvePicks, ...[...picked].sort((a, b) => a - b).map((i) => others[i].curve)] as ModelCurve[];
    }, [model, loopsOff, inner, sketchPicks, curvePicks, others, api.values.chain]);
    useEffect(() => {
        pending = { curves: chosen, points: [], error };
        useSketchModel.setState({ preview: chosen.map(curveEntity) });
    }, [chosen, error]);
    const toggleLoop = (p: ModelPick, loop: number, count: number) => {
        const key = pickKey(p);
        const current = loopsOff[key] ?? Array.from({ length: count }, (_, i) => i).filter((i) => i > 0 && !inner);
        setLoopsOff({ ...loopsOff, [key]: current.includes(loop) ? current.filter((x) => x !== loop) : [...current, loop] });
    };
    return (
        <>
            <p className="tb-note">
                Click model edges (on the sketch plane or on the model) or faces (a face gives its loops), or curves of other
                sketches. Click again to remove.
            </p>
            <div className="sk-list">
                {!picks.length && !sketchPicks.length && !curvePicks.length && <p className="tb-note">Nothing picked yet.</p>}
                {curvePicks.map((c, i) => (
                    <div key={`curve-${i}`} className="sk-row">
                        <span className="sk-row-text"><b>Model edge</b><small>{CURVE_NAME[c.kind]}</small></span>
                        <button type="button" className="sk-row-x" title="Remove" aria-label="Remove" onClick={() => removeCurvePick(c)}>×</button>
                    </div>
                ))}
                {picks.map((p) => {
                    const k = faces.indexOf(p);
                    const count = k >= 0 ? model?.loops?.[k] ?? 0 : 0;
                    const off = loopsOff[pickKey(p)];
                    return (
                        <div key={pickKey(p)} className="sk-row">
                            <span className="sk-row-text">
                                <b>{p.kind === 'edge' ? `Edge ${p.index + 1}` : `Face ${p.index + 1}`}</b>
                                {k >= 0 && count > 0 && (
                                    <small>
                                        {Array.from({ length: count }, (_, loop) => (
                                            <label key={loop} className="sk-inline">
                                                <input
                                                    type="checkbox"
                                                    checked={off ? !off.includes(loop) : loop === 0 || inner}
                                                    onChange={() => toggleLoop(p, loop, count)}
                                                />
                                                {loop === 0 ? 'Outer loop' : `Inner loop ${loop}`}{' '}
                                            </label>
                                        ))}
                                    </small>
                                )}
                            </span>
                            <button type="button" className="sk-row-x" title="Remove" aria-label="Remove" onClick={() => removePick(p)}>×</button>
                        </div>
                    );
                })}
                {sketchPicks.map((id) => (
                    <div key={id} className="sk-row">
                        <span className="sk-row-text"><b>{stepName(context, id.split('/')[0])}</b><small>{id.split('/')[1]}</small></span>
                        <button type="button" className="sk-row-x" title="Remove" aria-label="Remove" onClick={() => removeSketchPick(id)}>×</button>
                    </div>
                ))}
            </div>
            {loading && <p className="tb-note">Reading the model…</p>}
            {error && <p className="tb-note error">{error}</p>}
            <SkippedList model={model} />
            <p className="tb-note">{BY_VALUE_NOTE}</p>
        </>
    );
}

/** Intersection curve: the picked faces (none: the whole body). */
function SectionPanel() {
    useModelSession('section');
    const picks = useSketchModel((s) => s.picks);
    const query = useMemo<ModelQuery>(() => ({ kind: 'section', faces: queryPoints(picks).faces }), [picks]);
    const { model, error, loading } = useModelAnswer(query);
    useEffect(() => {
        const curves = model?.curves ?? [];
        pending = { curves, points: [], error };
        useSketchModel.setState({ preview: curves.map(curveEntity) });
    }, [model, error]);
    return (
        <>
            <p className="tb-note">
                The curve where the sketch plane cuts the model. Click faces to cut only those; with none picked, the whole body is cut.
            </p>
            <div className="sk-list">
                {picks.map((p) => (
                    <div key={pickKey(p)} className="sk-row">
                        <span className="sk-row-text"><b>Face {p.index + 1}</b></span>
                        <button type="button" className="sk-row-x" title="Remove" aria-label="Remove" onClick={() => removePick(p)}>×</button>
                    </div>
                ))}
            </div>
            {loading && <p className="tb-note">Reading the model…</p>}
            {error && <p className="tb-note error">{error}</p>}
            {model && !model.curves.length && !loading && <p className="tb-note">The plane does not cut {picks.length ? 'those faces' : 'the body'}.</p>}
            <SkippedList model={model} />
            <p className="tb-note">{BY_VALUE_NOTE}</p>
        </>
    );
}

/** Silhouette entities: the outline of the part's body seen along the plane normal. */
function SilhouettePanel({ api }: { api: PopupApi }) {
    useModelSession('silhouette');
    const external = api.values.external !== false;
    const query = useMemo<ModelQuery>(() => ({ kind: 'silhouette', external }), [external]);
    const { model, error, loading } = useModelAnswer(query);
    useEffect(() => {
        const curves = model?.curves ?? [];
        pending = { curves, points: [], error };
        useSketchModel.setState({ preview: curves.map(curveEntity) });
    }, [model, error]);
    return (
        <>
            <p className="tb-note">The outline of the part's body, seen straight along the sketch plane's normal.</p>
            {loading && <p className="tb-note">Reading the model…</p>}
            {error && <p className="tb-note error">{error}</p>}
            {model && !model.curves.length && !loading && !error && <p className="tb-note">The part has no body to outline yet.</p>}
            <SkippedList model={model} />
            <p className="tb-note">{BY_VALUE_NOTE}</p>
        </>
    );
}

/** Pierce point: where the picked model edges or curves of other sketches pass through the sketch plane. */
function PiercePanel() {
    useModelSession('pierce');
    const picks = useSketchModel((s) => s.picks);
    const sketchPicks = useSketchModel((s) => s.sketchPicks);
    const context = useSketcher((s) => s.context);
    // Joined to a string: a selector that builds a new array on every call makes React loop.
    const selectedKey = useSketcher((s) => s.selection.filter((x) => x.type === 'point').map((x) => x.id).join('\n'));
    const selected = useMemo(() => (selectedKey ? selectedKey.split('\n') : []), [selectedKey]);
    const query = useMemo<ModelQuery | null>(() => (picks.length ? { kind: 'pierce', edges: queryPoints(picks).edges } : null), [picks]);
    const { model, error, loading } = useModelAnswer(query);
    const fromSketches = useMemo(() => {
        const s = useSketcher.getState();
        const target = modelTarget(s);
        return target ? pierceCurves(s.context, target.frame, sketchPicks) : { points: [], skipped: [] };
    }, [context, sketchPicks]);
    const points = useMemo(() => [...(model?.points ?? []), ...fromSketches.points], [model, fromSketches]);
    useEffect(() => {
        pending = { curves: [], points, error };
        useSketchModel.setState({ preview: points.map((p) => ({ kind: 'circle' as const, c: p, r: 0.4 })) });
    }, [points, error]);
    return (
        <>
            <p className="tb-note">
                Click model edges or curves of other sketches that pass through the sketch plane. A point is made where each one
                pierces it{selected.length === 1 ? ', or the selected point is moved there' : ' (select one sketch point first to move it there instead)'}.
            </p>
            <div className="sk-list">
                {picks.map((p) => (
                    <div key={pickKey(p)} className="sk-row">
                        <span className="sk-row-text"><b>Edge {p.index + 1}</b></span>
                        <button type="button" className="sk-row-x" title="Remove" aria-label="Remove" onClick={() => removePick(p)}>×</button>
                    </div>
                ))}
                {sketchPicks.map((id) => (
                    <div key={id} className="sk-row">
                        <span className="sk-row-text"><b>{stepName(context, id.split('/')[0])}</b><small>{id.split('/')[1]}</small></span>
                        <button type="button" className="sk-row-x" title="Remove" aria-label="Remove" onClick={() => removeSketchPick(id)}>×</button>
                    </div>
                ))}
            </div>
            {loading && <p className="tb-note">Reading the model…</p>}
            {error && <p className="tb-note error">{error}</p>}
            {(picks.length > 0 || sketchPicks.length > 0) && !loading && !points.length && <p className="tb-note">Nothing picked passes through the sketch plane.</p>}
            <SkippedList model={model ? { ...model, skipped: [...model.skipped, ...fromSketches.skipped] } : fromSketches.skipped.length ? { curves: [], points: [], skipped: fromSketches.skipped } : null} />
            <p className="tb-note">{BY_VALUE_NOTE}</p>
        </>
    );
}

/** OK: adds what the form shows, locked in place. */
function addPending(construction: boolean): Result {
    if (pending.error) {
        return { text: pending.error, isError: true };
    }
    if (!pending.curves.length) {
        return { text: 'Nothing to add: pick model edges, faces or curves of other sketches first.', isError: true };
    }
    const r = addModelCurves(useSketcher.getState().geometry, pending.curves, { lock: true, construction });
    if (!commitGeometry(r.g)) {
        return { text: useSketcher.getState().message ?? 'Could not add them to the sketch.', isError: true };
    }
    useSketcher.setState({ selection: r.ids.map((id) => ({ type: 'curve' as const, id })) });
    return { text: '', isError: false };
}

/** OK for pierce points: new locked points, or the one selected point moved to the only pierce point. */
function addPierce(): Result {
    if (pending.error) {
        return { text: pending.error, isError: true };
    }
    const points = pending.points;
    if (!points.length) {
        return { text: 'Nothing pierces the sketch plane: pick model edges or curves of other sketches that pass through it.', isError: true };
    }
    const s = useSketcher.getState();
    const selected = s.selection.filter((x) => x.type === 'point').map((x) => x.id);
    let g = s.geometry;
    if (selected.length === 1 && points.length === 1) {
        const id = selected[0];
        g = { ...g, points: g.points.map((p) => (p.id === id ? { ...p, u: points[0][0], v: points[0][1] } : p)) };
        const used = new Set(g.constraints.map((c) => c.id));
        let n = 1;
        while (used.has(`km${n}`)) {
            n++;
        }
        g = { ...g, constraints: [...g.constraints.filter((c) => !(c.kind === 'fix' && c.point === id)), { id: `km${n}`, kind: 'fix', point: id }] };
    } else {
        // A point is a zero-length nothing to addModelCurves: add the points with their locks directly.
        const used = new Set([...g.points.map((p) => p.id), ...g.constraints.map((c) => c.id)]);
        const fresh = (prefix: string): string => {
            let n = 1;
            while (used.has(`${prefix}${n}`)) {
                n++;
            }
            used.add(`${prefix}${n}`);
            return `${prefix}${n}`;
        };
        for (const p of points) {
            const id = fresh('pm');
            g = { ...g, points: [...g.points, { id, u: p[0], v: p[1] }], constraints: [...g.constraints, { id: fresh('km'), kind: 'fix', point: id }] };
        }
    }
    return commitGeometry(g) ? { text: '', isError: false } : { text: useSketcher.getState().message ?? 'Could not place the point.', isError: true };
}

const panelTool = (def: Omit<ToolDef, 'panel' | 'width'>): ToolDef => ({ panel: true, width: 320, ...def });

export const modelSketchTools: ToolDef[] = [
    panelTool({
        id: 'sk-convert',
        label: 'Convert entities',
        icon: 'convert',
        hint: 'copy model edges, face loops or curves of other sketches into this sketch',
        fields: () => [
            { key: 'chain', label: 'Select chain', kind: 'check', section: 'Options' },
            { key: 'construction', label: 'For construction', kind: 'check', section: 'Options' },
            { key: 'inner', label: 'Select all inner loops', kind: 'check', section: 'Options' },
        ],
        defaults: () => ({ chain: false, construction: false, inner: true }),
        top: (api) => <ConvertPanel api={api} />,
        apply: async (v: Values) => addPending(!!v.construction),
    }),
    panelTool({
        id: 'sk-intersection',
        label: 'Intersection curve',
        icon: 'intersection-curve',
        hint: 'the curve where the sketch plane cuts the part or picked faces',
        top: () => <SectionPanel />,
        apply: async () => addPending(false),
    }),
    panelTool({
        id: 'sk-silhouette',
        label: 'Silhouette entities',
        icon: 'silhouette',
        hint: 'the outline of the part seen along the sketch plane normal',
        fields: () => [{ key: 'external', label: 'External silhouette', kind: 'check', section: 'Entities to silhouette' }],
        defaults: () => ({ external: true }),
        top: (api) => <SilhouettePanel api={api} />,
        apply: async () => addPending(false),
    }),
    panelTool({
        id: 'sk-pierce',
        label: 'Pierce point',
        icon: 'pierce',
        hint: 'a point where a model edge or a curve of another sketch passes through the sketch plane',
        top: () => <PiercePanel />,
        apply: async () => addPierce(),
    }),
];
