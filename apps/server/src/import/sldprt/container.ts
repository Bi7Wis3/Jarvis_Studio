// SolidWorks part files come in two containers, both holding named streams:
// - 2015 and later: a ZIP-like archive. Each record is a ZIP local header whose 4-byte signature is replaced by a
//   per-file value, with its name nibble-swapped and its data raw-deflated (CRC-32 as in ZIP).
// - Before 2015: an OLE compound document (Microsoft CFB) with storages such as "Contents".
// Stream names are given as paths: "Contents/Config-0-Partition", "PreviewPNG", ...

import { crc32, inflateRawSync } from 'node:zlib';

export interface SwContainer {
    kind: 'zip2015' | 'ole';
    streams: Map<string, Uint8Array>;
    /** Records that could not be read (bad checksum, broken data). */
    warnings: string[];
}

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
// Local header after the disguised signature: version 20, flags 6, method 8 (deflate).
const LOCAL_TAIL = [0x14, 0x00, 0x06, 0x00, 0x08, 0x00];

export function isOle(bytes: Uint8Array): boolean {
    return bytes.length >= 512 && OLE_MAGIC.every((b, i) => bytes[i] === b);
}

export function readContainer(bytes: Uint8Array): SwContainer {
    return isOle(bytes) ? readOle(bytes) : readZip2015(bytes);
}

const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number): number => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

function indexOf(hay: Uint8Array, needle: number[], from: number): number {
    return Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength).indexOf(Buffer.from(needle), from);
}

const swapNibbles = (b: Uint8Array): Uint8Array => b.map((x) => ((x >> 4) | (x << 4)) & 0xff);

/** A plausible local header at `at` (the version field): its name length and sizes fit the file. */
function headerFits(bytes: Uint8Array, at: number): boolean {
    if (at < 4 || at + 26 > bytes.length) {
        return false;
    }
    const csize = u32(bytes, at + 14);
    const nlen = u16(bytes, at + 22);
    const xlen = u16(bytes, at + 24);
    if (nlen === 0 || nlen > 1024 || at + 26 + nlen + xlen + csize > bytes.length) {
        return false;
    }
    // Names are printable ASCII paths once nibble-swapped.
    const name = swapNibbles(bytes.subarray(at + 26, at + 26 + nlen));
    return name.every((c) => c >= 0x20 && c < 0x7f);
}

/**
 * The 2015+ archive. The record signature differs per file; it is the 4 bytes most often found in front of
 * a fitting local header. Records are then walked by that 10-byte pattern, each skipped by its stored size.
 */
export function readZip2015(bytes: Uint8Array): SwContainer {
    const votes = new Map<number, number>();
    for (let at = indexOf(bytes, LOCAL_TAIL, 4); at >= 0; at = indexOf(bytes, LOCAL_TAIL, at + 1)) {
        if (headerFits(bytes, at)) {
            const sig = u32(bytes, at - 4);
            votes.set(sig, (votes.get(sig) ?? 0) + 1);
        }
    }
    const warnings: string[] = [];
    const streams = new Map<string, Uint8Array>();
    if (votes.size === 0) {
        throw new Error('This is not a SolidWorks file (no OLE header and no 2015+ records)');
    }
    const sig = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const pattern = [sig & 0xff, (sig >>> 8) & 0xff, (sig >>> 16) & 0xff, sig >>> 24, ...LOCAL_TAIL];
    for (let at = indexOf(bytes, pattern, 0); at >= 0;) {
        const h = at + 4;
        if (!headerFits(bytes, h)) {
            at = indexOf(bytes, pattern, at + 1);
            continue;
        }
        const crc = u32(bytes, h + 10);
        const csize = u32(bytes, h + 14);
        const usize = u32(bytes, h + 18);
        const nlen = u16(bytes, h + 22);
        const xlen = u16(bytes, h + 24);
        const name = Buffer.from(swapNibbles(bytes.subarray(h + 26, h + 26 + nlen))).toString('latin1');
        const start = h + 26 + nlen + xlen;
        const packed = bytes.subarray(start, start + csize);
        try {
            const data = usize === 0 && csize <= 2 ? new Uint8Array(0) : new Uint8Array(inflateRawSync(packed));
            if (data.length !== usize || crc32(data) !== crc) {
                warnings.push(`The file's "${name}" record fails its checksum and was skipped`);
            } else if (!streams.has(name)) {
                streams.set(name, data);
            }
        } catch {
            warnings.push(`The file's "${name}" record could not be unpacked and was skipped`);
        }
        at = indexOf(bytes, pattern, start + csize);
    }
    return { kind: 'zip2015', streams, warnings };
}

// ---- OLE compound document (MS-CFB) ---------------------------------------------------------------------------

