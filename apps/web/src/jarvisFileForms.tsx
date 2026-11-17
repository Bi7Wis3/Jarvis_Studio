// File > Save As, Save and Open of the studio's own file (.jarvis), as SolidWorks' Save As and Open dialogs, in the
// left panel: the app's file browser (fileBrowser.tsx) in a save mode (a file name under the list, Replace asked in the
// panel) and in an open mode with a quick filter for .jarvis files. The server writes and reads the files
// (apps/server/src/jarvisFile.ts); a picture of the view goes into the file as its thumbnail when the view gives one.

import { useEffect, useRef, useState } from 'react';
import { FileBrowser, type PickedFile } from './fileBrowser';
import { joinPath, openFolder, useFileBrowser } from './fileBrowserState';
import { loadFormats, openImportWith, quickFilters, useImport } from './importTool';
import { captureViewport } from './capture';
import {
    defaultFileName, fileNameProblem, fileNote, folderOf, isJarvisFile, JARVIS_FILTER, requestInfo, requestOpen, requestSave,
    requestSaveAs, SAVE_MODES, useJarvisFile, withExtension, type FileInfo, type SaveMode,
} from './jarvisFileState';
import { showError } from './menus';
import { refit, useStudio } from './state';
import type { Ctx, PopupApi, Result, ToolDef, Values } from './toolDefs';
import './jarvisFile.css';

/** A picture of the view for the file, or null (a save never waits long for it nor fails without it). */
function thumbnail(): Promise<string | null> {
    const explode = useStudio.getState().project?.view.explode ?? 0;
    return Promise.race([
        captureViewport(explode, { png: true }).catch(() => null),
        new Promise<null>((done) => window.setTimeout(() => done(null), 2500)),
    ]);
}

/** The browser's quick filters while a form is open, then as they were (the Import form keeps its own). */
function useQuickFilters(quick: string[]): void {
    useEffect(() => {
        const before = useFileBrowser.getState().quick;
        useFileBrowser.setState({ quick });
        return () => useFileBrowser.setState({ quick: before });
    }, []);
}

const project = () => useStudio.getState().history;

// ---- Save As -------------------------------------------------------------------------------------------------------

async function saveAs(path: string, v: Values, overwrite: boolean): Promise<Result> {
    const mode = (v.mode === 'copyAndOpen' ? 'copyAndOpen' : 'copy') satisfies SaveMode;
    const answer = await requestSaveAs({ path, mode, overwrite, description: String(v.description ?? ''), thumbnail: await thumbnail() });
    if (answer.exists) {
        useJarvisFile.setState({ replace: path });
        return { text: answer.text, isError: true };
    }
    useJarvisFile.setState({ replace: null });
    if (!answer.ok) {
        return { text: answer.text, isError: true };
    }
    fileNote(answer.text.split('\n')[0]);
    if (mode === 'copyAndOpen') {
        refit();
    }
    return { text: answer.text, isError: false };
}

/** The file OK saves to: the folder shown and the name typed. */
function savePath(v: Values): { path: string } | { problem: string } {
    const listing = useFileBrowser.getState().listing;
    const problem = fileNameProblem(String(v.name ?? ''));
    if (problem) {
        return { problem };
    }
    return listing ? { path: joinPath(listing.path, withExtension(String(v.name))) } : { problem: 'Choose a folder first.' };
}

/** The file name under the list, and where the file goes. */
function SaveName({ api }: { api: PopupApi }) {
    const listing = useFileBrowser((s) => s.listing);
    const replace = useJarvisFile((s) => s.replace);
    const input = useRef<HTMLInputElement>(null);
    const name = String(api.values.name ?? '');
    const problem = name.trim() ? fileNameProblem(name) : null;
    // The name is what Enter saves: it has the focus, its stem selected, once the form has placed its own.
    useEffect(() => {
        const timer = window.setTimeout(() => {
            const field = input.current;
            if (field) {
                field.focus();
                field.setSelectionRange(0, isJarvisFile(field.value) ? field.value.length - '.jarvis'.length : field.value.length);
            }
        }, 0);
        return () => window.clearTimeout(timer);
    }, []);
    return (
        <div className="jf-save">
            <label className="tb-field">
                <span>File name</span>
                <span className="tb-input">
                    <input
                        ref={input}
                        type="text"
                        spellCheck={false}
                        value={name}
                        aria-label="File name"
                        onChange={(event) => {
                            useJarvisFile.setState({ replace: null });
                            api.set({ name: event.target.value });
                        }}
                    />
                </span>
            </label>
            {problem ? <p className="fb-error">{problem}</p> : listing && name.trim() && !replace && (
                <p className="jf-where" title={joinPath(listing.path, withExtension(name))}>Saves {withExtension(name)} in {listing.path}</p>
            )}
        </div>
    );
}

