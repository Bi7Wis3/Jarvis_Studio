// File > Import: a STEP or STL file into a new part (as SolidWorks File > Open) or into the open part (Insert >
// Features > Imported), with the import options of the SolidWorks help that the kernel can honour. The file is sent to
// the local server (POST /api/import, see apps/server/src/import), which reads it in the CAD worker. Editing an Imported
// step replaces it with another file, or reads its own file again with changed options.

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { create } from 'zustand';
import type { Feature } from '@jarvis/core';
import { DEFAULT_IMPORT_OPTIONS, IMPORT_UNIT_NAMES, IMPORT_UNITS, type ImportOptions } from '@jarvis/core/imported';
import { FileBrowser, type PickedFile, type QuickFilter } from './fileBrowser';
import { loadPlaces, useFileBrowser } from './fileBrowserState';
import { refit, setWorkspace } from './state';
import type { Ctx, Field, PopupApi, Result, ToolDef, Values } from './toolDefs';
import './importTool.css';

interface Format {
    format: string;
    extensions: string[];
    label: string;
    mesh: boolean;
}

interface Progress {
    phase: 'idle' | 'upload' | 'read';
    loaded: number;
    total: number;
}

/**
 * The file to import (not a form value: values are text): `picked` in the file browser (read by the server from its
 * path), or `file` dropped or chosen in the system dialog (sent). The formats the server reads, the upload's progress,
 * and the last import's report (kept here: opening the new part redraws the form).
 */
export const useImport = create<{
    file: File | null; picked: PickedFile | null; formats: Format[] | null; progress: Progress; report: string | null;
}>(() => ({
    file: null, picked: null, formats: null, progress: { phase: 'idle', loaded: 0, total: 0 }, report: null,
}));

let asked = false;
/** When the report was made. */
let reportAt = 0;

export function loadFormats(): void {
    if (asked) {
        return;
    }
    asked = true;
    void fetch('/api/import/formats')
        .then((r) => (r.ok ? r.json() as Promise<{ formats: Format[] }> : null))
        .then((answer) => useImport.setState({ formats: answer?.formats ?? null }))
        .catch(() => {
            asked = false;
        });
}

const extension = (name: string): string => /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';

function formatOf(name: string): Format | null {
    const formats = useImport.getState().formats ?? [];
    return formats.find((f) => f.extensions.includes(extension(name))) ?? null;
}

const editedStep = (ctx: Ctx): Extract<Feature, { op: 'import' }> | null => (ctx.edit?.feature?.op === 'import' ? ctx.edit.feature : null);

/** Quick filter buttons in the file browser, one per format the server reads, in the SolidWorks dialog's order. */
const QUICK_ORDER = ['step', 'iges', 'stl', 'sldprt', 'swhistory'];
const QUICK_LABELS: Record<string, string> = { step: 'STEP', iges: 'IGES', stl: 'STL', sldprt: 'SolidWorks', swhistory: 'SolidWorks history' };

export function quickFilters(formats: Format[] | null): QuickFilter[] {
    const rank = (f: Format) => (QUICK_ORDER.includes(f.format) ? QUICK_ORDER.indexOf(f.format) : QUICK_ORDER.length);
    return [...formats ?? []].sort((a, b) => rank(a) - rank(b))
        .map((f) => ({ id: f.format, label: QUICK_LABELS[f.format] ?? f.format.toUpperCase(), title: f.label, formats: [f.format] }));
}

