// Form values <-> box and cylinder base shapes, so editing keeps every field: a box's automatic edge round stays
// automatic, and a cylinder keeps its top radius (taper) and bevel. Pure, so the round trips can be tested.

import type { Shape } from '@jarvis/core';

type Values = Record<string, string | boolean | string[]>;
type Box = Extract<Shape, { kind: 'box' }>;
type Cylinder = Extract<Shape, { kind: 'cylinder' }>;

const text = (n: number): string => String(Math.round(n * 100) / 100);

function read(v: Values, key: string, label: string, positive: boolean): number {
    const raw = v[key];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
        throw new Error(`${label} must be a number.`);
    }
    if (positive ? n <= 0 : n < 0) {
        throw new Error(`${label} must be ${positive ? 'greater than 0' : 'at least 0'}.`);
    }
    return n;
}

export const BOX_DEFAULTS: Values = { w: '40', h: '20', d: '30', autoR: false, r: '0.5' };

export function boxValues(s: Box): Values {
    return {
        w: text(s.size[0]), h: text(s.size[1]), d: text(s.size[2]),
        // No radius: the kernel rounds the edges a little by itself while the part has no features.
        autoR: s.radius === undefined, r: text(s.radius ?? 0.5),
    };
}

export function boxShape(v: Values): Box {
    const size: Box['size'] = [read(v, 'w', 'Width', true), read(v, 'h', 'Height', true), read(v, 'd', 'Depth', true)];
    return v.autoR ? { kind: 'box', size } : { kind: 'box', size, radius: read(v, 'r', 'Edge round', false) };
}

export const CYLINDER_DEFAULTS: Values = { r: '15', taper: false, rt: '10', h: '30', autoBevel: true, bevel: '0.5' };

export function cylinderValues(s: Cylinder): Values {
    return {
        r: text(s.radius), taper: s.radiusTop !== undefined, rt: text(s.radiusTop ?? s.radius), h: text(s.height),
        autoBevel: s.bevel === undefined, bevel: text(s.bevel ?? 0.5),
    };
}

export function cylinderShape(v: Values): Cylinder {
    const radius = read(v, 'r', 'Radius', true);
    const height = read(v, 'h', 'Height', true);
    return {
        kind: 'cylinder', radius, height,
        ...(v.taper ? { radiusTop: read(v, 'rt', 'Top radius', false) } : {}),
        ...(v.autoBevel ? {} : { bevel: read(v, 'bevel', 'Edge bevel', false) }),
    };
}
