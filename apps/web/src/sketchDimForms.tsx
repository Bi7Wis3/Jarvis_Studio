// The Dimension PropertyManager of the selected sketch dimension (SolidWorks: Dimension PropertyManager): its value
// (zero or negative for a position dimension, with Reverse direction), Driven (a reference dimension that follows the
// geometry), for distances to arcs and circles the First and Second arc condition (Centre | Min | Max), and for
// ordinate and angular running dimensions Break alignment, Run bidirectionally and Add to this set. Opens in the left
// panel when a dimension is clicked in the view. Also the toolbar entries of the Ordinate and Angular Running tools.

import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import type { Field, Result, ToolDef, Values } from './toolDefs';
import { curveOf, isDimension, measure, pointOf } from './solver';
import { describe, replaceConstraint, useSketcher } from './sketcher';
import { evaluate } from './sketchGeometry';
import { valueText } from './numberText';
import type { Dimension } from './sketchDimensions';
import { ordinateFrame, positionDimension, runningFrame, typedValue } from './sketchDimGroups';
import { addToSet, reverseDimension, setBidirectional, setRunningTool, setSmartOrdinateTool, setUnaligned } from './sketchDimTools';
import { TOLERANCE_FIELDS, toleranceOf, toleranceValues } from './sketchDimTolerance';

type Cond = 'centre' | 'min' | 'max';

/** The selected dimension, if one is selected. */
function selectedDimension(): { g: SketchGeometry; c: Dimension } | null {
    const s = useSketcher.getState();
    const id = s.selection.find((x) => x.type === 'constraint')?.id;
    const c = id ? s.geometry.constraints.find((k) => k.id === id) : undefined;
    return c && isDimension(c) ? { g: s.geometry, c } : null;
}

/** The one arc or circle a point is the centre of, if exactly one. */
function roundOfCentre(g: SketchGeometry, point: string): string | null {
    const rounds = g.curves.filter((k) => (k.kind === 'circle' || k.kind === 'arc') && k.center === point);
    return rounds.length === 1 ? rounds[0].id : null;
}

/** For one end of a distance: the arc or circle it can measure to, and how it does now; null when it is not an arc end. */
function arcEnd(g: SketchGeometry, c: Dimension, side: 'a' | 'b'): { round: string; cond: Cond } | null {
    if (c.kind !== 'distance' || c.ordinate) {
        return null;
    }
    const id = side === 'a' ? c.a : c.b;
    const cond = side === 'a' ? c.aCond : c.bCond;
    const curve = curveOf(g, id);
    if (cond && (curve?.kind === 'circle' || curve?.kind === 'arc')) {
        return { round: id, cond };
    }
    if (pointOf(g, id)) {
        const round = roundOfCentre(g, id);
        return round ? { round, cond: 'centre' } : null;
    }
    return null;
}

const CONDS = [{ value: 'centre', label: 'Centre' }, { value: 'min', label: 'Min' }, { value: 'max', label: 'Max' }];

/** An ordinate or angular running dimension: one of an aligned group. */
const grouped = (g: SketchGeometry, c: Dimension) => !!ordinateFrame(g, c) || !!runningFrame(g, c);

function valuesOf(g: SketchGeometry, c: Dimension): Values {
    return {
        value: valueText(c.value),
        driven: !!c.driven,
        aCond: arcEnd(g, c, 'a')?.cond ?? 'centre',
        bCond: arcEnd(g, c, 'b')?.cond ?? 'centre',
        unaligned: (c.kind === 'distance' || c.kind === 'pointAngle') && !!c.unaligned,
        bidirectional: c.kind === 'pointAngle' && !!c.bidirectional,
        ...toleranceValues(c),
    };
}

