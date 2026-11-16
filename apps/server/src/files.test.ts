import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Nothing here may touch the real data folder or the owner's home.
const data = await vi.hoisted(async () => {
    const { mkdtempSync: temp } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const scratch = temp(path.join(os.tmpdir(), 'jarvis-files-data-'));
    process.env.JARVIS_PROJECTS_DIR = scratch;
    process.env.JARVIS_SETTINGS_FILE = path.join(scratch, '.studio', 'settings.json');
    return scratch;
});

import { readImportAsset } from './import/assets.js';
import { importFileTool } from './import/hostTool.js';
import { runImport } from './import/job.js';
import { registerImportRoutes } from './import/routes.js';
import { stlBytes } from './import/stl.js';
import { registerFileRoutes, rememberImportFolder, type PlacesAnswer } from './fileRoutes.js';
import { compareEntries, FileAccessError, listFolder, PreviewCache, previewOf, resolveInHome, standardPlaces } from './files.js';
import { SettingsStore } from './settings.js';
import { ProjectStore } from './store.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-files-test-')));
const home = join(root, 'home');
const outside = join(root, 'elsewhere');
const fixture = (name: string): Buffer => readFileSync(new URL(`./import/sldprt/fixtures/${name}`, import.meta.url));

/** One facet, as a binary STL. */
const tinyStl = (): Uint8Array => stlBytes(new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]));

beforeAll(() => {
    for (const dir of ['Desktop', 'Docs', 'Downloads', 'parts/part10', 'parts/part2', 'parts/Part1', 'parts/.cache', 'parts/sub']) {
        mkdirSync(join(home, dir), { recursive: true });
    }
    mkdirSync(join(home, '.config'), { recursive: true });
    writeFileSync(join(home, '.config', 'user-dirs.dirs'), '# made by hand\nXDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOCUMENTS_DIR="$HOME/Docs"\nXDG_MUSIC_DIR="$HOME/"\n');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.step'), 'ISO-10303-21;');
    const parts = join(home, 'parts');
    writeFileSync(join(parts, 'bracket 10.STEP'), 'ISO-10303-21;');
    writeFileSync(join(parts, 'bracket 9.stp'), 'ISO-10303-21;');
    writeFileSync(join(parts, 'cube.stl'), tinyStl());
    writeFileSync(join(parts, 'ring.SLDPRT'), fixture('ring-ole.SLDPRT'));
    writeFileSync(join(parts, 'button.sldprt'), fixture('button-2015.SLDPRT'));
    writeFileSync(join(parts, 'notes.txt'), 'not a model');
    writeFileSync(join(parts, '.hidden.step'), 'ISO-10303-21;');
    symlinkSync(outside, join(parts, 'link-out'));
    symlinkSync(join(outside, 'secret.step'), join(parts, 'secret-link.step'));
    symlinkSync(join(home, 'Downloads'), join(parts, 'link-in'));
    symlinkSync(join(parts, 'cube.stl'), join(parts, 'cube-link.stl'));
    symlinkSync(join(home, 'missing'), join(parts, 'broken.step'));
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
});

const names = (entries: { name: string }[]) => entries.map((e) => e.name);

