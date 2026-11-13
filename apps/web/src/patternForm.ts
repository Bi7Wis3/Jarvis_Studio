// Form values <-> pattern features for the Linear pattern and Circular pattern tools (SolidWorks Linear Pattern and
// Circular Pattern PropertyManagers, as far as the kernel goes). Pure, so the round trips can be tested.

import type { AxisRef, Feature, Vec3 } from '@jarvis/core';

type Values = Record<string, string | boolean | string[]>;
type Option = { value: string; label: string };
type LinearPattern = Extract<Feature, { op: 'pattern'; kind: 'linear' }>;
type CircularPattern = Extract<Feature, { op: 'pattern'; kind: 'circular' }>;

/** Steps that add or cut material: the only ones the kernel can pattern. */
export const PATTERNABLE_OPS: ReadonlySet<Feature['op']> = new Set(['add', 'cut', 'hole', 'extrude', 'revolve', 'loft', 'sweep']);

/** Features to pattern: the steps before `upto` (the edited step, or all) that the kernel can repeat. */
export function patternableSteps(features: readonly Feature[] | undefined, upto?: string): Feature[] {
    const list = features ?? [];
    const end = upto ? list.findIndex((f) => f.id === upto) : -1;
    return (end < 0 ? list : list.slice(0, end)).filter((f) => PATTERNABLE_OPS.has(f.op));
}

const BASE_AXES: Option[] = [
    { value: 'x', label: 'X axis' },
    { value: 'y', label: 'Y axis' },
    { value: 'z', label: 'Z axis' },
];

/** The value of a direction or axis in the select: x / y / z, `ref:<axis step id>`, or `vec:x,y,z` for a vector. */
export function axisValue(ref: AxisRef | Vec3 | undefined): string {
    if (ref === undefined) {
        return '';
    }
    if (Array.isArray(ref)) {
        return `vec:${ref.join(',')}`;
    }
    return typeof ref === 'string' ? ref : `ref:${ref.axisRef}`;
}

export function axisFromValue(value: string): AxisRef | Vec3 | undefined {
    if (value === 'x' || value === 'y' || value === 'z') {
        return value;
    }
    if (value.startsWith('ref:')) {
        return { axisRef: value.slice(4) };
    }
    if (value.startsWith('vec:')) {
        const v = value.slice(4).split(',').map(Number);
        return v.length === 3 && v.every(Number.isFinite) ? (v as Vec3) : undefined;
    }
    return undefined;
}

/**
 * Directions and axes to choose from: the part's X, Y and Z axes and the axis steps before `upto`, plus the
 * current value when it is a vector (set by Jarvis), so editing keeps it.
 */
export function axisOptions(features: readonly Feature[] | undefined, upto?: string, current?: string): Option[] {
    const list = features ?? [];
    const end = upto ? list.findIndex((f) => f.id === upto) : -1;
    const axes = (end < 0 ? list : list.slice(0, end))
        .filter((f) => f.op === 'axis')
        .map((f) => ({ value: `ref:${f.id}`, label: f.name ?? f.id }));
    const options = [...BASE_AXES, ...axes];
    if (current?.startsWith('vec:')) {
        options.push({ value: current, label: `Direction (${current.slice(4).split(',').join(', ')})` });
    }
    return options;
}

/**
 * Instances to skip, typed as instance numbers along direction 1 ("3, 5"), or "i:j" for direction 1 and 2 in a
 * grid. The seed is instance 1 (1:1).
 */
export function parseSkip(text: string): [number, number][] {
    const out: [number, number][] = [];
    for (const token of text.split(/[,;\s]+/).filter(Boolean)) {
        const m = /^(\d+)(?::(\d+))?$/.exec(token);
        if (!m) {
            throw new Error(`Instances to skip: "${token}" is not an instance number (e.g. 3, or 2:3 in a grid).`);
        }
        const pair: [number, number] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2])];
        if (pair[0] < 1 || pair[1] < 1) {
            throw new Error('Instances to skip: instances are numbered from 1.');
        }
        if (pair[0] === 1 && pair[1] === 1) {
            throw new Error('Instances to skip: instance 1 is the seed and cannot be skipped.');
        }
        if (!out.some(([i, j]) => i === pair[0] && j === pair[1])) {
            out.push(pair);
        }
    }
    return out;
}

export function skipText(skip: readonly [number, number][] | undefined): string {
    return (skip ?? []).map(([i, j]) => (j === 1 ? String(i) : `${i}:${j}`)).join(', ');
}

function number(v: Values, key: string, label: string, opts: { int?: boolean; min?: number; nonZero?: boolean } = {}): number {
    const raw = v[key];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
        throw new Error(`${label} must be a number.`);
    }
    if (opts.int && !Number.isInteger(n)) {
        throw new Error(`${label} must be a whole number.`);
    }
    if (opts.min !== undefined && n < opts.min) {
        throw new Error(`${label} must be at least ${opts.min}.`);
    }
    if (opts.nonZero && n === 0) {
        throw new Error(`${label} must not be 0.`);
    }
    return n;
}