const FREE = 0xffffffff;
const END_OF_CHAIN = 0xfffffffe;

export function readOle(bytes: Uint8Array): SwContainer {
    const sectorShift = u16(bytes, 0x1e);
    const miniShift = u16(bytes, 0x20);
    const sectorSize = 1 << sectorShift;
    const miniSize = 1 << miniShift;
    const nFatSectors = u32(bytes, 0x2c);
    const dirStart = u32(bytes, 0x30);
    const miniCutoff = u32(bytes, 0x38);
    const miniFatStart = u32(bytes, 0x3c);
    const nMiniFat = u32(bytes, 0x40);
    let difatSector = u32(bytes, 0x44);
    const sectorAt = (s: number): number => (s + 1) * sectorSize;

    // FAT sector list: 109 entries in the header, the rest in DIFAT sectors.
    const fatSectors: number[] = [];
    for (let i = 0; i < 109 && fatSectors.length < nFatSectors; i++) {
        fatSectors.push(u32(bytes, 0x4c + i * 4));
    }
    const perDifat = sectorSize / 4 - 1;
    for (let guard = 0; difatSector !== END_OF_CHAIN && difatSector !== FREE && fatSectors.length < nFatSectors && guard < 1e6; guard++) {
        const base = sectorAt(difatSector);
        for (let i = 0; i < perDifat && fatSectors.length < nFatSectors; i++) {
            fatSectors.push(u32(bytes, base + i * 4));
        }
        difatSector = u32(bytes, base + perDifat * 4);
    }
    const perSector = sectorSize / 4;
    const fat = new Uint32Array(fatSectors.length * perSector);
    fatSectors.forEach((s, k) => {
        const base = sectorAt(s);
        for (let i = 0; i < perSector && base + i * 4 + 4 <= bytes.length; i++) {
            fat[k * perSector + i] = u32(bytes, base + i * 4);
        }
    });

    const chain = (start: number, table: Uint32Array): number[] => {
        const out: number[] = [];
        for (let s = start; s !== END_OF_CHAIN && s !== FREE && s < table.length && out.length <= table.length; s = table[s]) {
            out.push(s);
        }
        return out;
    };
    const readChain = (start: number, size?: number): Uint8Array => {
        const sectors = chain(start, fat);
        const out = new Uint8Array(sectors.length * sectorSize);
        sectors.forEach((s, i) => out.set(bytes.subarray(sectorAt(s), sectorAt(s) + sectorSize), i * sectorSize));
        return size === undefined ? out : out.subarray(0, size);
    };

    const dir = readChain(dirStart);
    interface Entry { name: string; type: number; left: number; right: number; child: number; start: number; size: number }
    const entries: Entry[] = [];
    for (let at = 0; at + 128 <= dir.length; at += 128) {
        const nameLen = u16(dir, at + 0x40);
        const name = Buffer.from(dir.subarray(at, at + Math.max(0, nameLen - 2))).toString('utf16le');
        entries.push({
            name, type: dir[at + 0x42], left: u32(dir, at + 0x44), right: u32(dir, at + 0x48), child: u32(dir, at + 0x4c),
            start: u32(dir, at + 0x74), size: u32(dir, at + 0x78),
        });
    }
    const root = entries[0];
    const miniStream = root ? readChain(root.start, root.size) : new Uint8Array(0);
    const miniFatBytes = nMiniFat > 0 ? readChain(miniFatStart) : new Uint8Array(0);
    const miniFat = new Uint32Array(miniFatBytes.length / 4);
    for (let i = 0; i < miniFat.length; i++) {
        miniFat[i] = u32(miniFatBytes, i * 4);
    }
    const readMini = (start: number, size: number): Uint8Array => {
        const out = new Uint8Array(size);
        let pos = 0;
        for (const s of chain(start, miniFat)) {
            const n = Math.min(miniSize, size - pos);
            out.set(miniStream.subarray(s * miniSize, s * miniSize + n), pos);
            pos += n;
            if (pos >= size) {
                break;
            }
        }
        return out;
    };

    const streams = new Map<string, Uint8Array>();
    const seen = new Set<number>();
    const visit = (id: number, path: string): void => {
        if (id === FREE || id >= entries.length || seen.has(id)) {
            return;
        }
        seen.add(id);
        const e = entries[id];
        visit(e.left, path);
        visit(e.right, path);
        const full = path ? `${path}/${e.name}` : e.name;
        if (e.type === 2) {
            streams.set(full, e.size < miniCutoff ? readMini(e.start, e.size) : readChain(e.start, e.size));
        } else if (e.type === 1) {
            visit(e.child, full);
        }
    };
    if (root) {
        visit(root.child, '');
    }
    return { kind: 'ole', streams, warnings: [] };
}