describe('folder listing', () => {
    it('puts folders first, each in natural order, case ignored', async () => {
        const listing = await listFolder(join(home, 'parts'), home);
        expect(names(listing.entries)).toEqual([
            'link-in', 'Part1', 'part2', 'part10', 'sub',
            'bracket 9.stp', 'bracket 10.STEP', 'button.sldprt', 'cube-link.stl', 'cube.stl', 'ring.SLDPRT',
        ]);
        expect(listing.path).toBe(join(home, 'parts'));
        expect(listing.parent).toBe(home);
        expect(compareEntries({ name: 'a', kind: 'file' }, { name: 'A', kind: 'file' })).not.toBe(0);
    });

    it('gives each file its import format, size, date and whether it has a preview', async () => {
        const { entries } = await listFolder(join(home, 'parts'), home);
        const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
        expect(byName['bracket 10.STEP']).toMatchObject({ kind: 'file', format: 'step', size: 13 });
        expect(byName['cube.stl']).toMatchObject({ format: 'stl', size: tinyStl().length });
        expect(byName['ring.SLDPRT']).toMatchObject({ format: 'sldprt', preview: true });
        expect(byName['cube.stl'].preview).toBeUndefined();
        expect(byName.sub).toMatchObject({ kind: 'folder', size: 0 });
        expect(byName['cube-link.stl']).toMatchObject({ link: true, format: 'stl' });
        expect(byName['link-in']).toMatchObject({ kind: 'folder', link: true });
        expect(Math.abs(byName['cube.stl'].modified - Date.now())).toBeLessThan(60_000);
    });

    it('leaves hidden entries and other files out unless asked, and counts what it left out', async () => {
        const plain = await listFolder(join(home, 'parts'), home);
        expect(names(plain.entries)).not.toContain('.cache');
        expect(names(plain.entries)).not.toContain('notes.txt');
        // .cache, .hidden.step, notes.txt, and the links out of home or broken.
        expect(plain.skipped).toBe(6);
        const hidden = await listFolder(join(home, 'parts'), home, { hidden: true });
        expect(names(hidden.entries).slice(0, 2)).toEqual(['.cache', 'link-in']);
        expect(names(hidden.entries)).toContain('.hidden.step');
        const all = await listFolder(join(home, 'parts'), home, { all: true });
        const notes = all.entries.find((e) => e.name === 'notes.txt');
        expect(notes).toMatchObject({ kind: 'file' });
        expect(notes?.format).toBeUndefined();
    });

    it('lists only inside home, symlinks resolved', async () => {
        const refused = (path: string) => listFolder(path, home).then(() => null, (e: unknown) => e);
        for (const path of [outside, join(home, '..'), join(home, 'parts', 'link-out'), '/']) {
            const error = await refused(path);
            expect(error, path).toBeInstanceOf(FileAccessError);
            expect((error as FileAccessError).status, path).toBe(403);
        }
        // A link out of home is not even listed.
        const { entries } = await listFolder(join(home, 'parts'), home, { all: true, hidden: true });
        expect(names(entries)).not.toContain('link-out');
        expect(names(entries)).not.toContain('secret-link.step');
        expect(names(entries)).not.toContain('broken.step');
        expect(((await refused('relative/path')) as FileAccessError).status).toBe(400);
        expect(((await refused(join(home, 'nothing'))) as FileAccessError).status).toBe(404);
        expect(((await refused(join(home, 'parts', 'cube.stl'))) as FileAccessError).status).toBe(400);
        // ~ and '' are home; a link into home is followed.
        expect((await listFolder('', home)).parent).toBeNull();
        expect((await listFolder('~/parts', home)).path).toBe(join(home, 'parts'));
        expect((await listFolder(join(home, 'parts', 'link-in'), home)).path).toBe(join(home, 'Downloads'));
        await expect(resolveInHome(join(home, 'parts', 'secret-link.step'), home, 'file')).rejects.toMatchObject({ status: 403 });
    });

    it('lists thousands of entries quickly', async () => {
        const big = join(home, 'big');
        mkdirSync(big);
        for (let i = 0; i < 5000; i++) {
            writeFileSync(join(big, `part ${i}.${i % 3 ? 'stl' : 'txt'}`), '');
        }
        const started = performance.now();
        const listing = await listFolder(big, home);
        const ms = performance.now() - started;
        expect(listing.entries).toHaveLength(3333);
        expect(listing.skipped).toBe(1667);
        expect(names(listing.entries).slice(0, 3)).toEqual(['part 1.stl', 'part 2.stl', 'part 4.stl']);
        expect(ms).toBeLessThan(2000);
    });
});

