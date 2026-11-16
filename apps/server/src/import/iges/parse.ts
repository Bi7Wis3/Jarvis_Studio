// The sections of an IGES 5.3 file (fixed-column ASCII): Start, Global, Directory Entry, Parameter Data and
// Terminate. Each entity is two Directory Entry lines (fixed 8-column fields) and free-format parameters
// separated by the file's delimiters, strings written as Hollerith constants (5HHello).

/** A parameter: a number, a string (Hollerith), or null when the field is empty (the default applies). */
export type Param = number | string | null;

export interface IgesEntity {
    /** Sequence number of the entity's first Directory Entry line: the pointer other entities use. */
    de: number;
    type: number;
    form: number;
    /** The parameters after the entity type number. */
    params: Param[];
    /** DE pointer of a transformation matrix (124), or 0. */
    xform: number;
    level: number;
    /** Colour number: 0 none, 1..8 the standard colours, negative a pointer to a colour definition (314). */
    color: number;
    blank: boolean;
    /** 0 independent, 1 physically dependent, 2 logically dependent, 3 both. */
    subordinate: number;
    /** 0 geometry, 1 annotation, 2 definition, 3 other, 4 logical, 5 2D parametric, 6 construction. */
    use: number;
    label: string;
    subscript: number;
}

export interface IgesGlobal {
    paramDelimiter: string;
    recordDelimiter: string;
    /** The global parameters in order (index 0 is the parameter delimiter, 12 the model space scale ...). */
    fields: Param[];
    /** The system that wrote the file. */
    system: string;
    /** Millimetres per model unit. */
    unitMm: number;
    unitName: string;
    /** Model space scale: model units per real-world unit. */
    scale: number;
    /** Minimum user-intended resolution, in model units. */
    resolution: number;
}

export interface IgesFile {
    start: string;
    global: IgesGlobal;
    entities: Map<number, IgesEntity>;
    /** Entities in file order. */
    order: IgesEntity[];
}

export class IgesFormatError extends Error {}

/** The file's 80-column records: lines, or a stream of fixed 80-character records without line breaks. */
function records(text: string): string[] {
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length <= 2 && text.length > 160 && text.length % 80 === 0) {
        const out: string[] = [];
        for (let i = 0; i < text.length; i += 80) {
            out.push(text.slice(i, i + 80));
        }
        return out;
    }
    return lines.filter((l) => l.trim().length > 0);
}

/** Splits free-format parameter text at the delimiters, reading Hollerith strings whole; stops at the record delimiter. */
export function splitParams(text: string, pd: string, rd: string): Param[] {
    const out: Param[] = [];
    let i = 0;
    const n = text.length;
    while (i < n) {
        while (i < n && text[i] === ' ') {
            i++;
        }
        // nHxxxx: a string of n characters.
        let j = i;
        while (j < n && text[j] >= '0' && text[j] <= '9') {
            j++;
        }
        let value: Param;
        if (j > i && j < n && (text[j] === 'H' || text[j] === 'h')) {
            const count = Number(text.slice(i, j));
            value = text.slice(j + 1, j + 1 + count);
            i = j + 1 + count;
            while (i < n && text[i] !== pd && text[i] !== rd) {
                i++;
            }
        } else {
            let k = i;
            while (k < n && text[k] !== pd && text[k] !== rd) {
                k++;
            }
            const raw = text.slice(i, k).replace(/\s+/g, '');
            i = k;
            if (raw === '') {
                value = null;
            } else {
                const num = Number(raw.replace(/[dD]/, 'E'));
                value = Number.isFinite(num) ? num : raw;
            }
        }
        out.push(value);
        if (i >= n || text[i] === rd) {
            break;
        }
        i++; // past the parameter delimiter
        if (i >= n) {
            out.push(null);
        }
    }
    return out;
}

const UNIT_MM: Record<number, number> = { 1: 25.4, 2: 1, 4: 304.8, 5: 1609344, 6: 1000, 7: 1e6, 8: 0.0254, 9: 0.001, 10: 10, 11: 0.0000254 };
const UNIT_NAMES: Record<string, number> = {
    IN: 25.4, INCH: 25.4, MM: 1, FT: 304.8, MI: 1609344, M: 1000, KM: 1e6, MIL: 0.0254, UM: 0.001, MICRON: 0.001, CM: 10, UIN: 0.0000254,
};

