// Imported solids kept as OpenCascade BREP text, gzipped, in the assets folder, and read back once per CAD worker:
// each build of an Imported step gets a copy of the shape read the first time.

import { gunzipSync, gzipSync } from 'node:zlib';
import { cast, getOC, type Shape3D } from 'replicad';
import { readImportAsset, saveImportAsset } from './assets.js';

/** Stores a shape and returns its asset id (a hash of the file, so equal shapes share one). */
export function saveBrep(shape: Shape3D): string {
    const text = getOC().BRepToolsWrapper.Write(shape.wrapped);
    return saveImportAsset(gzipSync(Buffer.from(text, 'utf8'), { level: 6 }), 'brep');
}

const cache = new Map<string, Shape3D>();
const CACHE_SIZE = 16;

/** A copy of the stored shape (the caller owns it). */
export function loadBrep(id: string): Shape3D {
    let shape = cache.get(id);
    if (shape) {
        cache.delete(id);
    } else {
        const data = readImportAsset(id);
        // Plain BREP text is read too (a file put there by hand).
        const text = data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data).toString('utf8') : data.toString('utf8');
        shape = cast(getOC().BRepToolsWrapper.Read(text)) as Shape3D;
        if (shape.isNull) {
            throw new Error(`the imported bodies (${id}) could not be read back`);
        }
    }
    cache.set(id, shape);
    while (cache.size > CACHE_SIZE) {
        const oldest = cache.keys().next().value as string;
        cache.get(oldest)?.delete();
        cache.delete(oldest);
    }
    return shape.clone();
}
