import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { DEFAULT_PRINT, type PrintSettings } from '@jarvis/core';
import { InlineInput, tool, typingInField, useDismiss } from './menus';
import { createProject, deleteProject, openProject, renameProject, saveProjectAs, useStudio } from './state';
import { confirmDeletes, openOptions } from './options';
import { OptionsButton } from './OptionsPage';
import { openImport } from './importTool';
import './browser.css';

type View = 'menu' | 'open' | 'new' | 'saveAs' | 'print';

/** File menu and the project name (click to rename), top left. */
export function FileMenu() {
    const name = useStudio((s) => s.history?.name ?? s.projects.find((p) => p.slug === s.current)?.name ?? 'Jarvis Studio');
    const error = useStudio((s) => s.error);
    const [view, setView] = useState<View | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [renameError, setRenameError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const pendingRename = useRef<{ name: string; at: number } | null>(null);
    const noteTimer = useRef<number | undefined>(undefined);
    const box = useRef<HTMLDivElement>(null);

    const close = useCallback(() => setView(null), []);
    useDismiss(box, close, view !== null);

    const flash = (text: string) => {
        window.clearTimeout(noteTimer.current);
        setNote(text);
        noteTimer.current = window.setTimeout(() => setNote(null), 4000);
    };

    // A rename the server refused comes back as an error: reopen the field with the reason.
    useEffect(() => {
        const pending = pendingRename.current;
        if (error && pending && Date.now() - pending.at < 5000) {
            pendingRename.current = null;
            setRenameError(error);
            setRenaming(pending.name);
        }
    }, [error]);

    useEffect(() => {
        pendingRename.current = null;
    }, [name]);

    const rename = (next: string) => {
        setRenaming(null);
        setRenameError(null);
        pendingRename.current = { name: next, at: Date.now() };
        renameProject(next);
    };

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (!(event.ctrlKey || event.metaKey) || event.altKey || typingInField(event.target)) {
                return;
            }
            const key = event.key.toLowerCase();
            const next: View | null = key === 'o' && !event.shiftKey ? 'open'
                : key === 'n' && !event.shiftKey ? 'new'
                    : key === 's' && event.shiftKey ? 'saveAs' : null;
            if (next) {
                event.preventDefault();
                setView(next);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const run = async (label: string, toolName: string, args: Record<string, unknown> = {}) => {
        close();
        flash(`${label}…`);
        const result = await tool(toolName, args);
        flash(result.isError ? `${label} failed` : result.text.split('\n')[0].slice(0, 80));
    };

    return (
        <div className="fm" ref={box}>
            <div className="fm-bar">
                <button
                    type="button"
                    className={`fm-file ${view ? 'open' : ''}`}
                    onClick={() => setView(view ? null : 'menu')}
                    aria-haspopup="menu"
                    aria-expanded={view !== null}
                >
                    File <span className="caret">▾</span>
                </button>
                <OptionsButton />
                {renaming !== null ? (
                    <InlineInput
                        key={renaming}
                        className="fm-name-input"
                        style={{ width: `${Math.min(40, Math.max(12, renaming.length + 3))}ch` }}
                        value={renaming}
                        label="Project name"
                        onCommit={rename}
                        onCancel={() => {
                            setRenaming(null);
                            setRenameError(null);
                        }}
                    />
                ) : (
                    <button type="button" className="fm-name" onClick={() => setRenaming(name)} title="Rename project">
                        {name}
                    </button>
                )}
                <span className="fm-note">{note ?? 'Saved automatically'}</span>
            </div>
            {renameError && renaming !== null && <div className="fm-error">{renameError}</div>}
            {view && (
                <div className="fm-pop" role={view === 'menu' ? 'menu' : 'dialog'}>
                    {view === 'menu' && (
                        <MainMenu
                            onView={setView}
                            onRename={() => {
                                close();
                                setRenaming(name);
                            }}
                            onRun={run}
                            onOptions={() => {
                                close();
                                openOptions();
                            }}
                            onImport={() => {
                                close();
                                openImport();
                            }}
                        />
                    )}
                    {view === 'open' && <OpenList onBack={() => setView('menu')} onDone={close} />}
                    {view === 'new' && (
                        <NameForm
                            title="New project"
                            initial=""
                            action="Create"
                            onBack={() => setView('menu')}
                            onSubmit={(value) => {
                                close();
                                createProject(value);
                            }}
                        />
                    )}
                    {view === 'saveAs' && (
                        <NameForm
                            title="Save as copy"
                            initial={`${name} copy`}
                            action="Save copy"
                            onBack={() => setView('menu')}
                            onSubmit={(value) => {
                                close();
                                saveProjectAs(value);
                                flash('Saved a copy and opened it');
                            }}
                        />
                    )}
                    {view === 'print' && (
                        <PrintForm
                            onBack={() => setView('menu')}
                            onSaved={() => {
                                close();
                                flash('Print settings saved');
                            }}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

function MainMenu(props: {
    onView: (view: View) => void;
    onRename: () => void;
    onRun: (label: string, tool: string, args?: Record<string, unknown>) => void;
    onOptions: () => void;
    onImport: () => void;
}) {
    const { onView, onRename, onRun, onOptions, onImport } = props;
    const item = (label: string, onClick: () => void, hint?: string) => (
        <button type="button" role="menuitem" onClick={onClick}>
            <span>{label}</span>
            {hint && <span className="hint">{hint}</span>}
        </button>
    );
    return (
        <div className="fm-menu">
            {item('New project…', () => onView('new'), 'Ctrl+N')}
            {item('Open…', () => onView('open'), 'Ctrl+O')}
            {item('Rename…', onRename)}
            {item('Save as copy…', () => onView('saveAs'), 'Ctrl+Shift+S')}
            <div className="ctx-sep" role="separator" />
            {item('Import…', onImport)}
            {item('Export STL (printed parts)', () => onRun('Exporting STL', 'export_stl'))}
            {item('Export STEP', () => onRun('Exporting STEP', 'export_step'))}
            {item('Export history for FreeCAD', () => onRun('Exporting history for FreeCAD', 'export_freecad'))}
            <div className="ctx-sep" role="separator" />
            {item('Print settings…', () => onView('print'))}
            {item('Options…', onOptions)}
            <div className="ctx-sep" role="separator" />
            {item('Undo', () => onRun('Undo', 'undo'))}
            {item('Redo', () => onRun('Redo', 'redo'))}
        </div>
    );
}

function PopHead({ title, onBack }: { title: string; onBack: () => void }) {
    return (
        <div className="fm-pop-head">
            <button type="button" onClick={onBack} aria-label="Back to the File menu" title="Back">‹</button>
            <span>{title}</span>
        </div>
    );
}

function OpenList({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
    const projects = useStudio((s) => s.projects);
    const current = useStudio((s) => s.current);
    const [confirming, setConfirming] = useState<string | null>(null);
    return (
        <div className="fm-open">
            <PopHead title="Open project" onBack={onBack} />
            {projects.length === 0 && <p className="fm-empty">No saved projects.</p>}
            <ul>
                {projects.map((entry) => (confirming === entry.slug ? (
                    <li key={entry.slug} className="br-row confirm">
                        <span className="br-confirm-text">Delete {entry.name}?</span>
                        <button
                            type="button"
                            className="danger"
                            autoFocus
                            onClick={() => {
                                setConfirming(null);
                                deleteProject(entry.slug);
                            }}
                        >
                            Delete
                        </button>
                        <button type="button" onClick={() => setConfirming(null)}>Keep</button>
                    </li>
                ) : (
                    <li key={entry.slug} className={`fm-project ${entry.slug === current ? 'current' : ''}`}>
                        <button
                            type="button"
                            className="fm-project-name"
                            onClick={() => {
                                if (entry.slug !== current) {
                                    openProject(entry.slug);
                                }
                                onDone();
                            }}
                        >
                            <span className="dot" />
                            <span className="fm-project-label">{entry.name}</span>
                            {entry.slug === current && <span className="hint">open</span>}
                        </button>
                        <button
                            type="button"
                            className="fm-delete"
                            onClick={() => (confirmDeletes() ? setConfirming(entry.slug) : deleteProject(entry.slug))}
                            title={`Delete ${entry.name}`}
                            aria-label={`Delete ${entry.name}`}
                        >
                            ×
                        </button>
                    </li>
                )))}
            </ul>
            <p className="fm-foot">Deleted projects go to the trash folder.</p>
        </div>
    );
}

function NameForm(props: { title: string; initial: string; action: string; onBack: () => void; onSubmit: (name: string) => void }) {
    const { title, initial, action, onBack, onSubmit } = props;
    const [value, setValue] = useState(initial);
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (value.trim()) {
            onSubmit(value.trim());
        }
    };
    return (
        <form className="fm-form" onSubmit={submit}>
            <PopHead title={title} onBack={onBack} />
            <input
                autoFocus
                onFocus={(event) => event.target.select()}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Project name"
                aria-label="Project name"
                maxLength={80}
            />
            <div className="fm-buttons">
                <button type="button" onClick={onBack}>Cancel</button>
                <button type="submit" className="primary" disabled={!value.trim()}>{action}</button>
            </div>
        </form>
    );
}

function PrintForm({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
    const print = useStudio((s) => s.history?.print);
    const [form, setForm] = useState<PrintSettings>(() => ({ ...DEFAULT_PRINT, ...print }));
    const [busy, setBusy] = useState(false);
    const num = (value: string, fallback: number) => (Number.isFinite(parseFloat(value)) ? parseFloat(value) : fallback);
    const field = (label: string, value: number, onChange: (v: number) => void, unit = 'mm') => (
        <label className="fm-field">
            <span>{label}</span>
            <span className="fm-input">
                <input type="number" step="any" min="0" value={value} onChange={(e) => onChange(num(e.target.value, value))} />
                <span className="unit">{unit}</span>
            </span>
        </label>
    );
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        const result = await tool('print_settings', { ...form });
        setBusy(false);
        if (!result.isError) {
            onSaved();
        }
    };
    const bed = (i: number) => (v: number) => {
        const next = [...form.bed] as PrintSettings['bed'];
        next[i] = v;
        setForm({ ...form, bed: next });
    };
    return (
        <form className="fm-form" onSubmit={submit}>
            <PopHead title="Print settings" onBack={onBack} />
            <div className="fm-field column">
                <span>Bed size (mm)</span>
                <span className="fm-vec">
                    {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                        <label key={axis} className="fm-input">
                            <span className="unit">{axis}</span>
                            <input
                                type="number"
                                min="1"
                                step="any"
                                value={form.bed[i]}
                                onChange={(e) => bed(i)(num(e.target.value, form.bed[i]))}
                                aria-label={`Bed ${axis}`}
                            />
                        </label>
                    ))}
                </span>
            </div>
            {field('Nozzle', form.nozzle, (nozzle) => setForm({ ...form, nozzle }))}
            {field('Layer height', form.layerHeight, (layerHeight) => setForm({ ...form, layerHeight }))}
            {field('Hole tolerance', form.holeTolerance, (holeTolerance) => setForm({ ...form, holeTolerance }))}
            <p className="fm-foot">Hole tolerance is added to printed hole diameters so hardware fits.</p>
            <div className="fm-buttons">
                <button type="button" onClick={() => setForm({ ...DEFAULT_PRINT })}>Defaults</button>
                <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Apply'}</button>
            </div>
        </form>
    );
}
