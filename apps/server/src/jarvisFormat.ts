// The studio's own file, .jarvis (docs/FILE_FORMAT.md): one project and every file it uses, in a ZIP archive.
// Packing and unpacking work on bytes only, so they can be tested without a disk; jarvisFile.ts reads and writes the
// files and opens what it reads as a project.

import { createHash } from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { Project } from '@jarvis/core';
import { IMPORT_ASSET } from '@jarvis/core/imported';

export const FORMAT = 'jarvis-studio';
/** The format version written. Files with the same major version (the whole number) are read. */
export const VERSION = 1;
export const EXTENSION = '.jarvis';

/** The largest entry a file may hold unpacked (as large as an imported file may be), and the most in all. */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

/**
 * View settings that only steer the browsers showing the project now (a highlighted part, the turntable spin, a camera
 * angle asked for): left out of the file; an opened project starts with the defaults.
 */
export const LOCAL_VIEW_KEYS = ['focus', 'autoRotate', 'azimuth', 'elevation'] as const;

export interface ManifestEntry {
    name: string;
    /** Bytes, unpacked. */
    size: number;
    /** SHA-256 of the unpacked bytes, as lowercase hex. */
    sha256: string;
}

export interface Manifest {
    format: typeof FORMAT;
    version: number;
    /** The version of the studio that wrote the file. */
    app: string;
    /** When it was written (ISO 8601). */
    saved: string;
    name: string;
    description?: string;
    units: 'mm';
    up: 'y';
    /** Parts in the project. */
    parts: number;
    /** Every entry of the archive but manifest.json itself. */
    files: ManifestEntry[];
}