/** The dimension with the form's arc conditions: an end at Centre measures from the centre point, Min / Max from the arc. */
function withConds(g: SketchGeometry, c: Dimension, v: Values): Dimension {
    if (c.kind !== 'distance') {
        return c;
    }
    const out: Record<string, unknown> = { ...c };
    let changed = false;
    for (const side of ['a', 'b'] as const) {
        const end = arcEnd(g, c, side);
        const want = String(v[`${side}Cond`] ?? 'centre') as Cond;
        const round = end ? curveOf(g, end.round) : undefined;
        if (!end || want === end.cond || (round?.kind !== 'circle' && round?.kind !== 'arc')) {
            continue;
        }
        const key = side === 'a' ? 'aCond' : 'bCond';
        if (want === 'centre') {
            out[side] = round.center;
            delete out[key];
        } else {
            out[side] = end.round;
            out[key] = want;
        }
        changed = true;
    }
    return changed ? out as unknown as Dimension : c;
}

function apply(v: Values): Result {
    const found = selectedDimension();
    if (!found) {
        return { text: 'Select a dimension in the view first.', isError: true };
    }
    const { g, c } = found;
    // Break alignment and Run bidirectionally act on the group first.
    if ((c.kind === 'distance' || c.kind === 'pointAngle') && grouped(g, c) && !!c.unaligned !== !!v.unaligned && !setUnaligned([c.id], !!v.unaligned)) {
        return { text: useSketcher.getState().message ?? 'Not applied.', isError: true };
    }
    if (c.kind === 'pointAngle' && c.running && !!c.bidirectional !== !!v.bidirectional && !setBidirectional(c.id, !!v.bidirectional)) {
        return { text: useSketcher.getState().message ?? 'Not applied.', isError: true };
    }
    const now0 = useSketcher.getState().geometry.constraints.find((k) => k.id === c.id) as Dimension | undefined;
    if (!now0) {
        return { text: 'That dimension is gone.', isError: true };
    }
    const g1 = useSketcher.getState().geometry;
    // Tolerance and precision only change how the value is shown.
    const tolerance = toleranceOf(v);
    const { tolerance: _t, ...plain } = now0;
    const shown = (tolerance ? { ...plain, tolerance } : plain) as Dimension;
    const conds = withConds(g1, shown, v);
    const changedConds = conds !== shown;
    const driven = !!v.driven;
    let next: Dimension;
    if (driven) {
        next = { ...conds, driven: true };
        next = { ...next, value: measure(g1, next as SketchConstraint) ?? next.value };
    } else {
        const { driven: _d, ...rest } = conds;
        const raw = evaluate(String(v.value ?? ''));
        // A changed arc condition, or a dimension that was driven, keeps the size the geometry has unless a value was typed.
        const now = measure(g1, rest as SketchConstraint) ?? now0.value;
        const keepNow = (changedConds || now0.driven) && raw !== null && Math.abs(raw - now0.value) < 1e-12;
        const typed = typedValue(g1, rest as SketchConstraint, keepNow ? now : raw);
        if ('error' in typed) {
            return { text: typed.error, isError: true };
        }
        next = { ...rest, value: typed.value } as Dimension;
        if (typed.reverse) {
            // A negative value: the point goes to the other side, then takes the value.
            const error = reverseDimension(c.id);
            if (error) {
                return { text: error, isError: true };
            }
        }
    }
    if (next === now0 || JSON.stringify(next) === JSON.stringify(now0)) {
        return { text: '', isError: false };
    }
    if (!replaceConstraint(c.id, next as SketchConstraint)) {
        return { text: useSketcher.getState().message ?? 'The sketch would not solve with that.', isError: true };
    }
    return { text: '', isError: false };
}

/** Reverse direction and Add to this set, as buttons under the fields. */
function DimensionActions() {
    const id = useSketcher((s) => s.selection.find((x) => x.type === 'constraint')?.id);
    const g = useSketcher((s) => s.geometry);
    const message = useSketcher((s) => s.message);
    const c = id ? g.constraints.find((k) => k.id === id) : undefined;
    if (!c || !isDimension(c)) {
        return null;
    }
    const reversible = !c.driven && positionDimension(g, c);
    const inSet = grouped(g, c);
    if (!reversible && !inSet) {
        return null;
    }
    return (
        <>
            <div className="sk-list-actions">
                {reversible && (
                    <button type="button" className="sk-small" title="Put the point on the other side of what it is measured from, at the same value" onClick={() => {
                        const error = reverseDimension(c.id);
                        if (error) {
                            useSketcher.setState({ message: error });
                        }
                    }}>
                        Reverse direction
                    </button>
                )}
                {inSet && (
                    <button type="button" className="sk-small" title="Click more points in the view to dimension them in this row or set" onClick={() => addToSet(c.id)}>
                        {c.kind === 'pointAngle' ? 'Add to running dimension' : 'Add to this ordinate'}
                    </button>
                )}
            </div>
            {message && <p className="tb-note">{message}</p>}
        </>
    );
}

