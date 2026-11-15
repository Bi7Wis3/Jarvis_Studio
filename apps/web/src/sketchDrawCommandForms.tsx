// Toolbar entries and left-panel forms of Select Chain, Reverse Endpoint Tangent, Align Grid/Origin, Make Path (and
// Path Properties), Belt/Chain and the Slot PropertyManager of a selected slot. The actions are in sketchDrawCommands.ts.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SketchBelt, SketchGeometry, SketchPath } from '@jarvis/core';
import type { Field, PopupApi, Result, ToolDef, Values } from './toolDefs';
import { ORIGIN, curveOf, pointOf, solveGeometry, solverReady } from './solver';
import { addRelationToSelection, commitGeometry, constraintTool, deleteConstraints, setHighlight, useSketcher } from './sketcher';
import { PickBoxes } from './sketchMoreForms';
import { startPicker, stopPicker } from './sketchMoreTools';
import { PmSection } from './sketchPm';
import { CURVE_NOUN } from './sketchCurves';
import { selectChains } from './sketchChainTools';
import { alignFrame, type AlignOptions } from './sketchAlignGrid';
import { pathOf } from './sketchPathModel';
import { beltPreview, pathLength } from './sketchPaths';
import { editSlot, setSlotLengthKind, slotAmong, slotCurveIds, slotParams, type SlotFound } from './sketchSlotParams';
import {
    applyAlignGrid, applyBelt, applyPath, deletePath, makeEndlessSelected, report, reverseTangentSelected, selectChainSelected,
} from './sketchDrawCommands';
import { setPathPreview } from './sketchPathDrawing';
import { valueText } from './numberText';

const fmt = valueText;
const ok = (error: string | null): Result => ({ text: error ?? '', isError: !!error });
const sk = () => useSketcher.getState();

function num(v: Values, key: string): number {
    const raw = v[key];
    return typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
}

const list = (v: Values, key: string): string[] => (Array.isArray(v[key]) ? (v[key] as string[]) : []);
const name = (g: SketchGeometry, id: string): string => {
    const c = curveOf(g, id);
    return c ? `${CURVE_NOUN[c.kind][0].toUpperCase()}${CURVE_NOUN[c.kind].slice(1)} ${id}${c.construction ? ' (construction)' : ''}` : `${id} (deleted)`;
};

/**
 * A selection list of curves in order: clicks in the view add (or take away) curves while it is active. With
 * `order`, each row can move up or down, and with `flip` be flipped.
 */
function OrderedList({ api, valueKey, label, empty, accept, order, flip }: {
    api: PopupApi; valueKey: string; label: string; empty: string; accept: (g: SketchGeometry, id: string) => string | null;
    order?: boolean; flip?: { key: string; label: string };
}) {
    const g = useSketcher((s) => s.geometry);
    const [active, setActive] = useState(!list(api.values, valueKey).length);
    const latest = useRef(api);
    latest.current = api;
    const ids = list(api.values, valueKey);
    useEffect(() => {
        if (!active) {
            stopPicker();
            return;
        }
        startPicker({
            back: 'select',
            accept: (geometry, pick) => (pick.type !== 'curve' || !curveOf(geometry, pick.id) ? 'Pick a curve of the sketch.' : accept(geometry, pick.id)),
            onPick: (pick) => {
                const now = list(latest.current.values, valueKey);
                latest.current.set({ [valueKey]: now.includes(pick.id) ? now.filter((id) => id !== pick.id) : [...now, pick.id] });
            },
        });
    }, [active]);
    useEffect(() => () => {
        stopPicker();
        setHighlight([]);
    }, []);
    useEffect(() => setHighlight(ids), [ids.join()]);
    const move = (i: number, by: number) => {
        const next = [...ids];
        [next[i], next[i + by]] = [next[i + by], next[i]];
        api.set({ [valueKey]: next });
    };
    const flipped = flip ? list(api.values, flip.key) : [];
    return (
        <div className="tb-field pm-pick">
            <span>{label}</span>
            <ul className={`pm-contours pm-pick-list ${active ? 'active' : ''}`} tabIndex={0} aria-label={label} onClick={() => setActive(true)} onFocus={() => setActive(true)}>
                {!ids.length && <li className="pm-contours-all">{active ? 'Click them in the view' : empty}</li>}
                {ids.map((id, i) => (
                    <li key={id}>
                        <span>{name(g, id)}{flipped.includes(id) ? ' · flipped' : ''}</span>
                        {order && (
                            <>
                                <button type="button" title="Move up" aria-label={`Move ${name(g, id)} up`} disabled={i === 0}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        move(i, -1);
                                    }}
                                >
                                    ↑
                                </button>
                                <button type="button" title="Move down" aria-label={`Move ${name(g, id)} down`} disabled={i === ids.length - 1}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        move(i, 1);
                                    }}
                                >
                                    ↓
                                </button>
                            </>
                        )}
                        {flip && (
                            <button type="button" title={flip.label} aria-label={`${flip.label}: ${name(g, id)}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    api.set({ [flip.key]: flipped.includes(id) ? flipped.filter((x) => x !== id) : [...flipped, id] });
                                }}
                            >
                                ⇄
                            </button>
                        )}
                        <button type="button" title="Remove from the selection" aria-label={`Remove ${name(g, id)}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                api.set({ [valueKey]: ids.filter((x) => x !== id) });
                            }}
                        >
                            ×
                        </button>
                    </li>
                ))}
            </ul>
            {active && <button type="button" className="sk-small" onClick={() => setActive(false)}>Done picking</button>}
        </div>
    );
}

