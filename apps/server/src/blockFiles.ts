// Sketch blocks saved as files (SolidWorks Save Block / Insert Block from a file): JSON files in the blocks folder of
// the projects folder, one per block, named after the block. A file holds the block's entities and relations, the
// text, equation curves and block instances inside it, the definitions of those nested blocks, and its colour. Saving
// under the same name replaces the file (blocks linked to it follow it).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SketchBlock, SketchGeometry } from '@jarvis/core';
import { PROJECTS_DIR } from './paths.js';

export const BLOCKS_DIR = join(PROJECTS_DIR, 'blocks');

export interface BlockFile {
    name: string;
    geometry: SketchGeometry;
    colour?: string;
    blocks?: SketchBlock[];
}

/** A file name for a block name: letters, digits, spaces, dashes and underscores only. */
const fileOf = (name: string): string | null => {
    const clean = name.trim();
    return /^[\p{L}\p{N} _-]{1,80}$/u.test(clean) ? join(BLOCKS_DIR, `${clean}.json`) : null;
};

export function listBlockFiles(dir = BLOCKS_DIR): string[] {
    if (!existsSync(dir)) {
        return [];
    }
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort((a, b) => a.localeCompare(b));
}

export function readBlockFile(name: string): BlockFile | null {
    const path = fileOf(name);
    if (!path || !existsSync(path)) {
        return null;
    }
    try {
        const data = JSON.parse(readFileSync(path, 'utf8')) as BlockFile;
        return valid(data) ? data : null;
    } catch {
        return null;
    }
}

const validGeometry = (g: SketchGeometry | undefined): boolean => !!g && Array.isArray(g.points) && Array.isArray(g.curves) && Array.isArray(g.constraints)
    && [g.texts, g.equations, g.inserts].every((list) => list === undefined || Array.isArray(list));

function valid(data: unknown): data is BlockFile {
    const d = data as BlockFile | null;
    return !!d && typeof d.name === 'string' && validGeometry(d.geometry)
        && (d.colour === undefined || (typeof d.colour === 'string' && /^#[0-9a-f]{6}$/i.test(d.colour)))
        && (d.blocks === undefined || (Array.isArray(d.blocks) && d.blocks.every((b) => !!b && typeof b.id === 'string' && typeof b.name === 'string' && validGeometry(b.geometry))));
}

/** The parts of a sketch geometry a block keeps. */
function blockContent(g: SketchGeometry): SketchGeometry {
    const { points, curves, constraints, texts, equations, inserts } = g;
    return { points, curves, constraints, ...(texts?.length ? { texts } : {}), ...(equations?.length ? { equations } : {}), ...(inserts?.length ? { inserts } : {}) };
}

/** Writes a block file and returns its name; throws on a bad body or name. */
export function saveBlockFile(body: unknown): string {
    if (!valid(body)) {
        throw new Error('Expected { name, geometry }.');
    }
    const path = fileOf(body.name);
    if (!path) {
        throw new Error('A block name may hold letters, digits, spaces, dashes and underscores (up to 80).');
    }
    mkdirSync(BLOCKS_DIR, { recursive: true });
    const file: BlockFile = {
        name: body.name.trim(),
        geometry: blockContent(body.geometry),
        ...(body.colour ? { colour: body.colour } : {}),
        ...(body.blocks?.length ? { blocks: body.blocks.map((b) => ({ id: b.id, name: b.name, geometry: blockContent(b.geometry), ...(b.colour ? { colour: b.colour } : {}) })) } : {}),
    };
    writeFileSync(path, JSON.stringify(file, null, 1));
    return file.name;
}
