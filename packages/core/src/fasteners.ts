// ISO metric hardware dimensions and the hole sizes that go with them. All values in mm.
// Used by the CAD kernel to model fasteners and standard holes, and by Jarvis to pick lengths.

import type { FastenerType, HoleSpec, PrintSettings, ThreadSize } from './index';

export interface ThreadData {
    size: ThreadSize;
    /** Coarse pitch. */
    pitch: number;
    major: number;
    /** Root diameter of the external thread. */
    minor: number;
    /** Drill for cutting a thread (or self-tapping into plastic). */
    tapDrill: number;
    /** ISO 273 clearance holes. */
    clearanceClose: number;
    clearanceNormal: number;
}

export interface ScrewHeadData {
    /** Outer diameter (hex bolts: across corners). */
    diameter: number;
    /** Head height (countersunk: height of the cone). */
    height: number;
    /** Hex bolts only. */
    acrossFlats?: number;
    /** Hex socket key size and depth (socket screws). */
    socket?: { size: number; depth: number };
    /** Included angle of a countersunk head. */
    countersinkAngle?: number;
}

export interface NutData {
    /** Hex or square nut width across flats. */
    acrossFlats: number;
    thickness: number;
}

export interface WasherData {
    inner: number;
    outer: number;
    thickness: number;
}

export interface HeatsetData {
    /** Outer (knurled) diameter of the insert. */
    outer: number;
    length: number;
    /** Hole to melt it into, before print tolerance. */
    hole: number;
}

/** Geometry of a standard hole, ready to cut. Print tolerance is already included. */
export interface HoleDimensions {
    diameter: number;
    /** Fixed depth (heat-set inserts); otherwise the feature's depth or through-all applies. */
    depth?: number;
    counterbore?: { diameter: number; depth: number };
    countersink?: { diameter: number; angle: number };
    nutTrap?: { acrossFlats: number; depth: number };
}

/** Lengths sold for screws and bolts, shortest first. */
export const STANDARD_LENGTHS: number[] = [3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80];

// Coarse pitch, major, minor d3 = d - 1.2269 P, tap drill, ISO 273 close and medium clearance.
const THREADS: Record<ThreadSize, ThreadData> = {
    M2: { size: 'M2', pitch: 0.4, major: 2, minor: 1.51, tapDrill: 1.6, clearanceClose: 2.2, clearanceNormal: 2.4 },
    'M2.5': { size: 'M2.5', pitch: 0.45, major: 2.5, minor: 1.95, tapDrill: 2.05, clearanceClose: 2.7, clearanceNormal: 2.9 },
    M3: { size: 'M3', pitch: 0.5, major: 3, minor: 2.39, tapDrill: 2.5, clearanceClose: 3.2, clearanceNormal: 3.4 },
    M4: { size: 'M4', pitch: 0.7, major: 4, minor: 3.14, tapDrill: 3.3, clearanceClose: 4.3, clearanceNormal: 4.5 },
    M5: { size: 'M5', pitch: 0.8, major: 5, minor: 4.02, tapDrill: 4.2, clearanceClose: 5.3, clearanceNormal: 5.5 },
    M6: { size: 'M6', pitch: 1, major: 6, minor: 4.77, tapDrill: 5, clearanceClose: 6.4, clearanceNormal: 6.6 },
    M8: { size: 'M8', pitch: 1.25, major: 8, minor: 6.47, tapDrill: 6.8, clearanceClose: 8.4, clearanceNormal: 9 },
};

// ISO 4762: head diameter, head height (= d), hex key size and socket depth.
const SOCKET_CAP: Record<ThreadSize, ScrewHeadData> = {
    M2: { diameter: 3.8, height: 2, socket: { size: 1.5, depth: 1 } },
    'M2.5': { diameter: 4.5, height: 2.5, socket: { size: 2, depth: 1.1 } },
    M3: { diameter: 5.5, height: 3, socket: { size: 2.5, depth: 1.3 } },
    M4: { diameter: 7, height: 4, socket: { size: 3, depth: 2 } },
    M5: { diameter: 8.5, height: 5, socket: { size: 4, depth: 2.5 } },
    M6: { diameter: 10, height: 6, socket: { size: 5, depth: 3 } },
    M8: { diameter: 13, height: 8, socket: { size: 6, depth: 4 } },
};