const selectedCurves = () => sk().selection.filter((x) => x.type === 'curve').map((x) => x.id).filter((id) => !!curveOf(sk().geometry, id));

// ---- Select chain, reverse endpoint tangent, infinite length -------------------------------------------------

const selectChain: ToolDef = {
    id: 'sk-select-chain',
    label: 'Select chain',
    icon: 'select-chain',
    hint: 'selects the entities joined end to end with the selected one, both ways up to a branch (right-click an entity)',
    instant: () => report(selectChainSelected()),
};

const reverseTangent: ToolDef = {
    id: 'sk-reverse-tangent',
    label: 'Reverse endpoint tangent',
    icon: 'reverse-tangent',
    hint: 'the selected arc flips over to the other side of its ends, still tangent where it was',
    instant: () => report(reverseTangentSelected()),
};

const infiniteLength: ToolDef = {
    id: 'sk-infinite-length',
    label: 'Infinite length',
    icon: 'infinite-line',
    hint: 'the selected line runs on without end both ways',
    instant: () => report(makeEndlessSelected()),
};

// ---- Align grid / origin -----------------------------------------------------------------------------------------

const pointPick = (g: SketchGeometry, pick: { type: string; id: string }) => (pick.type === 'point' && (pick.id === ORIGIN || pointOf(g, pick.id)) ? null : 'Pick a point or a vertex.');
const linePick = (g: SketchGeometry, pick: { type: string; id: string }) => (pick.type === 'curve' && curveOf(g, pick.id)?.kind === 'line' ? null : 'Pick a line of the sketch.');

function alignOptions(v: Values): AlignOptions {
    return {
        origin: String(v.origin ?? '') || undefined, axis: String(v.axis ?? '') || undefined, axisIs: v.axisIs === 'y' ? 'y' : 'x', flip: !!v.flip,
        mode: v.mode === 'all' ? 'all' : 'origin',
    };
}

/** The new origin and X axis as a ghost while the form is open. */
function AlignPreview({ api }: { api: PopupApi }) {
    const g = useSketcher((s) => s.geometry);
    const o = alignOptions(api.values);
    useEffect(() => {
        const f = o.origin || o.axis ? alignFrame(g, o) : null;
        setPathPreview({ origin: f && !('error' in f) ? { at: f.at, x: [Math.cos(f.angle), Math.sin(f.angle)] } : null });
    }, [g, o.origin, o.axis, o.axisIs, o.flip]);
    useEffect(() => () => setPathPreview({ origin: null }), []);
    return null;
}

