import {
    existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, Part, Project } from '@jarvis/core';

// Nothing here may touch the real data folder or the owner's home: made-up projects and assets only.
const data = await vi.hoisted(async () => {
    const { mkdtempSync: temp } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const scratch = temp(path.join(os.tmpdir(), 'jarvis-file-data-'));
    process.env.JARVIS_PROJECTS_DIR = scratch;
    process.env.JARVIS_SETTINGS_FILE = path.join(scratch, '.studio', 'settings.json');
    return scratch;
});

import { saveAsset } from './assets.js';
import { listFolder, previewOf } from './files.js';
import { assetId, saveImportAsset } from './import/assets.js';
import {
    FileExistsError, NoFileError, openProjectFile, saveLinkedFile, saveProjectFile, saveTarget, fileInfo, setHomeFolder,
} from './jarvisFile.js';
import { jarvisFileTools, registerJarvisFileRoutes } from './jarvisFileRoutes.js';
import {
    designOf, JarvisFileError, MAX_ENTRY_BYTES, MAX_TOTAL_BYTES, packProject, safeEntryName, sha256, unpackProject, type Manifest,
} from './jarvisFormat.js';
import { SettingsStore } from './settings.js';
import { ProjectStore, slug } from './store.js';
import { checkHistory, createTools } from './tools.js';

const ASSETS = join(data, 'assets');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-file-test-')));
const home = join(root, 'home');
const outside = join(root, 'elsewhere');
const docs = join(home, 'Documents');
mkdirSync(docs, { recursive: true });
mkdirSync(outside, { recursive: true });
symlinkSync(outside, join(home, 'link-out'));
// The tools that take no home of their own (project_open in tools.ts) use this one too.
setHomeFolder(home);

afterAll(() => {
    setHomeFolder(null);
    rmSync(root, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
});

const steel = { color: '#c9d1d9', metalness: 1, roughness: 0.3 };
/** A PNG as far as anyone checks: the signature, then anything. */
const png = (fill: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, fill, fill, fill, 1, 2, 3]);

/** Made-up assets of every kind a project refers to, stored as the studio stores them. */
function makeAssets() {
    return {
        step: saveImportAsset(strToU8('ISO-10303-21; made up for a test;'), 'step'),
        brep: saveImportAsset(new Uint8Array([31, 139, 8, 0, 1, 2, 3, 4, 5]), 'brep'),
        mesh: saveImportAsset(new Uint8Array(84).fill(7), 'stl'),
        preview: saveAsset(Buffer.from(png(1)), 'image/png'),
        decal: saveAsset(Buffer.from(png(2)), 'image/png'),
        picture: saveAsset(Buffer.from(png(3)), 'image/png'),
    };
}

function part(id: string, extra: Partial<Part> = {}): Part {
    return { id, name: id.toUpperCase(), shape: { kind: 'box', size: [10, 20, 30] }, position: [0, 0, 0], rotation: [0, 0, 0], material: steel, ...extra };
}

/** A project with an imported part (original file, BREP, preview), a mesh part, a decal and a sketch picture. */
function buildProject(store: ProjectStore, name: string) {
    const ids = makeAssets();
    store.create(name);
    store.mutate((draft) => {
        draft.parts.push(part('bracket', {
            features: [{
                id: 'imported1', op: 'import', file: { name: 'bracket.step', format: 'step', asset: ids.step, thumbnail: ids.preview },
                brep: ids.brep, bodies: [{ name: 'Body' }],
            } as Feature],
            decals: [{ id: 'logo', image: ids.decal, position: [0, 0, 15], normal: [0, 0, 1], size: [8, 4] }],
        }));
        draft.parts.push(part('mesh', { features: [{ id: 'stl1', op: 'import', file: { name: 'm.stl', format: 'stl', asset: ids.mesh }, mesh: ids.mesh } as Feature] }));
        draft.parts.push(part('plate', {
            position: [40, 0, 0],
            features: [{
                id: 'sketch1', op: 'sketch',
                sketch: {
                    plane: 'front', profiles: [],
                    geometry: { points: [], curves: [], constraints: [], pictures: [{ id: 'p1', asset: ids.picture, at: [0, 0], width: 10, height: 5, angle: 0, pixels: [20, 10] }] },
                },
            } as unknown as Feature],
        }));
        draft.view.focus = 'plate';
        draft.view.autoRotate = true;
        draft.view.azimuth = 30;
        draft.view.hidden = ['mesh'];
    });
    return ids;
}

