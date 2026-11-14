// The axis of revolution of a revolve, as the form keeps it (a select value) and as the preview needs it.
// Form values: 'u', 'v' (the sketch's own axes), 'line:<curve id>' (a line or centreline of the sketch),
// 'axis:<step id>' (an axis step) and 'x', 'y', 'z' (the part axes).

import type { Feature, RevolveAxis, RevolveType, SketchGeometry } from '@jarvis/core';
import { sketchCentrelines } from '@jarvis/core/reference';
import { valueText } from './numberText';
import type { Pt } from './sketchMath';

/** The Revolve form keeps one axis field per sketch step (each sketch has its own lines). */
export const revolveAxisKey = (sketchId: unknown): string => `axis_${String(sketchId ?? '')}`;

export function axisValue(axis: RevolveAxis | undefined): string {
    if (!axis) {
        return 'v';
    }
    if (typeof axis === 'string') {
        return axis;
    }
    return 'line' in axis ? `line:${axis.line}` : `axis:${axis.axisRef}`;
}

export function axisFromValue(value: unknown): RevolveAxis {
    const v = typeof value === 'string' ? value : '';
    if (v.startsWith('line:')) {
        return { line: v.slice(5) };
    }
    if (v.startsWith('axis:')) {
        return { axisRef: v.slice(5) };
    }
    return v === 'u' || v === 'x' || v === 'y' || v === 'z' ? v : 'v';
}

/** The default axis: the sketch's centreline when it has exactly one (as SolidWorks picks it), else its V axis. */
export function defaultAxis(geometry: SketchGeometry | undefined): string {
    const lines = sketchCentrelines({ geometry });
    return lines.length === 1 ? `line:${lines[0]}` : 'v';
}

/**
 * The axes a revolve can use: the sketch's U and V axes, each line and centreline of the sketch, and the axis steps
 * among `steps` (the part's steps before the revolve; none for a base body). `current` stays listed.
 */
export function axisOptions(geometry: SketchGeometry | undefined, steps: Feature[], current?: string): { value: string; label: string }[] {
    const options = [{ value: 'v', label: 'Sketch V (vertical)' }, { value: 'u', label: 'Sketch U (horizontal)' }];
    let centre = 0;
    let line = 0;
    for (const c of geometry?.curves ?? []) {
        if (c.kind === 'line') {
            options.push({ value: `line:${c.id}`, label: c.construction ? `Centreline ${++centre}` : `Line ${++line}` });
        }
    }
    for (const f of steps) {
        if (f.op === 'axis' && !f.suppressed) {
            options.push({ value: `axis:${f.id}`, label: f.name ?? f.id });
        }
    }
    if (current && !options.some((o) => o.value === current)) {
        options.push({ value: current, label: /^[xyz]$/.test(current) ? `${current.toUpperCase()} axis` : current });
    }
    return options;
}

/**
 * Where a profile sits around an axis in its sketch plane, for a lathe preview: each outline point as (radius,
 * height along the axis), and the unit (u, v) direction from the axis to the profile side.
 */
export function latheProfile(outline: Pt[], axis: { point: Pt; direction: Pt }): { points: Pt[]; side: Pt } {
    const [pu, pv] = axis.point;
    const [du, dv] = axis.direction;
    // Signed distance to the left of the axis direction; the profile is on one side.
    const across = outline.map(([u, v]) => du * (v - pv) - dv * (u - pu));
    const left = across.reduce((s, a) => s + a, 0) >= 0;
    const side: Pt = left ? [-dv, du] : [dv, -du];
    return {
        points: outline.map(([u, v], i) => [Math.abs(across[i]), (u - pu) * du + (v - pv) * dv]),
        side,
    };
}

// ---- Form values <-> step fields ---------------------------------------------------------------------------

export interface RevolveOptionValues {
    axis: RevolveAxis;
    angle: number;
    type?: RevolveType;
    reverse?: boolean;
    angle2?: number | null;
}

const fmt = valueText;

/** Form values for a revolve's options (the axis is its own field). */
export function revolveValues(o: Partial<RevolveOptionValues>): Record<string, string | boolean> {
    return {
        angle: fmt(o.angle ?? 360), revolveType: o.type ?? 'blind', reverse: !!o.reverse,
        revSecond: !!o.angle2, angle2: fmt(o.angle2 || 90),
    };
}

/** The revolve options from form values; `read` reads (and, strict, checks) a number field. */
export function readRevolve(v: Record<string, unknown>, axis: unknown, read: (key: string, label: string) => number, strict = false): RevolveOptionValues {
    const angle = read('angle', 'Angle') || 360;
    const type = v.revolveType === 'midPlane' ? 'midPlane' : 'blind';
    const angle2 = type === 'blind' && v.revSecond ? read('angle2', 'Direction 2 angle') : 0;
    if (strict && angle + angle2 > 360) {
        throw new Error(angle2 ? 'The two angles add up to more than 360°.' : 'Angle must be at most 360°.');
    }
    return { axis: axisFromValue(axis), angle, type, reverse: type === 'blind' && !!v.reverse, angle2: angle2 || null };
}

/**
 * A revolve's option fields for a step. A new step leaves the defaults out; an edit sends every option, because an
 * update only changes the fields it is given (so 360°, Blind or no Direction 2 would otherwise keep the old value).
 */
export function revolveStepFields(r: RevolveOptionValues, stored: Feature | null | undefined): Record<string, unknown> {
    const edit = stored?.op === 'revolve' ? stored : null;
    const blind = r.type !== 'midPlane';
    return {
        axis: r.axis,
        ...(r.angle !== 360 || edit ? { angle: r.angle } : {}),
        ...(!blind ? { type: 'midPlane' } : edit?.type !== undefined ? { type: 'blind' } : {}),
        ...(blind && r.reverse ? { reverse: true } : edit?.reverse !== undefined ? { reverse: false } : {}),
        ...(blind && r.angle2 ? { angle2: r.angle2 } : edit?.angle2 != null ? { angle2: null } : {}),
    };
}

/** Start and sweep of a revolve in degrees, as the kernel builds it (see revolveRange on the server). */
export function revolveSpan(angle: number, type: string | undefined, reverse: boolean, angle2: number): [number, number] {
    if (type === 'midPlane') {
        return [-angle / 2, angle];
    }
    const sign = reverse ? -1 : 1;
    return [-sign * angle2, sign * (angle + angle2)];
}