const alignGrid: ToolDef = {
    id: 'sk-align-grid',
    label: 'Align grid/origin',
    icon: 'align-grid',
    hint: 'moves the sketch origin to a point and its X or Y axis along a line',
    panel: true,
    width: 300,
    fields: () => [
        { key: 'axisIs', label: 'The line is the', kind: 'select', section: 'Selections', options: [{ value: 'x', label: 'X axis' }, { value: 'y', label: 'Y axis' }] },
        { key: 'flip', label: 'Flip the axes 180°', kind: 'check', section: 'Selections' },
        {
            key: 'mode', label: 'Relocate', kind: 'select', section: 'Selections',
            options: [{ value: 'origin', label: 'Relocate origin' }, { value: 'all', label: 'Relocate all sketch entities' }],
        },
    ],
    defaults: () => {
        const s = sk();
        const point = s.selection.find((x) => x.type === 'point')?.id ?? '';
        const line = s.selection.find((x) => x.type === 'curve' && curveOf(s.geometry, x.id)?.kind === 'line')?.id ?? '';
        return { origin: point, axis: line, axisIs: 'x', flip: false, mode: 'origin' };
    },
    top: (api) => (
        <>
            <PickBoxes
                api={api}
                boxes={[
                    { key: 'origin', label: 'Sketch origin location', accept: pointPick },
                    { key: 'axis', label: 'X axis or Y axis', accept: linePick },
                ]}
            />
            <p className="tb-note">
                Relocate origin: the entities stay where they are; what was tied to the old origin and axes stays tied to a locked
                point and locked construction lines in their place. Relocate all sketch entities: the sketch moves with its origin.
            </p>
        </>
    ),
    extra: (api) => <AlignPreview api={api} />,
    apply: async (v) => ok(applyAlignGrid(alignOptions(v))),
};

// ---- Make path / path properties ---------------------------------------------------------------------------------

const pathMember = (g: SketchGeometry, id: string) => {
    const c = curveOf(g, id);
    return c?.kind === 'line' || c?.kind === 'arc' ? null : 'A path is made of lines and arcs.';
};

/** The path the form edits: the selected one (Path Properties), or none (Make Path). */
function editedPath(): SketchPath | null {
    const first = selectedCurves()[0];
    const path = first ? pathOf(sk().geometry, first) : null;
    return path && !path.belt ? path : null;
}

function pathValues(path: SketchPath | null): Values {
    const g = sk().geometry;
    const curves = path ? path.curves : selectedCurves().filter((id) => !pathMember(g, id));
    const dim = path && g.constraints.find((k) => k.kind === 'pathLength' && k.curves.length === path.curves.length && k.curves.every((c) => path.curves.includes(c)));
    const length = dim && dim.kind === 'pathLength' ? dim.value : path ? pathLength(g, path) : 0;
    return { id: path?.id ?? '', curves, lengthDim: !!dim, driving: !!dim && dim.kind === 'pathLength' && !dim.driven, length: fmt(length) };
}

/** The path tangent relations of the path, each with Delete. */
function PathRelations({ id }: { id: string }) {
    const g = useSketcher((s) => s.geometry);
    const rows = g.constraints.filter((k) => k.kind === 'pathTangent' && k.path === id);
    return (
        <PmSection title="Existing relations">
            {!rows.length && <p className="tb-note">None yet. Tangent with the path and another entity (Add relation) keeps them touching as they move.</p>}
            <div className="sk-list">
                {rows.map((k) => k.kind === 'pathTangent' && (
                    <div key={k.id} className="sk-row" onMouseEnter={() => setHighlight([k.curve])} onMouseLeave={() => setHighlight([])}>
                        <span className="sk-row-text"><b>Tangent</b><small>{name(g, k.curve)}</small></span>
                        <button type="button" className="sk-row-x" title="Delete" aria-label="Delete the relation" onClick={() => deleteConstraints([k.id])}>×</button>
                    </div>
                ))}
            </div>
        </PmSection>
    );
}