const assetBytes = (id: string) => readFileSync(join(ASSETS, id));
const projectFiles = () => readdirSync(data).filter((f) => f.endsWith('.json'));

let store: ProjectStore;

beforeEach(() => {
    store = new ProjectStore();
});

describe('the .jarvis format', () => {
    it('round trip: save then open gives the same project and the same asset bytes', () => {
        const ids = buildProject(store, 'Round trip');
        const before = designOf(store.get());
        const bytes = Object.fromEntries(Object.values(ids).map((id) => [id, new Uint8Array(assetBytes(id))]));
        const file = join(docs, 'round trip.jarvis');
        const saved = saveProjectFile(store, { path: file, thumbnail: png(9) }, { home });
        expect(saved.missing).toEqual([]);
        expect(saved.thumbnail).toBe(true);
        // On another machine: none of the assets are there.
        rmSync(ASSETS, { recursive: true, force: true });
        store.create('Elsewhere');
        // The link is this machine's: a fresh studio opening the file has no project from it.
        for (const f of projectFiles().filter((f) => f.startsWith('round-trip'))) {
            rmSync(join(data, f));
        }
        const opened = openProjectFile(store, file, { home });
        expect(opened.switched).toBe(false);
        expect(opened.name).toBe('Round trip');
        const after = store.get();
        expect(designOf(after)).toEqual(before);
        expect(after.jarvisFile).toEqual({ path: file, sha256: sha256(readFileSync(file)) });
        for (const [id, data] of Object.entries(bytes)) {
            expect(new Uint8Array(assetBytes(id))).toEqual(data);
        }
    });

    it('holds the manifest, the design without this machine\'s data, the thumbnail and exactly the assets used', () => {
        const ids = buildProject(store, 'Contents');
        const orphan = saveImportAsset(strToU8('not used by any project here'), 'step');
        saveProjectFile(store, { path: '~/Documents/contents', thumbnail: png(5), description: 'A test bracket' }, { home });
        const file = join(docs, 'contents.jarvis');
        const zip = unzipSync(readFileSync(file));
        const manifest = JSON.parse(strFromU8(zip['manifest.json'])) as Manifest;
        expect(manifest).toMatchObject({
            format: 'jarvis-studio', version: 1, name: 'Contents', description: 'A test bracket', units: 'mm', up: 'y', parts: 3,
        });
        expect(manifest.app).toMatch(/^\d+\.\d+/);
        expect(Number.isNaN(Date.parse(manifest.saved))).toBe(false);
        const names = Object.values(ids).map((id) => `assets/${id}`);
        expect(Object.keys(zip).sort()).toEqual(['design.json', 'manifest.json', 'thumbnail.png', ...new Set(names)].sort());
        expect(Object.keys(zip)).not.toContain(`assets/${orphan}`);
        for (const entry of manifest.files) {
            expect(entry.size).toBe(zip[entry.name].length);
            expect(entry.sha256).toBe(sha256(zip[entry.name]));
        }
        const design = JSON.parse(strFromU8(zip['design.json'])) as Project;
        expect(design.jarvisFile).toBeUndefined();
        expect(JSON.stringify(design)).not.toContain(root);
        expect(design.view).not.toHaveProperty('focus');
        expect(design.view).not.toHaveProperty('autoRotate');
        expect(design.view).not.toHaveProperty('azimuth');
        expect(design.view.hidden).toEqual(['mesh']);
        expect(design.description).toBe('A test bracket');
        // The project keeps the description and remembers the file; nothing is left beside it.
        expect(store.get().description).toBe('A test bracket');
        expect(store.get().jarvisFile?.path).toBe(file);
        expect(readdirSync(docs).filter((f) => f.endsWith('.part'))).toEqual([]);
    });

    it('saves what it has and says which assets were missing', () => {
        buildProject(store, 'Missing');
        const gone = store.get().parts[1].features![0] as Extract<Feature, { op: 'import' }>;
        rmSync(join(ASSETS, gone.mesh!));
        const answer = saveProjectFile(store, { path: join(docs, 'missing.jarvis') }, { home });
        expect(answer.missing).toEqual([gone.mesh]);
        expect(answer.text).toContain(gone.mesh);
        expect(answer.thumbnail).toBe(false);
    });

    const project = (): Project => ({ name: 'Made up', parts: [part('a')], view: { explode: 0, explodeSpacing: null, labels: false, focus: null, autoRotate: false, azimuth: null, elevation: null } });
    const pack = () => unzipSync(packProject({ project: project(), app: '0.1.0', asset: () => null }).bytes);
    const zip = (entries: Record<string, Uint8Array>) => zipSync(entries as Zippable);
    const withManifest = (entries: Record<string, Uint8Array>, change: (m: Manifest) => void) => {
        const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as Manifest;
        change(manifest);
        return { ...entries, 'manifest.json': strToU8(JSON.stringify(manifest)) };
    };
    const refusal = (bytes: Uint8Array): string => {
        try {
            unpackProject(bytes);
        } catch (error) {
            expect(error).toBeInstanceOf(JarvisFileError);
            return (error as Error).message;
        }
        throw new Error('it was not refused');
    };

    it('checks the format and the major version; a newer major is refused in plain words', () => {
        expect(unpackProject(zip(pack())).project.name).toBe('Made up');
        expect(unpackProject(zip(withManifest(pack(), (m) => {
            m.version = 1.4;
        }))).project.name).toBe('Made up');
        expect(refusal(zip(withManifest(pack(), (m) => {
            m.version = 2;
            m.app = '3.0.0';
        })))).toBe('it was saved by a newer Jarvis Studio (file format 2, studio 3.0.0); this studio reads format 1. Update the studio to open it');
        expect(refusal(zip(withManifest(pack(), (m) => {
            (m as { format: string }).format = 'other';
        })))).toMatch(/not a Jarvis Studio file/);
        expect(refusal(zip(withManifest(pack(), (m) => {
            (m as { version: unknown }).version = 'one';
        })))).toMatch(/no valid format version/);
        const { 'manifest.json': _m, ...rest } = pack();
        expect(refusal(zip(rest))).toMatch(/no manifest\.json/);
        expect(refusal(strToU8('just some text, not a zip at all'))).toBe('it is not a ZIP archive');
    });

    it('refuses an entry whose bytes do not match the manifest', () => {
        const entries = pack();
        const design = JSON.parse(strFromU8(entries['design.json'])) as Project;
        design.parts[0].position = [1, 2, 3];
        const altered = strToU8(JSON.stringify(design, null, 2));
        expect(refusal(zip({ ...entries, 'design.json': altered }))).toMatch(/design\.json is not the size|design\.json does not match its SHA-256/);
        // Same size, other bytes.
        const same = new Uint8Array(entries['design.json']);
        same[same.length - 2] = same[same.length - 2] === 0x20 ? 0x09 : 0x20;
        expect(refusal(zip({ ...entries, 'design.json': same }))).toBe('it is damaged: design.json does not match its SHA-256 in the manifest');
        // An asset whose content is not the one its name (a hash of it) says.
        const id = assetId(strToU8('the real bytes'), 'step');
        const fake = strToU8('other bytes');
        const withAsset = withManifest({ ...entries, [`assets/${id}`]: fake }, (m) => {
            m.files.push({ name: `assets/${id}`, size: fake.length, sha256: sha256(fake) });
        });
        const design2 = { ...project(), parts: [part('a', { features: [{ id: 'i', op: 'import', file: { name: 'x.step', format: 'step', asset: id } } as Feature] })] };
        const designBytes = strToU8(JSON.stringify(design2));
        expect(refusal(zip(withManifest({ ...withAsset, 'design.json': designBytes }, (m) => {
            m.files = m.files.map((f) => (f.name === 'design.json' ? { name: f.name, size: designBytes.length, sha256: sha256(designBytes) } : f));
        })))).toBe(`it is damaged: assets/${id} does not match its name`);
    });

    it('refuses zip-slip names and anything outside the listed entries', () => {
        for (const name of ['../evil.txt', '/etc/evil', 'assets\\..\\evil', 'assets/../../evil', 'C:/evil', 'a//b', './x']) {
            expect(safeEntryName(name)).toBe(false);
            const evil = strToU8('evil');
            expect(refusal(zip(withManifest({ ...pack(), [name]: evil }, (m) => {
                m.files.push({ name, size: evil.length, sha256: sha256(evil) });
            })))).toMatch(/not allowed/);
        }
        expect(safeEntryName('assets/0123456789abcdef01234567.step')).toBe(true);
        expect(refusal(zip({ ...pack(), 'extra.txt': strToU8('not listed') }))).toBe('it holds extra.txt, which its manifest does not list');
        expect(refusal(zip(withManifest(pack(), (m) => {
            m.files.push({ name: 'thumbnail.png', size: 3, sha256: sha256(strToU8('abc')) });
        })))).toBe('it is damaged: thumbnail.png, listed in its manifest, is not in it');
    });

    /** Sets the unpacked size the central directory gives an entry (the sizes are checked before unpacking). */
    function claimSize(bytes: Uint8Array, name: string, size: number): Uint8Array {
        const out = new Uint8Array(bytes);
        const view = new DataView(out.buffer);
        for (let at = 0; at < out.length - 46; at++) {
            if (view.getUint32(at, true) === 0x02014b50) {
                const length = view.getUint16(at + 28, true);
                if (strFromU8(out.subarray(at + 46, at + 46 + length)) === name) {
                    view.setUint32(at + 24, size, true);
                    return out;
                }
            }
        }
        throw new Error(`no ${name}`);
    }

    it('refuses entries and archives that unpack past the size limits, before unpacking them', () => {
        const bytes = zip(pack());
        expect(refusal(claimSize(bytes, 'design.json', MAX_ENTRY_BYTES + 1))).toBe('design.json unpacks to more than the 512 MB allowed for one entry');
        const two = zip({ ...pack(), 'thumbnail.png': png(1) });
        const big = claimSize(claimSize(two, 'design.json', MAX_ENTRY_BYTES), 'thumbnail.png', MAX_ENTRY_BYTES);
        expect(refusal(claimSize(big, 'manifest.json', 4096))).toBe('it unpacks to more than the 1024 MB the studio opens');
        // A file larger than that is not even read.
        const huge = join(docs, 'huge.jarvis');
        writeFileSync(huge, '');
        truncateSync(huge, MAX_TOTAL_BYTES + 1);
        expect(() => openProjectFile(store, huge, { home })).toThrow('huge.jarvis cannot be opened: it is larger than the 1024 MB the studio opens.');
        rmSync(huge);
    });
});

