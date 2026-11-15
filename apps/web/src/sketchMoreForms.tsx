// Toolbar entries and left-panel forms of the tools in sketchMoreTools.ts: dynamic mirror, jog line, segment,
// replace entity, modify sketch and check sketch for feature.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SketchGeometry } from '@jarvis/core';
import type { PopupApi, Result, ToolDef, Values } from './toolDefs';
import { ORIGIN, curveOf, pointOf } from './solver';
import { evaluate, type Pick } from './sketchGeometry';
import { useSketcher } from './sketcher';
import {
    applyReplace, applyResegment, applySegment, checkSketch, clearCheck, flipWholeSketch, isCurve, moveSketchFrame, positionPoint, scaleWholeSketch, startJog,
    startPicker, stopPicker, toggleDynamicMirror, useSketchMore,
} from './sketchMoreTools';
import { CONTOUR_TEXT, USAGES, type FeatureUsage } from './sketchFeatureCheck';
import { setRotationCentre, startModifyDrag, stopModifyDrag, useModifyDrag } from './sketchModifyDrag';
import { useFlipSymbols } from './sketchModifyView';
import { valueText } from './numberText';
import { segmentGroupOf } from './sketchSegment';

const NOUN: Record<string, string> = { line: 'Line', arc: 'Arc', circle: 'Circle' };

function nameOf(g: SketchGeometry, id: string): string {
    const c = curveOf(g, id);
    if (c) {
        return `${NOUN[c.kind] ?? c.kind} ${id}${c.construction ? ' (construction)' : ''}`;
    }
    return pointOf(g, id) ? `Point ${id}` : `${id} (deleted)`;
}

interface Box {
    key: string;
    label: string;
    accept: (g: SketchGeometry, pick: Pick) => string | null;
}

/**
 * The form's selection boxes for sketch entities: the active one (outlined) takes the next click in the view; a
 * filled box hands over to the next empty one.
 */