function pathTool(id: 'sk-make-path' | 'sk-pm-path'): ToolDef {
    return {
        id,
        label: id === 'sk-make-path' ? 'Make path' : 'Path properties',
        icon: 'make-path',
        hint: 'lines and arcs joined end to end become one path: tangent relations then pass along it (cams), with a path length',
        panel: true,
        width: 300,
        fields: () => [
            { key: 'lengthDim', label: 'Path length dimension', kind: 'check', section: 'Path length dimension' },
            { key: 'driving', label: 'Driving', kind: 'check', section: 'Path length dimension', show: (v) => !!v.lengthDim },
            { key: 'length', label: 'Path length', kind: 'number', unit: 'mm', min: 0, section: 'Path length dimension', show: (v) => !!v.lengthDim && !!v.driving },
        ],
        defaults: () => pathValues(id === 'sk-pm-path' ? editedPath() : null),
        top: (api) => (
            <>
                {api.values.id && <PathRelations id={String(api.values.id)} />}
                <PmSection title="Definition">
                    <OrderedList api={api} valueKey="curves" label="Selected entities" empty="Click here, then the lines and arcs of the chain" accept={pathMember} />
                    <div className="sk-list-actions">
                        <button type="button" className="sk-small" title="Adds every entity joined end to end with those listed"
                            onClick={() => api.set({ curves: selectChains(sk().geometry, list(api.values, 'curves')).filter((c) => !pathMember(sk().geometry, c)) })}
                        >
                            Select chain
                        </button>
                        {api.values.id && (
                            <button type="button" className="sk-small danger" onClick={() => api.run(async () => ok(deletePath(String(api.values.id))))}>
                                Delete path
                            </button>
                        )}
                    </div>
                </PmSection>
            </>
        ),
        apply: async (v) => {
            const driving = !!v.driving;
            const r = applyPath(list(v, 'curves'), String(v.id ?? '') || null, { show: !!v.lengthDim, driving, value: driving ? num(v, 'length') : undefined });
            return 'error' in r ? ok(r.error) : ok(null);
        },
    };
}

// ---- Belt / chain --------------------------------------------------------------------------------------------------

const pulleyPick = (g: SketchGeometry, id: string) => {
    const c = curveOf(g, id);
    if (c?.kind !== 'circle' && c?.kind !== 'arc') {
        return 'Belt members are circles and arcs.';
    }
    return pathOf(g, id)?.belt ? 'That is a curve of a belt, not a pulley.' : null;
};

/** The belt being edited: the selected belt, if any. */
function editedBelt(): SketchPath | null {
    const first = selectedCurves()[0];
    const path = first ? pathOf(sk().geometry, first) : null;
    return path?.belt ? path : null;
}

function beltOf(v: Values): SketchBelt {
    const pulleys = list(v, 'pulleys');
    const flipped = list(v, 'flipped');
    const thickness = v.useThickness ? num(v, 'thickness') : 0;
    return {
        pulleys, flip: pulleys.map((p) => flipped.includes(p)),
        ...(thickness > 0 ? { thickness } : {}), ...(v.driving ? { length: num(v, 'length') } : {}),
    };
}

