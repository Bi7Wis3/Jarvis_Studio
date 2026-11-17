import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@jarvis/core';
import { useFileBrowser, type Listing } from './fileBrowserState';
import {
    defaultFileName, fileNameProblem, folderOf, isJarvisFile, requestOpen, requestSave, requestSaveAs, setJarvisFetch, withExtension,
} from './jarvisFileState';
import { openFileTool, saveAsTool } from './jarvisFileForms';
import { ALL_TOOLS, type Ctx, type PopupApi, type Values } from './toolDefs';

vi.mock('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url', () => ({ default: '' }));

const view = { explode: 0, explodeSpacing: null, labels: false, focus: null, autoRotate: false, azimuth: null, elevation: null };
const project = (extra: Partial<Project> = {}): Project => ({ name: 'Robot arm', parts: [], view, ...extra });

describe('file names', () => {
    it('adds .jarvis when it is missing and says what cannot be a file name', () => {
        expect(withExtension('robot')).toBe('robot.jarvis');
        expect(withExtension(' robot.JARVIS ')).toBe('robot.JARVIS');
        expect(isJarvisFile('a.Jarvis')).toBe(true);
        expect(isJarvisFile('a.jarvis-sw.json')).toBe(false);
        expect(fileNameProblem('')).toBe('Type a name for the file.');
        expect(fileNameProblem('.jarvis')).toBe('Type a name for the file.');
        expect(fileNameProblem('../x')).toBe('Type the file name only: choose its folder in the list above.');
        expect(fileNameProblem('x'.repeat(250))).toBe('The file name is too long.');
        expect(fileNameProblem('robot arm v2')).toBeNull();
        expect(folderOf('/home/me/Desktop/robot.jarvis')).toBe('/home/me/Desktop');
        expect(folderOf('/robot.jarvis')).toBe('/');
    });

    it('starts Save As with the file the project goes with, else its name', () => {
        expect(defaultFileName(project())).toBe('Robot arm.jarvis');
        expect(defaultFileName(project({ name: 'a/b' }))).toBe('a-b.jarvis');
        expect(defaultFileName(project({ jarvisFile: { path: '/home/me/Desktop/arm v3.jarvis', sha256: 'x' } }))).toBe('arm v3.jarvis');
        expect(defaultFileName(null)).toBe('Untitled.jarvis');
    });
});

describe('requests', () => {
    it('sends Save As, Save and Open and reads the answers, a file that is there included', async () => {
        const calls: { url: string; body: Record<string, unknown> | null }[] = [];
        setJarvisFetch(async (url, init) => {
            const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : null;
            calls.push({ url, body });
            const answer = (status: number, json: unknown) => ({ ok: status === 200, status, json: async () => json });
            if (url === '/api/jarvis/save-as') {
                return body?.overwrite ? answer(200, { text: 'Saved arm.jarvis in /home/me.' })
                    : answer(409, { error: 'arm.jarvis already exists in /home/me.', exists: true, path: '/home/me/arm.jarvis' });
            }
            if (url === '/api/jarvis/save') {
                return answer(409, { error: 'This project has not been saved to a .jarvis file yet: use Save As.', noFile: true });
            }
            return answer(200, { text: 'Opened arm.jarvis as "Arm".', name: 'Arm', switched: false });
        });
        const first = await requestSaveAs({ path: '/home/me/arm.jarvis', mode: 'copy', overwrite: false, description: '', thumbnail: null });
        expect(first).toMatchObject({ ok: false, exists: true, text: 'arm.jarvis already exists in /home/me.' });
        expect(calls[0].body).toEqual({ path: '/home/me/arm.jarvis', mode: 'copy', overwrite: false, description: '' });
        const replaced = await requestSaveAs({ path: '/home/me/arm.jarvis', mode: 'copyAndOpen', overwrite: true, description: 'd', thumbnail: 'iVBOR' });
        expect(replaced).toMatchObject({ ok: true, text: 'Saved arm.jarvis in /home/me.' });
        expect(calls[1].body).toMatchObject({ overwrite: true, thumbnail: 'iVBOR', mode: 'copyAndOpen' });
        expect(await requestSave(null)).toMatchObject({ ok: false, noFile: true });
        expect(await requestOpen('/home/me/arm.jarvis')).toMatchObject({ ok: true, name: 'Arm' });
        expect(calls[3]).toEqual({ url: '/api/jarvis/open', body: { path: '/home/me/arm.jarvis' } });
        setJarvisFetch(async () => {
            throw new Error('down');
        });
        expect(await requestOpen('/x.jarvis')).toEqual({ ok: false, text: 'The server is not answering.' });
    });
});

describe('the forms', () => {
    const ctx: Ctx = { part: null, project: project({ description: 'Six axes' }), edit: null };
    const api = (values: Values): PopupApi => ({ values, set: () => {}, run: () => {} });
    const listing: Listing = {
        path: '/home/me/Desktop', home: '/home/me', parent: '/home/me', skipped: 0,
        entries: [{ name: 'arm.jarvis', kind: 'file', size: 4096, modified: 0, format: 'jarvis', preview: true }],
    };

    it('are File menu forms in the left panel', () => {
        expect(ALL_TOOLS).toEqual(expect.arrayContaining([saveAsTool, openFileTool]));
        expect(saveAsTool.panel && openFileTool.panel).toBe(true);
    });

    it('Save As: the browser in its save mode, the file name, the SolidWorks modes and Description', () => {
        useFileBrowser.setState({ listing });
        const values = saveAsTool.defaults!(ctx);
        expect(values).toEqual({ name: 'Robot arm.jarvis', mode: 'copy', description: 'Six axes' });
        expect(saveAsTool.fields!(ctx).map((f) => [f.key, f.label, f.options?.map((o) => o.label)])).toEqual([
            ['mode', 'Mode', ['Save as copy and continue', 'Save as copy and open']],
            ['description', 'Description', undefined],
        ]);
        const html = renderToStaticMarkup(createElement(Fragment, null, saveAsTool.top!(api(values), ctx)));
        // (A static render shows the stores' first state: no folder listed yet.)
        for (const text of ['Places', 'Jarvis Studio project (*.jarvis)', 'File name', 'value="Robot arm.jarvis"', 'Show all files']) {
            expect(html, text).toContain(text);
        }
    });

    it('Save As refuses a name that cannot be a file before asking the server', async () => {
        useFileBrowser.setState({ listing });
        expect(await saveAsTool.apply!({ name: 'a/b', mode: 'copy', description: '' }, ctx))
            .toEqual({ text: 'Type the file name only: choose its folder in the list above.', isError: true });
    });

    it('Open: the browser with a Jarvis quick filter, and nothing to open until a file is picked', async () => {
        useFileBrowser.setState({ listing });
        const html = renderToStaticMarkup(createElement(Fragment, null, openFileTool.top!(api({}), ctx)));
        expect(html).toContain('Jarvis');
        expect(html).toContain('Pick a .jarvis file, or a model file to import.');
        expect(await openFileTool.apply!({}, ctx)).toEqual({ text: 'Pick a .jarvis file to open first.', isError: true });
    });
});
