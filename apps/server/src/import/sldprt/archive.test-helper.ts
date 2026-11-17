// Part files made up for tests, in SolidWorks' 2015+ container: no real design is needed to test the container, the
// file browser or its preview pictures.

import { crc32, deflateRawSync } from 'node:zlib';

/** A 2015+ style archive: ZIP local headers with a disguised signature and nibble-swapped names. */
export function archive(entries: [string, Uint8Array][]): Uint8Array {
    const sig = [0x0f, 0xba, 0x02, 0x64];
    const parts: Buffer[] = [Buffer.from([0x09, 0x43, 0x24, 0x00, 0, 0, 0, 4])];
    // A decoy with the same tail but another signature, as the real files have.
    parts.push(Buffer.from([1, 2, 3, 4, 0x14, 0, 6, 0, 8, 0, 0, 0, 0, 0, 0xbc, 7, 0, 0, 0xef, 1, 0, 0, 0xde, 3, 0, 0, 3, 0, 0, 0, 0x05, 0x27, 0x56]));
    for (const [name, data] of entries) {
        const packed = deflateRawSync(data);
        const nameBytes = Buffer.from(name, 'latin1').map((x) => ((x >> 4) | (x << 4)) & 0xff);
        const h = Buffer.alloc(26);
        h.set([0x14, 0, 6, 0, 8, 0], 0);
        h.writeUInt32LE(crc32(data), 10);
        h.writeUInt32LE(packed.length, 14);
        h.writeUInt32LE(data.length, 18);
        h.writeUInt16LE(nameBytes.length, 22);
        parts.push(Buffer.from(sig), h, Buffer.from(nameBytes), packed);
    }
    return new Uint8Array(Buffer.concat(parts));
}

/** A stand-in part file: a model stream and a preview picture of `size` bytes (a PNG signature, then filler). */
export function standInPart(size = 1500, seed = 1): Uint8Array {
    const png = new Uint8Array(size);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (let i = 8; i < size; i++) {
        png[i] = (i * 31 + seed * 17) & 0xff;
    }
    return archive([['Contents/Config-0-Partition', new Uint8Array([1, 2, 3, seed])], ['PreviewPNG', png]]);
}