// ISO 7380-1 low button head.
const BUTTON_HEAD: Record<ThreadSize, ScrewHeadData> = {
    M2: { diameter: 4, height: 1.3, socket: { size: 1.5, depth: 0.8 } },
    'M2.5': { diameter: 4.7, height: 1.5, socket: { size: 1.5, depth: 0.9 } },
    M3: { diameter: 5.7, height: 1.65, socket: { size: 2, depth: 1.04 } },
    M4: { diameter: 7.6, height: 2.2, socket: { size: 2.5, depth: 1.3 } },
    M5: { diameter: 9.5, height: 2.75, socket: { size: 3, depth: 1.5 } },
    M6: { diameter: 10.5, height: 3.3, socket: { size: 4, depth: 2 } },
    M8: { diameter: 14, height: 4.4, socket: { size: 5, depth: 2.5 } },
};

// ISO 10642: theoretical head diameter, cone height, 90 degree included angle (M2 and M2.5 extrapolated).
const COUNTERSUNK: Record<ThreadSize, ScrewHeadData> = {
    M2: { diameter: 4.4, height: 1.2, socket: { size: 1.5, depth: 0.6 }, countersinkAngle: 90 },
    'M2.5': { diameter: 5.5, height: 1.5, socket: { size: 1.5, depth: 0.7 }, countersinkAngle: 90 },
    M3: { diameter: 6.72, height: 1.86, socket: { size: 2, depth: 1.1 }, countersinkAngle: 90 },
    M4: { diameter: 8.96, height: 2.48, socket: { size: 2.5, depth: 1.5 }, countersinkAngle: 90 },
    M5: { diameter: 11.2, height: 3.1, socket: { size: 3, depth: 1.9 }, countersinkAngle: 90 },
    M6: { diameter: 13.44, height: 3.72, socket: { size: 4, depth: 2.2 }, countersinkAngle: 90 },
    M8: { diameter: 17.92, height: 4.96, socket: { size: 5, depth: 3 }, countersinkAngle: 90 },
};

// ISO 4017: across flats, across corners (AF / cos 30), head height.
const HEX_BOLT: Record<ThreadSize, ScrewHeadData> = {
    M2: { diameter: 4.62, height: 1.4, acrossFlats: 4 },
    'M2.5': { diameter: 5.77, height: 1.7, acrossFlats: 5 },
    M3: { diameter: 6.35, height: 2, acrossFlats: 5.5 },
    M4: { diameter: 8.08, height: 2.8, acrossFlats: 7 },
    M5: { diameter: 9.24, height: 3.5, acrossFlats: 8 },
    M6: { diameter: 11.55, height: 4, acrossFlats: 10 },
    M8: { diameter: 15.01, height: 5.3, acrossFlats: 13 },
};

const SCREW_HEADS: Partial<Record<FastenerType, Record<ThreadSize, ScrewHeadData>>> = {
    socketCap: SOCKET_CAP,
    buttonHead: BUTTON_HEAD,
    countersunk: COUNTERSUNK,
    hexBolt: HEX_BOLT,
};

// ISO 4032 hex nut (M2.5 is not in the standard; DIN 934 style values).
const HEX_NUT: Record<ThreadSize, NutData> = {
    M2: { acrossFlats: 4, thickness: 1.6 },
    'M2.5': { acrossFlats: 5, thickness: 2 },
    M3: { acrossFlats: 5.5, thickness: 2.4 },
    M4: { acrossFlats: 7, thickness: 3.2 },
    M5: { acrossFlats: 8, thickness: 4.7 },
    M6: { acrossFlats: 10, thickness: 5.2 },
    M8: { acrossFlats: 13, thickness: 6.8 },
};

// ISO 10511 low nylon-insert nut: overall height including the collar.
const NYLOC_NUT: Record<ThreadSize, NutData> = {
    M2: { acrossFlats: 4, thickness: 3 },
    'M2.5': { acrossFlats: 5, thickness: 3.5 },
    M3: { acrossFlats: 5.5, thickness: 4 },
    M4: { acrossFlats: 7, thickness: 5 },
    M5: { acrossFlats: 8, thickness: 5 },
    M6: { acrossFlats: 10, thickness: 6 },
    M8: { acrossFlats: 13, thickness: 8 },
};

// DIN 562 thin square nut.
const SQUARE_NUT: Record<ThreadSize, NutData> = {
    M2: { acrossFlats: 4, thickness: 1.2 },
    'M2.5': { acrossFlats: 5, thickness: 1.6 },
    M3: { acrossFlats: 5.5, thickness: 1.8 },
    M4: { acrossFlats: 7, thickness: 2.2 },
    M5: { acrossFlats: 8, thickness: 2.7 },
    M6: { acrossFlats: 10, thickness: 3.2 },
    M8: { acrossFlats: 13, thickness: 4 },
};

