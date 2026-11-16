// File > Import: a STEP or STL file into a new part (as SolidWorks File > Open) or into the open part (Insert >
// Features > Imported), with the import options of the SolidWorks help that the kernel can honour. The file is sent to
// the local server (POST /api/import, see apps/server/src/import), which reads it in the CAD worker. Editing an Imported
// step replaces it with another file, or reads its own file again with changed options.

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { create } from 'zustand';
import type { Feature } from '@jarvis/core';
import { DEFAULT_IMPORT_OPTIONS, IMPORT_UNIT_NAMES, IMPORT_UNITS, type ImportOptions } from '@jarvis/core/imported';
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
 * The picked file (not a form value: values are text), the formats the server reads, the upload's progress, and the
 * last import's report (kept here: opening the new part redraws the form).
 */
export const useImport = create<{ file: File | null; formats: Format[] | null; progress: Progress; report: string | null }>(() => ({
    file: null, formats: null, progress: { phase: 'idle', loaded: 0, total: 0 }, report: null,
}));

let asked = false;
/** When the report was made. */
let reportAt = 0;

function loadFormats(): void {
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

const megabytes = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`);

/** The file box: choose or drop a file; shows the file and the upload's progress. */
function ImportFile({ api, ctx }: { api: PopupApi; ctx: Ctx }) {
    const file = useImport((s) => s.file);
    const formats = useImport((s) => s.formats);
    const progress = useImport((s) => s.progress);
    const report = useImport((s) => s.report);
    const input = useRef<HTMLInputElement>(null);
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
        return () => useImport.setState({ file: null, progress: { phase: 'idle', loaded: 0, total: 0 } });
    }, []);
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
        useImport.setState({ file: picked, report: null });
        api.set({ file: picked.name, mesh: format ? format.mesh : extension(picked.name) === 'stl' });
    };
    const accept = (formats ?? []).flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');
    const busy = progress.phase !== 'idle';
    return (
        <div
            className={`pic-drop imp-drop ${dragging ? 'dragging' : ''}`}
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
            {file ? (
                <p className="imp-file"><b>{file.name}</b> · {megabytes(file.size)}{formatOf(file.name) ? ` · ${formatOf(file.name)!.label}` : ''}</p>
            ) : step ? (
                <p>{step.file.name}: OK reads it again with these options, or choose a file to replace it with.</p>
            ) : (
                <p>Drop a file here, or choose one.</p>
            )}
            <button type="button" onClick={() => input.current?.click()} disabled={busy}>{file ? 'Choose another file…' : 'Choose a file…'}</button>
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
            {formats && <p className="imp-types">{formats.map((f) => f.label).join(' · ')}</p>}
            {refused && <p className="imp-refused">{refused}</p>}
            {busy && <ImportProgress progress={progress} />}
            {/* Only in a form redrawn after its import (the form's own answer is gone with the old one). */}
            {report && !busy && reportAt < mounted && <pre className="tb-result imp-report">{report}</pre>}
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
    const file = useImport.getState().file;
    const step = editedStep(ctx);
    if (!file && !step) {
        return { text: 'Choose a file to import first.', isError: true };
    }
    if (v.customTolerance && !(Number(v.tolerance) > 0)) {
        return { text: 'The curve tolerance must be a number greater than 0.', isError: true };
    }
    const target = step ? ctx.edit!.partId : String(v.target ?? 'new');
    const answer = await upload(file, {
        name: file?.name ?? step!.file.name, options: optionsOf(v), target, ...(step ? { replace: step.id } : {}),
    });
    if (answer.error || !answer.text) {
        return { text: answer.error ?? 'The import failed.', isError: true };
    }
    // Done with this file: OK again does not import it twice. The report is kept for a form redrawn as the part opens.
    useImport.setState({ file: null, report: answer.text });
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
    // Until a mesh file is chosen the form shows the options of exact (STEP) files.
    const isStep = (v: Values) => !v.mesh;
    return [
        ...(step ? [] : [{
            key: 'target', label: 'Part', kind: 'select' as const, section: 'Import into', options: opts(['new', 'A new part'], ...open),
        }]),
        { key: 'up', label: 'Up axis of the file', kind: 'select', section: 'Orientation',
            options: opts(['z', 'Z up (turned to Y up)'], ['y', 'Y up (kept as it is)']) },
        { key: 'meshAs', label: 'Import as', kind: 'select', section: 'Mesh', show: (v) => !!v.mesh,
            options: opts(['graphics', 'Graphics body'], ['solid', 'Solid body']) },
        { key: 'groupFacets', label: 'Group facets into faces', kind: 'check', section: 'Mesh', show: (v) => !!v.mesh && v.meshAs === 'solid' },
        { key: 'unit', label: 'Unit', kind: 'select', section: 'Mesh', show: (v) => !!v.mesh,
            options: (Object.keys(IMPORT_UNITS) as (keyof typeof IMPORT_UNITS)[]).map((u) => ({ value: u, label: IMPORT_UNIT_NAMES[u] })) },
        { key: 'knit', label: 'Knit surfaces into solids', kind: 'check', section: 'Solid and surface entities', show: isStep },
        { key: 'bodiesAsParts', label: 'Import multiple bodies as parts', kind: 'check', section: 'Solid and surface entities',
            show: (v) => !step && v.target === 'new' && isStep(v) },
        { key: 'repair', label: 'Perform full entity check and repair errors', kind: 'check', section: 'Solid and surface entities' },
        { key: 'customTolerance', label: 'Customize curve tolerance', kind: 'check', section: 'Solid and surface entities', show: isStep },
        { key: 'tolerance', label: 'Tolerance', kind: 'number', unit: 'mm', step: 0.001, min: 0, section: 'Solid and surface entities',
            show: (v) => isStep(v) && !!v.customTolerance },
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