function parseGlobal(text: string): IgesGlobal {
    // The first two fields name the delimiters themselves (1H, and 1H;), or are empty for the defaults.
    let pd = ',';
    let rd = ';';
    let rest = text.trimStart();
    if (/^1[Hh]/.test(rest)) {
        pd = rest[2];
        rest = rest.slice(3);
        if (rest[0] === pd) {
            rest = rest.slice(1);
        }
    } else if (rest[0] === ',') {
        rest = rest.slice(1);
    }
    if (/^1[Hh]/.test(rest)) {
        rd = rest[2];
    }
    const fields = splitParams(text.trimStart(), pd, rd);
    const num = (i: number, fallback: number): number => (typeof fields[i] === 'number' ? fields[i] as number : fallback);
    const str = (i: number): string => (typeof fields[i] === 'string' ? (fields[i] as string).trim() : '');
    const flag = num(13, 1);
    const unitName = str(14).toUpperCase();
    const unitMm = flag === 3 ? (UNIT_NAMES[unitName] ?? 1) : (UNIT_MM[flag] ?? UNIT_NAMES[unitName] ?? 1);
    return {
        paramDelimiter: pd,
        recordDelimiter: rd,
        fields,
        system: str(4) || str(5),
        unitMm,
        unitName: unitName || 'MM',
        scale: num(12, 1) > 0 ? num(12, 1) : 1,
        resolution: num(18, 0) > 0 ? num(18, 0) : 0,
    };
}

const field = (line: string, k: number): string => line.slice(k * 8, k * 8 + 8).trim();
const intField = (line: string, k: number): number => {
    const t = field(line, k);
    const v = t ? parseInt(t, 10) : 0;
    return Number.isFinite(v) ? v : 0;
};

export function parseIges(bytes: Uint8Array): IgesFile {
    if (bytes.length === 0) {
        throw new IgesFormatError('the file is empty');
    }
    const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
    const lines = records(text);
    const start: string[] = [];
    const global: string[] = [];
    const dir: string[] = [];
    const param = new Map<number, string>();
    for (const raw of lines) {
        const line = raw.padEnd(80, ' ');
        const section = line[72];
        if (section === 'S') {
            start.push(line.slice(0, 72).trimEnd());
        } else if (section === 'G') {
            global.push(line.slice(0, 72));
        } else if (section === 'D') {
            dir.push(line);
        } else if (section === 'P') {
            param.set(parseInt(line.slice(73, 80), 10), line.slice(0, 64));
        } else if (section === 'C' || section === 'B') {
            throw new IgesFormatError('the file is a compressed or binary IGES file; only the ASCII form is read');
        }
    }
    if (global.length === 0 || dir.length === 0) {
        throw new IgesFormatError('the file is not an IGES file (no Global or Directory Entry section)');
    }
    const entities = new Map<number, IgesEntity>();
    const order: IgesEntity[] = [];
    const g = parseGlobal(global.join(''));
    for (let i = 0; i + 1 < dir.length; i += 2) {
        const a = dir[i];
        const b = dir[i + 1];
        const de = parseInt(a.slice(73, 80), 10) || i + 1;
        const status = field(a, 8).replace(/\D/g, '').padStart(8, '0');
        const pdStart = intField(a, 1);
        const pdLines = intField(b, 3);
        let pdText = '';
        for (let k = 0; k < Math.max(1, pdLines); k++) {
            pdText += param.get(pdStart + k) ?? '';
        }
        const all = splitParams(pdText, g.paramDelimiter, g.recordDelimiter);
        const entity: IgesEntity = {
            de,
            type: intField(a, 0),
            form: intField(b, 4),
            params: all.slice(1),
            xform: intField(a, 6),
            level: intField(a, 4),
            color: intField(b, 2),
            blank: status.slice(0, 2) === '01',
            subordinate: parseInt(status.slice(2, 4), 10) || 0,
            use: parseInt(status.slice(4, 6), 10) || 0,
            label: b.slice(56, 64).trim(),
            subscript: intField(b, 8),
        };
        entities.set(de, entity);
        order.push(entity);
    }
    return { start: start.join('\n'), global: g, entities, order };
}
