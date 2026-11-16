// Test helper: writes neutral binary Parasolid transmit data from node field values (base schema 13006, or with
// embedded schema changes), so the reader can be tested on synthetic models.

import { baseSchema, type XtField } from './xtSchema.js';

export type FieldValues = Record<string, number | string | boolean | number[]>;

export interface TestNode {
    type: number;
    index: number;
    fields: FieldValues;
}

/** An embedded schema change for a type: edit codes, with the inserted fields' definitions. */
export interface SchemaEdit {
    type: number;
    /** e.g. ['C', 'C', 'D', { code: 'I', name: 'extra', type: 'd' }] */
    codes: (string | { code: 'I' | 'A'; name: string; type: string; nElts?: number })[];
}

class Bytes {
    readonly out: number[] = [];
    u8(v: number): void {
        this.out.push(v & 0xff);
    }
    i16(v: number): void {
        this.u8(v >> 8);
        this.u8(v);
    }
    i32(v: number): void {
        this.u8(v >>> 24);
        this.u8(v >>> 16);
        this.u8(v >>> 8);
        this.u8(v);
    }
    f64(v: number): void {
        const b = Buffer.alloc(8);
        b.writeDoubleBE(v);
        for (const x of b) {
            this.u8(x);
        }
    }
    chars(s: string): void {
        for (const c of Buffer.from(s, 'latin1')) {
            this.u8(c);
        }
    }
    index(i: number): void {
        if (i < 32767) {
            this.i16(i + 1);
        } else {
            this.i16(-((i % 32767) + 1));
            this.i16(Math.floor(i / 32767));
        }
    }
}

function writeValue(b: Bytes, type: string, v: unknown): void {
    switch (type) {
        case 'u': b.u8(Number(v ?? 0)); break;
        case 'c': b.u8(typeof v === 'string' ? v.charCodeAt(0) : Number(v ?? 0)); break;
        case 'l': b.u8(v ? 1 : 0); break;
        case 'n':
        case 'w': b.i16(Number(v ?? 0)); break;
        case 'd': b.i32(Number(v ?? 0)); break;
        case 'p': b.index(Number(v ?? 0)); break;
        case 'f': b.f64(Number(v ?? 0)); break;
        case 'i': for (const x of (v as number[]) ?? [0, 0]) b.f64(x); break;
        case 'v':
        case 'h': for (const x of (v as number[]) ?? [0, 0, 0]) b.f64(x); break;
        default: throw new Error(`type ${type}`);
    }
}

const width = (type: string): number => (type === 'v' || type === 'h' ? 3 : type === 'i' ? 2 : 1);

/** Neutral binary transmit data for the nodes (index 1 first is the root, by convention). */
export function writeXt(nodes: TestNode[], edits: SchemaEdit[] = []): Uint8Array {
    const base = baseSchema();
    const b = new Bytes();
    b.chars('PS\0\0');
    const header = ': TRANSMIT FILE (partition) created by modeller version 2700199';
    b.i16(header.length);
    b.chars(header);
    const schema = edits.length > 0 ? 'SCH_2700199_26105_13006' : 'SCH_1300000_13006';
    b.i32(schema.length);
    b.chars(schema);
    if (edits.length > 0) {
        b.i16(200);
    }
    b.i32(0);
    const effective = new Map<number, XtField[]>();
    for (const n of nodes) {
        const def = base.get(n.type);
        if (!def) {
            throw new Error(`no base type ${n.type}`);
        }
        let fields = def.fields;
        b.i16(n.type);
        if (edits.length > 0 && !effective.has(n.type)) {
            const edit = edits.find((e) => e.type === n.type);
            if (!edit) {
                b.u8(0xff);
            } else {
                const out: typeof fields = [];
                let k = 0;
                const ins: Bytes = new Bytes();
                for (const c of edit.codes) {
                    if (c === 'C') {
                        out.push(fields[k++]);
                        ins.u8(0x43);
                    } else if (c === 'D') {
                        k++;
                        ins.u8(0x44);
                    } else if (typeof c === 'object') {
                        const f = { name: c.name, type: c.type, nElts: c.nElts ?? 0, xmt: true };
                        out.push(f);
                        ins.u8(c.code.charCodeAt(0));
                        ins.u8(c.name.length);
                        ins.chars(c.name);
                        ins.i16(c.type === 'p' ? 1019 : 0);
                        ins.index(f.nElts);
                        if (c.type !== 'p') {
                            ins.u8(1);
                            ins.chars(c.type);
                        }
                        if (f.nElts === 1) {
                            ins.u8(1);
                        }
                    }
                }
                ins.u8(0x5a);
                b.u8(out.length);
                b.out.push(...ins.out);
                fields = out;
            }
            effective.set(n.type, fields);
        } else if (edits.length > 0) {
            fields = effective.get(n.type)!;
        }
        const variable = fields.find((f) => f.nElts === 1);
        if (variable) {
            const v = n.fields[variable.name];
            const len = typeof v === 'string' ? v.length : Array.isArray(v) ? v.length / width(variable.type) : 0;
            b.i32(len);
        }
        b.index(n.index);
        for (const f of fields) {
            const v = n.fields[f.name];
            if (f.nElts === 0) {
                writeValue(b, f.type, v);
            } else if (f.type === 'c') {
                b.chars(String(v ?? ''));
            } else {
                const arr = (v as number[]) ?? [];
                const count = f.nElts === 1 ? arr.length / width(f.type) : f.nElts;
                const w = width(f.type);
                for (let i = 0; i < count; i++) {
                    writeValue(b, f.type, w === 1 ? arr[i] : arr.slice(i * w, i * w + w));
                }
            }
        }
    }
    b.i16(1);
    b.index(0);
    return new Uint8Array(b.out);
}