describe('saving to a file', () => {
    it('writes only inside home, through links that stay in it', () => {
        buildProject(store, 'Paths');
        expect(() => saveProjectFile(store, { path: join(outside, 'x.jarvis') }, { home })).toThrow('Only files in your home folder can be saved or opened here.');
        expect(() => saveProjectFile(store, { path: join(home, 'link-out', 'x.jarvis') }, { home })).toThrow('Only files in your home folder');
        expect(() => saveProjectFile(store, { path: 'relative.jarvis' }, { home })).toThrow('Give an absolute path.');
        expect(() => saveProjectFile(store, { path: join(home, 'no such folder', 'x.jarvis') }, { home })).toThrow('does not exist');
        expect(() => saveProjectFile(store, { path: `${docs}/` }, { home })).toThrow('Give a file name, not only a folder.');
        expect(() => saveProjectFile(store, { path: join(docs, '.jarvis') }, { home })).toThrow('Give the file a name.');
        expect(existsSync(join(outside, 'x.jarvis'))).toBe(false);
        // A link in home to a file elsewhere in home is written through.
        writeFileSync(join(home, 'real.jarvis'), 'old');
        symlinkSync(join(home, 'real.jarvis'), join(docs, 'linked.jarvis'));
        expect(saveTarget(join(docs, 'linked'), home)).toMatchObject({ path: join(home, 'real.jarvis'), exists: true });
        symlinkSync(join(outside, 'x.jarvis'), join(docs, 'out.jarvis'));
        expect(() => saveTarget(join(docs, 'out.jarvis'), home)).toThrow();
    });

    it('replaces a file only when that is confirmed, atomically', () => {
        buildProject(store, 'Twice');
        const file = join(docs, 'twice.jarvis');
        saveProjectFile(store, { path: file }, { home });
        const first = readFileSync(file);
        store.mutate((draft) => {
            draft.parts[0].position = [5, 5, 5];
        });
        expect(() => saveProjectFile(store, { path: file }, { home })).toThrow(FileExistsError);
        expect(readFileSync(file)).toEqual(first);
        saveProjectFile(store, { path: file, overwrite: true }, { home });
        expect(readFileSync(file)).not.toEqual(first);
        expect(unpackProject(readFileSync(file)).project.parts[0].position).toEqual([5, 5, 5]);
        expect(readdirSync(docs).filter((f) => f.includes('.part'))).toEqual([]);
    });

    it('Save writes the file the project remembers, and asks for Save As without one', () => {
        buildProject(store, 'Remembered');
        expect(() => saveLinkedFile(store, {}, { home })).toThrow(NoFileError);
        const file = join(docs, 'remembered.jarvis');
        saveProjectFile(store, { path: file }, { home });
        const link = store.get().jarvisFile!;
        expect(link.path).toBe(file);
        store.mutate((draft) => {
            draft.parts[0].name = 'Renamed bracket';
        });
        // An undo does not take the file away: saving set it, not undoably.
        store.mutate((draft) => {
            draft.parts[0].name = 'Again';
        });
        store.undo();
        expect(store.get().jarvisFile).toEqual(link);
        const answer = saveLinkedFile(store, {}, { home });
        expect(answer.path).toBe(file);
        expect(unpackProject(readFileSync(file)).project.parts[0].name).toBe('Renamed bracket');
        expect(store.get().jarvisFile).toEqual({ path: file, sha256: sha256(readFileSync(file)) });
        // A copy made in the studio has not been saved to a file.
        store.saveAs('Remembered copy');
        expect(store.get().jarvisFile).toBeUndefined();
    });

    it('Save as copy and open: the file opens as a new project and the open one stays as it was', () => {
        buildProject(store, 'Original');
        const original = JSON.parse(JSON.stringify(store.get())) as Project;
        const file = join(docs, 'copy.jarvis');
        const answer = saveProjectFile(store, { path: file, mode: 'copyAndOpen', description: 'The copy' }, { home });
        expect(answer.opened?.name).toBe('Original 2');
        expect(store.get().name).toBe('Original 2');
        expect(store.get().description).toBe('The copy');
        expect(store.get().jarvisFile?.path).toBe(file);
        const kept = JSON.parse(readFileSync(join(data, 'original.json'), 'utf8')) as Project;
        expect(kept).toEqual(original);
        expect(kept.jarvisFile).toBeUndefined();
    });
});