/** Replace the existing file? Asked in the panel, under the form's answer. */
function ReplaceQuestion({ api }: { api: PopupApi }) {
    const replace = useJarvisFile((s) => s.replace);
    if (!replace) {
        return null;
    }
    const name = replace.split('/').pop();
    return (
        <div className="jf-replace" role="alertdialog" aria-label="Replace the existing file?">
            <span>Replace the existing file {name}?</span>
            <button type="button" className="danger" onClick={() => api.run(() => saveAs(replace, api.values, true))}>Replace</button>
            <button type="button" onClick={() => useJarvisFile.setState({ replace: null })}>Keep</button>
        </div>
    );
}

function SaveAsBrowser({ api, ctx }: { api: PopupApi; ctx: Ctx }) {
    const listing = useFileBrowser((s) => s.listing);
    const zone = useRef<HTMLDivElement>(null);
    useQuickFilters([JARVIS_FILTER.id]);
    useEffect(() => {
        useJarvisFile.setState({ replace: null });
        // As SolidWorks: Save As starts in the folder of the file the project goes with.
        const file = (ctx.project ?? project())?.jarvisFile;
        if (file) {
            void openFolder(folderOf(file.path));
        }
        return () => useJarvisFile.setState({ replace: null });
    }, []);
    // Another folder: the question was about the file in the one before.
    useEffect(() => {
        useJarvisFile.setState({ replace: null });
    }, [listing?.path]);
    const choose = (file: PickedFile | null) => {
        if (file) {
            useJarvisFile.setState({ replace: null });
            api.set({ name: file.name });
        }
    };
    return (
        <div ref={zone} className="jf-zone">
            <ReplaceQuestion api={api} />
            <FileBrowser
                filters={[JARVIS_FILTER]}
                onSelect={choose}
                onPick={(file) => {
                    // Double click on a file: save over it (Replace is asked first).
                    choose(file);
                    window.setTimeout(() => zone.current?.closest('form')?.requestSubmit(), 0);
                }}
                footer={<SaveName api={api} />}
            />
        </div>
    );
}

export const saveAsTool: ToolDef = {
    id: 'save-as',
    label: 'Save As',
    icon: 'save-file',
    hint: 'the project and every file it uses, in one .jarvis file',
    shortcut: 'Ctrl+Shift+S',
    panel: true,
    width: 320,
    top: (api, ctx) => <SaveAsBrowser api={api} ctx={ctx} />,
    fields: () => [
        { key: 'mode', label: 'Mode', kind: 'select', section: 'Options', options: SAVE_MODES },
        { key: 'description', label: 'Description', kind: 'text', section: 'Options' },
    ],
    defaults: (ctx) => {
        const now = ctx.project ?? project();
        return { name: defaultFileName(now), mode: 'copy', description: now?.description ?? '' };
    },
    applyLabel: 'Save',
    apply: async (v) => {
        const target = savePath(v);
        return 'problem' in target ? { text: target.problem, isError: true } : saveAs(target.path, v, false);
    },
    extra: (api) => (
        <p className="tb-note">
            {api.values.mode === 'copyAndOpen'
                ? 'The file is written, then opened as a new project; this one stays as it is.'
                : 'The file is written and this project stays open; File > Save (Ctrl+S) writes the same file again.'}
            {' '}The parts, imported files and pictures all go into the one file. The studio keeps saving its own copy
            automatically as before.
        </p>
    ),
};

/** File > Save: the file the project was last saved to or opened from, written again; Save As when it has none. */
export async function saveProject(): Promise<void> {
    if (!project()?.jarvisFile) {
        openSaveAs();
        return;
    }
    fileNote('Saving…');
    const answer = await requestSave(await thumbnail());
    if (answer.noFile) {
        fileNote(null);
        openSaveAs();
    } else if (!answer.ok) {
        fileNote('Save failed');
        showError(answer.text);
    } else {
        fileNote(answer.text.split('\n')[0]);
        if (answer.text.includes('\n')) {
            showError(answer.text.split('\n').slice(1).join(' '));
        }
    }
}

// ---- Open ----------------------------------------------------------------------------------------------------------

/** Whether the Import form reads this file (true while the formats are not known yet: Import says so if not). */
function importable(name: string): boolean {
    const formats = useImport.getState().formats;
    const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
    return !formats || formats.some((f) => f.extensions.includes(extension));
}

