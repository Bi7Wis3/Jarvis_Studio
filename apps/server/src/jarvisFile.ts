// File > Save As, Save and Open of the studio's own file (.jarvis, jarvisFormat.ts): the open project and every asset
// it uses written to a file in the home folder (atomically: a temporary file beside it, then renamed over it), and a
// file opened as a new project in projects/ with its assets copied to projects/assets (shared by id). The project
// remembers the file in `jarvisFile` (path and SHA-256 of the file's bytes), which is never written into a file.
// Paths follow the file browser's rules (files.ts): home folder only, resolved through links first.

import { randomBytes } from 'node:crypto';
import {
    chmodSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Part, Project } from '@jarvis/core';
import { FileAccessError, inside } from './files.js';
import { hasImportAsset, importAssetPath, saveImportAsset } from './import/assets.js';
import { extensionOf, importerFor } from './import/registry.js';
import {
    EXTENSION, JarvisFileError, manifestOf, MAX_TOTAL_BYTES, packProject, sha256, unpackProject, type Manifest, type Unpacked,
} from './jarvisFormat.js';
import { PROJECTS_DIR, ROOT } from './paths.js';
import { slug, type ProjectStore } from './store.js';

/**
 * Save as copy and continue: the file is written and the open project stays open, going with that file from now on.
 * Save as copy and open: the file is written, then opened as a new project; the one that was open stays as it was.
 */
export type SaveMode = 'copy' | 'copyAndOpen';

/** A file that is there and was not to be replaced: the form asks, then saves again with overwrite. */
export class FileExistsError extends Error {
    readonly status = 409;

    constructor(readonly path: string) {
        super(`${basename(path)} already exists in ${dirname(path)}.`);
    }
}

/** Save with no file to save to. */
export class NoFileError extends Error {
    readonly status = 409;

    constructor() {
        super('This project has not been saved to a .jarvis file yet: use Save As.');
    }
}

export interface FileOptions {
    /** The home folder, resolved (tests); the owner's by default. */
    home?: string;
    /** Checks a part's history (tools.ts checkHistory); what it throws is reported, the file opens all the same. */
    checkPart?: (part: Part) => void;
}

let realHome: string | null = null;
const homeOf = (options: FileOptions): string => options.home ?? (realHome ??= realpathSync(homedir()));

/** For tests: the home folder used when none is given (null: the owner's again). */
export function setHomeFolder(path: string | null): void {
    realHome = path;
}

let version: string | null = null;
/** The studio's version, from the package.json at the root. */
export function appVersion(): string {
    try {
        version ??= String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0');
    } catch {
        version = '0';
    }
    return version;
}

const code = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? '';

/** An absolute path (or ~ for home) as given, resolved; refused when relative. */
function givenPath(path: string, home: string): string {
    const text = path.trim();
    const given = text.startsWith('~') ? join(home, text.slice(1)) : text;
    if (!isAbsolute(given) || given.includes('\0')) {
        throw new FileAccessError('Give an absolute path.', 400);
    }
    return resolve(given);
}

/** The real path (links followed) of something that exists, refused outside home. */
function realInHome(path: string, home: string): string {
    let real: string;
    try {
        real = realpathSync(path);
    } catch (error) {
        throw new FileAccessError(code(error) === 'EACCES' ? `${path} cannot be read (EACCES).` : `${path} does not exist.`,
            code(error) === 'EACCES' ? 403 : 404);
    }
    if (!inside(real, home)) {
        throw new FileAccessError('Only files in your home folder can be saved or opened here.', 403);
    }
    return real;
}

export interface SaveTarget {
    /** The file to write, resolved (a link that is there is written through). */
    path: string;
    name: string;
    folder: string;
    exists: boolean;
    /** The permissions of the file that is there, kept when it is replaced. */
    mode?: number;
}

/** Where a save goes: the folder must exist in home; ".jarvis" is added to a name without it. */
export function saveTarget(path: string, home: string): SaveTarget {
    if (/[/\\]\s*$/.test(path)) {
        throw new FileAccessError('Give a file name, not only a folder.', 400);
    }
    const given = givenPath(path, home);
    let name = basename(given);
    if (!name.toLowerCase().endsWith(EXTENSION)) {
        name += EXTENSION;
    }
    if (name.length <= EXTENSION.length) {
        throw new FileAccessError('Give the file a name.', 400);
    }
    if (Buffer.byteLength(name) > 255) {
        throw new FileAccessError('The file name is too long.', 400);
    }
    const folder = realInHome(dirname(given), home);
    if (!statSync(folder).isDirectory()) {
        throw new FileAccessError(`${basename(folder)} is not a folder.`, 400);
    }
    let full = join(folder, name);
    let stats = lstatSync(full, { throwIfNoEntry: false });
    if (stats?.isSymbolicLink()) {
        full = realInHome(full, home);
        stats = statSync(full);
    }
    if (stats && !stats.isFile()) {
        throw new FileAccessError(`${name} is a folder, not a file.`, 400);
    }
    return { path: full, name: basename(full), folder: dirname(full), exists: !!stats, ...(stats ? { mode: stats.mode } : {}) };
}

