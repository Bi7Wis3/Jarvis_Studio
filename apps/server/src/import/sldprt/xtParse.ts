// Reader for Parasolid binary transmit (XT) data: neutral binary ("PS\0\0", big-endian) and typed binary
// ("PS\0\1" + machine bytes), with the schema changes newer versions embed before the first node of each type.
// Gives the raw node graph; see xtModel.ts for bodies and geometry.

import { baseSchema, PK_VISIBLE, type XtField, type XtNodeType } from './xtSchema.js';

export type XtValue = number | string | boolean | number[] | boolean[];

export interface XtNode {
    type: number;
    index: number;
    /** Field values by name. Pointers are node indices (0: null), vectors [x, y, z], char arrays strings. */
    f: Record<string, XtValue>;
}

export interface XtFile {
    /** E.g. ": TRANSMIT FILE (partition) created by modeller version 2700199". */
    header: string;
    /** The modeller version number, e.g. 2700199 (Parasolid 27.0.199). */
    modellerVersion: number;
    schema: string;
    nodes: Map<number, XtNode>;
    types: Map<number, XtNodeType>;
}

/** Parasolid's "unset" values. */
export const NULL_INT = -32764;
export const NULL_DOUBLE = -3.14158e13;
export const isNullDouble = (v: number): boolean => Math.abs(v - NULL_DOUBLE) < 1e3;

export class XtError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'XtError';
    }
}

class Reader {
    pos = 0;
    private readonly view: DataView;

    constructor(readonly bytes: Uint8Array, readonly little: boolean) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    need(n: number): void {
        if (this.pos + n > this.bytes.length) {
            throw new XtError(`The Parasolid data ends early (at byte ${this.pos})`);
        }
    }

    u8(): number {
        this.need(1);
        return this.bytes[this.pos++];
    }

    i16(): number {
        this.need(2);
        const v = this.view.getInt16(this.pos, this.little);
        this.pos += 2;
        return v;
    }

    i32(): number {
        this.need(4);
        const v = this.view.getInt32(this.pos, this.little);
        this.pos += 4;
        return v;
    }

    f64(): number {
        this.need(8);
        const v = this.view.getFloat64(this.pos, this.little);
        this.pos += 8;
        return v;
    }

    chars(n: number): string {
        this.need(n);
        const s = Buffer.from(this.bytes.subarray(this.pos, this.pos + n)).toString('latin1');
        this.pos += n;
        return s;
    }

    /** A pointer index or "positive integer": one short below 32767, else a (negative remainder, quotient) pair. */
    index(): number {
        let r = this.i16();
        let q = 0;
        if (r < 0) {
            q = this.i16();
            r = -r;
        }
        return q * 32767 + r - 1;
    }

    shortString(): string {
        return this.chars(this.u8());
    }
}

function readEmbeddedField(r: Reader): XtField {
    const name = r.shortString();
    const ptrClass = r.i16();
    const nElts = r.index();
    const type = ptrClass !== 0 ? 'p' : r.shortString();
    const xmt = nElts === 1 ? r.u8() !== 0 : true;
    return { name, type, nElts, xmt };
}

const EDIT_CODES = new Set([0x43, 0x44, 0x49, 0x41, 0x5a]); // C D I A Z

/** Reads the schema information inserted before the first node of a type, giving that type's fields. */
function readEmbeddedType(r: Reader, id: number, known: XtNodeType | undefined): XtNodeType {
    const first = r.u8();
    if (first === 0xff) {
        if (!known) {
            throw new XtError(`Node type ${id} is unknown and has no definition`);
        }
        return known;
    }
    // A type not in the base schema (or one a writer treats so) is defined in full: name, description, fields.
    if (!known || !EDIT_CODES.has(r.bytes[r.pos])) {
        const name = r.shortString();
        r.shortString();
        const fields: XtField[] = [];
        for (let i = 0; i < first; i++) {
            fields.push(readEmbeddedField(r));
        }
        return { id, name, fields };
    }
    const fields: XtField[] = [];
    let b = 0;
    for (;;) {
        const code = String.fromCharCode(r.u8());
        if (code === 'Z') {
            break;
        }
        if (code === 'C') {
            if (b >= known.fields.length) {
                throw new XtError(`Bad schema change for node type ${id}`);
            }
            fields.push(known.fields[b++]);
        } else if (code === 'D') {
            b++;
        } else if (code === 'I' || code === 'A') {
            fields.push(readEmbeddedField(r));
        } else {
            throw new XtError(`Bad schema change code for node type ${id}`);
        }
    }
    return { id, name: known.name, fields };
}

