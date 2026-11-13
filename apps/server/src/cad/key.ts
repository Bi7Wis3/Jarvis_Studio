import { createHash } from 'node:crypto';
import type { Feature, Part, PrintSettings } from '@jarvis/core';
import { combineTargets, relativeKey, type CombineContext } from './context.js';

/** Bump when the kernel's modelling changes, so cached meshes are rebuilt. */
export const KERNEL_VERSION = 3;

/** JSON with sorted keys, so equal specs hash equally whatever their key order. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

/** Steps that later steps refer to by id, and that count even when suppressed. */
const REFERENCED = new Set(['sketch', 'plane', 'axis', 'point']);

function geometryOf(features: Feature[] | undefined): unknown[] {
    // Names do not change geometry. Ids only do where later steps can refer to them (sketchRef, planeRef, axisRef,
    // pattern targets), so renumbering any other step keeps the cached mesh.
    const list = features ?? [];
    const patterned = new Set(list.flatMap((f) => (f.op === 'pattern' ? f.features : [])));
    return list
        .filter((f) => !f.suppressed || REFERENCED.has(f.op))
        .map(({ name: _name, id, ...geometry }) => (REFERENCED.has(geometry.op) || patterned.has(id) ? { id, ...geometry } : geometry));
}

/** The parts combined into this one, with their own combines, as seen from the part being keyed. */
function combineDeps(id: string, features: Feature[] | undefined, context: CombineContext, seen: string[]): unknown[] {
    const self = context.parts[id];
    return combineTargets(features).map((target) => {
        const other = context.parts[target];
        if (!other || !self) {
            return { target, missing: true };
        }
        if (seen.includes(target)) {
            return { target, cycle: true };
        }
        return {
            target,
            shape: other.shape,
            features: geometryOf(other.features),
            placement: relativeKey(self, other),
            deps: combineDeps(target, other.features, context, [...seen, target]),
        };
    });
}

/**
 * Stable hash of everything that affects a part's solid: its shape, its features (names do not change geometry;
 * suppressed steps only count if later steps can refer to them), the print tolerance, and for combine steps the
 * other parts' designs and placements relative to this one.
 */
export function meshKey(part: Pick<Part, 'shape' | 'features'>, print: PrintSettings, context?: CombineContext): string {
    const spec: Record<string, unknown> = {
        v: KERNEL_VERSION, shape: part.shape, features: geometryOf(part.features), holeTolerance: print.holeTolerance,
    };
    if (context && combineTargets(part.features).length) {
        spec.combine = combineDeps(context.self, part.features, context, [context.self]);
    }
    return createHash('sha256').update(canonical(spec)).digest('hex').slice(0, 24);
}
