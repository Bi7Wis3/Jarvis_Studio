// Further sketch tools, kept apart from toolDefs.tsx: draw tools, modify tools and relation tools that the sketch
// toolbar groups include after their own.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Feature, SketchConstraint, SketchGeometry } from '@jarvis/core';
import type { Field, PopupApi, Result, ToolDef, Values } from './toolDefs';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, isDimension, solveGeometry, solverReady } from './solver';
import {
    clearTransformPicks, deleteConstraints, describe, fullyDefineSketch, repairAll, repairProblem, selectConstraint, setDimensionTool, setHighlight, setSnapKind, setTool,
    startTransformPick, stopTransformPick, stretchSelected, transformCentre, transformSelected, useSketcher, type TransformKind,
} from './sketcher';
import { constraintRefs, liveIds } from './sketchGeometry';
import { findProblems, GAP } from './sketchRepair';
import type { Transform } from './sketchEdit';
import { QUICK_SNAPS } from './snapping';
import { valueText } from './numberText';
import { CURVE_NOUN } from './sketchCurves';
import type { Pt } from './sketchMath';
import { RELATION_NAMES, relationName } from './sketchRelationNames';
import { addRelationsTool } from './sketchRelationForms';
import { sketchXpertTool } from './sketchXpertForm';
import { fullyDefineTool } from './sketchFullyDefineForm';
import { RELATION_FILTERS, externalRelations, relationStates, showsUnder, type RelationFilter, type RelationState } from './sketchRelationEdit';
import { definedEntities } from './sketchStatus';
import { undoSketch } from './sketcher';
import { PmSection } from './sketchPm';
import { moreDimensionTools } from './sketchDimForms';
import { QuickSnapButtons } from './sketchQuickSnaps';
import {
    cancelReplaceEntity, constraintTool, setDimensionsDriven, setOrdinateTool, setPathLengthTool, setSuppressed, startReplaceEntity,
} from './sketcher';

const fmt = valueText;

async function attempt(build: () => Promise<Result>): Promise<Result> {
    try {
        return await build();
    } catch (e) {
        return { text: e instanceof Error ? e.message : String(e), isError: true };
    }
}

function num(v: Values, key: string, label: string): number {
    const raw = v[key];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
        throw new Error(`${label} must be a number.`);
    }
    return n;
}

const vecField = (key: string, label: string, unit: string): Field => ({ key, label, kind: 'vec', unit, axes: ['U', 'V', ''] });

// ---- Draw: point, centreline, quick snaps -----------------------------------------------------------------

function QuickSnaps() {
    const kinds = useSketcher((s) => s.snapKinds);
    const snap = useSketcher((s) => s.snap);
    return (
        <div className="sk-snaps">
            <QuickSnapButtons />
            <p className="tb-note"><b>Sketch snaps</b> (kept on or off):</p>
            {!snap && <p className="tb-note">Snapping is off in the sketch settings.</p>}
            {QUICK_SNAPS.map(({ kind, label }) => (
                <label key={kind}>
                    <input type="checkbox" checked={kinds[kind] !== false} onChange={(e) => setSnapKind(kind, e.target.checked)} />
                    {label}
                </label>
            ))}
            <button type="button" className="sk-small" onClick={() => setSnapKind(null)}>All on</button>
        </div>
    );
}

/** Shown after the draw tools (line, rectangle, circle, ...). */
export const moreDrawTools: ToolDef[] = [
    {
        id: 'sk-centerline',
        label: 'Centreline',
        icon: 'centerline',
        hint: 'a construction line, e.g. to mirror or revolve about',
        instant: () => setTool('centerline'),
        active: (_, s) => s.sketchTool === 'centerline',
    },
    {
        id: 'sk-point',
        label: 'Point',
        icon: 'sk-point',
        hint: 'a sketch point on its own',
        instant: () => setTool('point'),
        active: (_, s) => s.sketchTool === 'point',
    },
    {
        id: 'sk-snaps',
        label: 'Quick snaps',
        icon: 'snap',
        hint: 'choose what the cursor snaps to',
        noApply: true,
        width: 220,
        top: () => <QuickSnaps />,
    },
];

// ---- Modify: move, copy, rotate, scale, repair ----------------------------------------------------------

const TRANSFORMS: Record<TransformKind, { label: string; icon: string; hint: string }> = {
    move: { label: 'Move', icon: 'move', hint: 'move the selected curves and points' },
    copy: { label: 'Copy', icon: 'duplicate', hint: 'copy the selected curves and points' },
    rotate: { label: 'Rotate', icon: 'rotate', hint: 'turn the selected curves about a point' },
    scale: { label: 'Scale', icon: 'scale', hint: 'scale the selected curves about a point' },
    stretch: { label: 'Stretch', icon: 'move', hint: 'move the selected curves and points; what is attached stretches' },
};