function readValue(r: Reader, type: string): XtValue {
    switch (type) {
        case 'u': return r.u8();
        case 'c': return String.fromCharCode(r.u8());
        case 'l': return r.u8() !== 0;
        case 'n':
        case 'w': return r.i16();
        case 'd':
        case 't': return r.i32();
        case 'p': return r.index();
        case 'f': return r.f64();
        case 'i': return [r.f64(), r.f64()];
        case 'v':
        case 'h': return [r.f64(), r.f64(), r.f64()];
        case 'b': return [r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64()];
        default: throw new XtError(`Unknown field type "${type}"`);
    }
}

function readArray(r: Reader, type: string, n: number): XtValue {
    if (type === 'c') {
        return r.chars(n);
    }
    const width = type === 'v' || type === 'h' ? 3 : type === 'i' ? 2 : type === 'b' ? 6 : 1;
    if (width > 1) {
        const out: number[] = [];
        for (let i = 0; i < n; i++) {
            out.push(...(readValue(r, type) as number[]));
        }
        return out;
    }
    const out: (number | boolean)[] = [];
    for (let i = 0; i < n; i++) {
        out.push(readValue(r, type) as number | boolean);
    }
    return out as number[] | boolean[];
}

export function parseXt(bytes: Uint8Array): XtFile {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x53) {
        throw new XtError('Not Parasolid binary transmit data');
    }
    let little = false;
    let pos: number;
    if (bytes[2] === 0 && bytes[3] === 0) {
        pos = 4;
    } else if (bytes[2] === 0 && bytes[3] === 1) {
        little = bytes[4] === 1;
        if (bytes[5] !== 0 || bytes[6] !== 0) {
            throw new XtError('Parasolid data from a machine with non-IEEE reals or EBCDIC text is not supported');
        }
        pos = 7;
    } else {
        throw new XtError('Unsupported Parasolid binary flavour');
    }
    const r = new Reader(bytes, little);
    r.pos = pos;
    const header = r.chars(r.i16());
    const schema = r.chars(r.i32());
    const embedded = /^SCH_\d+_\d+_\d+/.test(schema);
    if (embedded) {
        r.i16(); // highest node type number
    }
    const userFields = r.i32();
    const version = /version\s+(\d+)/.exec(header);

    const base = baseSchema();
    const types = new Map<number, XtNodeType>();
    const nodes = new Map<number, XtNode>();
    for (;;) {
        const type = r.i16();
        if (type === 1) {
            break;
        }
        let def = types.get(type);
        if (!def) {
            def = embedded ? readEmbeddedType(r, type, base.get(type)) : base.get(type);
            if (!def) {
                throw new XtError(`Unknown Parasolid node type ${type} at byte ${r.pos - 2}`);
            }
            types.set(type, def);
        }
        const variable = def.fields.some((f) => f.nElts === 1);
        const length = variable ? r.i32() : 0;
        if (length < 0 || length > bytes.length) {
            throw new XtError(`Bad length in node type ${type} at byte ${r.pos}`);
        }
        const index = r.index();
        const f: Record<string, XtValue> = {};
        for (const field of def.fields) {
            if (!field.xmt) {
                continue;
            }
            f[field.name] = field.nElts === 0 ? readValue(r, field.type) : readArray(r, field.type, field.nElts === 1 ? length : field.nElts);
        }
        if (userFields > 0 && PK_VISIBLE.has(type)) {
            for (let i = 0; i < userFields; i++) {
                r.i32();
            }
        }
        nodes.set(index, { type, index, f });
    }
    return { header, modellerVersion: version ? Number(version[1]) : 0, schema, nodes, types };
}
