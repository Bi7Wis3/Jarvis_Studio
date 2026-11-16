// Closed loops of a sketch's curves, for the profiles the kernel builds from and the regions a feature's selected
// contours pick. The curves form a planar graph (ends joined where they share a point); walking it with the face on
// the left gives every bounded area (counter-clockwise) and each connected group's outline (clockwise).

import type { SketchProfile, SketchRegion, SketchSegment } from '@jarvis/core';

export type P2 = [number, number];

/** One curve between two ends (or a closed curve on its own, `from` === `to` and `closed`). */
export interface Piece {
    id: string;
    from: string;
    to: string;
    /** The path segment from `from` to `to`, and the other way. */
    forward: SketchSegment;
    backward: SketchSegment;
    /** Points along it from `from` to `to` (ends included), for areas and containment. */
    samples: P2[];
    /** A closed curve as a profile of its own (circle, ellipse, closed spline). */
    closed?: SketchProfile;
}

interface Half {
    piece: Piece;
    reversed: boolean;
    from: string;
    to: string;
    angle: number;
}

export interface Loop {
    pieces: { piece: Piece; reversed: boolean }[];
    polygon: P2[];
    area: number;
}

export interface SketchLoops {
    /** Each connected group's outline, counter-clockwise: the kernel's profiles (nesting makes holes). */
    outlines: Loop[];
    /** Every bounded area, counter-clockwise. */
    faces: Loop[];
    /** Chains that close nothing (sweep paths). */
    open: { pieces: { piece: Piece; reversed: boolean }[] }[];
}

const signedArea = (poly: P2[]): number => {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
        const [x0, y0] = poly[i];
        const [x1, y1] = poly[(i + 1) % poly.length];
        a += x0 * y1 - x1 * y0;
    }
    return a / 2;
};

export function inside(point: P2, poly: P2[]): boolean {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
            c = !c;
        }
    }
    return c;
}

/** The direction a piece leaves an end: towards a point a little way along it. */
function leaveAngle(samples: P2[]): number {
    const [x0, y0] = samples[0];
    const total = samples.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - samples[i - 1][0], p[1] - samples[i - 1][1]) : 0), 0);
    const reach = Math.max(total * 1e-3, 1e-9);
    let walked = 0;
    for (let i = 1; i < samples.length; i++) {
        const step = Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]);
        if (walked + step >= reach) {
            const t = (reach - walked) / step;
            const x = samples[i - 1][0] + t * (samples[i][0] - samples[i - 1][0]);
            const y = samples[i - 1][1] + t * (samples[i][1] - samples[i - 1][1]);
            return Math.atan2(y - y0, x - x0);
        }
        walked += step;
    }
    const [x1, y1] = samples[samples.length - 1];
    return Math.atan2(y1 - y0, x1 - x0);
}

function polygonOf(pieces: { piece: Piece; reversed: boolean }[]): P2[] {
    const out: P2[] = [];
    for (const { piece, reversed } of pieces) {
        const s = reversed ? [...piece.samples].reverse() : piece.samples;
        out.push(...s.slice(0, -1));
    }
    return out;
}

/** The loops of a set of pieces. */
export function findLoops(all: Piece[]): SketchLoops {
    const closed = all.filter((p) => p.closed);
    let pieces = all.filter((p) => !p.closed && p.from !== p.to);
    // Ends met only once lead nowhere: peel those pieces off (they are open chains).
    const dangling: Piece[] = [];
    for (;;) {
        const degree = new Map<string, number>();
        for (const p of pieces) {
            degree.set(p.from, (degree.get(p.from) ?? 0) + 1);
            degree.set(p.to, (degree.get(p.to) ?? 0) + 1);
        }
        const loose = pieces.filter((p) => degree.get(p.from) === 1 || degree.get(p.to) === 1);
        if (!loose.length) {
            break;
        }
        dangling.push(...loose);
        pieces = pieces.filter((p) => !loose.includes(p));
    }
    const out: Map<string, Half[]> = new Map();
    const halves: Half[] = [];
    for (const piece of pieces) {
        const back = [...piece.samples].reverse();
        const f: Half = { piece, reversed: false, from: piece.from, to: piece.to, angle: leaveAngle(piece.samples) };
        const b: Half = { piece, reversed: true, from: piece.to, to: piece.from, angle: leaveAngle(back) };
        halves.push(f, b);
        for (const h of [f, b]) {
            const list = out.get(h.from) ?? [];
            list.push(h);
            out.set(h.from, list);
        }
    }
    for (const list of out.values()) {
        list.sort((a, b) => a.angle - b.angle);
    }
    const twin = (h: Half): Half => halves[halves.indexOf(h) ^ 1];
    // Arriving at v, the face on the left continues along the first edge clockwise from the way back.
    const next = (h: Half): Half => {
        const list = out.get(h.to)!;
        const i = list.indexOf(twin(h));
        return list[(i - 1 + list.length) % list.length];
    };
    const used = new Set<Half>();
    const faces: Loop[] = [];
    const outlines: Loop[] = [];
    for (const start of halves) {
        if (used.has(start)) {
            continue;
        }
        const cycle: Half[] = [];
        let h = start;
        while (!used.has(h)) {
            used.add(h);
            cycle.push(h);
            h = next(h);
        }
        const loopPieces = cycle.map((c) => ({ piece: c.piece, reversed: c.reversed }));
        const polygon = polygonOf(loopPieces);
        const area = signedArea(polygon);
        if (area > 0) {
            faces.push({ pieces: loopPieces, polygon, area });
        } else {
            // A group's outline, walked clockwise: turned round it is the group's outer boundary.
            const turned = [...loopPieces].reverse().map((p) => ({ piece: p.piece, reversed: !p.reversed }));
            outlines.push({ pieces: turned, polygon: polygonOf(turned), area: -area });
        }
    }
    for (const piece of closed) {
        const loop = { pieces: [{ piece, reversed: false }], polygon: piece.samples.slice(0, -1), area: Math.abs(signedArea(piece.samples)) };
        faces.push(loop);
        outlines.push(loop);
    }
    return { faces, outlines, open: chains(dangling) };
}