/** What the selected file is: a .jarvis file's name, description, date and part count, or what OK does with it. */
function OpenInfo() {
    const picked = useJarvisFile((s) => s.picked);
    useImport((s) => s.formats);
    const [info, setInfo] = useState<{ path: string; info: FileInfo | { error: string } } | null>(null);
    useEffect(() => {
        if (!picked || !isJarvisFile(picked.name)) {
            return;
        }
        let live = true;
        void requestInfo(picked.path).then((answer) => live && setInfo({ path: picked.path, info: answer }));
        return () => {
            live = false;
        };
    }, [picked?.path, picked?.modified]);
    if (!picked) {
        return <p className="jf-where">Pick a .jarvis file, or a model file to import.</p>;
    }
    if (!isJarvisFile(picked.name)) {
        return importable(picked.name)
            ? <p className="jf-where">{picked.name} is a model file: OK opens it in the Import form.</p>
            : <p className="fb-error">{picked.name}: the studio cannot open this type of file.</p>;
    }
    const shown = info?.path === picked.path ? info.info : null;
    if (!shown) {
        return <p className="jf-where">Reading {picked.name}…</p>;
    }
    if ('error' in shown) {
        return <p className="fb-error">{shown.error}</p>;
    }
    const saved = shown.saved ? new Date(shown.saved) : null;
    return (
        <dl className="jf-info">
            <dt>Project</dt>
            <dd>{shown.name || picked.name}</dd>
            {shown.description && <><dt>Description</dt><dd className="jf-description">{shown.description}</dd></>}
            <dt>Parts</dt>
            <dd>{shown.parts}</dd>
            {saved && !Number.isNaN(saved.getTime()) && <><dt>Saved</dt><dd>{saved.toLocaleString()}{shown.app ? ` · studio ${shown.app}` : ''}</dd></>}
        </dl>
    );
}

function OpenBrowser() {
    const formats = useImport((s) => s.formats);
    const zone = useRef<HTMLDivElement>(null);
    useQuickFilters([JARVIS_FILTER.id]);
    useEffect(() => {
        loadFormats();
        useJarvisFile.setState({ picked: null });
        return () => useJarvisFile.setState({ picked: null });
    }, []);
    return (
        <div ref={zone} className="jf-zone">
            <FileBrowser
                filters={[JARVIS_FILTER, ...quickFilters(formats)]}
                onSelect={(file) => useJarvisFile.setState({ picked: file })}
                onPick={(file) => {
                    // Double click or Enter on a file: open it (as Open in SolidWorks).
                    useJarvisFile.setState({ picked: file });
                    window.setTimeout(() => zone.current?.closest('form')?.requestSubmit(), 0);
                }}
                footer={<OpenInfo />}
            />
        </div>
    );
}

async function openPicked(): Promise<Result> {
    const picked = useJarvisFile.getState().picked;
    if (!picked) {
        return { text: 'Pick a .jarvis file to open first.', isError: true };
    }
    if (!isJarvisFile(picked.name)) {
        if (!importable(picked.name)) {
            return { text: `${picked.name}: the studio cannot open this type of file.`, isError: true };
        }
        // Other model files go to the Import form, picked there.
        openImportWith(picked);
        return { text: `Opening ${picked.name} in the Import form.`, isError: false };
    }
    const answer = await requestOpen(picked.path);
    if (!answer.ok) {
        return { text: answer.text, isError: true };
    }
    fileNote(answer.text.split('\n')[0]);
    if (answer.text.includes('\n')) {
        showError(answer.text.split('\n').slice(1).join(' '));
    }
    refit();
    return { text: answer.text, isError: false };
}

export const openFileTool: ToolDef = {
    id: 'open-file',
    label: 'Open',
    icon: 'open-file',
    hint: 'a .jarvis file as a project; model files go to Import',
    shortcut: 'Ctrl+O',
    panel: true,
    width: 320,
    top: () => <OpenBrowser />,
    applyLabel: 'Open',
    apply: openPicked,
    extra: () => (
        <p className="tb-note">
            A .jarvis file opens as a new project in the studio, its imported files and pictures with it. A project that came
            from the same file, unchanged since, is switched to instead of copied again.
        </p>
    ),
};

const openForm = (id: string) => window.setTimeout(() => window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: id })), 0);

/** Opens the Save As form in the left panel (File > Save As). */
export const openSaveAs = (): void => {
    openForm(saveAsTool.id);
};

/** Opens the Open form in the left panel (File > Open). */
export const openFileForm = (): void => {
    openForm(openFileTool.id);
};
