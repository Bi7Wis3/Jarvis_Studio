// File > Save, Save As and Open of the studio's own file (.jarvis): the rules for the file name, the requests to the
// server (apps/server/src/jarvisFileRoutes.ts) and the little state the forms share, kept apart from the drawing
// (jarvisFileForms.tsx) so they can be tested.

import { create } from 'zustand';
import type { Project } from '@jarvis/core';
import type { PickedFile, QuickFilter } from './fileBrowserState';

export const EXTENSION = '.jarvis';

/** The quick filter for the studio's own files (the format the server's listing gives them). */
export const JARVIS_FILTER: QuickFilter = { id: 'jarvis', label: 'Jarvis', title: 'Jarvis Studio project (*.jarvis)', formats: ['jarvis'] };

export type SaveMode = 'copy' | 'copyAndOpen';

/** Save As choices, as SolidWorks names them. */
export const SAVE_MODES: { value: SaveMode; label: string }[] = [
    { value: 'copy', label: 'Save as copy and continue' },
    { value: 'copyAndOpen', label: 'Save as copy and open' },
];

export const isJarvisFile = (name: string): boolean => name.trim().toLowerCase().endsWith(EXTENSION);

/** The name as it is saved: ".jarvis" added when missing. */
export const withExtension = (name: string): string => (isJarvisFile(name) ? name.trim() : `${name.trim()}${EXTENSION}`);

/** Why a typed file name cannot be used, or null. */
export function fileNameProblem(name: string): string | null {
    const text = name.trim();
    if (!text || text.toLowerCase() === EXTENSION) {
        return 'Type a name for the file.';
    }
    if (/[/\\]/.test(text)) {
        return 'Type the file name only: choose its folder in the list above.';
    }
    if (text === '.' || text === '..' || text.includes('\0')) {
        return 'That name cannot be used for a file.';
    }
    if (new TextEncoder().encode(withExtension(text)).length > 255) {
        return 'The file name is too long.';
    }
    return null;
}

const lastPart = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? path;

/** The folder of a path ('/' for a file at the root). */
export const folderOf = (path: string): string => path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';

/** The name a new Save As starts with: the file the project goes with, else the project's name (made safe for a file). */
export function defaultFileName(project: Pick<Project, 'name' | 'jarvisFile'> | null | undefined): string {
    if (project?.jarvisFile) {
        return lastPart(project.jarvisFile.path);
    }
    const stem = (project?.name ?? '').replace(/[/\\\0]+/g, '-').trim() || 'Untitled';
    return withExtension(stem);
}

// ---- Requests ------------------------------------------------------------------------------------------------------

export interface Answer {
    ok: boolean;
    text: string;
    /** Save As: the file is there and was not to be replaced. */
    exists?: boolean;
    /** Save: the project has no file yet. */
    noFile?: boolean;
    /** Save as copy and open, Open: the project's name in the studio. */
    opened?: string;
    name?: string;
    path?: string;
}

export interface FileInfo {
    name: string;
    description?: string;
    saved: string;
    app: string;
    parts: number;
    version: number;
}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
    Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

let fetcher: Fetch = (url, init) => globalThis.fetch(url, init);

/** For tests: the server the forms talk to. */
export function setJarvisFetch(f: Fetch): void {
    fetcher = f;
}

async function request(url: string, body?: object): Promise<Answer & Record<string, unknown>> {
    try {
        const response = await fetcher(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
        const answer = await response.json().catch(() => null) as Record<string, unknown> | null;
        const text = typeof answer?.text === 'string' ? answer.text : typeof answer?.error === 'string' ? answer.error : `The server answered ${response.status}.`;
        return { ...answer, ok: response.ok, text } as Answer & Record<string, unknown>;
    } catch {
        return { ok: false, text: 'The server is not answering.' };
    }
}

export interface SaveAsRequest {
    path: string;
    mode: SaveMode;
    overwrite: boolean;
    description: string;
    /** A PNG of the view, base64; left out when the view cannot give one. */
    thumbnail?: string | null;
}

export const requestSaveAs = (body: SaveAsRequest): Promise<Answer> => {
    const { thumbnail, ...rest } = body;
    return request('/api/jarvis/save-as', { ...rest, ...(thumbnail ? { thumbnail } : {}) });
};

export const requestSave = (thumbnail?: string | null): Promise<Answer> => request('/api/jarvis/save', thumbnail ? { thumbnail } : {});

export const requestOpen = (path: string): Promise<Answer> => request('/api/jarvis/open', { path });

export async function requestInfo(path: string): Promise<FileInfo | { error: string }> {
    const answer = await request(`/api/jarvis/info?${new URLSearchParams({ path })}`);
    return answer.ok ? answer as unknown as FileInfo : { error: answer.text };
}

// ---- Shared state --------------------------------------------------------------------------------------------------

export const useJarvisFile = create<{
    /** Save As: the file that is there, waiting for Replace or Keep. */
    replace: string | null;
    /** Open: the file selected in the browser. */
    picked: PickedFile | null;
    /** A line for the File menu's bar after a save or an open. */
    note: string | null;
}>(() => ({ replace: null, picked: null, note: null }));

let noteTimer: ReturnType<typeof setTimeout> | undefined;

/** Shows a short line in the File menu's bar for a few seconds. */
export function fileNote(text: string | null): void {
    clearTimeout(noteTimer);
    useJarvisFile.setState({ note: text });
    if (text) {
        noteTimer = setTimeout(() => useJarvisFile.setState({ note: null }), 5000);
    }
}