/** A file that is not a .jarvis file, is damaged, is too large or is of a newer format. */
export class JarvisFileError extends Error {}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export const isPng = (bytes: Uint8Array | null | undefined): bytes is Uint8Array =>
    !!bytes && bytes.length > PNG.length && PNG.every((b, i) => bytes[i] === b);

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const megabytes = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MB`;

/** The project as it goes into design.json: nothing that belongs to this machine or only to the browsers showing it. */
export function designOf(project: Project): Project {
    const { jarvisFile: _file, ...design }: Project = JSON.parse(JSON.stringify(project));
    const view = design.view as unknown as Record<string, unknown> | undefined;
    for (const key of LOCAL_VIEW_KEYS) {
        delete view?.[key];
    }
    return design;
}

/**
 * Asset ids the project refers to, wherever they are (import steps' files, BREP and mesh, decal and sketch pictures,
 * and any later use): every string that is an asset id, in order of first use.
 */
export function assetIdsOf(value: unknown, found = new Set<string>()): string[] {
    if (typeof value === 'string') {
        if (IMPORT_ASSET.test(value)) {
            found.add(value);
        }
    } else if (Array.isArray(value)) {
        for (const item of value) {
            assetIdsOf(item, found);
        }
    } else if (value && typeof value === 'object') {
        for (const item of Object.values(value)) {
            assetIdsOf(item, found);
        }
    }
    return [...found];
}

export interface PackInput {
    project: Project;
    /** The studio's version. */
    app: string;
    saved?: Date;
    /** A PNG of the model; anything else is left out. */
    thumbnail?: Uint8Array | null;
    /** An asset's bytes, or null when it is not on this machine. */
    asset: (id: string) => Uint8Array | null;
}

export interface Packed {
    bytes: Uint8Array;
    manifest: Manifest;
    /** Assets the project refers to that were not found, so are not in the file. */
    missing: string[];
}

/** Entries that are compressed already (or barely compress) are stored as they are. */
const STORED = /\.(png|jpe?g|webp|brep|sldprt|sldasm|zip|gz)$/i;

/** Packs a project and the assets it refers to into the bytes of a .jarvis file. */
export function packProject(input: PackInput): Packed {
    const saved = input.saved ?? new Date();
    const design = designOf(input.project);
    const entries: [string, Uint8Array][] = [['design.json', strToU8(JSON.stringify(design, null, 2))]];
    if (isPng(input.thumbnail) && input.thumbnail.length <= MAX_THUMBNAIL_BYTES) {
        entries.push(['thumbnail.png', input.thumbnail]);
    }
    const missing: string[] = [];
    for (const id of assetIdsOf(design)) {
        const bytes = input.asset(id);
        if (bytes) {
            entries.push([`assets/${id}`, bytes]);
        } else {
            missing.push(id);
        }
    }
    // A file the studio could not open again is not written.
    const total = entries.reduce((sum, [, bytes]) => sum + bytes.length, 0);
    const large = entries.find(([, bytes]) => bytes.length > MAX_ENTRY_BYTES);
    if (large || total > MAX_TOTAL_BYTES) {
        throw new JarvisFileError(large
            ? `${large[0]} is ${megabytes(large[1].length)}, more than the ${megabytes(MAX_ENTRY_BYTES)} one entry of a .jarvis file may hold`
            : `the project and its files come to ${megabytes(total)}, more than the ${megabytes(MAX_TOTAL_BYTES)} a .jarvis file may hold`);
    }
    const manifest: Manifest = {
        format: FORMAT,
        version: VERSION,
        app: input.app,
        saved: saved.toISOString(),
        name: input.project.name,
        ...(input.project.description ? { description: input.project.description } : {}),
        units: 'mm',
        up: 'y',
        parts: input.project.parts.length,
        files: entries.map(([name, bytes]) => ({ name, size: bytes.length, sha256: sha256(bytes) })),
    };
    const zippable: Zippable = { 'manifest.json': [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }] };
    for (const [name, bytes] of entries) {
        zippable[name] = [bytes, { level: STORED.test(name) ? 0 : 6 }];
    }
    return { bytes: zipSync(zippable, { mtime: saved }), manifest, missing };
}

/** A name an archive entry may have: plain relative segments, no `..`, no backslashes, no drive or absolute path. */
export function safeEntryName(name: string): boolean {
    if (!name || name.length > 255 || name.startsWith('/') || name.includes('\\') || /[\0-\x1f:]/.test(name)) {
        return false;
    }
    return name.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

interface Header {
    name: string;
    originalSize: number;
    compression: number;
}

/** The archive's entries as its central directory lists them, nothing unpacked. */
function headersOf(bytes: Uint8Array): Header[] {
    const headers: Header[] = [];
    try {
        unzipSync(bytes, {
            filter: (file) => {
                headers.push({ name: file.name, originalSize: file.originalSize, compression: file.compression });
                if (headers.length > MAX_ENTRIES) {
                    throw new JarvisFileError(`it holds more than ${MAX_ENTRIES} entries`);
                }
                return false;
            },
        });
    } catch (error) {
        throw error instanceof JarvisFileError ? error : new JarvisFileError('it is not a ZIP archive');
    }
    return headers;
}

/** The entries named, unpacked; each is checked against the size limits before it is unpacked. */
function unpackEntries(bytes: Uint8Array, wanted: Set<string>): Record<string, Uint8Array> {
    try {
        return unzipSync(bytes, { filter: (file) => wanted.has(file.name) && file.originalSize <= MAX_ENTRY_BYTES });
    } catch {
        throw new JarvisFileError('it is damaged (an entry cannot be unpacked)');
    }
}

function parseManifest(bytes: Uint8Array): Manifest {
    let manifest: Partial<Manifest> & Record<string, unknown>;
    try {
        manifest = JSON.parse(strFromU8(bytes));
    } catch {
        throw new JarvisFileError('its manifest.json is not JSON');
    }
    if (!manifest || typeof manifest !== 'object' || manifest.format !== FORMAT) {
        throw new JarvisFileError('it is not a Jarvis Studio file (manifest.json does not say format "jarvis-studio")');
    }
    const version = manifest.version;
    if (typeof version !== 'number' || !Number.isFinite(version) || version < 1) {
        throw new JarvisFileError('its manifest.json gives no valid format version');
    }
    if (Math.floor(version) > VERSION) {
        throw new JarvisFileError(`it was saved by a newer Jarvis Studio (file format ${version}${typeof manifest.app === 'string' ? `, studio ${manifest.app}` : ''}); `
            + `this studio reads format ${VERSION}. Update the studio to open it`);
    }
    const files = manifest.files;
    if (!Array.isArray(files) || !files.every((f) => f && typeof f.name === 'string' && Number.isSafeInteger(f.size) && f.size >= 0
        && typeof f.sha256 === 'string' && /^[a-f0-9]{64}$/.test(f.sha256))) {
        throw new JarvisFileError('its manifest.json does not list the files with their sizes and SHA-256');
    }
    return manifest as Manifest;
}

/** Enough of a project to open it: a name, parts with ids, names, shapes and places, and steps with ids and ops. */
function checkProject(value: unknown): Project {
    const project = value as Project;
    const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    const vec3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');
    const fail = (what: string) => {
        throw new JarvisFileError(`its design.json is not a project (${what})`);
    };
    if (!isObject(project) || typeof project.name !== 'string' || !Array.isArray(project.parts)) {
        fail('no name or no parts');
    }
    if (project.view !== undefined && !isObject(project.view)) {
        fail('the view is not an object');
    }
    project.parts.forEach((part, i) => {
        if (!isObject(part) || typeof part.id !== 'string' || typeof part.name !== 'string' || !isObject(part.shape)
            || typeof part.shape.kind !== 'string' || !vec3(part.position) || !vec3(part.rotation) || !isObject(part.material)) {
            fail(`part ${i + 1} lacks an id, name, shape, position, rotation or material`);
        }
        if (part.features !== undefined && (!Array.isArray(part.features)
            || !part.features.every((f) => isObject(f) && typeof f.id === 'string' && typeof f.op === 'string'))) {
            fail(`a step of part ${part.name} has no id or op`);
        }
    });
    return project;
}

export interface Unpacked {
    manifest: Manifest;
    project: Project;
    /** The assets the project refers to that the file holds, each checked against its id. */
    assets: Map<string, Uint8Array>;
    /** Assets the project refers to that the file does not hold. */
    missing: string[];
    thumbnail: Uint8Array | null;
}

/**
 * Reads the bytes of a .jarvis file. Refused, with the reason (JarvisFileError): no ZIP, no manifest of this format, a
 * newer major version, entry names that could reach outside a folder, entries the manifest does not list (or listed
 * ones missing), sizes past the limits (checked before anything is unpacked), and any entry whose bytes do not match
 * its size and SHA-256.
 */
export function unpackProject(bytes: Uint8Array): Unpacked {
    if (bytes.length > MAX_TOTAL_BYTES) {
        throw new JarvisFileError(`it is larger than the ${megabytes(MAX_TOTAL_BYTES)} the studio opens`);
    }
    const headers = headersOf(bytes);
    const seen = new Set<string>();
    let total = 0;
    for (const header of headers) {
        if (!safeEntryName(header.name)) {
            throw new JarvisFileError(`it holds an entry named "${header.name}", which is not allowed (absolute, .. or backslash)`);
        }
        if (seen.has(header.name)) {
            throw new JarvisFileError(`it holds ${header.name} twice`);
        }
        seen.add(header.name);
        if (header.originalSize > MAX_ENTRY_BYTES) {
            throw new JarvisFileError(`${header.name} unpacks to more than the ${megabytes(MAX_ENTRY_BYTES)} allowed for one entry`);
        }
        total += header.originalSize;
        if (total > MAX_TOTAL_BYTES) {
            throw new JarvisFileError(`it unpacks to more than the ${megabytes(MAX_TOTAL_BYTES)} the studio opens`);
        }
        if (header.compression !== 0 && header.compression !== 8) {
            throw new JarvisFileError(`${header.name} is packed in a way the studio does not read (method ${header.compression})`);
        }
    }
    const manifestHeader = headers.find((h) => h.name === 'manifest.json');
    if (!manifestHeader) {
        throw new JarvisFileError('it is not a Jarvis Studio file (no manifest.json)');
    }
    if (manifestHeader.originalSize > MAX_MANIFEST_BYTES) {
        throw new JarvisFileError('its manifest.json is too large');
    }
    const manifest = parseManifest(unpackEntries(bytes, new Set(['manifest.json']))['manifest.json'] ?? new Uint8Array(0));
    const listed = new Map<string, ManifestEntry>();
    for (const entry of manifest.files) {
        if (!safeEntryName(entry.name) || entry.name === 'manifest.json') {
            throw new JarvisFileError(`its manifest lists "${entry.name}", which is not allowed`);
        }
        if (listed.has(entry.name)) {
            throw new JarvisFileError(`its manifest lists ${entry.name} twice`);
        }
        listed.set(entry.name, entry);
    }
    for (const header of headers) {
        const entry = listed.get(header.name);
        if (header.name !== 'manifest.json' && !entry) {
            throw new JarvisFileError(`it holds ${header.name}, which its manifest does not list`);
        }
        if (entry && entry.size !== header.originalSize) {
            throw new JarvisFileError(`it is damaged: ${header.name} is not the size its manifest gives`);
        }
    }
    for (const name of listed.keys()) {
        if (!seen.has(name)) {
            throw new JarvisFileError(`it is damaged: ${name}, listed in its manifest, is not in it`);
        }
    }
    if (!listed.has('design.json')) {
        throw new JarvisFileError('it holds no design.json');
    }
    // Entries of a later minor version that this studio does not know are left packed.
    const known = (name: string) => name === 'design.json' || name === 'thumbnail.png' || (name.startsWith('assets/') && IMPORT_ASSET.test(name.slice(7)));
    const unpacked = unpackEntries(bytes, new Set([...listed.keys()].filter(known)));
    for (const [name, data] of Object.entries(unpacked)) {
        const entry = listed.get(name)!;
        if (data.length !== entry.size || sha256(data) !== entry.sha256) {
            throw new JarvisFileError(`it is damaged: ${name} does not match its SHA-256 in the manifest`);
        }
    }
    let design: unknown;
    try {
        design = JSON.parse(strFromU8(unpacked['design.json']));
    } catch {
        throw new JarvisFileError('its design.json is not JSON');
    }
    const project = checkProject(design);
    delete project.jarvisFile;
    const assets = new Map<string, Uint8Array>();
    const missing: string[] = [];
    for (const id of assetIdsOf(project)) {
        const data = unpacked[`assets/${id}`];
        if (!data) {
            missing.push(id);
            continue;
        }
        // An asset is named by the hash of its content: a mismatch is a damaged or altered file.
        if (sha256(data).slice(0, 24) !== id.slice(0, 24)) {
            throw new JarvisFileError(`it is damaged: assets/${id} does not match its name`);
        }
        assets.set(id, data);
    }
    const thumbnail = unpacked['thumbnail.png'];
    return { manifest, project, assets, missing, thumbnail: isPng(thumbnail) ? thumbnail : null };
}

/** The manifest of a .jarvis file, for the Open form (nothing else is unpacked or checked). */
export function manifestOf(bytes: Uint8Array): Manifest {
    const header = headersOf(bytes).find((h) => h.name === 'manifest.json');
    if (!header) {
        throw new JarvisFileError('it is not a Jarvis Studio file (no manifest.json)');
    }
    if (header.originalSize > MAX_MANIFEST_BYTES) {
        throw new JarvisFileError('its manifest.json is too large');
    }
    return parseManifest(unpackEntries(bytes, new Set(['manifest.json']))['manifest.json'] ?? new Uint8Array(0));
}

/** The picture a .jarvis file carries, or null. Only that entry is unpacked. */
export function thumbnailOf(bytes: Uint8Array): Uint8Array | null {
    try {
        const png = unzipSync(bytes, { filter: (f) => f.name === 'thumbnail.png' && f.originalSize <= MAX_THUMBNAIL_BYTES })['thumbnail.png'];
        return isPng(png) ? png : null;
    } catch {
        return null;
    }
}