export const dimensionForm: ToolDef = {
    id: 'sk-pm-dimension',
    label: 'Dimension',
    icon: 'dimension',
    hint: 'the selected dimension',
    panel: true,
    width: 300,
    fields: () => {
        const found = selectedDimension();
        const unit = found && (found.c.kind === 'angle' || found.c.kind === 'pointAngle') ? 'deg' : found?.c.kind === 'rho' ? '' : 'mm';
        const a = found ? arcEnd(found.g, found.c, 'a') : null;
        const b = found ? arcEnd(found.g, found.c, 'b') : null;
        const inSet = found ? grouped(found.g, found.c) : false;
        const running = found?.c.kind === 'pointAngle' && !!found.c.running;
        return [
            { key: 'value', label: 'Value', kind: 'text', unit, section: 'Primary value', show: (v: Values) => !v.driven },
            { key: 'driven', label: 'Driven (follows the geometry, holds nothing)', kind: 'check', section: 'Options' } as Field,
            ...(inSet ? [{ key: 'unaligned', label: 'Break alignment (moves on its own)', kind: 'check', section: 'Options' } as Field] : []),
            ...(running ? [{ key: 'bidirectional', label: 'Run bidirectionally (the nearer way, up to 180°)', kind: 'check', section: 'Options' } as Field] : []),
            ...(a ? [{ key: 'aCond', label: 'First arc condition', kind: 'select', options: CONDS, section: 'Arc condition' } as Field] : []),
            ...(b ? [{ key: 'bCond', label: 'Second arc condition', kind: 'select', options: CONDS, section: 'Arc condition' } as Field] : []),
            ...TOLERANCE_FIELDS,
        ];
    },
    defaults: () => {
        const found = selectedDimension();
        return found ? valuesOf(found.g, found.c) : {};
    },
    top: () => {
        const found = selectedDimension();
        if (!found) {
            return <p className="tb-note">Click a dimension in the view first.</p>;
        }
        const position = !found.c.driven && positionDimension(found.g, found.c);
        return (
            <p className="tb-note">
                <b>{describe(found.g, found.c.id)}</b>{found.c.driven ? ': a driven dimension; it follows the geometry.' : ''}
                {position ? ' A position dimension: zero is allowed, and a negative value puts it on the other side.' : ''}
            </p>
        );
    },
    extra: () => <DimensionActions />,
    apply: async (v) => {
        try {
            return apply(v);
        } catch (e) {
            return { text: e instanceof Error ? e.message : String(e), isError: true };
        }
    },
};

/** The Ordinate Dimension (direction from where the row goes) and Angular Running Dimension tools. */
export const moreDimensionTools: ToolDef[] = [
    {
        id: 'sk-dim-ordinate-auto',
        label: 'Ordinate dimension',
        icon: 'dim-ordinate',
        hint: 'a zero (a point or an edge), then where the row goes: above or below measures horizontally, to the side vertically',
        instant: () => setSmartOrdinateTool(),
        active: (_, s) => {
            const special = useSketcher.getState().dimSpecial;
            return s.sketchTool === 'dimension' && special?.kind === 'ordinate' && !!special.auto;
        },
    },
    {
        id: 'sk-dim-running',
        label: 'Angular running dimension',
        icon: 'dim-running',
        hint: 'a centre, the zero, the ring, then the angle of each point from the zero, anticlockwise',
        instant: () => setRunningTool(),
        active: (_, s) => s.sketchTool === 'dimension' && useSketcher.getState().dimSpecial?.kind === 'running',
    },
];