describe('preview pictures', () => {
    it('reads the PNG SolidWorks saves in both kinds of part file, and nothing from other files', () => {
        for (const name of ['ring-ole.SLDPRT', 'button-2015.SLDPRT']) {
            const png = previewOf(name, new Uint8Array(fixture(name)));
            expect(png, name).not.toBeNull();
            expect(Buffer.from(png!.subarray(1, 4)).toString('latin1')).toBe('PNG');
        }
        expect(previewOf('cube.stl', tinyStl())).toBeNull();
        expect(previewOf('broken.sldprt', new Uint8Array(1000))).toBeNull();
    });

    it('caches by path and modified time, and reads a changed file again', async () => {
        const reads: string[] = [];
        const cache = new PreviewCache(2, async (p) => {
            reads.push(p);
            return new Uint8Array(readFileSync(p));
        });
        const ring = join(home, 'parts', 'ring.SLDPRT');
        const first = await cache.get(ring, home);
        expect(first?.length).toBeGreaterThan(1000);
        expect(await cache.get(ring, home)).toBe(first);
        expect(reads).toEqual([ring]);
        utimesSync(ring, new Date(), new Date(Date.now() + 5000));
        expect(await cache.get(ring, home)).not.toBe(first);
        expect(reads).toHaveLength(2);
        // Files without a preview type are not read at all, and remembered as having none.
        expect(await cache.get(join(home, 'parts', 'cube.stl'), home)).toBeNull();
        expect(reads).toHaveLength(2);
        // Past the limit the oldest (the ring) is dropped, so it is read again.
        await cache.get(join(home, 'parts', 'button.sldprt'), home);
        expect(cache.size).toBe(2);
        expect(reads).toHaveLength(3);
        await cache.get(ring, home);
        expect(reads).toHaveLength(4);
        await expect(cache.get(join(outside, 'secret.step'), home)).rejects.toMatchObject({ status: 403 });
    });
});

describe('places', () => {
    it('finds home, desktop, documents and downloads as the desktop names them', async () => {
        expect(await standardPlaces(home)).toEqual([
            { id: 'home', name: 'Home', path: home },
            { id: 'desktop', name: 'Desktop', path: join(home, 'Desktop') },
            { id: 'documents', name: 'Documents', path: join(home, 'Docs') },
            { id: 'downloads', name: 'Downloads', path: join(home, 'Downloads') },
        ]);
    });

    it('keeps pinned, recent and last folders in the settings, inside home only', async () => {
        const settings = new SettingsStore(join(data, 'places-settings.json'));
        const app = Fastify();
        registerFileRoutes(app, settings, async () => home);
        const put = async (body: unknown) => (await app.inject({ method: 'PUT', url: '/api/files/places', payload: body as object })).json() as PlacesAnswer;
        let answer = await put({ favourites: [join(home, 'parts'), outside, join(home, 'gone'), join(home, 'parts', 'sub')], last: join(home, 'parts') });
        expect(answer.favourites).toEqual([join(home, 'parts'), join(home, 'parts', 'sub')]);
        expect(answer.last).toBe(join(home, 'parts'));
        await rememberImportFolder(settings, join(home, 'parts', 'cube.stl'), home);
        await rememberImportFolder(settings, join(home, 'parts', 'sub', '..', 'ring.SLDPRT'), home);
        await rememberImportFolder(settings, join(outside, 'secret.step'), home);
        answer = (await app.inject({ method: 'GET', url: '/api/files/places' })).json() as PlacesAnswer;
        expect(answer.recent).toEqual([join(home, 'parts')]);
        expect(answer.standard.map((p) => p.id)).toEqual(['home', 'desktop', 'documents', 'downloads']);
        answer = await put({ forget: join(home, 'parts') });
        expect(answer.recent).toEqual([]);
        expect(settings.get().files.favourites).toHaveLength(2);
        // A last folder outside home is not taken.
        answer = await put({ last: outside });
        expect(answer.last).toBe(join(home, 'parts'));
        expect((await app.inject({ method: 'PUT', url: '/api/files/places', payload: { favourites: 'x' } })).statusCode).toBe(400);
        // The browser opens at the last folder, or at home once that is gone.
        expect((await app.inject({ method: 'GET', url: '/api/files/list?last=1' })).json().path).toBe(join(home, 'parts'));
        settings.update({ files: { ...settings.get().files, lastFolder: join(home, 'gone') } });
        expect((await app.inject({ method: 'GET', url: '/api/files/list?last=1' })).json().path).toBe(home);
        await app.close();
    });

    it('answers listings and previews over HTTP, refusing what is outside home', async () => {
        const app = Fastify();
        registerFileRoutes(app, new SettingsStore(join(data, 'http-settings.json')), async () => home);
        const list = await app.inject({ method: 'GET', url: `/api/files/list?path=${encodeURIComponent(join(home, 'parts'))}&all=1` });
        expect(list.statusCode).toBe(200);
        expect(list.json().entries.some((e: { name: string }) => e.name === 'notes.txt')).toBe(true);
        expect((await app.inject({ method: 'GET', url: `/api/files/list?path=${encodeURIComponent(outside)}` })).statusCode).toBe(403);
        const png = await app.inject({ method: 'GET', url: `/api/files/preview?path=${encodeURIComponent(join(home, 'parts', 'button.sldprt'))}` });
        expect(png.statusCode).toBe(200);
        expect(png.headers['content-type']).toBe('image/png');
        expect(png.rawPayload.subarray(1, 4).toString()).toBe('PNG');
        expect((await app.inject({ method: 'GET', url: `/api/files/preview?path=${encodeURIComponent(join(home, 'parts', 'cube.stl'))}` })).statusCode).toBe(404);
        await app.close();
    });
});

