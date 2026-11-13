import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSETS_DIR } from './paths.js';

export const MAX_ASSET_BYTES = 15 * 1024 * 1024;

const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const ID = /^[a-f0-9]{24}\.(png|jpg|webp)$/;

/** Stores an image under a hash of its content (so the same picture is stored once) and returns its id. */
export function saveAsset(data: Buffer, mimeType: string): string {
    const extension = TYPES[mimeType];
    if (!extension) {
        throw new Error(`Unsupported image type ${mimeType}; use PNG, JPEG or WebP.`);
    }
    const id = `${createHash('sha256').update(data).digest('hex').slice(0, 24)}.${extension}`;
    mkdirSync(ASSETS_DIR, { recursive: true });
    const path = join(ASSETS_DIR, id);
    if (!existsSync(path)) {
        writeFileSync(path, data);
    }
    return id;
}

/** The image and its content type, or null for an unknown or malformed id. */
export function readAsset(id: string): { data: Buffer; type: string } | null {
    const match = ID.exec(id);
    const path = match ? join(ASSETS_DIR, id) : null;
    if (!match || !path || !existsSync(path)) {
        return null;
    }
    const type = Object.entries(TYPES).find(([, ext]) => ext === match[1])![0];
    return { data: readFileSync(path), type };
}