/** Pieces joined end to end into chains. */
function chains(pieces: Piece[]): { pieces: { piece: Piece; reversed: boolean }[] }[] {
    const left = [...pieces];
    const result: { pieces: { piece: Piece; reversed: boolean }[] }[] = [];
    while (left.length) {
        const first = left.shift()!;
        const chain = [{ piece: first, reversed: false }];
        let head = first.from;
        let tail = first.to;
        for (let grown = true; grown;) {
            grown = false;
            for (let i = 0; i < left.length; i++) {
                const p = left[i];
                if (p.from === tail || p.to === tail) {
                    chain.push({ piece: p, reversed: p.to === tail });
                    tail = p.to === tail ? p.from : p.to;
                } else if (p.to === head || p.from === head) {
                    chain.unshift({ piece: p, reversed: p.from === head });
                    head = p.from === head ? p.to : p.from;
                } else {
                    continue;
                }
                left.splice(i, 1);
                grown = true;
                break;
            }
        }
        result.push({ pieces: chain });
    }
    return result;
}

/** A loop or chain as a path profile (a closed curve on its own as its own profile). */
export function profileOf(loop: { pieces: { piece: Piece; reversed: boolean }[] }, start: P2, closed = true): SketchProfile {
    if (closed && loop.pieces.length === 1 && loop.pieces[0].piece.closed) {
        return loop.pieces[0].piece.closed;
    }
    return { kind: 'path', start, segments: loop.pieces.map(({ piece, reversed }) => (reversed ? piece.backward : piece.forward)) };
}

/** Where a loop starts: the first point of its first piece. */
export function loopStart(loop: { pieces: { piece: Piece; reversed: boolean }[] }): P2 {
    const { piece, reversed } = loop.pieces[0];
    return reversed ? piece.samples[piece.samples.length - 1] : piece.samples[0];
}

/** A point inside `outer` and outside every hole: the middle of the widest span on a few lines across it. */
export function interiorPoint(outer: P2[], holes: P2[][]): P2 {
    const ys = outer.map((p) => p[1]);
    const [lo, hi] = [Math.min(...ys), Math.max(...ys)];
    let best: { width: number; at: P2 } | null = null;
    for (const f of [0.5, 0.37, 0.63, 0.25, 0.75, 0.13, 0.87, 0.06, 0.94]) {
        const y = lo + (hi - lo) * f;
        const xs: number[] = [];
        for (const poly of [outer, ...holes]) {
            for (let i = 0; i < poly.length; i++) {
                const [x0, y0] = poly[i];
                const [x1, y1] = poly[(i + 1) % poly.length];
                if ((y0 > y) !== (y1 > y)) {
                    xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
                }
            }
        }
        xs.sort((a, b) => a - b);
        for (let i = 0; i + 1 < xs.length; i += 2) {
            const width = xs[i + 1] - xs[i];
            const at: P2 = [(xs[i] + xs[i + 1]) / 2, y];
            if (width > (best?.width ?? 0) && inside(at, outer) && !holes.some((h) => inside(at, h))) {
                best = { width, at };
            }
        }
        if (best && best.width > (hi - lo) * 0.2) {
            break;
        }
    }
    return best?.at ?? outer[0];
}

/** The sketch's regions: every bounded area, with the groups lying in it as holes, and a point inside it. */
export function regionsOf(loops: SketchLoops): SketchRegion[] {
    const regions: SketchRegion[] = [];
    for (const face of loops.faces) {
        // Outlines directly inside this face: not inside a smaller face that is itself inside this one.
        const holes = loops.outlines.filter((o) => {
            if (o.polygon === face.polygon || o.area >= face.area || !inside(o.polygon[0], face.polygon)) {
                return false;
            }
            if (face.pieces.some((fp) => o.pieces.some((op) => op.piece === fp.piece))) {
                return false;
            }
            return !loops.faces.some((g) => g !== face && g.area < face.area && g.area > o.area && inside(g.polygon[0], face.polygon)
                && inside(o.polygon[0], g.polygon) && !g.pieces.some((gp) => o.pieces.some((op) => op.piece === gp.piece)));
        });
        regions.push({
            loops: [profileOf(face, loopStart(face)), ...holes.map((h) => profileOf(h, loopStart(h)))],
            at: interiorPoint(face.polygon, holes.map((h) => h.polygon)),
        });
    }
    return regions;
}