const movesBy = (kind: TransformKind) => kind === 'move' || kind === 'copy' || kind === 'stretch';

/** What the form will act on, live. */
function TransformNote({ kind }: { kind: TransformKind }) {
    const count = useSketcher((s) => s.selection.filter((x) => x.type !== 'constraint').length);
    const by = movesBy(kind);
    return (
        <p className="tb-note">
            {count ? <><b>{count}</b> selected. </> : <>Select the curves first: click them in the view (Shift adds). </>}
            {by ? 'Type how far, or click a point to move from and then where it goes.' : 'Click a point in the view for the centre, or type it.'}
        </p>
    );
}

/** Picks points in the view for the form while it is open. */
function TransformPicker({ kind, api }: { kind: TransformKind; api: PopupApi }) {
    const picks = useSketcher((s) => s.xform?.picks);
    useEffect(() => {
        startTransformPick(kind);
        return () => stopTransformPick();
    }, [kind]);
    useEffect(() => {
        if (!picks?.length) {
            return;
        }
        if (movesBy(kind)) {
            if (picks.length < 2) {
                return;
            }
            const [a, b] = picks;
            const by: Pt = [b[0] - a[0], b[1] - a[1]];
            clearTransformPicks();
            api.set({ by0: fmt(by[0]), by1: fmt(by[1]) });
            api.run(() => runTransform({ kind: 'move', by }, kind, { ...api.values, by0: fmt(by[0]), by1: fmt(by[1]) }));
            return;
        }
        const c = picks[picks.length - 1];
        clearTransformPicks();
        api.set({ centre0: fmt(c[0]), centre1: fmt(c[1]) });
    }, [picks]);
    return null;
}

async function runTransform(t: Transform, kind: TransformKind, v: Values): Promise<Result> {
    const error = kind === 'stretch' ? stretchSelected((t as { by: Pt }).by)
        : transformSelected(t, !!v.copy, { keepRelations: !!v.keep, copies: Number(v.copies) || 1 });
    return { text: error ?? '', isError: !!error };
}

/** The form's transform. */
function transformOf(kind: TransformKind, v: Values): Transform {
    const centre: Pt = movesBy(kind) ? [0, 0] : [num(v, 'centre0', 'Centre U'), num(v, 'centre1', 'Centre V')];
    return movesBy(kind) ? { kind: 'move', by: [num(v, 'by0', 'Move U'), num(v, 'by1', 'Move V')] }
        : kind === 'rotate' ? { kind: 'rotate', centre, angle: num(v, 'angle', 'Angle') }
            : { kind: 'scale', centre, factor: num(v, 'factor', 'Factor') };
}

/** Repeat: moves (or stretches) again by the same distance, keeping the form open. */
function RepeatButton({ kind, api }: { kind: TransformKind; api: PopupApi }) {
    return (
        <div className="sk-list-actions">
            <button type="button" className="sk-small" onClick={() => api.run(() => attempt(async () => runTransform(transformOf(kind, api.values), kind, api.values)), false)}>
                Repeat
            </button>
        </div>
    );
}

function transformTool(kind: TransformKind): ToolDef {
    const { label, icon, hint } = TRANSFORMS[kind];
    const by = movesBy(kind);
    const canCopy = kind !== 'stretch';
    return {
        id: `sk-${kind}`,
        label,
        icon,
        hint,
        width: 300,
        panel: true,
        fields: () => [
            ...(by ? [vecField('by', kind === 'stretch' ? 'Stretch by' : 'Move by', 'mm')] : []),
            ...(kind === 'rotate' ? [{ key: 'angle', label: 'Angle', kind: 'number', unit: 'deg' } as Field] : []),
            ...(kind === 'scale' ? [{ key: 'factor', label: 'Factor', kind: 'number', unit: '×', min: 0, step: 0.1 } as Field] : []),
            ...(by ? [] : [vecField('centre', 'About', 'mm')]),
            ...(canCopy ? [{ key: 'copy', label: 'Keep the original (copy)', kind: 'check' } as Field] : []),
            ...(canCopy ? [{ key: 'copies', label: 'Number of copies', kind: 'number', min: 1, step: 1, show: (v: Values) => !!v.copy } as Field] : []),
            ...(kind === 'move' || kind === 'rotate' ? [{ key: 'keep', label: 'Keep relations', kind: 'check', show: (v: Values) => !v.copy } as Field] : []),
        ],
        defaults: () => {
            const [u, v] = transformCentre();
            return {
                by0: '10', by1: '0', by2: '0', angle: '90', factor: '2', centre0: fmt(u), centre1: fmt(v), centre2: '0',
                copy: kind === 'copy', copies: '1', keep: false,
            };
        },
        top: () => <TransformNote kind={kind} />,
        extra: (api) => (
            <>
                <TransformPicker kind={kind} api={api} />
                {by && <RepeatButton kind={kind} api={api} />}
            </>
        ),
        apply: (v) => attempt(async () => runTransform(transformOf(kind, v), kind, v)),
    };
}