// ---- Models -------------------------------------------------------------------------------------------------

const BODY = 12, REGION = 19, SHELL = 13, FACE = 14, LOOP = 15, FIN = 17, EDGE = 16, VERTEX = 18, POINT = 29;
const PLANE = 50, CYLINDER = 51, LINE = 30, CIRCLE = 31;

/** A solid cylinder about +z (metres): two planes, one cylinder, two ring edges. */
export function cylinderNodes(r: number, h: number): TestNode[] {
    const n: TestNode[] = [];
    const add = (type: number, index: number, fields: FieldValues): void => {
        n.push({ type, index, fields });
    };
    add(BODY, 1, { body_type: 1, region: 2, state: 1, nom_geom_state: 1, res_size: 1000, res_linear: 1e-8 });
    add(REGION, 2, { node_id: 2, body: 1, next: 3, type: 'V' });
    add(REGION, 3, { node_id: 3, body: 1, previous: 2, shell: 4, type: 'S' });
    add(SHELL, 4, { node_id: 4, body: 1, face: 5, region: 3 });
    // Faces: top (normal +z), bottom (plane normal +z, face reversed), side.
    add(FACE, 5, { node_id: 5, next: 6, loop: 8, shell: 4, surface: 18, sense: '+', tolerance: -3.14158e13 });
    add(FACE, 6, { node_id: 6, previous: 5, next: 7, loop: 9, shell: 4, surface: 19, sense: '-', tolerance: -3.14158e13 });
    add(FACE, 7, { node_id: 7, previous: 6, loop: 10, shell: 4, surface: 20, sense: '+', tolerance: -3.14158e13 });
    add(LOOP, 8, { node_id: 8, fin: 12, face: 5 });
    add(LOOP, 9, { node_id: 9, fin: 13, face: 6 });
    add(LOOP, 10, { node_id: 10, fin: 14, face: 7, next: 11 });
    add(LOOP, 11, { node_id: 11, fin: 15, face: 7 });
    // Top edge 16: fin 12 (top face, along the circle) and 14 (side, against). Bottom edge 17: 13 against, 15 along.
    add(FIN, 12, { loop: 8, forward: 12, backward: 12, other: 14, edge: 16, sense: '+' });
    add(FIN, 14, { loop: 10, forward: 14, backward: 14, other: 12, edge: 16, sense: '-' });
    add(FIN, 13, { loop: 9, forward: 13, backward: 13, other: 15, edge: 17, sense: '-' });
    add(FIN, 15, { loop: 11, forward: 15, backward: 15, other: 13, edge: 17, sense: '+' });
    add(EDGE, 16, { node_id: 16, fin: 12, curve: 21, owner: 1, tolerance: -3.14158e13 });
    add(EDGE, 17, { node_id: 17, fin: 15, curve: 22, owner: 1, tolerance: -3.14158e13 });
    add(PLANE, 18, { node_id: 18, owner: 5, sense: '+', pvec: [0, 0, h], normal: [0, 0, 1], x_axis: [1, 0, 0] });
    add(PLANE, 19, { node_id: 19, owner: 6, sense: '+', pvec: [0, 0, 0], normal: [0, 0, 1], x_axis: [1, 0, 0] });
    add(CYLINDER, 20, { node_id: 20, owner: 7, sense: '+', pvec: [0, 0, 0], axis: [0, 0, 1], radius: r, x_axis: [1, 0, 0] });
    add(CIRCLE, 21, { node_id: 21, owner: 16, sense: '+', centre: [0, 0, h], normal: [0, 0, 1], x_axis: [1, 0, 0], radius: r });
    add(CIRCLE, 22, { node_id: 22, owner: 17, sense: '+', centre: [0, 0, 0], normal: [0, 0, 1], x_axis: [1, 0, 0], radius: r });
    return n;
}

/**
 * A box [0, a] x [0, b] x [0, c] (metres) with vertices, points and line edges, each edge's line running
 * as `lineSense` says relative to the edge (to test curve senses).
 */
