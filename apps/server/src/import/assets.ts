// Import files kept next to the projects (projects/assets), named by a hash of their content so equal files are
// stored once and a step's asset id never changes: the original file, the BREP of its solids, the mesh of a graphics
// body. Used by the server and the CAD worker alike.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMPORT_ASSET } from '@jarvis/core/imported';
import { ASSETS_DIR } from '../paths.js';

export const assetId = (data: Uint8Array | string, extension: string): string =>
    `${createHash('sha256').update(data).digest('hex').slice(0, 24)}.${extension.toLowerCase()}`;

/** Stores the bytes (once) and returns their asset id. */
export function saveImportAsset(data: Uint8Array | string, extension: string): string {
    const id = assetId(data, extension);
    mkdirSync(ASSETS_DIR, { recursive: true });
    const path = join(ASSETS_DIR, id);
    if (!existsSync(path)) {
        // Written beside it first, so a half-written file is never taken for the asset.
        const partial = `${path}.${process.pid}.part`;
        writeFileSync(partial, data);
        renameSync(partial, path);
    }
    return id;
}

export function importAssetPath(id: string): string {
    if (!IMPORT_ASSET.test(id)) {
        throw new Error(`"${id}" is not an import asset id`);
    }
    return join(ASSETS_DIR, id);
}

/** The asset's bytes; throws a readable error when it is missing (a project copied without its assets folder). */
export function readImportAsset(id: string): Buffer {
    const path = importAssetPath(id);
    if (!existsSync(path)) {
        throw new Error(`the imported file's data (${id}) is missing from ${ASSETS_DIR}`);
    }
    return readFileSync(path);
}

export const hasImportAsset = (id: string): boolean => IMPORT_ASSET.test(id) && existsSync(join(ASSETS_DIR, id));