describe('opening a file', () => {
    it('switches to the project that came from the same unchanged file instead of copying it again', () => {
        buildProject(store, 'Reopen');
        const file = join(docs, 'reopen.jarvis');
        saveProjectFile(store, { path: file }, { home });
        const count = projectFiles().length;
        expect(openProjectFile(store, file, { home })).toMatchObject({ switched: true, name: 'Reopen' });
        store.create('Somewhere else');
        const again = openProjectFile(store, file, { home });
        expect(again).toMatchObject({ switched: true, name: 'Reopen' });
        expect(again.text).toBe('Switched to "Reopen", which came from reopen.jarvis and is already in the studio.');
        expect(store.get().name).toBe('Reopen');
        expect(projectFiles().length).toBe(count + 1);
        // Saved again from another project: that project goes with the file now.
        store.create('Other');
        store.mutate((draft) => {
            draft.parts.push(part('only'));
        });
        saveProjectFile(store, { path: file, overwrite: true }, { home });
        store.open('Reopen');
        expect(openProjectFile(store, file, { home })).toMatchObject({ switched: true, name: 'Other' });
        // Changed elsewhere (another machine's copy put in its place): it opens as a new project.
        const newer: Project = { ...JSON.parse(JSON.stringify(store.get())), name: 'Newer', parts: [part('newer')] };
        writeFileSync(file, packProject({ project: newer, app: '0.1.0', asset: () => null }).bytes);
        const changed = openProjectFile(store, file, { home });
        expect(changed).toMatchObject({ switched: false, name: 'Newer' });
        expect(openProjectFile(store, file, { home })).toMatchObject({ switched: true, name: 'Newer' });
    });

    it('refuses files outside home, folders and model files, and reports history problems without refusing', () => {
        writeFileSync(join(outside, 'away.jarvis'), 'x');
        expect(() => openProjectFile(store, join(outside, 'away.jarvis'), { home })).toThrow('Only files in your home folder');
        expect(() => openProjectFile(store, docs, { home })).toThrow('Documents is not a file.');
        writeFileSync(join(docs, 'part.step'), 'ISO-10303-21;');
        expect(() => openProjectFile(store, join(docs, 'part.step'), { home })).toThrow('part.step is a file to import (STEP AP203/AP214), not a Jarvis Studio project: use File > Import.');
        writeFileSync(join(docs, 'broken.jarvis'), 'not a zip');
        expect(() => openProjectFile(store, join(docs, 'broken.jarvis'), { home })).toThrow('broken.jarvis cannot be opened: it is not a ZIP archive.');
        const bad: Project = {
            name: 'Bad refs', view: { explode: 0, explodeSpacing: null, labels: false, focus: null, autoRotate: false, azimuth: null, elevation: null },
            parts: [part('a', { features: [{ id: 'cut1', op: 'extrude', sketchRef: 'nothing', distance: 5 } as unknown as Feature] })],
        };
        writeFileSync(join(docs, 'bad.jarvis'), packProject({ project: bad, app: '0.1.0', asset: () => null }).bytes);
        const answer = openProjectFile(store, join(docs, 'bad.jarvis'), { home, checkPart: checkHistory });
        expect(answer.name).toBe('Bad refs');
        expect(answer.warnings).toEqual(['A: feature cut1: sketch "nothing" is not an earlier sketch step of a']);
        expect(answer.text).toContain('History check: A: feature cut1');
    });

    it('shows a file\'s details, and its thumbnail in the file browser', async () => {
        buildProject(store, 'Shown');
        saveProjectFile(store, { path: join(docs, 'shown.jarvis'), thumbnail: png(4), description: 'Seen in Open' }, { home });
        expect(fileInfo(join(docs, 'shown.jarvis'), { home })).toMatchObject({ name: 'Shown', description: 'Seen in Open', parts: 3, version: 1 });
        const listing = await listFolder(docs, home);
        expect(listing.entries.find((e) => e.name === 'shown.jarvis')).toMatchObject({ format: 'jarvis', preview: true });
        expect(previewOf('shown.jarvis', readFileSync(join(docs, 'shown.jarvis')))).toEqual(png(4));
    });
});

