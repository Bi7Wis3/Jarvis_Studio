// SolidWorks-style names for new history steps: Boss-Extrude1, Cut-Extrude2, Sketch3, Fillet1.

import type { Feature } from '@jarvis/core';

/** What a step needs to be named: its operation, and whether it adds or cuts, or which kind of pattern it is. */
export interface Nameable {
    op: Feature['op'];
    mode?: 'add' | 'cut';
    kind?: string;
}

/** The name without its number, e.g. "Cut-Extrude". */
export function featureBaseName(feature: Nameable): string {
    const cut = feature.mode === 'cut';
    switch (feature.op) {
        case 'extrude':
            return cut ? 'Cut-Extrude' : 'Boss-Extrude';
        case 'revolve':
            return cut ? 'Cut-Revolve' : 'Revolve';
        case 'sweep':
            return cut ? 'Cut-Sweep' : 'Sweep';
        case 'loft':
            return cut ? 'Cut-Loft' : 'Loft';
        case 'pattern':
            return feature.kind === 'circular' ? 'CirPattern' : 'LPattern';
        case 'add':
            return 'Boss';
        case 'helix':
            return 'Helix/Spiral';
        default:
            return feature.op[0].toUpperCase() + feature.op.slice(1);
    }
}

/** The next free name of its kind in the part: the lowest number above every one already used. */
export function nextFeatureName(features: readonly Pick<Feature, 'name'>[] | undefined, feature: Nameable): string {
    return nextNumberedName(features, featureBaseName(feature));
}

/** `base` with the lowest number above every one the part already uses (Box1, Box2...). */
export function nextNumberedName(features: readonly Pick<Feature, 'name'>[] | undefined, base: string): string {
    let n = 0;
    for (const f of features ?? []) {
        const match = f.name?.startsWith(base) ? /^(\d+)$/.exec(f.name.slice(base.length)) : null;
        if (match) {
            n = Math.max(n, Number(match[1]));
        }
    }
    return `${base}${n + 1}`;
}