export function PickBoxes({ api, boxes, idle }: { api: PopupApi; boxes: Box[]; idle?: boolean }) {
    const g = useSketcher((s) => s.geometry);
    const first = boxes.find((b) => !api.values[b.key])?.key ?? boxes[0].key;
    // idle: optional boxes, active only once clicked (the view keeps selecting meanwhile).
    const [active, setActive] = useState<string | null>(idle ? null : first);
    const latest = useRef(api);
    latest.current = api;
    useEffect(() => {
        const box = boxes.find((b) => b.key === active);
        if (!box) {
            stopPicker();
            return;
        }
        startPicker({
            back: 'select',
            accept: box.accept,
            onPick: (pick) => {
                const values = { ...latest.current.values, [box.key]: pick.id };
                latest.current.set({ [box.key]: pick.id });
                setActive(idle ? null : boxes.find((b) => b.key !== box.key && !values[b.key])?.key ?? box.key);
            },
        });
    }, [active]);
    useEffect(() => () => stopPicker(), []);
    return (
        <>
            {boxes.map((b) => {
                const id = String(api.values[b.key] ?? '');
                return (
                    <div key={b.key} className="tb-field pm-pick">
                        <span>{b.label}</span>
                        <ul className={`pm-contours pm-pick-list ${active === b.key ? 'active' : ''}`} tabIndex={0} aria-label={b.label} onClick={() => setActive(b.key)} onFocus={() => setActive(b.key)}>
                            {!id && <li className="pm-contours-all">{active === b.key ? 'Click it in the view' : 'Click here, then in the view'}</li>}
                            {id && (
                                <li>
                                    <span>{nameOf(g, id)}</span>
                                    <button
                                        type="button"
                                        title="Remove from the selection"
                                        aria-label={`Remove ${nameOf(g, id)}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            api.set({ [b.key]: '' });
                                            setActive(idle ? null : b.key);
                                        }}
                                    >
                                        ×
                                    </button>
                                </li>
                            )}
                        </ul>
                    </div>
                );
            })}
        </>
    );
}

/** The direction of a sketch line (degrees from the u axis, a to b), for a pattern direction taken from it. */
export function lineDirection(id: unknown): number | null {
    const g = useSketcher.getState().geometry;
    const line = typeof id === 'string' && id ? curveOf(g, id) : undefined;
    const a = line?.kind === 'line' ? pointOf(g, line.a) : undefined;
    const b = line?.kind === 'line' ? pointOf(g, line.b) : undefined;
    return a && b ? (Math.atan2(b.v - a.v, b.u - a.u) * 180) / Math.PI : null;
}

export const lineOnly = (g: SketchGeometry, pick: Pick) => (pick.type === 'curve' && curveOf(g, pick.id)?.kind === 'line' ? null : 'Pick a line of the sketch.');

const ok = (error: string | null): Result => ({ text: error ?? '', isError: !!error });
const firstSelectedCurve = () => {
    const s = useSketcher.getState();
    return s.selection.find((x) => x.type === 'curve' && isCurve(s.geometry, { type: 'curve', id: x.id }))?.id ?? '';
};
const segmentable = (g: SketchGeometry, pick: Pick) => {
    const kind = pick.type === 'curve' ? curveOf(g, pick.id)?.kind : undefined;
    return kind === 'line' || kind === 'arc' || kind === 'circle' ? null : 'Pick a line, arc or circle.';
};
const anyCurve = (g: SketchGeometry, pick: Pick) => (isCurve(g, pick) ? null : 'Pick a sketch entity (not a point or an axis).');

// ---- Dynamic mirror and jog: click tools ----------------------------------------------------------------------

const dynamicMirror: ToolDef = {
    id: 'sk-dynamic-mirror',
    label: 'Dynamic mirror',
    icon: 'dynamic-mirror',
    hint: 'pick a line, then draw: what you draw is mirrored about it (click again to stop)',
    instant: () => toggleDynamicMirror(),
    active: () => !!useSketchMore.getState().dynamicMirror,
};

const jog: ToolDef = {
    id: 'sk-jog',
    label: 'Jog line',
    icon: 'jog',
    hint: 'click a line, then click to place a step in it',
    instant: () => startJog(),
    active: (_, s) => s.sketchTool === 'm:jog',
};

// ---- Segment --------------------------------------------------------------------------------------------------

const segment: ToolDef = {
    id: 'sk-segment',
    label: 'Segment',
    icon: 'segment',
    hint: 'equally spaced points on a line, arc or circle, or equal pieces of it',
    panel: true,
    width: 300,
    fields: () => [
        { key: 'count', label: 'Number of instances', kind: 'number', min: 1, step: 1, section: 'Segment parameters' },
        {
            key: 'mode', label: 'Make', kind: 'select', section: 'Segment parameters',
            options: [{ value: 'points', label: 'Sketch points' }, { value: 'segments', label: 'Sketch segments' }],
        },
    ],
    defaults: () => {
        // A point, chord or piece of an earlier Segment selected: that group, to change its number of instances.
        const s = useSketcher.getState();
        const group = s.selection.map((x) => segmentGroupOf(s.geometry, x.id)).find((x) => !!x);
        if (group) {
            return { group: group.id, curve: group.curve, count: String(group.mode === 'points' ? group.points.length : group.pieces?.length ?? 2), mode: group.mode };
        }
        return { group: '', curve: firstSelectedCurve(), count: '3', mode: 'points' };
    },
    top: (api) => (
        <>
            {api.values.group
                ? <p className="tb-note">Changing an earlier segment group: OK spaces its entity again with this number of instances.</p>
                : <PickBoxes api={api} boxes={[{ key: 'curve', label: 'Sketch entity to segment', accept: segmentable }]} />}
            <p className="tb-note">
                Points stay equally spaced along the entity and follow it when it changes (held by equal construction chords); deleting one spaces the others
                again. Segments cut it into equal pieces. Select a point of a group before opening Segment to change its number.
            </p>
        </>
    ),
    apply: async (v) => {
        if (!v.curve) {
            return ok('Pick the line, arc or circle to segment.');
        }
        const count = Number(v.count);
        if (!Number.isInteger(count)) {
            return ok('Number of instances must be a whole number.');
        }
        const mode = v.mode === 'segments' ? 'segments' : 'points';
        return ok(v.group ? applyResegment(String(v.group), count, mode) : applySegment(String(v.curve), count, mode));
    },
};

// ---- Replace entity -------------------------------------------------------------------------------------------

const replace: ToolDef = {
    id: 'sk-replace',
    label: 'Replace entity',
    icon: 'replace',
    hint: 'one entity takes over another\'s relations and dimensions',
    panel: true,
    width: 300,
    fields: () => [
        {
            key: 'old', label: 'The replaced entity', kind: 'select', section: 'Selection',
            options: [{ value: 'construction', label: 'Make construction' }, { value: 'delete', label: 'Delete' }],
        },
        { key: 'contour', label: 'Make contour (the new entity is not construction)', kind: 'check', section: 'Selection' },
    ],
    defaults: () => ({ from: firstSelectedCurve(), to: '', old: 'construction', contour: false }),
    top: (api) => (
        <PickBoxes
            api={api}
            boxes={[
                { key: 'from', label: 'Replace this entity', accept: anyCurve },
                { key: 'to', label: 'With this one', accept: anyCurve },
            ]}
        />
    ),
    apply: async (v) => ok(!v.from || !v.to ? 'Pick the entity to replace and the one to replace it with.'
        : applyReplace(String(v.from), String(v.to), { old: v.old === 'delete' ? 'delete' : 'construction', contour: !!v.contour })),
};

// ---- Modify sketch --------------------------------------------------------------------------------------------

/** A collapsible block like the property manager's own sections. */
function Section({ title, children }: { title: string; children: ReactNode }) {
    const [open, setOpen] = useState(true);
    return (
        <section className={`pm-section ${open ? 'open' : ''}`}>
            <button type="button" className="pm-section-head" onClick={() => setOpen(!open)} aria-expanded={open}>
                <span>{title}</span>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" /></svg>
            </button>
            {open && <div className="pm-section-body">{children}</div>}
        </section>
    );
}

function NumberBox({ label, value, onChange, unit }: { label: string; value: string; onChange: (v: string) => void; unit?: string }) {
    return (
        <label className="tb-field">
            <span>{label}</span>
            <span className="tb-input">
                <input type="text" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} />
                {unit && <em>{unit}</em>}
            </span>
        </label>
    );
}

function ModifySketchForm({ api }: { api: PopupApi }) {
    const [v, setV] = useState({ x: '0', y: '0', angle: '0', cu: '0', cv: '0', factor: '1', su: '0', sv: '0' });
    const [about, setAbout] = useState<'origin' | 'movable'>('origin');
    const [position, setPosition] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const values = useRef<Values>({ point: '' });
    const field = (key: keyof typeof v) => ({
        value: v[key],
        onChange: (x: string) => {
            setV((o) => ({ ...o, [key]: x }));
            // The centre of rotation is drawn in the view and dragged there too.
            const typed = evaluate(x);
            if ((key === 'cu' || key === 'cv') && typed !== null) {
                const c = useModifyDrag.getState().centre;
                setRotationCentre(key === 'cu' ? [typed, c[1]] : [c[0], typed]);
            }
        },
    });
    // Dragging in the view: the left button moves the sketch, the right one turns it; right-click flips.
    useEffect(() => {
        startModifyDrag();
        return () => stopModifyDrag();
    }, []);
    useFlipSymbols();
    const centre = useModifyDrag((m) => m.centre);
    useEffect(() => {
        setV((o) => (evaluate(o.cu) === centre[0] && evaluate(o.cv) === centre[1] ? o : { ...o, cu: valueText(centre[0]), cv: valueText(centre[1]) }));
    }, [centre]);
    const n = (text: string, label: string) => {
        const x = evaluate(text);
        if (x === null) {
            throw new Error(`${label} must be a number.`);
        }
        return x;
    };
    const run = (f: () => string | null) => {
        try {
            setError(f());
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };
    const pointApi: PopupApi = {
        values: values.current,
        set: (patch) => {
            values.current = { ...values.current, ...patch };
            setV((o) => ({ ...o }));
        },
        run: api.run,
    };
    const pointAccept = (g: SketchGeometry, pick: Pick) => (pick.type === 'point' && pick.id !== ORIGIN && pointOf(g, pick.id) ? null : 'Pick a sketch point.');
    return (
        <div className="sk-modify">
            <Section title="Translate">
                <label className="tb-check">
                    <input type="checkbox" checked={position} onChange={(e) => setPosition(e.target.checked)} />
                    <span>Position selected point</span>
                </label>
                {position && <PickBoxes api={pointApi} boxes={[{ key: 'point', label: 'Point', accept: pointAccept }]} />}
                <NumberBox label={position ? 'X position' : 'X value'} unit="mm" {...field('x')} />
                <NumberBox label={position ? 'Y position' : 'Y value'} unit="mm" {...field('y')} />
                <div className="sk-list-actions">
                    <button
                        type="button"
                        className="sk-small"
                        onClick={() => run(() => {
                            const to: [number, number] = [n(v.x, 'X'), n(v.y, 'Y')];
                            if (position) {
                                return values.current.point ? positionPoint(String(values.current.point), to) : 'Pick the point to position.';
                            }
                            return moveSketchFrame(to);
                        })}
                    >
                        Move
                    </button>
                </div>
            </Section>
            <Section title="Rotate">
                <NumberBox label="Angle" unit="deg" {...field('angle')} />
                <NumberBox label="Centre U" unit="mm" {...field('cu')} />
                <NumberBox label="Centre V" unit="mm" {...field('cv')} />
                <div className="sk-list-actions">
                    <button type="button" className="sk-small" onClick={() => run(() => moveSketchFrame([0, 0], [n(v.cu, 'Centre U'), n(v.cv, 'Centre V')], n(v.angle, 'Angle')))}>
                        Rotate
                    </button>
                </div>
            </Section>
            <Section title="Scale about">
                <label className="tb-check">
                    <input type="radio" checked={about === 'origin'} onChange={() => setAbout('origin')} />
                    <span>Sketch origin</span>
                </label>
                <label className="tb-check">
                    <input type="radio" checked={about === 'movable'} onChange={() => setAbout('movable')} />
                    <span>Movable origin</span>
                </label>
                {about === 'movable' && (
                    <>
                        <NumberBox label="Origin U" unit="mm" {...field('su')} />
                        <NumberBox label="Origin V" unit="mm" {...field('sv')} />
                    </>
                )}
                <NumberBox label="Factor" unit="×" {...field('factor')} />
                <div className="sk-list-actions">
                    <button
                        type="button"
                        className="sk-small"
                        onClick={() => run(() => scaleWholeSketch(n(v.factor, 'Factor'), about === 'movable' ? [n(v.su, 'Origin U'), n(v.sv, 'Origin V')] : null))}
                    >
                        Scale
                    </button>
                </div>
            </Section>
            <Section title="Flip">
                <div className="sk-list-actions">
                    <button type="button" className="sk-small" onClick={() => run(() => flipWholeSketch('x'))}>About X axis</button>
                    <button type="button" className="sk-small" onClick={() => run(() => flipWholeSketch('y'))}>About Y axis</button>
                    <button type="button" className="sk-small" onClick={() => run(() => flipWholeSketch('both'))}>Both</button>
                </div>
            </Section>
            {error && <p className="tb-note pm-pick-note">{error}</p>}
            <p className="tb-note">Move and Rotate take the sketch's origin and axes along, so relations to them hold. Scale and Flip work about the origin.</p>
            <p className="tb-note">
                In the view: drag with the left button to move the sketch, with the right button to turn it about the centre of rotation (the
                diamond; drag it with the left button). Right-click the end of an arm of the origin, or its centre, to flip the sketch.
            </p>
        </div>
    );
}

const modifySketch: ToolDef = {
    id: 'sk-modify-sketch',
    label: 'Modify sketch',
    icon: 'modify-sketch',
    hint: 'move, rotate, scale or flip the whole sketch',
    panel: true,
    noApply: true,
    width: 300,
    top: (api) => <ModifySketchForm api={api} />,
};

// ---- Check sketch for feature ---------------------------------------------------------------------------------

/** The usage the sketch was opened for: what it is checked for first. */
function defaultUsage(): FeatureUsage {
    const s = useSketcher.getState();
    return s.intent === 'cut' ? 'cut' : s.intent === 'revolve' ? 'revolve' : s.intent === 'extrude' ? 'extrude' : 'none';
}

function CheckSketchForm() {
    const [usage, setUsage] = useState<FeatureUsage>(defaultUsage);
    const result = useSketchMore((m) => m.check);
    const g = useSketcher((s) => s.geometry);
    const contour = USAGES.find((u) => u.value === usage)!.contour;
    useEffect(() => () => clearCheck(), []);
    // The result is for the sketch as it was: a change clears it.
    useEffect(() => clearCheck(), [g, usage]);
    return (
        <>
            <label className="tb-field">
                <span>Feature usage</span>
                <select value={usage} onChange={(e) => setUsage(e.target.value as FeatureUsage)} aria-label="Feature usage">
                    {USAGES.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                </select>
            </label>
            <p className="tb-note">Contour type: <b>{CONTOUR_TEXT[contour]}</b></p>
            <div className="sk-list-actions">
                <button type="button" className="sk-small" onClick={() => checkSketch(contour)}>Check</button>
                <button type="button" className="sk-small" onClick={() => setUsage(defaultUsage())}>Reset</button>
            </div>
            {result && <p className={`tb-note ${result.ok ? '' : 'pm-pick-note'}`}>{result.text}</p>}
        </>
    );
}

const checkFeature: ToolDef = {
    id: 'sk-check-feature',
    label: 'Check sketch for feature',
    icon: 'check-sketch',
    hint: 'whether the sketch can make an extrude, cut, revolve, loft or sweep, and what is wrong',
    panel: true,
    noApply: true,
    width: 300,
    top: () => <CheckSketchForm />,
};

/** In the Modify group, after the others. */
export const moreSketchTools: ToolDef[] = [dynamicMirror, jog, segment, replace, modifySketch, checkFeature];