describe('import by path', () => {
    it('imports a file in home through the same job and options as an upload, and remembers its folder', async () => {
        const store = new ProjectStore();
        store.create('Path import test');
        const jobs: string[] = [];
        // The CAD worker's job run in this thread: an STL graphics body needs no kernel.
        const kernel = { importFile: (job: Parameters<typeof runImport>[0]) => (jobs.push(job.filename), runImport(job)) };
        const remembered: string[] = [];
        const app = Fastify();
        registerImportRoutes(app, store, kernel as never, { home, importedPath: (p) => void remembered.push(p) });
        const send = (meta: object) => app.inject({
            method: 'POST', url: '/api/import', headers: { 'content-type': 'application/octet-stream', 'x-import': encodeURIComponent(JSON.stringify(meta)) },
            payload: Buffer.alloc(0),
        });
        const ok = await send({ name: 'cube.stl', path: join(home, 'parts', 'cube-link.stl'), options: { up: 'y', meshAs: 'graphics' } });
        expect(ok.statusCode, ok.body).toBe(200);
        const answer = ok.json() as { text: string; parts: string[] };
        // The link is followed: the file's own name and folder.
        expect(answer.text).toContain('Imported cube.stl');
        expect(jobs).toEqual(['cube.stl']);
        expect(remembered).toEqual([join(home, 'parts', 'cube.stl')]);
        const step = store.get().parts.find((p) => p.id === answer.parts[0])?.features?.[0] as { file: { asset: string; name: string } };
        expect(step.file.name).toBe('cube.stl');
        expect(Buffer.from(readImportAsset(step.file.asset)).equals(Buffer.from(tinyStl()))).toBe(true);
        // Refused: outside home, through a link out of it, a folder, a missing file. Nothing is imported.
        const parts = store.get().parts.length;
        for (const [path, status] of [[join(outside, 'secret.step'), 403], [join(home, 'parts', 'secret-link.step'), 403],
            [join(home, 'parts'), 400], [join(home, 'parts', 'none.stl'), 404], ['parts/cube.stl', 400]] as const) {
            const refused = await send({ name: 'x.step', path });
            expect(refused.statusCode, path).toBe(status);
        }
        expect(store.get().parts).toHaveLength(parts);
        expect(jobs).toHaveLength(1);
        await app.close();
    });

    it("reads the assistant's import_file path the same way (any absolute path, as before)", async () => {
        const store = new ProjectStore();
        store.create('Tool import test');
        const tool = importFileTool(store, { kernel: { importFile: runImport } as never });
        const answer = await tool.run({ path: join(home, 'parts', 'cube.stl'), options: { up: 'y' } }) as { text: string };
        expect(answer.text).toContain('Imported cube.stl');
        await expect(tool.run({ path: join(home, 'parts', 'none.stl') })).rejects.toThrow(/There is no file at/);
        await expect(tool.run({ path: join(home, 'parts') })).rejects.toThrow(/There is no file at/);
        await expect(tool.run({ path: 'parts/cube.stl' })).rejects.toThrow(/absolute path/);
    });
});