const megabytes = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`);

/**
 * The file box: a file picked in the app's own file browser (fileBrowser.tsx) is read by the server from the disk by
 * its path, nothing sent; one dropped on the form or chosen in the system dialog is sent. Shows the upload's progress.
 */
function ImportFile({ api, ctx }: { api: PopupApi; ctx: Ctx }) {
    const file = useImport((s) => s.file);
    const picked = useImport((s) => s.picked);
    const formats = useImport((s) => s.formats);
    const progress = useImport((s) => s.progress);
    const report = useImport((s) => s.report);
    const input = useRef<HTMLInputElement>(null);
    const zone = useRef<HTMLDivElement>(null);
    const filters = useMemo(() => quickFilters(formats), [formats]);
    const [dragging, setDragging] = useState(false);
    const [refused, setRefused] = useState<string | null>(null);
    const [mounted] = useState(() => Date.now());
    const step = editedStep(ctx);
    useEffect(loadFormats, []);
    // The picked file belongs to this form: a new form starts without one. A form redrawn as the imported part opens
    // keeps the report it just got; one opened later starts without it.
    useEffect(() => {
        if (Date.now() - reportAt > 10_000) {
            useImport.setState({ report: null });
        }
        return () => useImport.setState({ file: null, picked: null, progress: { phase: 'idle', loaded: 0, total: 0 } });
    }, []);
    // The file selected in the browser is the one OK imports.
    const select = (chosen: PickedFile | null): boolean => {
        if (!chosen) {
            setRefused(null);
            if (useImport.getState().picked) {
                useImport.setState({ picked: null });
                api.set({ file: useImport.getState().file?.name ?? '' });
            }
            return false;
        }
        const format = formatOf(chosen.name);
        if (formats && !format) {
            setRefused(/\.jarvis$/i.test(chosen.name) ? `${chosen.name} is a Jarvis Studio project: open it with File > Open (Ctrl+O).`
                : `${chosen.name}: the studio cannot import this type of file.`);
            useImport.setState({ picked: null });
            return false;
        }
        setRefused(null);
        useImport.setState({ picked: chosen, file: null, report: null });
        api.set({ file: chosen.name, mesh: format ? format.mesh : extension(chosen.name) === 'stl' });
        return true;
    };
    // A model file picked in File > Open comes here selected, ready for OK.
    useEffect(() => {
        const handed = pending;
        if (handed) {
            pending = null;
            select(handed);
            useFileBrowser.setState({ selected: handed.name });
        }
    }, []);
    // Double click or Enter on a file: import it at once, with the options as they are (as Open in SolidWorks).
    const pickNow = (chosen: PickedFile) => {
        if (select(chosen)) {
            window.setTimeout(() => zone.current?.closest('form')?.requestSubmit(), 0);
        }
    };
    const take = (picked: File | undefined) => {
        if (!picked) {
            return;
        }
        const format = formatOf(picked.name);
        if (formats && !format) {
            setRefused(`${picked.name}: the studio cannot import this type of file.`);
            return;
        }
        setRefused(null);
        useImport.setState({ file: picked, picked: null, report: null });
        useFileBrowser.setState({ selected: null });
        api.set({ file: picked.name, mesh: format ? format.mesh : extension(picked.name) === 'stl' });
    };
    const accept = (formats ?? []).flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');
    const busy = progress.phase !== 'idle';
    return (
        <div
            ref={zone}
            className={`imp-zone ${dragging ? 'dragging' : ''}`}
            onDragOver={(event: DragEvent<HTMLElement>) => {
                if (event.dataTransfer.types.includes('Files')) {
                    event.preventDefault();
                    setDragging(true);
                }
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event: DragEvent<HTMLElement>) => {
                setDragging(false);
                if (event.dataTransfer.files.length) {
                    event.preventDefault();
                    take(event.dataTransfer.files[0]);
                }
            }}
        >
            {step && !file && !picked && <p className="imp-note">{step.file.name}: OK reads it again with these options, or pick a file to replace it with.</p>}
            {refused && <p className="imp-refused">{refused}</p>}
            {busy && <ImportProgress progress={progress} />}
            {/* Only in a form redrawn after its import (the form's own answer is gone with the old one). */}
            {report && !busy && reportAt < mounted && <pre className="tb-result imp-report">{report}</pre>}
            <FileBrowser
                filters={filters}
                onSelect={select}
                onPick={pickNow}
                disabled={busy}
                footer={(
                    <div className="imp-other">
                        {file && <p className="imp-file">To import: <b>{file.name}</b> · {megabytes(file.size)}{formatOf(file.name) ? ` · ${formatOf(file.name)!.label}` : ''}</p>}
                        <p>
                            {dragging ? 'Drop the file to import it.' : 'Or drop a file on this form, or use the '}
                            {!dragging && <button type="button" className="imp-link" onClick={() => input.current?.click()} disabled={busy}>system dialog…</button>}
                        </p>
                    </div>
                )}
            />
            <input
                ref={input}
                type="file"
                accept={accept || undefined}
                hidden
                onChange={(event) => {
                    take(event.target.files?.[0]);
                    event.target.value = '';
                }}
            />
        </div>
    );
}

function ImportProgress({ progress }: { progress: Progress }) {
    const share = progress.total ? progress.loaded / progress.total : 0;
    return (
        <div className="imp-progress" role="status">
            <span className="imp-bar"><span style={{ width: progress.phase === 'read' ? '100%' : `${Math.round(share * 100)}%` }} className={progress.phase === 'read' ? 'reading' : ''} /></span>
            <span>{progress.phase === 'upload' ? `Sending ${megabytes(progress.loaded)} of ${megabytes(progress.total)}` : 'Reading the file in the CAD kernel…'}</span>
        </div>
    );
}

interface Answer {
    text?: string;
    warnings?: string[];
    parts?: string[];
    steps?: string[];
    error?: string;
}

/** Sends the file (or nothing, to read a step's own file again) with its name and options; reports the upload's progress. */
function upload(file: File | null, meta: Record<string, unknown>): Promise<Answer> {
    const progress = (p: Progress) => useImport.setState({ progress: p });
    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/import');
        xhr.setRequestHeader('content-type', 'application/octet-stream');
        xhr.setRequestHeader('x-import', encodeURIComponent(JSON.stringify(meta)));
        const total = file?.size ?? 0;
        progress({ phase: total ? 'upload' : 'read', loaded: 0, total });
        xhr.upload.onprogress = (event) => progress({ phase: 'upload', loaded: event.loaded, total: event.total || total });
        xhr.upload.onload = () => progress({ phase: 'read', loaded: total, total });
        const done = (answer: Answer) => {
            progress({ phase: 'idle', loaded: 0, total: 0 });
            resolve(answer);
        };
        xhr.onload = () => {
            try {
                done(JSON.parse(xhr.responseText) as Answer);
            } catch {
                done({ error: `The server answered ${xhr.status} ${xhr.statusText}.` });
            }
        };
        xhr.onerror = () => done({ error: 'Could not reach the server.' });
        xhr.send(file ?? new Blob([]));
    });
}

function optionsOf(v: Values): ImportOptions {
    const tolerance = Number(v.tolerance);
    return {
        up: v.up === 'y' ? 'y' : 'z',
        ...(v.mesh
            ? { meshAs: v.meshAs === 'solid' ? 'solid' : 'graphics', unit: (v.unit as ImportOptions['unit']) ?? 'mm', groupFacets: !!v.groupFacets }
            : { knit: !!v.knit }),
        repair: !!v.repair,
        ...(v.customTolerance && tolerance > 0 ? { tolerance } : {}),
        ...(v.target === 'new' && v.bodiesAsParts ? { bodiesAsParts: true } : {}),
    };
}

async function runImport(v: Values, ctx: Ctx): Promise<Result> {
    const { file, picked } = useImport.getState();
    const step = editedStep(ctx);
    if (!file && !picked && !step) {
        return { text: 'Pick a file to import first.', isError: true };
    }
    if (v.customTolerance && !(Number(v.tolerance) > 0)) {
        return { text: 'The curve tolerance must be a number greater than 0.', isError: true };
    }
    const target = step ? ctx.edit!.partId : String(v.target ?? 'new');
    // A file picked in the browser is read by the server from its path: nothing is sent.
    const answer = await upload(picked ? null : file, {
        name: picked?.name ?? file?.name ?? step!.file.name, ...(picked ? { path: picked.path } : {}), options: optionsOf(v), target,
        ...(step ? { replace: step.id } : {}),
    });
    if (answer.error || !answer.text) {
        return { text: answer.error ?? 'The import failed.', isError: true };
    }
    // Done with this file: OK again does not import it twice. The report is kept for a form redrawn as the part opens.
    useImport.setState({ file: null, picked: null, report: answer.text });
    if (picked) {
        // Its folder is now the first of the recent ones.
        useFileBrowser.setState({ selected: null });
        void loadPlaces();
    }
    reportAt = Date.now();
    if (target === 'new' && answer.parts?.[0]) {
        // As File > Open in SolidWorks: the new part opens, ready for features.
        setWorkspace('part', answer.parts[0], 'isolated');
        refit();
    }
    return { text: answer.text, isError: false };
}

const opts = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

function fields(ctx: Ctx): Field[] {
    const step = editedStep(ctx);
    const open: [string, string][] = ctx.part && !ctx.part.instanceOf ? [[ctx.part.id, `${ctx.part.name} (adds bodies)`]] : [];
    // Until a mesh file is chosen the form shows the options of exact files (STEP and IGES have the same ones).
    const isStep = (v: Values) => !v.mesh;
    // A SolidWorks part holds exact solids, always Y up: knitting, curve tolerance, repair and the up axis do not apply.
    const solidWorks = (v: Values) => (v.file ? /\.(sldprt|jarvis-sw\.json)$/i.test(String(v.file)) : step?.file.format === 'sldprt');
    // A SolidWorks history (.jarvis-sw.json, tools/solidworks) is rebuilt as new parts with their own features.
    const history = (v: Values) => /\.jarvis-sw\.json$/i.test(String(v.file ?? ''));
    const exact = (v: Values) => isStep(v) && !solidWorks(v);
    return [
        ...(step ? [] : [{
            key: 'target', label: 'Part', kind: 'select' as const, section: 'Import into', options: opts(['new', 'A new part'], ...open),
            show: (v: Values) => !history(v),
        }]),
        { key: 'up', label: 'Up axis of the file', kind: 'select', section: 'Orientation', show: (v) => !solidWorks(v),
            options: opts(['z', 'Z up (turned to Y up)'], ['y', 'Y up (kept as it is)']) },
        { key: 'meshAs', label: 'Import as', kind: 'select', section: 'Mesh', show: (v) => !!v.mesh,
            options: opts(['graphics', 'Graphics body'], ['solid', 'Solid body']) },
        { key: 'groupFacets', label: 'Group facets into faces', kind: 'check', section: 'Mesh', show: (v) => !!v.mesh && v.meshAs === 'solid' },
        { key: 'unit', label: 'Unit', kind: 'select', section: 'Mesh', show: (v) => !!v.mesh,
            options: (Object.keys(IMPORT_UNITS) as (keyof typeof IMPORT_UNITS)[]).map((u) => ({ value: u, label: IMPORT_UNIT_NAMES[u] })) },
        { key: 'knit', label: 'Knit surfaces into solids', kind: 'check', section: 'Solid and surface entities', show: exact },
        { key: 'bodiesAsParts', label: 'Import multiple bodies as parts', kind: 'check', section: 'Solid and surface entities',
            show: (v) => !step && v.target === 'new' && isStep(v) && !history(v) },
        { key: 'repair', label: 'Perform full entity check and repair errors', kind: 'check', section: 'Solid and surface entities',
            show: (v) => !solidWorks(v) },
        { key: 'customTolerance', label: 'Customize curve tolerance', kind: 'check', section: 'Solid and surface entities', show: exact },
        { key: 'tolerance', label: 'Tolerance', kind: 'number', unit: 'mm', step: 0.001, min: 0, section: 'Solid and surface entities',
            show: (v) => exact(v) && !!v.customTolerance },
    ];
}

function defaults(ctx: Ctx): Values {
    const step = editedStep(ctx);
    const o = { ...DEFAULT_IMPORT_OPTIONS, ...step?.options };
    return {
        file: '', mesh: !!step && (step.file.format === 'stl' || !!step.options?.meshAs), target: 'new',
        up: o.up, meshAs: o.meshAs, groupFacets: o.groupFacets, unit: o.unit, knit: o.knit, bodiesAsParts: o.bodiesAsParts,
        repair: o.repair, customTolerance: !!step?.options?.tolerance, tolerance: String(step?.options?.tolerance ?? 0.001),
    };
}

export const importTool: ToolDef = {
    id: 'import',
    label: 'Import',
    icon: 'import',
    hint: 'a STEP or STL file, into a new part or the open one',
    panel: true,
    keepOpen: true,
    width: 320,
    top: (api, ctx) => <ImportFile api={api} ctx={ctx} />,
    fields,
    defaults,
    applyLabel: 'Import',
    apply: runImport,
    extra: () => (
        <p className="tb-note">
            STEP files keep exact solids (bodies come in placed as in the file; names, colours and the assembly structure
            are not read). An STL is a mesh: a graphics body is shown and exported but cannot take features; as a solid body
            each facet becomes a face, for closed meshes only. Later features work on the imported solids.
        </p>
    ),
};

/** Opens the Import form in the left panel (File > Import). */
export function openImport(): void {
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: importTool.id })), 0);
}

/** A file picked in File > Open that is imported rather than opened, for the Import form to start with. */
let pending: PickedFile | null = null;

/** Opens the Import form with a file already picked (a model file chosen in File > Open). */
export function openImportWith(file: PickedFile): void {
    pending = file;
    openImport();
}