/** The belt the form would build, as a ghost, and its length. */
function BeltPreview({ api }: { api: PopupApi }) {
    const g = useSketcher((s) => s.geometry);
    const belt = beltOf(api.values);
    const key = JSON.stringify(belt);
    const preview = useMemo(() => (belt.pulleys.length >= 2 ? beltPreview(g, { ...belt, length: undefined }) : null), [g, key]);
    useEffect(() => {
        setPathPreview({ entities: preview && !('error' in preview) ? preview : [] });
    }, [preview]);
    useEffect(() => () => setPathPreview({ entities: [] }), []);
    if (!preview) {
        return <p className="tb-note">Pick two or more circles or arcs, in the order the belt runs round them.</p>;
    }
    if ('error' in preview) {
        return <p className="tb-note pm-pick-note">{preview.error}</p>;
    }
    const length = preview.reduce((sum, e) => {
        if (e.kind === 'line') {
            return sum + Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
        }
        if (e.kind !== 'arc') {
            return sum;
        }
        // The arc's length from its ends and middle point.
        const [a, b, m] = [e.a, e.b, e.m];
        const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
        if (Math.abs(d) < 1e-12) {
            return sum + Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
        const sq = (p: [number, number]) => p[0] * p[0] + p[1] * p[1];
        const c: [number, number] = [(sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d, (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d];
        const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
        const t0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
        let t1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
        while (t1 <= t0) {
            t1 += 2 * Math.PI;
        }
        return sum + r * (t1 - t0);
    }, 0);
    return <p className="tb-note">Belt length now: <b>{fmt(length)} mm</b>{api.values.driving ? '; Driving sets it, and the pulleys move to suit.' : '.'}</p>;
}

function beltValues(path: SketchPath | null): Values {
    const g = sk().geometry;
    if (!path?.belt) {
        const pulleys = selectedCurves().filter((id) => !pulleyPick(g, id));
        return { id: '', pulleys, flipped: [], driving: false, length: '0', useThickness: false, thickness: '1' };
    }
    const b = path.belt;
    return {
        id: path.id, pulleys: [...b.pulleys], flipped: b.pulleys.filter((_, i) => b.flip[i]), driving: b.length !== undefined,
        length: fmt(b.length ?? pathLength(g, path)), useThickness: !!b.thickness, thickness: fmt(b.thickness ?? 1),
    };
}

const belt: ToolDef = {
    id: 'sk-belt',
    label: 'Belt/chain',
    icon: 'belt',
    hint: 'a belt round circles and arcs: tangent lines between them and arcs round each, one path',
    panel: true,
    width: 300,
    fields: () => [
        { key: 'driving', label: 'Driving', kind: 'check', section: 'Properties' },
        { key: 'length', label: 'Belt length', kind: 'number', unit: 'mm', min: 0, section: 'Properties', show: (v) => !!v.driving },
        { key: 'useThickness', label: 'Use belt thickness', kind: 'check', section: 'Properties' },
        { key: 'thickness', label: 'Belt thickness', kind: 'number', unit: 'mm', min: 0, section: 'Properties', show: (v) => !!v.useThickness },
    ],
    defaults: () => beltValues(editedBelt()),
    top: (api) => (
        <PmSection title="Belt members">
            <OrderedList api={api} valueKey="pulleys" label="Pulley components" empty="Click here, then the circles and arcs in order" accept={pulleyPick}
                order flip={{ key: 'flipped', label: 'Flip belt side' }}
            />
            <div className="sk-list-actions">
                <button type="button" className="sk-small" title="The belt goes round every pulley on its other side"
                    onClick={() => {
                        const pulleys = list(api.values, 'pulleys');
                        const flipped = list(api.values, 'flipped');
                        api.set({ flipped: pulleys.filter((p) => !flipped.includes(p)) });
                    }}
                >
                    Flip belt side
                </button>
            </div>
        </PmSection>
    ),
    extra: (api) => <BeltPreview api={api} />,
    apply: async (v) => {
        const b = beltOf(v);
        if (b.length !== undefined && !(b.length > 0)) {
            return ok('The belt length must be above zero.');
        }
        if (v.useThickness && !(num(v, 'thickness') >= 0)) {
            return ok('The belt thickness must be zero or more.');
        }
        const r = applyBelt(b, String(v.id ?? '') || null);
        return 'error' in r ? ok(r.error) : ok(null);
    },
};

// ---- Slot PropertyManager (a slot that is there) -------------------------------------------------------------------

function selectedSlot(): SlotFound | null {
    return slotAmong(sk().geometry, selectedCurves());
}

function slotValues(): Values {
    const found = selectedSlot();
    if (!found) {
        return {};
    }
    const overall = found.kind === 'straight' && sk().drawOptions.slotOverall;
    const p = slotParams(sk().geometry, found, overall);
    return {
        overall: overall ? 'overall' : 'centre', cx: fmt(p.cx), cy: fmt(p.cy), width: fmt(p.width), length: fmt(p.length),
        ...(found.kind === 'arc' ? { radius: fmt(p.radius!), angle: fmt(p.angle!) } : {}),
    };
}

/** OK: the slot's length dimension kind and parameters, applied only if its relations let the values hold. */
function applySlot(v: Values): string | null {
    const found = selectedSlot();
    if (!found) {
        return 'Select the slot in the view again.';
    }
    const overall = v.overall === 'overall';
    let g = setSlotLengthKind(sk().geometry, found, overall);
    const next = {
        cx: num(v, 'cx'), cy: num(v, 'cy'), width: num(v, 'width'), length: num(v, 'length'),
        ...(found.kind === 'arc' ? { radius: num(v, 'radius'), angle: num(v, 'angle') } : {}),
    };
    if (Object.values(next).some((x) => !Number.isFinite(x))) {
        return 'Every parameter must be a number.';
    }
    const before = slotParams(g, found, overall);
    const same = (Object.keys(next) as (keyof typeof next)[]).every((k) => Math.abs((next[k] ?? 0) - (before[k] ?? 0)) < 1e-12);
    if (!same) {
        const edited = editSlot(g, found, next, overall);
        if (typeof edited === 'string') {
            return edited;
        }
        if (solverReady()) {
            const solved = solveGeometry(edited);
            const after = solved.ok ? slotAmong(solved.geometry, slotCurveIds(found)) : null;
            const got = after ? slotParams(solved.geometry, after, overall) : null;
            const meant = slotParams(edited, found, overall);
            if (!got || (Object.keys(meant) as (keyof typeof meant)[]).some((k) => Math.abs((got[k] ?? 0) - (meant[k] ?? 0)) > 1e-6)) {
                return 'Relations or dimensions hold that value; change or delete them first.';
            }
        }
        g = edited;
    }
    useSketcher.setState({ drawOptions: { ...sk().drawOptions, slotOverall: overall } });
    return g === sk().geometry || commitGeometry(g) ? null : sk().message ?? 'Not applied.';
}

/** Fix Slot and Equal Slots for the selected slot. */
function SlotRelations() {
    const [note, setNote] = useState<string | null>(null);
    const relate = (tool: 'fixSlot' | 'equalSlots') => {
        const found = selectedSlot();
        if (!found) {
            setNote('Select the slot in the view again.');
            return;
        }
        if (tool === 'fixSlot') {
            setNote(addRelationToSelection('fixSlot') ?? 'Fixed: the slot keeps its size and place.');
            return;
        }
        // Equal slots: this slot, then a click on each other slot.
        useSketcher.setState({ selection: [{ type: 'curve', id: slotCurveIds(found)[0] }] });
        constraintTool('equalSlots');
        setNote('Now click a curve of the other slot.');
    };
    return (
        <PmSection title="Add relations">
            <div className="sk-list-actions">
                <button type="button" className="sk-small" title="The slot's size and place are fixed" onClick={() => relate('fixSlot')}>Fix slot</button>
                <button type="button" className="sk-small" title="Other slots keep the same size as this one" onClick={() => relate('equalSlots')}>Equal slots</button>
            </div>
            {note && <p className="tb-note">{note}</p>}
        </PmSection>
    );
}

const slotPm: ToolDef = {
    id: 'sk-pm-slot',
    label: 'Slot',
    icon: 'slot',
    hint: 'the selected slot',
    panel: true,
    width: 300,
    fields: (): Field[] => {
        const found = selectedSlot();
        const number = (key: string, label: string, unit = 'mm'): Field => ({ key, label, kind: 'number', unit, section: 'Parameters' });
        return [
            ...(found?.kind === 'straight' ? [{
                key: 'overall', label: 'Length', kind: 'select', section: 'Options',
                options: [{ value: 'centre', label: 'Centre to centre' }, { value: 'overall', label: 'Overall length' }],
            } as Field] : []),
            number('cx', 'Centre X'), number('cy', 'Centre Y'), number('width', 'Width'), number('length', 'Length'),
            ...(found?.kind === 'arc' ? [number('radius', 'Radius'), number('angle', 'Angle', 'deg')] : []),
        ];
    },
    defaults: () => slotValues(),
    top: () => (selectedSlot() ? <SlotRelations /> : <p className="tb-note">Select a slot in the view first.</p>),
    apply: async (v) => ok(applySlot(v)),
};

/** In the Draw group. */
export const drawCommandTools: ToolDef[] = [belt];
/** In the Modify group. */
export const modifyCommandTools: ToolDef[] = [pathTool('sk-make-path'), selectChain, reverseTangent, alignGrid];
/** Opened from the view (a click, the right-click menu), not on the toolbar. */
export const drawCommandForms: ToolDef[] = [pathTool('sk-pm-path'), slotPm, infiniteLength];