/** Writes the bytes to a temporary file in the same folder, flushes them to the disk, then renames it over `path`. */
export function writeAtomically(path: string, bytes: Uint8Array, mode?: number): void {
    const temp = join(dirname(path), `.${basename(path)}.${process.pid}-${randomBytes(4).toString('hex')}.part`);
    let fd: number | null = null;
    try {
        fd = openSync(temp, 'wx');
        for (let at = 0; at < bytes.length;) {
            at += writeSync(fd, bytes, at, bytes.length - at);
        }
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        if (mode !== undefined) {
            chmodSync(temp, mode & 0o7777);
        }
        renameSync(temp, path);
    } catch (error) {
        if (fd !== null) {
            closeSync(fd);
        }
        rmSync(temp, { force: true });
        if (['EACCES', 'EPERM', 'EROFS'].includes(code(error))) {
            throw new FileAccessError(`${dirname(path)} cannot be written to (${code(error)}).`, 403);
        }
        throw error;
    }
}

/** An asset's bytes from projects/assets, or null when it is not there. */
function localAsset(id: string): Uint8Array | null {
    return hasImportAsset(id) ? readFileSync(importAssetPath(id)) : null;
}

const missingNote = (missing: string[], where: string): string[] => (missing.length
    ? [`Not ${where} (missing from the studio's assets folder): ${missing.join(', ')}. The steps that use them cannot be built.`] : []);

export interface SaveRequest {
    /** The file: absolute or ~; ".jarvis" is added when missing. */
    path: string;
    mode?: SaveMode;
    /** Replace a file that is there (only after asking). */
    overwrite?: boolean;
    /** The description to keep with the project and the file; undefined keeps the project's own. */
    description?: string;
    /** A PNG of the model; left out when missing or not a PNG. */
    thumbnail?: Uint8Array | null;
}

export interface SaveAnswer {
    text: string;
    /** The file written, resolved. */
    path: string;
    mode: SaveMode;
    /** Assets the project uses that were not found, so are not in the file. */
    missing: string[];
    thumbnail: boolean;
    /** Save as copy and open: the project it opened as. */
    opened?: OpenAnswer;
}

/** Saves the open project to a .jarvis file (File > Save As). Throws FileExistsError for a file there, not to be replaced. */
export function saveProjectFile(store: ProjectStore, request: SaveRequest, options: FileOptions = {}): SaveAnswer {
    const home = homeOf(options);
    const target = saveTarget(request.path, home);
    if (target.exists && !request.overwrite) {
        throw new FileExistsError(target.path);
    }
    const mode = request.mode ?? 'copy';
    const current = store.get();
    const description = request.description === undefined ? current.description : request.description.trim() || undefined;
    const { description: _old, ...rest } = current;
    const project: Project = { ...rest, ...(description ? { description } : {}) };
    const packed = packProject({ project, app: appVersion(), thumbnail: request.thumbnail, asset: localAsset });
    writeAtomically(target.path, packed.bytes, target.mode);
    const saved = `Saved ${target.name} in ${target.folder}.`;
    const answer = { path: target.path, mode, missing: packed.missing, thumbnail: packed.manifest.files.some((f) => f.name === 'thumbnail.png') };
    if (mode === 'copy') {
        const link = { path: target.path, sha256: sha256(packed.bytes) };
        store.mutate((draft) => {
            delete draft.description;
            Object.assign(draft, description ? { description } : {}, { jarvisFile: link });
        }, { undoable: false });
        return { ...answer, text: [saved, ...missingNote(packed.missing, 'in the file')].join('\n') };
    }
    // Read back from the disk as Open reads any file, so the new project is exactly what the file holds.
    const opened = openProjectFile(store, target.path, options);
    return {
        ...answer, opened,
        text: [`${saved} Opened it as "${opened.name}"; "${current.name}" stays as it was.`, ...missingNote(packed.missing, 'in the file')].join('\n'),
    };
}

/** Writes the project to the file it was last saved to or opened from (File > Save). Throws NoFileError without one. */
export function saveLinkedFile(store: ProjectStore, request: { thumbnail?: Uint8Array | null } = {}, options: FileOptions = {}): SaveAnswer {
    const link = store.get().jarvisFile;
    if (!link) {
        throw new NoFileError();
    }
    return saveProjectFile(store, { path: link.path, mode: 'copy', overwrite: true, thumbnail: request.thumbnail }, options);
}

export interface OpenAnswer {
    text: string;
    /** The project's name in the studio. */
    name: string;
    /** The file, resolved. */
    path: string;
    /** A project from this same file was there already: the studio switched to it instead of adding a copy. */
    switched: boolean;
    missing: string[];
    warnings: string[];
}