const NUTS: Partial<Record<FastenerType, Record<ThreadSize, NutData>>> = {
    hexNut: HEX_NUT,
    nylocNut: NYLOC_NUT,
    squareNut: SQUARE_NUT,
};

// ISO 7089 normal series washer.
const WASHERS: Record<ThreadSize, WasherData> = {
    M2: { inner: 2.2, outer: 5, thickness: 0.3 },
    'M2.5': { inner: 2.7, outer: 6, thickness: 0.5 },
    M3: { inner: 3.2, outer: 7, thickness: 0.5 },
    M4: { inner: 4.3, outer: 9, thickness: 0.8 },
    M5: { inner: 5.3, outer: 10, thickness: 1 },
    M6: { inner: 6.4, outer: 12, thickness: 1.6 },
    M8: { inner: 8.4, outer: 16, thickness: 1.6 },
};

// Common brass inserts for 3D printing, after the Ruthex / CNC Kitchen published size tables (M3: 4.6 x 5.7).
const HEATSETS: Record<ThreadSize, HeatsetData> = {
    M2: { outer: 3.2, length: 4, hole: 3.2 },
    'M2.5': { outer: 3.6, length: 5, hole: 3.6 },
    M3: { outer: 4.6, length: 5.7, hole: 4 },
    M4: { outer: 6, length: 8.1, hole: 5.6 },
    M5: { outer: 7, length: 9.5, hole: 6.4 },
    M6: { outer: 8.6, length: 12.7, hole: 8 },
    M8: { outer: 10.1, length: 12.7, hole: 9.7 },
};

export function threadData(size: ThreadSize): ThreadData {
    return { ...THREADS[size] };
}

/** Head dimensions for screw and bolt types; throws for nuts, washers and inserts. */
export function screwHead(type: FastenerType, size: ThreadSize): ScrewHeadData {
    const table = SCREW_HEADS[type];
    if (!table) throw new Error(`screwHead: ${type} is not a screw or bolt`);
    return structuredClone(table[size]);
}

/** hexNut, nylocNut or squareNut. */
export function nutData(type: FastenerType, size: ThreadSize): NutData {
    const table = NUTS[type];
    if (!table) throw new Error(`nutData: ${type} is not a nut`);
    return { ...table[size] };
}

export function washerData(size: ThreadSize): WasherData {
    return { ...WASHERS[size] };
}

export function heatsetData(size: ThreadSize): HeatsetData {
    return { ...HEATSETS[size] };
}

const round = (v: number): number => Math.round(v * 1000) / 1000;

/** Sizes a standard hole for printing, adding `print.holeTolerance` to printed diameters. */
export function holeDimensions(spec: HoleSpec, print: PrintSettings): HoleDimensions {
    const tol = print.holeTolerance;
    if (spec.kind === 'plain') {
        if (spec.diameter === undefined) throw new Error('plain hole needs a diameter');
        return { diameter: round(spec.diameter + tol) };
    }
    if (!spec.size) throw new Error(`${spec.kind} hole needs a thread size`);
    const t = threadData(spec.size);
    const clearance = round((spec.fit === 'close' ? t.clearanceClose : t.clearanceNormal) + tol);
    switch (spec.kind) {
        case 'clearance':
            return { diameter: clearance };
        case 'tap':
            return { diameter: round(t.tapDrill + tol) };
        case 'heatset': {
            const h = heatsetData(spec.size);
            return { diameter: round(h.hole + tol), depth: round(h.length + 0.5) };
        }
        case 'counterbore': {
            const head = screwHead('socketCap', spec.size);
            return {
                diameter: clearance,
                counterbore: { diameter: round(head.diameter + 0.6 + tol), depth: round(head.height + 0.4) },
            };
        }
        case 'countersink': {
            const head = screwHead('countersunk', spec.size);
            return { diameter: clearance, countersink: { diameter: round(head.diameter + tol), angle: 90 } };
        }
        case 'nutTrap': {
            const nut = nutData('hexNut', spec.size);
            return {
                diameter: clearance,
                nutTrap: { acrossFlats: round(nut.acrossFlats + tol), depth: round(nut.thickness + 0.3) },
            };
        }
        default:
            throw new Error(`Unknown hole kind: ${String(spec.kind)}`);
    }
}
