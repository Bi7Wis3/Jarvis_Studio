// Further sketch tools, kept apart from toolDefs.tsx: draw tools, modify tools and relation tools that the sketch
// toolbar groups include after their own.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import type { Field, PopupApi, Result, ToolDef, Values } from './toolDefs';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, isDimension, solveGeometry, solverReady } from './solver';
import {
    clearTransformPicks, deleteConstraints, describe, fullyDefineSketch, repairAll, repairProblem, selectConstraint, setHighlight, setSnapKind, setTool,
    startTransformPick, stopTransformPick, transformCentre, transformSelected, useSketcher, type TransformKind,
} from './sketcher';
import { constraintRefs, liveIds } from './sketchGeometry';
import { findProblems } from './sketchRepair';
import type { Transform } from './sketchEdit';
import { QUICK_SNAPS } from './snapping';
import type { Pt } from './sketchMath';

const fmt = (n: number): string => String(Math.round(n * 100) / 100);

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
};

/** What the form will act on, live. */
function TransformNote({ kind }: { kind: TransformKind }) {
    const count = useSketcher((s) => s.selection.filter((x) => x.type !== 'constraint').length);
    const by = kind === 'move' || kind === 'copy';
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
        if (kind === 'move' || kind === 'copy') {
            if (picks.length < 2) {
                return;
            }
            const [a, b] = picks;
            const by: Pt = [b[0] - a[0], b[1] - a[1]];
            clearTransformPicks();
            api.set({ by0: fmt(by[0]), by1: fmt(by[1]) });
            api.run(() => runTransform({ kind: 'move', by }, !!api.values.copy));
            return;
        }
        const c = picks[picks.length - 1];
        clearTransformPicks();
        api.set({ centre0: fmt(c[0]), centre1: fmt(c[1]) });
    }, [picks]);
    return null;
}

async function runTransform(t: Transform, copy: boolean): Promise<Result> {
    const error = transformSelected(t, copy);
    return { text: error ?? '', isError: !!error };
}

function transformTool(kind: TransformKind): ToolDef {
    const { label, icon, hint } = TRANSFORMS[kind];
    const by = kind === 'move' || kind === 'copy';
    return {
        id: `sk-${kind}`,
        label,
        icon,
        hint,
        width: 300,
        panel: true,
        fields: () => [
            ...(by ? [vecField('by', 'Move by', 'mm')] : []),
            ...(kind === 'rotate' ? [{ key: 'angle', label: 'Angle', kind: 'number', unit: 'deg' } as Field] : []),
            ...(kind === 'scale' ? [{ key: 'factor', label: 'Factor', kind: 'number', unit: '×', min: 0, step: 0.1 } as Field] : []),
            ...(by ? [] : [vecField('centre', 'About', 'mm')]),
            { key: 'copy', label: 'Keep the original (copy)', kind: 'check' },
        ],
        defaults: () => {
            const [u, v] = transformCentre();
            return {
                by0: '10', by1: '0', by2: '0', angle: '90', factor: '2', centre0: fmt(u), centre1: fmt(v), centre2: '0',
                copy: kind === 'copy',
            };
        },
        top: () => <TransformNote kind={kind} />,
        extra: (api) => <TransformPicker kind={kind} api={api} />,
        apply: (v) => attempt(async () => {
            const centre: Pt = by ? [0, 0] : [num(v, 'centre0', 'Centre U'), num(v, 'centre1', 'Centre V')];
            const t: Transform = by ? { kind: 'move', by: [num(v, 'by0', 'Move U'), num(v, 'by1', 'Move V')] }
                : kind === 'rotate' ? { kind: 'rotate', centre, angle: num(v, 'angle', 'Angle') }
                    : { kind: 'scale', centre, factor: num(v, 'factor', 'Factor') };
            return runTransform(t, !!v.copy);
        }),
    };
}