/** The file of an existing path in home, refused when it is a folder, not a .jarvis file, or too large. */
function openTarget(path: string, home: string): { path: string; size: number; mtime: number } {
    const file = realInHome(givenPath(path, home), home);
    const stats = statSync(file);
    if (!stats.isFile()) {
        throw new FileAccessError(`${basename(file)} is not a file.`, 400);
    }
    const importer = !file.toLowerCase().endsWith(EXTENSION) ? importerFor(file) : null;
    if (importer && (importer.format !== 'swhistory' || /\.jarvis-sw\.json$/i.test(file))) {
        throw new JarvisFileError(`${basename(file)} is a file to import (${importer.label.replace(/ \(.*$/, '')}), not a Jarvis Studio project: use File > Import.`);
    }
    if (stats.size > MAX_TOTAL_BYTES) {
        throw new JarvisFileError(`${basename(file)} cannot be opened: it is larger than the ${MAX_TOTAL_BYTES / 1024 / 1024} MB the studio opens.`);
    }
    return { path: file, size: stats.size, mtime: stats.mtimeMs };
}

/** The saved project (slug) that last saved to or opened `file` while it held exactly these bytes, if any. */
function linkedProject(store: ProjectStore, file: string, hash: string): string | null {
    const matches = (project: Project | undefined) => project?.jarvisFile?.path === file && project.jarvisFile.sha256 === hash;
    if (matches(store.get())) {
        return slug(store.get().name);
    }
    for (const entry of store.list()) {
        try {
            if (matches(JSON.parse(readFileSync(join(PROJECTS_DIR, `${entry}.json`), 'utf8')) as Project)) {
                return entry;
            }
        } catch {
            // An unreadable project file is not the one.
        }
    }
    return null;
}

/**
 * Opens a .jarvis file as a project (File > Open). A project that came from this file and still matches it (the file
 * unchanged since it was saved to or opened from it) is switched to instead of adding a second copy; otherwise the
 * file becomes a new project under a free name, its assets copied into projects/assets (those there already are kept),
 * read through the store's own loading and repairs. The undo history starts afresh, as with any project opened.
 */
export function openProjectFile(store: ProjectStore, path: string, options: FileOptions = {}): OpenAnswer {
    const home = homeOf(options);
    const file = openTarget(path, home).path;
    const bytes = readFileSync(file);
    const hash = sha256(bytes);
    const linked = linkedProject(store, file, hash);
    const open = linked !== null && slug(store.get().name) === linked;
    if (linked !== null && (open || store.open(linked))) {
        const name = store.get().name;
        return {
            text: open ? `"${name}" is the open project, from ${basename(file)}.` : `Switched to "${name}", which came from ${basename(file)} and is already in the studio.`,
            name, path: file, switched: true, missing: [], warnings: [],
        };
    }
    let unpacked: Unpacked;
    try {
        unpacked = unpackProject(bytes);
    } catch (error) {
        throw error instanceof JarvisFileError ? new JarvisFileError(`${basename(file)} cannot be opened: ${error.message}.`) : error;
    }
    for (const [id, data] of unpacked.assets) {
        if (!hasImportAsset(id)) {
            saveImportAsset(data, extensionOf(id));
        }
    }
    const missing = unpacked.missing.filter((id) => !hasImportAsset(id));
    const warnings: string[] = [];
    for (const part of unpacked.project.parts) {
        try {
            options.checkPart?.(part);
        } catch (error) {
            warnings.push(`${part.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const name = store.add({
        ...unpacked.project,
        name: unpacked.project.name.trim().slice(0, 80) || basename(file).slice(0, -EXTENSION.length) || 'Untitled',
        jarvisFile: { path: file, sha256: hash },
    });
    return {
        text: [`Opened ${basename(file)} as "${name}".`, ...missingNote(missing, 'in the file nor in the studio'),
            ...warnings.map((w) => `History check: ${w}`)].join('\n'),
        name, path: file, switched: false, missing, warnings,
    };
}

export interface FileInfo {
    name: string;
    description?: string;
    saved: string;
    app: string;
    parts: number;
    version: number;
}

const infoCache = new Map<string, FileInfo>();

/** What the Open form shows for a selected .jarvis file, from its manifest (kept while the file stays the same). */
export function fileInfo(path: string, options: FileOptions = {}): FileInfo {
    const file = openTarget(path, homeOf(options));
    const key = `${file.path}\0${file.mtime}\0${file.size}`;
    const kept = infoCache.get(key);
    if (kept) {
        return kept;
    }
    let manifest: Manifest;
    try {
        manifest = manifestOf(readFileSync(file.path));
    } catch (error) {
        throw error instanceof JarvisFileError ? new JarvisFileError(`${basename(file.path)} cannot be opened: ${error.message}.`) : error;
    }
    const info: FileInfo = {
        name: String(manifest.name ?? ''), saved: String(manifest.saved ?? ''), app: String(manifest.app ?? ''),
        parts: Number(manifest.parts) || 0, version: manifest.version,
        ...(typeof manifest.description === 'string' && manifest.description ? { description: manifest.description } : {}),
    };
    infoCache.set(key, info);
    while (infoCache.size > 50) {
        infoCache.delete(infoCache.keys().next().value!);
    }
    return info;
}