export function boxNodes(a: number, b: number, c: number, lineSense: '+' | '-' = '+'): TestNode[] {
    const nodes: TestNode[] = [];
    let next = 1;
    const id = (): number => next++;
    const body = id();
    const voidRegion = id();
    const solidRegion = id();
    const shell = id();
    const corners: number[][] = [];
    for (let i = 0; i < 8; i++) {
        corners.push([(i & 1) * a, ((i >> 1) & 1) * b, ((i >> 2) & 1) * c]);
    }
    const vertexIds = corners.map(() => id());
    const pointIds = corners.map(() => id());
    // Faces as corner rings, counter-clockwise seen from outside.
    const faces: { ring: number[]; normal: number[]; p: number[] }[] = [
        { ring: [0, 2, 3, 1], normal: [0, 0, -1], p: [0, 0, 0] },
        { ring: [4, 5, 7, 6], normal: [0, 0, 1], p: [0, 0, c] },
        { ring: [0, 1, 5, 4], normal: [0, -1, 0], p: [0, 0, 0] },
        { ring: [2, 6, 7, 3], normal: [0, 1, 0], p: [0, b, 0] },
        { ring: [0, 4, 6, 2], normal: [-1, 0, 0], p: [0, 0, 0] },
        { ring: [1, 3, 7, 5], normal: [1, 0, 0], p: [a, 0, 0] },
    ];
    const faceIds = faces.map(() => id());
    const loopIds = faces.map(() => id());
    const surfIds = faces.map(() => id());
    const edgeKey = (i: number, j: number): string => (i < j ? `${i}-${j}` : `${j}-${i}`);
    const edges = new Map<string, { id: number; curve: number; fins: { fin: number; along: boolean }[]; from: number; to: number }>();
    const finIds: number[][] = faces.map((f) => f.ring.map(() => id()));
    faces.forEach((f, k) => {
        f.ring.forEach((v, i) => {
            const w = f.ring[(i + 1) % 4];
            const key = edgeKey(v, w);
            let e = edges.get(key);
            if (!e) {
                e = { id: id(), curve: id(), fins: [], from: Math.min(v, w), to: Math.max(v, w) };
                edges.set(key, e);
            }
            e.fins.push({ fin: finIds[k][i], along: v === e.from });
        });
    });
    nodes.push({ type: BODY, index: body, fields: { body_type: 1, region: voidRegion, state: 1, nom_geom_state: 1, vertex: vertexIds[0] } });
    nodes.push({ type: REGION, index: voidRegion, fields: { node_id: voidRegion, body, next: solidRegion, type: 'V' } });
    nodes.push({ type: REGION, index: solidRegion, fields: { node_id: solidRegion, body, previous: voidRegion, shell, type: 'S' } });
    nodes.push({ type: SHELL, index: shell, fields: { node_id: shell, body, face: faceIds[0], region: solidRegion } });
    corners.forEach((p, i) => {
        nodes.push({ type: VERTEX, index: vertexIds[i], fields: { node_id: vertexIds[i], point: pointIds[i], owner: body, tolerance: -3.14158e13 } });
        nodes.push({ type: POINT, index: pointIds[i], fields: { node_id: pointIds[i], owner: vertexIds[i], pvec: p } });
    });
    faces.forEach((f, k) => {
        nodes.push({ type: FACE, index: faceIds[k], fields: {
            node_id: faceIds[k], next: faceIds[k + 1] ?? 0, previous: faceIds[k - 1] ?? 0, loop: loopIds[k], shell, surface: surfIds[k],
            sense: '+', tolerance: -3.14158e13,
        } });
        nodes.push({ type: LOOP, index: loopIds[k], fields: { node_id: loopIds[k], fin: finIds[k][0], face: faceIds[k] } });
        const x = Math.abs(f.normal[0]) > 0.5 ? [0, 1, 0] : [1, 0, 0];
        nodes.push({ type: PLANE, index: surfIds[k], fields: { node_id: surfIds[k], owner: faceIds[k], sense: '+', pvec: f.p, normal: f.normal, x_axis: x } });
        f.ring.forEach((v, i) => {
            const w = f.ring[(i + 1) % 4];
            const e = edges.get(edgeKey(v, w))!;
            const me = e.fins.find((q) => q.fin === finIds[k][i])!;
            const other = e.fins.find((q) => q.fin !== finIds[k][i])!;
            nodes.push({ type: FIN, index: finIds[k][i], fields: {
                loop: loopIds[k], forward: finIds[k][(i + 1) % 4], backward: finIds[k][(i + 3) % 4], vertex: vertexIds[w], other: other.fin,
                edge: e.id, sense: me.along ? '+' : '-',
            } });
        });
    });
    for (const e of edges.values()) {
        const p0 = corners[e.from];
        const p1 = corners[e.to];
        const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        const len = Math.hypot(d[0], d[1], d[2]);
        const dir = d.map((x) => (x / len) * (lineSense === '+' ? 1 : -1));
        nodes.push({ type: EDGE, index: e.id, fields: { node_id: e.id, fin: e.fins.find((q) => q.along)!.fin, curve: e.curve, owner: body, tolerance: -3.14158e13 } });
        nodes.push({ type: LINE, index: e.curve, fields: { node_id: e.curve, owner: e.id, sense: lineSense, pvec: p0, direction: dir } });
    }
    return nodes;
}