/** Repair sketch: the problems found, each with its fix; hovering one lights up its geometry. */
function RepairList() {
    const g = useSketcher((s) => s.geometry);
    const problems = useMemo(() => findProblems(g), [g]);
    useEffect(() => () => setHighlight([]), []);
    if (!problems.length) {
        return <p className="tb-note">No problems found: no gaps, overlapping duplicates, zero-length curves or relations to deleted geometry.</p>;
    }
    return (
        <>
            <div className="sk-list">
                {problems.map((p) => (
                    <div key={p.key} className="sk-row" onMouseEnter={() => setHighlight(p.refs)} onMouseLeave={() => setHighlight([])}>
                        <span className="sk-row-text">{p.text}</span>
                        <button type="button" className="sk-small" onClick={() => repairProblem(p)}>{p.action}</button>
                    </div>
                ))}
            </div>
            <div className="sk-list-actions">
                <button type="button" className="sk-small" onClick={() => repairAll()}>Fix all</button>
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

const KIND_NAMES: Record<SketchConstraint['kind'], string> = {
    coincident: 'Coincident', horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Parallel', perpendicular: 'Perpendicular',
    tangent: 'Tangent', equal: 'Equal', pointOnCurve: 'On curve', midpoint: 'Midpoint', symmetric: 'Symmetric', fix: 'Lock',
    fixRadius: 'Lock radius', horizontalPoints: 'Horizontal', verticalPoints: 'Vertical', concentric: 'Concentric', coradial: 'Coradial',
    collinear: 'Collinear',
    distance: 'Distance', length: 'Length', angle: 'Angle', radius: 'Radius', diameter: 'Diameter',
};

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
    return curve ? `${curve.kind} ${id}` : `point ${id}`;
}

type RelationState = 'ok' | 'conflicting' | 'redundant' | 'dangling';
const STATE_TEXT: Record<RelationState, string> = { ok: 'satisfied', conflicting: 'conflicting', redundant: 'redundant', dangling: 'dangling' };

function RelationsList() {
    const g = useSketcher((s) => s.geometry);
    const selection = useSketcher((s) => s.selection);
    const conflicting = useSketcher((s) => s.conflicting);
    const [filter, setFilter] = useState<'all' | 'dangling' | 'problems'>('all');
    useEffect(() => () => setHighlight([]), []);
    const solved = useMemo(() => (solverReady() ? solveGeometry(g) : null), [g]);
    const alive = useMemo(() => liveIds(g), [g]);
    // Selected points and curves narrow the list to their relations. Selecting a relation (from the list) keeps the
    // list as it was; clearing the selection shows everything.
    const lastScope = useRef<string[]>([]);
    const geometryPicked = selection.filter((x) => x.type !== 'constraint').map((x) => x.id);
    if (geometryPicked.length || !selection.length) {
        lastScope.current = geometryPicked;
    }
    const scope = lastScope.current.filter((id) => alive.has(id));
    const rows = g.constraints.map((c) => {
        const refs = constraintRefs(c);
        const state: RelationState = refs.some((r) => !alive.has(r)) ? 'dangling'
            : conflicting.includes(c.id) || solved?.conflicting.includes(c.id) ? 'conflicting'
                : solved?.redundant.includes(c.id) ? 'redundant' : 'ok';
        return { c, refs, state };
    }).filter(({ refs, state }) => (!scope.length || refs.some((r) => scope.includes(r)))
        && (filter === 'all' || (filter === 'dangling' ? state === 'dangling' : state !== 'ok')));
    const selected = new Set(selection.map((x) => x.id));
    return (
        <>
            <p className="tb-note">
                {scope.length ? `Relations of the ${scope.length} selected item${scope.length === 1 ? '' : 's'}.` : 'All relations and dimensions in the sketch.'}
            </p>
            <div className="sk-list-filter">
                <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="Show">
                    <option value="all">All</option>
                    <option value="dangling">Dangling (deleted geometry)</option>
                    <option value="problems">Conflicting or redundant</option>
                </select>
                <button
                    type="button"
                    className="sk-small danger"
                    disabled={!rows.length}
                    onClick={() => {
                        if (window.confirm(`Delete ${rows.length} relation${rows.length === 1 ? '' : 's'}?`)) {
                            deleteConstraints(rows.map((r) => r.c.id));
                        }
                    }}
                >
                    Delete all
                </button>
            </div>
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
                            <b>{KIND_NAMES[c.kind]}{isDimension(c) ? ` ${describe(g, c.id)}` : ''}</b>
                            <small>{refs.map((r) => refLabel(g, r, alive)).join(', ')}</small>
                        </span>
                        <span className={`sk-state ${state}`}>{STATE_TEXT[state]}</span>
                        <button
                            type="button"
                            className="sk-row-x"
                            title="Delete"
                            aria-label={`Delete ${KIND_NAMES[c.kind]}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                deleteConstraints([c.id]);
                            }}
                        >
                            ×
                        </button>
                    </div>
                ))}
            </div>
        </>
    );
}

/** Shown at the end of the Constrain group. */
export const moreConstrainTools: ToolDef[] = [
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
    {
        id: 'sk-fully-define',
        label: 'Fully define',
        icon: 'fully-define',
        hint: 'add the dimensions the sketch still needs',
        instant: () => fullyDefineSketch(),
    },
];