/** Repair sketch: the problems found, each with its fix; hovering one lights up its geometry. */
function RepairList() {
    const g = useSketcher((s) => s.geometry);
    const [gapText, setGapText] = useState(String(GAP));
    const gap = Number(gapText) > 0 ? Number(gapText) : GAP;
    const problems = useMemo(() => findProblems(g, gap), [g, gap]);
    useEffect(() => () => setHighlight([]), []);
    const gapField = (
        <label className="tb-field">
            <span>Showing gaps smaller than</span>
            <span className="tb-input">
                <input type="number" min={0} step="any" value={gapText} onChange={(e) => setGapText(e.target.value)} aria-label="Gap size" />
                <em>mm</em>
            </span>
        </label>
    );
    if (!problems.length) {
        return <>{gapField}<p className="tb-note">No problems found: no gaps, overlaps, tiny or zero-length curves, points shared by three or more entities or relations to deleted geometry.</p></>;
    }
    return (
        <>
            {gapField}
            <div className="sk-list">
                {problems.map((p) => (
                    <div key={p.key} className="sk-row" onMouseEnter={() => setHighlight(p.refs)} onMouseLeave={() => setHighlight([])}>
                        <span className="sk-row-text">{p.text}</span>
                        {p.action && <button type="button" className="sk-small" onClick={() => repairProblem(p)}>{p.action}</button>}
                    </div>
                ))}
            </div>
            <div className="sk-list-actions">
                <button type="button" className="sk-small" onClick={() => repairAll(gap)}>Fix all</button>
            </div>
        </>
    );
}

/** Shown at the end of the Modify group. */
export const moreModifyTools: ToolDef[] = [
    transformTool('move'),
    transformTool('copy'),
    transformTool('rotate'),
    transformTool('scale'),
    transformTool('stretch'),
    {
        id: 'sk-repair',
        label: 'Repair sketch',
        icon: 'repair',
        hint: 'close small gaps, remove duplicates and broken relations',
        noApply: true,
        width: 340,
        top: () => <RepairList />,
    },
];

// ---- Constrain: display / delete relations, fully define ------------------------------------------------

const KIND_NAMES = RELATION_NAMES;

/** A short name of what a relation refers to. */
function refLabel(g: SketchGeometry, id: string, alive: Set<string>): string {
    if (id === ORIGIN) {
        return 'origin';
    }
    if (id === AXIS_U || id === AXIS_V) {
        return id === AXIS_U ? 'horizontal axis' : 'vertical axis';
    }
    if (!alive.has(id)) {
        return `${id} (deleted)`;
    }
    const curve = curveOf(g, id);
    return curve ? `${CURVE_NOUN[curve.kind]} ${id}` : `point ${id}`;
}

const STATE_TEXT: Record<RelationState, string> = {
    ok: 'satisfied', conflicting: 'conflicting', redundant: 'over defining', dangling: 'dangling', unsolved: 'not solved', suppressed: 'suppressed',
};

/** The Entities group of the relation picked in the list: what it refers to, each with Replace. */
function RelationEntities({ id }: { id: string }) {
    const g = useSketcher((s) => s.geometry);
    const dof = useSketcher((s) => s.dof);
    const c = g.constraints.find((k) => k.id === id);
    const alive = useMemo(() => liveIds(g), [g]);
    // Status and Defined In of each entity: fully or under defined; this sketch, or copied in from the model or another sketch.
    const defined = useMemo(() => (dof > 0 ? definedEntities(g) : null), [g, dof]);
    const outside = useMemo(() => externalRelations(g).entities, [g]);
    if (!c) {
        return null;
    }
    const status = (r: string) => (dof === 0 || defined?.has(r) ? 'Fully defined' : 'Under defined');
    return (
        <PmSection title="Entities">
            <div className="sk-list">
                {constraintRefs(c).map((r) => (
                    <div key={r} className="sk-row" onMouseEnter={() => setHighlight(alive.has(r) ? [r] : [])} onMouseLeave={() => setHighlight([])}>
                        <span className="sk-row-text">
                            <b>{refLabel(g, r, alive)}</b>
                            <small>
                                {alive.has(r) ? `${status(r)} · ${outside.has(r) ? 'Same model (copied in, locked)' : 'Current sketch'}` : 'Deleted: replace it to repair the relation'}
                            </small>
                        </span>
                        <button
                            type="button"
                            className="sk-small"
                            title="Then click the entity that takes its place"
                            disabled={r === ORIGIN}
                            onClick={() => startReplaceEntity(c.id, r)}
                        >
                            Replace
                        </button>
                    </div>
                ))}
            </div>
        </PmSection>
    );
}