function chosenFeatures(v: Values): string[] {
    const list = Array.isArray(v.features) ? v.features : [];
    if (list.length === 0) {
        throw new Error('Pick the features to pattern.');
    }
    return list;
}

function direction(v: Values, key: string, what: string): AxisRef | Vec3 {
    const d = axisFromValue(String(v[key] ?? ''));
    if (d === undefined) {
        throw new Error(`Pick ${what}.`);
    }
    return d;
}

function checkSkip(skip: [number, number][], count: number, count2: number): void {
    const out = skip.find(([i, j]) => i > count || j > count2);
    if (out) {
        throw new Error(`Instances to skip: ${out[1] === 1 ? out[0] : `${out[0]}:${out[1]}`} is not an instance of this pattern.`);
    }
}

export const LINEAR_DEFAULTS: Values = {
    dir: 'x', rev: false, spacing: '10', count: '3', two: false, dir2: 'z', rev2: false, spacing2: '10', count2: '2', seedOnly2: false,
    features: [], skip: '',
};

export function linearValues(f: LinearPattern): Values {
    return {
        dir: axisValue(f.direction), rev: !!f.reverse, spacing: String(f.spacing), count: String(f.count),
        two: f.direction2 !== undefined, dir2: axisValue(f.direction2) || 'z', rev2: !!f.reverse2,
        spacing2: String(f.spacing2 ?? 10), count2: String(f.count2 ?? 2), seedOnly2: !!f.seedOnly2,
        features: [...f.features], skip: skipText(f.skip),
    };
}

/** The feature fields of a linear pattern; on an edit, cleared options are sent as null so they are removed. */
export function linearFeature(v: Values): Record<string, unknown> {
    const count = number(v, 'count', 'Number of instances', { int: true, min: 2 });
    const two = !!v.two;
    const count2 = two ? number(v, 'count2', 'Direction 2 instances', { int: true, min: 2 }) : 1;
    const skip = parseSkip(String(v.skip ?? ''));
    checkSkip(skip, count, count2);
    if (two && v.seedOnly2) {
        const bad = skip.find(([i, j]) => j > 1 && i > 1);
        if (bad) {
            throw new Error(`Instances to skip: ${bad[0]}:${bad[1]} is not an instance (direction 2 repeats the seed only).`);
        }
    }
    return {
        op: 'pattern',
        kind: 'linear',
        features: chosenFeatures(v),
        direction: direction(v, 'dir', 'a direction'),
        spacing: number(v, 'spacing', 'Spacing', { nonZero: true }),
        count,
        reverse: !!v.rev,
        direction2: two ? direction(v, 'dir2', 'a second direction') : null,
        spacing2: two ? number(v, 'spacing2', 'Direction 2 spacing', { nonZero: true }) : null,
        count2: two ? count2 : null,
        reverse2: two ? !!v.rev2 : null,
        seedOnly2: two ? !!v.seedOnly2 : null,
        skip,
    };
}

export const CIRCULAR_DEFAULTS: Values = {
    axis: 'y', rev: false, equal: true, total: '360', step: '30', count: '4', features: [], skip: '',
};

export function circularValues(f: CircularPattern): Values {
    const equal = f.equal !== false;
    return {
        axis: axisValue(f.axis), rev: !!f.reverse, equal,
        total: String(equal ? f.angle ?? 360 : 360), step: String(equal ? 30 : f.angle ?? 30), count: String(f.count),
        features: [...f.features], skip: skipText(f.skip),
    };
}

export function circularFeature(v: Values): Record<string, unknown> {
    const count = number(v, 'count', 'Number of instances', { int: true, min: 2 });
    const equal = !!v.equal;
    const angle = equal ? number(v, 'total', 'Total angle', { nonZero: true }) : number(v, 'step', 'Angle', { nonZero: true });
    if (equal && Math.abs(angle) > 360) {
        throw new Error('Total angle must be 360° or less.');
    }
    if (!equal && Math.abs(angle * (count - 1)) > 360) {
        throw new Error(`${count} instances ${angle}° apart go past a full turn.`);
    }
    const axis = direction(v, 'axis', 'an axis');
    if (Array.isArray(axis)) {
        throw new Error('Pick an axis: X, Y, Z or an axis step.');
    }
    const skip = parseSkip(String(v.skip ?? ''));
    checkSkip(skip, count, 1);
    return { op: 'pattern', kind: 'circular', features: chosenFeatures(v), axis, count, angle, equal, reverse: !!v.rev, skip };
}

/** Drops the null "remove this" markers for a new feature (features_add has no null fields). */
export function withoutNulls(feature: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(feature).filter(([, value]) => value !== null));
}
