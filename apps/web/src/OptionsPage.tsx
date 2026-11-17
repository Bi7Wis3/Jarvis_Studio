// The Options page (SolidWorks: Tools > Options): a full panel over the 3D view with the categories in a tree on the
// left and the chosen category's settings on the right; OK, Cancel, Apply, and Reset to defaults for the page shown.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { closeOptions, openOptions, saveOptions, useOptions } from './options';
import { draftChanged, draftOf, draftPatch, resetPage, type Draft, type PageId } from './optionsDraft';
import { DEFAULTS_TOOLS } from './optionsDefaults';
import {
    AiPage, DefaultsListPage, DefaultsToolPage, DisplayPage, GeneralPage, GridPage, RelationsPage, SketchPage, ToolbarsPage, UnitsPage,
    type PageProps,
} from './optionsPages';
import { LightingPage } from './optionsLighting';
import './options.css';

interface TreeNode {
    page: PageId;
    label: string;
    children?: TreeNode[];
}

export const OPTIONS_TREE: TreeNode[] = [
    {
        page: 'general', label: 'General', children: [
            { page: 'sketch', label: 'Sketch' },
            { page: 'relations', label: 'Relations/Snaps' },
            { page: 'grid', label: 'Grid/Snap' },
        ],
    },
    { page: 'defaults', label: 'Defaults', children: DEFAULTS_TOOLS.map((t) => ({ page: `defaults:${t.id}` as PageId, label: t.label })) },
    { page: 'units', label: 'Units and precision' },
    { page: 'display', label: 'Display' },
    { page: 'lighting', label: 'Lighting' },
    { page: 'ai', label: 'AI assistant' },
    { page: 'toolbars', label: 'Toolbars' },
];

const flat = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);

export function pageLabel(page: PageId): string {
    return flat(OPTIONS_TREE).find((n) => n.page === page)?.label ?? 'Options';
}

/** The gear next to the File menu: opens the Options page. */
export function OptionsButton() {
    return (
        <button type="button" className="fm-options" onClick={() => openOptions()} title="Options" aria-label="Options">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3.2" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
            </svg>
        </button>
    );
}

/** The Options page, while it is open. */
export function OptionsPage() {
    const open = useOptions((s) => s.open);
    return open ? <OptionsPanel initial={open} /> : null;
}

function Tree({ nodes, page, onPage, depth = 0 }: { nodes: TreeNode[]; page: PageId; onPage: (p: PageId) => void; depth?: number }) {
    return (
        <ul className={depth ? 'op-subtree' : 'op-tree'} role={depth ? 'group' : 'tree'}>
            {nodes.map((n) => {
                const inside = flat(n.children ?? []).some((c) => c.page === page);
                return (
                    <li key={n.page} role="treeitem" aria-selected={n.page === page} aria-expanded={n.children ? n.page === page || inside : undefined}>
                        <button type="button" className={n.page === page ? 'on' : ''} onClick={() => onPage(n.page)}>
                            {n.children && <span className="op-caret">{n.page === page || inside ? '▾' : '▸'}</span>}
                            {n.label}
                        </button>
                        {n.children && (n.page === page || inside) && <Tree nodes={n.children} page={page} onPage={onPage} depth={depth + 1} />}
                    </li>
                );
            })}
        </ul>
    );
}

export function OptionsPanel({ initial }: { initial: PageId }) {
    const saved = useOptions((s) => s.settings);
    const loaded = useOptions((s) => s.loaded);
    const [page, setPage] = useState<PageId>(initial);
    const [draft, setDraft] = useState<Draft>(() => draftOf(saved));
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
    const changed = useMemo(() => draftChanged(draft, saved), [draft, saved]);

    const apply = async (): Promise<boolean> => {
        let patch;
        try {
            patch = draftPatch(draft, saved);
        } catch (error) {
            setMessage({ text: error instanceof Error ? error.message : String(error), error: true });
            return false;
        }
        if (Object.keys(patch).length === 0) {
            return true;
        }
        setBusy(true);
        const failed = await saveOptions(patch);
        setBusy(false);
        if (failed) {
            setMessage({ text: failed.error, error: true });
            return false;
        }
        // The draft follows what was saved (the server may have tidied values); the page stays where it is.
        setDraft(draftOf(useOptions.getState().settings));
        setMessage({ text: 'Settings saved.', error: false });
        return true;
    };

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                closeOptions();
            }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, []);

    const props: PageProps = { draft, setDraft, saved, page, onPage: setPage };
    const body: ReactNode = page === 'general' ? <GeneralPage {...props} />
        : page === 'sketch' ? <SketchPage {...props} />
            : page === 'relations' ? <RelationsPage {...props} />
                : page === 'grid' ? <GridPage {...props} />
                    : page === 'defaults' ? <DefaultsListPage {...props} />
                        : page.startsWith('defaults:') ? <DefaultsToolPage key={page} {...props} tool={page.slice('defaults:'.length)} />
                            : page === 'units' ? <UnitsPage {...props} />
                                : page === 'display' ? <DisplayPage {...props} />
                                    : page === 'lighting' ? <LightingPage {...props} />
                                        : page === 'ai' ? <AiPage {...props} />
                                            : <ToolbarsPage {...props} />;
    return (
        <div className="op-page" role="dialog" aria-modal="true" aria-label="Options">
            <div className="op-panel tb-popup">
                <header className="op-head">
                    <span className="op-title">Options</span>
                    <span className="op-sub">{pageLabel(page)}</span>
                    <button type="button" className="op-close" onClick={closeOptions} aria-label="Close without saving" title="Cancel (Esc)">×</button>
                </header>
                {!loaded && (
                    <p className="op-offline">
                        The settings could not be loaded from the server: the defaults are shown, and changes cannot be saved until it answers.
                    </p>
                )}
                <div className="op-body">
                    <nav className="op-nav" aria-label="Option categories">
                        <Tree nodes={OPTIONS_TREE} page={page} onPage={(p) => {
                            setPage(p);
                            setMessage(null);
                        }} />
                    </nav>
                    <section className="op-pane" aria-label={pageLabel(page)}>{body}</section>
                </div>
                <footer className="op-foot">
                    <button
                        type="button"
                        className="sk-small"
                        onClick={() => {
                            setDraft(resetPage(draft, page));
                            setMessage({ text: `${pageLabel(page)} put back to the defaults: Apply or OK saves it.`, error: false });
                        }}
                        title={`Put the settings of ${pageLabel(page)} back to the defaults (saved with Apply or OK)`}
                    >
                        Reset to defaults
                    </button>
                    <span className={`op-message ${message?.error ? 'error' : ''}`} role="status">{message?.text ?? ''}</span>
                    <button
                        type="button"
                        className="sk-small primary"
                        disabled={busy}
                        onClick={async () => {
                            if (await apply()) {
                                closeOptions();
                            }
                        }}
                    >
                        OK
                    </button>
                    <button type="button" className="sk-small" onClick={closeOptions}>Cancel</button>
                    <button type="button" className="sk-small" disabled={busy || !changed} onClick={() => void apply()}>
                        {busy ? 'Saving…' : 'Apply'}
                    </button>
                </footer>
            </div>
        </div>
    );
}