function RelationsList() {
    const g = useSketcher((s) => s.geometry);
    const context = useSketcher((s) => s.context);
    const selection = useSketcher((s) => s.selection);
    const conflicting = useSketcher((s) => s.conflicting);
    const geometryPicked = selection.filter((x) => x.type !== 'constraint').map((x) => x.id);
    // Opened on an over defined or unsolvable sketch: the problems first.
    const [filter, setFilter] = useState<RelationFilter>(conflicting.length || useSketcher.getState().redundant.length ? 'problems'
        : geometryPicked.length ? 'selected' : 'all');
    // Delete all asks in the form itself (no browser dialog): the count to delete, or null.
    const [askAll, setAskAll] = useState<number | null>(null);
    // Undo last relation change: the sketch as the last change made from this list left it.
    const mine = useRef<SketchGeometry | null>(null);
    const did = (change: () => unknown) => {
        const before = useSketcher.getState().geometry;
        change();
        const after = useSketcher.getState().geometry;
        mine.current = after !== before ? after : mine.current;
    };
    const outside = useMemo(() => externalRelations(g), [g]);
    useEffect(() => () => {
        setHighlight([]);
        cancelReplaceEntity();
    }, []);
    const solved = useMemo(() => (solverReady() ? solveGeometry(g) : null), [g]);
    const alive = useMemo(() => liveIds(g), [g]);
    const states = useMemo(() => relationStates(g, solved, conflicting), [g, solved, conflicting]);
    // Selected Entities: the points and curves selected; picking a relation in the list keeps the list as it was.
    const lastScope = useRef<string[]>([]);
    if (geometryPicked.length || !selection.length) {
        lastScope.current = geometryPicked;
    }
    const scope = lastScope.current.filter((id) => alive.has(id));
    const rows = g.constraints.map((c) => ({ c, refs: constraintRefs(c), state: states.get(c.id) ?? 'ok' }))
        .filter(({ c, state }) => showsUnder(filter, state, c, scope, outside));
    const selected = new Set(selection.map((x) => x.id));
    const picked = selection.filter((x) => x.type === 'constraint' && g.constraints.some((c) => c.id === x.id)).map((x) => x.id);
    return (
        <>
            <div className="sk-list-filter">
                <select value={filter} onChange={(e) => setFilter(e.target.value as RelationFilter)} aria-label="Filter">
                    {RELATION_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
                <button
                    type="button"
                    className="sk-small danger"
                    disabled={!picked.length}
                    onClick={() => did(() => deleteConstraints(picked))}
                >
                    Delete
                </button>
                {askAll === null ? (
                    <button type="button" className="sk-small danger" disabled={!rows.length} onClick={() => setAskAll(rows.length)}>
                        Delete all
                    </button>
                ) : (
                    <span className="sk-ask" role="alertdialog" aria-label="Delete all listed relations">
                        Delete {askAll} relation{askAll === 1 ? '' : 's'}?
                        <button
                            type="button"
                            className="sk-small danger"
                            onClick={() => {
                                setAskAll(null);
                                did(() => deleteConstraints(rows.map((r) => r.c.id)));
                            }}
                        >
                            Delete
                        </button>
                        <button type="button" className="sk-small" onClick={() => setAskAll(null)}>Keep</button>
                    </span>
                )}
                <button
                    type="button"
                    className="sk-small"
                    title="Undo last relation change: takes back the last delete, suppress, driven or replace made here"
                    disabled={!mine.current || mine.current !== g}
                    onClick={() => {
                        mine.current = null;
                        undoSketch();
                    }}
                >
                    Undo
                </button>
            </div>
            {filter === 'selected' && !scope.length && <p className="tb-note">Select points or curves in the view to see their relations.</p>}
            {!rows.length && <p className="tb-note">Nothing to show.</p>}
            <div className="sk-list">
                {rows.map(({ c, refs, state }) => (
                    <div
                        key={c.id}
                        className={`sk-row ${selected.has(c.id) ? 'on' : ''}`}
                        onMouseEnter={() => setHighlight(refs.filter((r) => alive.has(r)))}
                        onMouseLeave={() => setHighlight([])}
                        onClick={(e) => selectConstraint(c.id, e.shiftKey)}
                    >
                        <span className="sk-row-text">
                            <b>{relationName(c, context)}{isDimension(c) ? ` ${describe(g, c.id)}` : ''}</b>
                            <small>{refs.map((r) => refLabel(g, r, alive)).join(', ')}</small>
                        </span>
                        <span className={`sk-state ${state}`}>{STATE_TEXT[state]}</span>
                        <label className="sk-row-check" title="Suppressed: kept, but not solved" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={!!c.suppressed} onChange={(e) => did(() => setSuppressed([c.id], e.target.checked))} aria-label="Suppressed" />
                            <span>Supp.</span>
                        </label>
                        {isDimension(c) && (
                            <label className="sk-row-check" title="Driven: follows the geometry, holds nothing" onClick={(e) => e.stopPropagation()}>
                                <input type="checkbox" checked={!!c.driven} onChange={(e) => did(() => setDimensionsDriven([c.id], e.target.checked))} aria-label="Driven" />
                                <span>Driven</span>
                            </label>
                        )}
                        <button
                            type="button"
                            className="sk-row-x"
                            title="Delete"
                            aria-label={`Delete ${KIND_NAMES[c.kind]}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                did(() => deleteConstraints([c.id]));
                            }}
                        >
                            ×
                        </button>
                    </div>
                ))}
            </div>
            {picked.length === 1 && <RelationEntities id={picked[0]} />}
        </>
    );
}

/** Shown at the end of the Constrain group. */
export const moreConstrainTools: ToolDef[] = [
    {
        id: 'sk-dim-horizontal',
        label: 'Horizontal dimension',
        icon: 'dim-horizontal',
        hint: 'a distance along the sketch’s horizontal: two points, a line, or centres',
        instant: () => setDimensionTool('u'),
        active: (_, s) => s.sketchTool === 'dimension' && useSketcher.getState().dimLock === 'u',
    },
    {
        id: 'sk-dim-vertical',
        label: 'Vertical dimension',
        icon: 'dim-vertical',
        hint: 'a distance along the sketch’s vertical: two points, a line, or centres',
        instant: () => setDimensionTool('v'),
        active: (_, s) => s.sketchTool === 'dimension' && useSketcher.getState().dimLock === 'v',
    },
    ...(['u', 'v'] as const).map((axis): ToolDef => ({
        id: axis === 'u' ? 'sk-dim-ordinate' : 'sk-dim-ordinate-v',
        label: axis === 'u' ? 'Horizontal ordinate' : 'Vertical ordinate',
        icon: 'dim-ordinate',
        hint: `a zero, then each point's ${axis === 'u' ? 'horizontal' : 'vertical'} distance from it, in one row`,
        instant: () => setOrdinateTool(axis),
        active: (_, s) => {
            const special = useSketcher.getState().dimSpecial;
            return s.sketchTool === 'dimension' && special?.kind === 'ordinate' && special.axis === axis && !special.auto;
        },
    })),
    {
        id: 'sk-dim-path',
        label: 'Path length',
        icon: 'dim-path',
        hint: 'the total length of a chain of lines and arcs, end to end; it drives the chain (driven if that over defines)',
        instant: () => setPathLengthTool(),
        active: (_, s) => s.sketchTool === 'dimension' && useSketcher.getState().dimSpecial?.kind === 'path',
    },
    ...moreDimensionTools,
    ...([
        { id: 'intersection', label: 'Intersection', hint: 'a point where two lines cross' },
        { id: 'equalSlots', label: 'Equal slots', hint: 'two or more straight slots: equal lengths and radii' },
        { id: 'fixSlot', label: 'Fix slot', hint: 'a straight slot keeps its size and place' },
    ] as const).map(({ id, label, hint }): ToolDef => ({
        id: `sk-c-${id}`,
        label,
        icon: id === 'intersection' ? 'c-intersection' : id === 'equalSlots' ? 'c-equal-slots' : 'c-fix-slot',
        hint,
        instant: () => constraintTool(id),
        active: (_, s) => s.sketchTool === `c:${id}`,
    })),
    addRelationsTool,
    sketchXpertTool,
    {
        id: 'sk-relations',
        label: 'Relations',
        icon: 'relations',
        hint: 'show and delete relations and dimensions',
        noApply: true,
        panel: true,
        width: 320,
        top: () => <RelationsList />,
    },
    fullyDefineTool,
];