describe('assistant tools and routes', () => {
    it('project_save_as, project_save and project_open with a path', async () => {
        buildProject(store, 'Tools');
        const tools = [...createTools(store), ...jarvisFileTools(store, { home, thumbnail: async () => png(6) })];
        const run = (name: string, args: unknown = {}) => tools.find((t) => t.name === name)!.run(args);
        await expect(run('project_save')).rejects.toThrow('use Save As');
        const saved = await run('project_save_as', { path: '~/Documents/tools' }) as { text: string };
        expect(saved.text).toBe(`Saved tools.jarvis in ${docs}.`);
        await expect(run('project_save_as', { path: '~/Documents/tools.jarvis' })).rejects.toThrow('call again with overwrite: true');
        expect((await run('project_save') as { text: string }).text).toBe(`Saved tools.jarvis in ${docs}.`);
        expect(unzipSync(readFileSync(join(docs, 'tools.jarvis')))['thumbnail.png']).toEqual(png(6));
        store.create('Away');
        expect(run('project_open', { path: '~/Documents/tools.jarvis' })).toBe('Switched to "Tools", which came from tools.jarvis and is already in the studio.');
        expect(run('project_open', {})).toBe('Give the name of a saved project or the path of a .jarvis file.');
        expect(run('project_open', { name: 'Away' })).toBe('Opened "Away".');
        expect(() => run('project_open', { path: join(outside, 'x.jarvis') })).toThrow();
    });

    it('answers Save As, Replace, Save and Open over HTTP', async () => {
        buildProject(store, 'Http');
        const app = Fastify();
        const settings = new SettingsStore(join(data, 'http-settings.json'));
        let stops = 0;
        registerJarvisFileRoutes(app, store, settings, { home, stop: () => stops++ });
        await app.ready();
        const post = (url: string, body: object) => app.inject({ method: 'POST', url, payload: body });
        expect((await post('/api/jarvis/save', {})).json()).toMatchObject({ noFile: true });
        const thumbnail = Buffer.from(png(8)).toString('base64');
        const first = await post('/api/jarvis/save-as', { path: join(docs, 'http'), mode: 'copy', thumbnail });
        expect(first.statusCode).toBe(200);
        expect(first.json()).toMatchObject({ path: join(docs, 'http.jarvis'), thumbnail: true });
        const again = await post('/api/jarvis/save-as', { path: join(docs, 'http.jarvis') });
        expect(again.statusCode).toBe(409);
        expect(again.json()).toMatchObject({ exists: true, path: join(docs, 'http.jarvis') });
        expect((await post('/api/jarvis/save-as', { path: join(docs, 'http.jarvis'), overwrite: true })).statusCode).toBe(200);
        expect((await post('/api/jarvis/save-as', { path: join(outside, 'http.jarvis') })).statusCode).toBe(403);
        expect((await post('/api/jarvis/save', {})).statusCode).toBe(200);
        // The folder becomes the first recent one, where the browser opens next.
        expect(settings.get().files.recentFolders[0]).toBe(docs);
        const info = await app.inject({ method: 'GET', url: `/api/jarvis/info?path=${encodeURIComponent(join(docs, 'http.jarvis'))}` });
        expect(info.json()).toMatchObject({ name: 'Http', parts: 3 });
        writeFileSync(join(docs, 'bad.jarvis'), 'nope');
        const bad = await post('/api/jarvis/open', { path: join(docs, 'bad.jarvis') });
        expect(bad.statusCode).toBe(422);
        expect(bad.json().error).toBe('bad.jarvis cannot be opened: it is not a ZIP archive.');
        store.create('Before open');
        const opened = await post('/api/jarvis/open', { path: join(docs, 'http.jarvis') });
        expect(opened.json()).toMatchObject({ switched: true, name: 'Http' });
        expect(slug(store.get().name)).toBe('http');
        expect(stops).toBe(2);
        await app.close();
    });
});
