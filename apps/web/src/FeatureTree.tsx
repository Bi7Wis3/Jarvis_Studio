// Part workspace: the part's history as a feature tree (part, reference planes, then the steps with their sketches).

import {
    useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement,
    type ReactNode,
} from 'react';
import type { Feature, Part, SketchPlaneName } from '@jarvis/core';
import wasmUrl from '@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url';
import { Icon } from './icons';
import { ContextMenu, InlineInput, showError, tool, type MenuEntry } from './menus';
import { editItem, runTool, setRollback, setSketchHidden, setWorkspace, useStudio } from './state';
import { deletionIds, dependants, suppressUpdates, unsuppressUpdates } from './historyOps';
import {
    errorText, failingFeature, featureIcon, featureName, featureSummary, shapeIcon, shapeSummary, sketchEdits, REFERENCE_OPS, stepRefs,
    stepUsers,
} from './historyText';
import { StepIcon } from './stepIcons';
import { DecalPanel } from './DecalPanel';
import { choosePlane, startSketch, useSketcher } from './sketcher';
import { loadSolver, solverReady } from './solver';
import { definitionMark, updateRecent, type RecentSteps } from './sketchState';
import {
    buildFeatureTree, filterKeys, gapCount, isRolled, markerGap, nodeSketch, reorderIds, treeGuides, type TreeNode,
} from './featureTree';
import { load, menuAt, NONE, store, STORAGE_KEY, type Menu } from './browserUtil';

/** Stands for "no expand state saved yet" for a part. */
const UNSAVED = '\u0000';
const NEW_PART = '__new';
const ROOT = '__root';
const BODY = '__body';
const MATERIAL = '__material';
const ORIGIN = '__origin';
const HISTORY = '__history';
const RECENT = '__recent:';

/** The material new parts start with: shown as "not specified". */
const DEFAULT_COLOR = '#9aa3b5';

/** Tree geometry in px: left padding, width of one indent column; the box and lines sit at a column's centre. */
const PAD = 2;
const INDENT = 16;
const lineX = (column: number) => PAD + column * INDENT + 8;

const PLANES: { key: string; plane: SketchPlaneName; label: string }[] = [
    { key: '__front', plane: 'front', label: 'Front Plane' },
    { key: '__top', plane: 'top', label: 'Top Plane' },
    { key: '__right', plane: 'right', label: 'Right Plane' },
];

/** Adds an empty part (it starts with a sketch) and opens it in isolation. */
async function newPart(parts: Part[]): Promise<void> {
    let n = parts.length + 1;
    while (parts.some((p) => p.name === `Part ${n}`)) {
        n++;
    }
    const result = await tool('parts_add', {
        parts: [{
            name: `Part ${n}`,
            shape: { kind: 'empty' },
            position: [0, 0, 0],
            material: { color: DEFAULT_COLOR, metalness: 0, roughness: 0.6 },
        }],
    });
    const id = /: ([^,.\s]+)\.?$/.exec(result.text.trim())?.[1];
    if (!result.isError && id) {
        setWorkspace('part', id, 'isolated');
    }
}

// Steps added or edited this session, per part (kept while the tree is closed; not across a reload).
const recentByPart = new Map<string, { features: Feature[]; state: RecentSteps }>();

function recentSteps(partId: string, features: Feature[]): string[] {
    const known = recentByPart.get(partId);
    if (known?.features === features) {
        return known.state.recent;
    }
    const state = updateRecent(known?.state ?? null, features);
    recentByPart.set(partId, { features, state });
    return state.recent;
}

/** True once the sketch solver is loaded (it loads in the background), for the sketch definition marks. */
function useSolverLoaded(): boolean {
    const [ready, setReady] = useState(solverReady);
    useEffect(() => {
        if (ready) {
            return undefined;
        }
        let live = true;
        void loadSolver(wasmUrl).then(() => live && setReady(true));
        return () => {
            live = false;
        };
    }, [ready]);
    return ready;
}

/** Short description of a part's material for its tree row. */
function materialText(part: Part): string | null {
    const { color, metalness, roughness } = part.material;
    if (color.toLowerCase() === DEFAULT_COLOR && metalness === 0) {
        return null;
    }
    return `${color} ${metalness >= 0.5 ? 'metal' : roughness < 0.35 ? 'gloss' : 'matte'}`;
}

/** Isolated (only this part) or in context (the rest of the assembly shown around it). */
function PartViewToggle({ instances }: { instances: number }) {
    const partView = useStudio((s) => s.partView);
    const activePart = useStudio((s) => s.activePart);
    return (
        <div className="br-view" role="group" aria-label="Part view">
            {(['isolated', 'inContext'] as const).map((v) => (
                <button
                    key={v}
                    type="button"
                    className={partView === v ? 'on' : ''}
                    onClick={() => setWorkspace('part', activePart ?? undefined, v)}
                    aria-pressed={partView === v}
                >
                    {v === 'isolated' ? 'Isolated' : 'In context'}
                </button>
            ))}
            {instances > 0 && (
                <span className="br-inst" title="Editing this design changes every instance">
                    {instances + 1} instances
                </span>
            )}
        </div>
    );
}

/** One visible line of the tree, in display order. */
type Entry =
    | { kind: 'root'; key: string; depth: 0 }
    | { kind: 'folder'; key: string; depth: 1 }
    | { kind: 'recent'; key: string; depth: 2; stepId: string | null }
    | { kind: 'fixed'; key: string; depth: 1; label: string; icon: ReactNode; plane?: SketchPlaneName; title?: string }
    | { kind: 'body'; key: string; depth: 1 }
    | { kind: 'node'; key: string; depth: number; node: TreeNode }
    | { kind: 'gap'; key: string; gap: number };

export function PartHistory(props: { part: Part; parts: Part[]; onMinimise: () => void }) {
    const { part, parts, onMinimise } = props;
    const rollback = useStudio((s) => s.history?.view.rollback ?? null);
    const error = useStudio((s) => s.meshes.errors[part.id]);
    const editing = useStudio((s) => s.editing);
    const hiddenRefs = useStudio((s) => s.history?.view.hiddenSketches ?? NONE);
    const features = useMemo(() => part.features ?? [], [part.features]);
    const tree = useMemo(() => buildFeatureTree(features), [features]);
    const byId = useMemo(() => new Map(features.map((f) => [f.id, f])), [features]);
    const total = features.length;
    const count = rollback?.partId === part.id ? Math.min(Math.max(0, rollback.count), total) : total;

    const treeKey = `${STORAGE_KEY}.tree.${part.id}`;
    const rootKey = `${STORAGE_KEY}.root.${part.id}`;
    // Steps with a sketch under them start open, so the sketch is seen beneath its feature; after that the part
    // remembers what was opened and closed.
    const [expanded, setExpanded] = useState<Set<string>>(() => {
        const saved = load(treeKey, UNSAVED);
        return new Set(saved === UNSAVED ? tree.filter((n) => n.children.length).map((n) => n.key) : saved.split(',').filter(Boolean));
    });
    const known = useRef(new Set(tree.map((n) => n.key)));
    useEffect(() => {
        // A step added since opens too.
        const added = tree.filter((n) => !known.current.has(n.key) && n.children.length).map((n) => n.key);
        known.current = new Set(tree.map((n) => n.key));
        if (added.length) {
            setExpanded((e) => {
                const next = new Set([...e, ...added]);
                store(treeKey, [...next].join(','));
                return next;
            });
        }
    }, [tree]);
    const [rootOpen, setRootOpen] = useState(() => load(rootKey, 'open') !== 'closed');
    const [filter, setFilter] = useState('');
    const [current, setCurrent] = useState<string | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<string | null>(null);
    const [menu, setMenu] = useState<Menu>(null);
    const [dragKey, setDragKey] = useState<string | null>(null);
    const [drop, setDrop] = useState<{ key: string; after: boolean } | null>(null);
    // Rollback count shown while the bar is dragged, and after a change until the server confirms it.
    const [preview, setPreview] = useState<number | null>(null);
    const draggingBar = useRef(false);
    const list = useRef<HTMLOListElement>(null);
    // A row to scroll into view once it is rendered (after a History shortcut expands its parent).
    const scrollTo = useRef<string | null>(null);
    const solverLoaded = useSolverLoaded();
    const recent = useMemo(() => recentSteps(part.id, features), [part.id, features]).filter((id) => byId.has(id));
    const sketchEdit = useSketcher((s) => (s.active ? s.edit : null));

    useEffect(() => {
        if (scrollTo.current) {
            list.current?.querySelector(`[data-key="${CSS.escape(scrollTo.current)}"]`)?.scrollIntoView({ block: 'nearest' });
            scrollTo.current = null;
        }
    });

    useEffect(() => {
        if (!draggingBar.current) {
            setPreview(null);
        }
    }, [count]);

    const shownCount = preview ?? count;
    // While a step (or its sketch) is edited, the steps after it are greyed like rolled-back ones.
    const editTarget = editing?.partId === part.id && editing.featureId
        ? editing.featureId
        : sketchEdit?.partId === part.id ? sketchEdit.featureId : null;
    const editAt = editTarget ? features.findIndex((f) => f.id === editTarget) : -1;
    const greyCount = editAt >= 0 ? Math.min(shownCount, editAt + 1) : shownCount;
    const shownGap = markerGap(tree, shownCount);
    const failing = failingFeature(part, error);
    const matches = filterKeys(tree, filter);
    const query = filter.trim().toLowerCase();
    const filtering = matches !== null;

    const saveExpanded = (next: Set<string>) => {
        setExpanded(next);
        store(treeKey, [...next].join(','));
    };
    const setOpen = (key: string, open: boolean) => {
        if (key === ROOT) {
            setRootOpen(open);
            store(rootKey, open ? 'open' : 'closed');
        } else if (expanded.has(key) !== open) {
            const next = new Set(expanded);
            if (open) {
                next.add(key);
            } else {
                next.delete(key);
            }
            saveExpanded(next);
        }
    };
    const isOpen = (key: string) => filtering || (key === ROOT ? rootOpen : expanded.has(key));

    // ---- Visible lines ----

    const entries: Entry[] = [{ kind: 'root', key: ROOT, depth: 0 }];
    if (isOpen(ROOT)) {
        if (!filtering) {
            entries.push({ kind: 'folder', key: HISTORY, depth: 1 });
            if (isOpen(HISTORY)) {
                entries.push(...(recent.length ? recent : [null])
                    .map((id): Entry => ({ kind: 'recent', key: `${RECENT}${id ?? ''}`, depth: 2, stepId: id })));
            }
        }
        const material = materialText(part);
        const fixed: Entry[] = [
            {
                kind: 'fixed',
                key: MATERIAL,
                depth: 1,
                label: `Material <${material ?? 'not specified'}>`,
                icon: material
                    ? <span className="br-swatch ft-swatch" style={{ background: part.material.color }} />
                    : <StepIcon name="material" />,
                title: `Colour ${part.material.color} · metalness ${part.material.metalness} · roughness ${part.material.roughness}`,
            },
            ...PLANES.map((p): Entry => ({ kind: 'fixed', key: p.key, depth: 1, label: p.label, icon: <StepIcon name="plane" />, plane: p.plane })),
            { kind: 'fixed', key: ORIGIN, depth: 1, label: 'Origin', icon: <StepIcon name="origin" /> },
        ];
        entries.push(...fixed.filter((e) => !query || (e.kind === 'fixed' && e.label.toLowerCase().includes(query))));
        if (part.shape.kind !== 'empty' && (!query || 'base body'.includes(query))) {
            entries.push({ kind: 'body', key: BODY, depth: 1 });
        }
        if (!filtering) {
            entries.push({ kind: 'gap', key: 'gap-0', gap: 0 });
        }
        tree.forEach((node, i) => {
            if (matches && !matches.has(node.key)) {
                return;
            }
            entries.push({ kind: 'node', key: node.key, depth: 1, node });
            if (node.children.length && isOpen(node.key)) {
                node.children
                    .filter((c) => !matches || matches.has(c.key))
                    .forEach((c) => entries.push({ kind: 'node', key: c.key, depth: 2, node: c }));
            }
            if (!filtering) {
                entries.push({ kind: 'gap', key: `gap-${i + 1}`, gap: i + 1 });
            }
        });
    }
    const keys = entries.filter((e) => e.kind !== 'gap').map((e) => e.key);
    // Does the line open onto children (the next row is deeper)?
    const depths = entries.map((e) => (e.kind === 'gap' ? null : e.depth));
    const opens = depths.map((d, i) => {
        const next = depths.slice(i + 1).find((n) => n !== null);
        return d !== null && next !== undefined && next !== null && next > d;
    });
    const guides = treeGuides(depths);
    const nodeOf = (key: string | null): TreeNode | undefined => {
        const entry = entries.find((e) => e.key === key);
        return entry?.kind === 'node' ? entry.node : undefined;
    };

    // ---- Actions ----

    const reorder = async (ids: string[]) => {
        const result = await runTool('features_reorder', { partId: part.id, ids });
        if (result.isError) {
            showError(/is not an earlier/.test(result.text)
                ? 'A step can only use steps above it. Move the step it uses up first, or this one further down.'
                : result.text);
        }
    };
    const placeCount = (k: number) => {
        if (k === count) {
            setPreview(null);
            return;
        }
        setPreview(k);
        setRollback(part.id, k >= total ? null : k);
    };
    const focusList = () => list.current?.focus();

    // The confirm row lists the steps built on it, which go with it (SolidWorks: Delete child features).
    const askDelete = (node: TreeNode) => {
        if (node.stepId && byId.has(node.stepId)) {
            setConfirming(node.key);
        }
    };
    /** Suppress cascades to the steps built on it; unsuppress brings back the steps it needs, and on request its children. */
    const suppress = (feature: Feature, on: boolean, withDependants = false) => {
        const updates = on ? suppressUpdates(features, feature.id) : unsuppressUpdates(features, feature.id, withDependants);
        if (updates.length) {
            void tool('features_update', { partId: part.id, updates });
        }
    };
    const remove = (ids: string[]) => {
        setConfirming(null);
        focusList();
        void tool('features_remove', { partId: part.id, ids });
    };
    const startRename = (key: string | null) => {
        if (key === ROOT || (key && nodeOf(key)?.stepId)) {
            setRenaming(key);
        }
    };
    const sketchOn = (plane: SketchPlaneName) => {
        startSketch(part.id, 'sketch');
        choosePlane(plane, 0);
    };
    /** Selects a step in the tree (opening the step it is nested under) and scrolls to it. */
    const jump = (stepId: string) => {
        const owner = tree.find((n) => n.children.some((c) => c.stepId === stepId));
        if (owner) {
            setOpen(owner.key, true);
        }
        setCurrent(stepId);
        scrollTo.current = stepId;
        focusList();
    };
    /** What double-click or Enter does on a line. */
    const activate = (key: string) => {
        if (key === ROOT || key === HISTORY) {
            setOpen(key, !isOpen(key));
        } else if (key.startsWith(RECENT)) {
            if (key !== RECENT) {
                jump(key.slice(RECENT.length));
            }
        } else if (key === BODY) {
            editItem(part.id, null);
        } else {
            const node = nodeOf(key);
            const parent = node?.parentId ? byId.get(node.parentId) : undefined;
            if (node?.stepId) {
                editItem(part.id, node.stepId);
            } else if (parent) {
                editItem(part.id, sketchEdits(parent)[0]?.id ?? parent.id);
            }
        }
    };

    const rollEntries = (k: number): MenuEntry[] => [
        { label: 'Roll back to here', onSelect: () => placeCount(k), disabled: k === shownCount },
        { label: 'Roll to end', onSelect: () => placeCount(total), disabled: shownCount === total },
    ];
    const nodeMenu = (node: TreeNode): MenuEntry[] => {
        const feature = node.stepId ? byId.get(node.stepId) : undefined;
        if (!feature) {
            // A sketch stored inline in its parent step: edited through the parent.
            const parent = node.parentId ? byId.get(node.parentId) : undefined;
            if (!parent) {
                return [];
            }
            const inline = sketchEdits(parent).filter((e) => e.id === parent.id);
            return [
                ...inline.map((e) => ({ label: e.label, onSelect: () => editItem(part.id, e.id) })),
                { label: `Edit ${featureName(parent)}`, onSelect: () => editItem(part.id, parent.id) },
                'separator',
                ...rollEntries(node.index),
            ];
        }
        const edits = sketchEdits(feature);
        return [
            ...(feature.op === 'sketch' ? [] : [{ label: 'Edit feature', onSelect: () => editItem(part.id, feature.id) }]),
            ...edits.map((e) => ({ label: e.label, onSelect: () => editItem(part.id, e.id) })),
            ...(feature.suppressed ? [
                { label: 'Unsuppress', onSelect: () => suppress(feature, false) },
                {
                    label: 'Unsuppress with dependents',
                    onSelect: () => suppress(feature, false, true),
                    disabled: !dependants(features, feature.id).some((f) => f.suppressed),
                },
            ] : [{ label: 'Suppress', onSelect: () => suppress(feature, true) }]),
            'separator',
            ...rollEntries(node.index),
            'separator',
            { label: 'Rename', hint: 'F2', onSelect: () => setRenaming(node.key) },
            { label: 'Delete', hint: 'Del', danger: true, onSelect: () => askDelete(node) },
        ];
    };
    const allParents = tree.filter((n) => n.children.length).map((n) => n.key);
    const rootMenu: MenuEntry[] = [
        ...(part.shape.kind !== 'empty' ? [{ label: 'Edit body', onSelect: () => editItem(part.id, null) }] : []),
        { label: 'Rename part', hint: 'F2', onSelect: () => setRenaming(ROOT) },
        'separator',
        { label: 'Expand all', onSelect: () => saveExpanded(new Set(allParents)), disabled: !allParents.length },
        { label: 'Collapse all', onSelect: () => saveExpanded(new Set()), disabled: !expanded.size },
        'separator',
        { label: 'Roll to end', onSelect: () => placeCount(total), disabled: shownCount === total },
    ];
    const menuFor = (entry: Entry): MenuEntry[] => {
        switch (entry.kind) {
            case 'root':
                return rootMenu;
            case 'body':
                return [{ label: 'Edit body', onSelect: () => editItem(part.id, null) }];
            case 'fixed':
                return entry.plane ? [{ label: 'Sketch on this plane', onSelect: () => sketchOn(entry.plane!) }] : [];
            case 'node':
                return nodeMenu(entry.node);
            default:
                return [];
        }
    };

    // ---- Keyboard ----

    const choose = (key: string | undefined) => {
        if (!key) {
            return;
        }
        setCurrent(key);
        list.current?.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    const onKey = (event: KeyboardEvent<HTMLOListElement>) => {
        if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) {
            return;
        }
        const at = current ? keys.indexOf(current) : -1;
        const node = nodeOf(current);
        const hasChildren = current === ROOT || current === HISTORY || !!node?.children.length;
        switch (event.key) {
            case 'ArrowDown':
                choose(keys[at < 0 ? 0 : Math.min(at + 1, keys.length - 1)]);
                break;
            case 'ArrowUp':
                choose(keys[at < 0 ? 0 : Math.max(at - 1, 0)]);
                break;
            case 'Home':
                choose(keys[0]);
                break;
            case 'End':
                choose(keys[keys.length - 1]);
                break;
            case 'ArrowRight':
                if (current && hasChildren && !isOpen(current)) {
                    setOpen(current, true);
                } else if (current && hasChildren) {
                    choose(keys[at + 1]);
                }
                break;
            case 'ArrowLeft':
                if (current && hasChildren && isOpen(current) && !filtering) {
                    setOpen(current, false);
                } else if (current?.startsWith(RECENT)) {
                    choose(HISTORY);
                } else if (node?.parentId) {
                    choose(node.parentId);
                } else if (current && current !== ROOT) {
                    choose(ROOT);
                }
                break;
            case 'Enter':
                if (current) {
                    activate(current);
                }
                break;
            case 'F2':
                startRename(current);
                break;
            case 'Delete':
                if (node) {
                    askDelete(node);
                }
                break;
            default:
                return;
        }
        event.preventDefault();
        event.stopPropagation();
    };

    // ---- Rollback bar ----

    const gapAt = (clientY: number): number => {
        const gaps = list.current ? [...list.current.querySelectorAll<HTMLElement>('[data-gap]')] : [];
        let best = shownGap;
        let distance = Infinity;
        for (const gap of gaps) {
            const rect = gap.getBoundingClientRect();
            const d = Math.abs(rect.top + rect.height / 2 - clientY);
            if (d < distance) {
                distance = d;
                best = Number(gap.dataset.gap);
            }
        }
        return best;
    };
    const barDown = (event: PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        draggingBar.current = true;
        setPreview(count);
    };
    const barMove = (event: PointerEvent<HTMLDivElement>) => {
        if (draggingBar.current) {
            setPreview(gapCount(tree, gapAt(event.clientY)));
        }
    };
    const barUp = (event: PointerEvent<HTMLDivElement>) => {
        if (!draggingBar.current) {
            return;
        }
        draggingBar.current = false;
        const gap = gapAt(event.clientY);
        if (gap === markerGap(tree, count)) {
            setPreview(null);
        } else {
            placeCount(gapCount(tree, gap));
        }
    };

    // ---- Drag to reorder (top-level rows; nested sketches move with their step) ----

    const dragOver = (event: DragEvent<HTMLLIElement>, key: string, after?: boolean) => {
        if (!dragKey) {
            return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const rect = event.currentTarget.getBoundingClientRect();
        const below = after ?? event.clientY > rect.top + rect.height / 2;
        if (drop?.key !== key || drop.after !== below) {
            setDrop({ key, after: below });
        }
    };
    const dropOn = (event: DragEvent<HTMLLIElement>) => {
        event.preventDefault();
        if (dragKey && drop) {
            const ids = reorderIds(features, tree, dragKey, drop.key, drop.after);
            if (ids) {
                void reorder(ids);
            }
        }
        setDragKey(null);
        setDrop(null);
    };
    // The line showing where a drop lands: after an open step's last nested sketch.
    const dropLine = (() => {
        if (!drop || drop.key === dragKey) {
            return null;
        }
        const target = tree.find((n) => n.key === drop.key);
        const shownChildren = target && isOpen(target.key) ? target.children : [];
        return drop.after && shownChildren.length
            ? { key: shownChildren[shownChildren.length - 1].key, after: true }
            : drop;
    })();

    // ---- Rendering ----

    /** "(-) " / "(+) " / "" before a sketch's name: how well it is defined (nothing until the solver is loaded). */
    const markOf = (node: TreeNode, feature: Feature | undefined): string => {
        if (!solverLoaded || (feature && feature.op !== 'sketch')) {
            return '';
        }
        return definitionMark(nodeSketch(node, byId)?.geometry) ?? '';
    };

    const nodeTitle = (node: TreeNode, feature: Feature | undefined): string => {
        const parent = node.parentId ? byId.get(node.parentId) : undefined;
        const lines: string[] = [];
        if (failing && (node.stepId === failing || (node.children.some((c) => c.stepId === failing) && !isOpen(node.key))) && error) {
            lines.push(`⚠ ${errorText(error)}`);
        }
        if (feature) {
            lines.push(featureSummary(feature, part, parts));
            const refs = stepRefs(feature).filter((id) => !node.children.some((c) => c.stepId === id));
            if (refs.length) {
                lines.push(`Uses ${refs.map((id) => (byId.get(id) ? featureName(byId.get(id)!) : id)).join(', ')}`);
            }
            if (feature.op === 'sketch' && !node.parentId) {
                const users = stepUsers(part, feature.id);
                lines.push(users.length ? `Used by ${users.map(featureName).join(', ')}` : 'Not used by any step');
            }
            if (feature.suppressed) {
                lines.push('Suppressed');
            }
        } else if (parent) {
            lines.push(`${node.label} of ${featureName(parent)}, stored in that step`);
        }
        if (node.role && feature) {
            lines.unshift(`${node.role} of ${parent ? featureName(parent) : 'its step'}`);
        }
        const mark = markOf(node, feature);
        if (mark) {
            lines.push(mark === '(-) ' ? 'Under defined: some geometry can still move'
                : mark === '(?) ' ? 'Cannot be solved: the constraints cannot all be met' : 'Over defined: constraints conflict');
        }
        if (isRolled(node, shownCount)) {
            lines.push('Below the rollback bar: not built');
        } else if (isRolled(node, greyCount)) {
            lines.push('After the step being edited');
        }
        return lines.join('\n');
    };

    /** Dotted connector lines of line `i`: lines passing through, its elbow and stub, and the line down to its children. */
    const lines = (i: number, depth: number) => (
        <>
            {guides[i].through.map((k) => <span key={k} className="ft-line" style={{ left: lineX(k) }} aria-hidden="true" />)}
            {depth > 0 && (
                <>
                    <span className={`ft-line elbow ${guides[i].last ? 'last' : ''}`} style={{ left: lineX(depth) }} aria-hidden="true" />
                    <span className="ft-line stub" style={{ left: lineX(depth) }} aria-hidden="true" />
                </>
            )}
            {opens[i] && <span className="ft-line down" style={{ left: lineX(depth + 1) }} aria-hidden="true" />}
        </>
    );

    /** The square [+] / [-] box of a line with children (an empty cell for a leaf), over its connector lines. */
    const lead = (i: number, entry: Exclude<Entry, { kind: 'gap' }>, hasChildren: boolean) => (
        <>
            {lines(i, entry.depth)}
            <span
                className={`ft-exp ${hasChildren ? '' : 'leaf'}`}
                onClick={hasChildren ? (event) => { event.stopPropagation(); setOpen(entry.key, !isOpen(entry.key)); } : undefined}
                onDoubleClick={(event) => event.stopPropagation()}
                aria-hidden="true"
            >
                {hasChildren && (
                    <svg className="ft-box" width="9" height="9" viewBox="0 0 9 9" shapeRendering="crispEdges">
                        <rect x="0.5" y="0.5" width="8" height="8" />
                        <path d="M2 4.5h5" />
                        {!isOpen(entry.key) && <path d="M4.5 2v5" />}
                    </svg>
                )}
            </span>
        </>
    );

    const nameOrInput = (key: string, name: string, onCommit: (next: string) => void, prefix = '') => (
        renaming === key ? (
            <InlineInput
                value={name}
                label="Name"
                onCommit={(next) => {
                    setRenaming(null);
                    focusList();
                    onCommit(next);
                }}
                onCancel={() => {
                    setRenaming(null);
                    focusList();
                }}
            />
        ) : <span className="ft-name">{prefix}{name}</span>
    );

    const rowProps = (entry: Exclude<Entry, { kind: 'gap' }>) => ({
        'data-key': entry.key,
        role: 'treeitem',
        'aria-level': entry.depth + 1,
        'aria-selected': current === entry.key,
        style: { '--depth': entry.depth } as CSSProperties,
        onClick: () => (entry.kind === 'recent' && entry.stepId ? jump(entry.stepId) : setCurrent(entry.key)),
        onDoubleClick: () => activate(entry.key),
        onContextMenu: (event: MouseEvent) => {
            setCurrent(entry.key);
            const items = menuFor(entry);
            if (items.length) {
                setMenu(menuAt(event, items));
            } else {
                event.preventDefault();
            }
        },
    });

    const rows: ReactElement[] = entries.map((entry, i) => {
        switch (entry.kind) {
            case 'gap': {
                const here = entry.gap === shownGap;
                return (
                    <li key={entry.key} className={`ft-gap ${here ? 'has-bar' : ''}`} data-gap={entry.gap} role="none">
                        {lines(i, 0)}
                        {here ? (
                            <div
                                className={`ft-bar ${preview !== null && draggingBar.current ? 'dragging' : ''}`}
                                onPointerDown={barDown}
                                onPointerMove={barMove}
                                onPointerUp={barUp}
                                onPointerCancel={() => {
                                    draggingBar.current = false;
                                    setPreview(null);
                                }}
                                onContextMenu={(event) => setMenu(menuAt(event, rollEntries(total).slice(1)))}
                                title="Rollback bar: drag up or down. Steps below it are not built."
                                role="slider"
                                aria-label="Rollback bar"
                                aria-valuemin={0}
                                aria-valuemax={tree.length}
                                aria-valuenow={entry.gap}
                            />
                        ) : (
                            <button
                                type="button"
                                className="ft-gap-hit"
                                tabIndex={-1}
                                onClick={() => placeCount(gapCount(tree, entry.gap))}
                                title={entry.gap === tree.length ? 'Roll to end' : 'Move the rollback bar here'}
                                aria-label="Move the rollback bar here"
                            />
                        )}
                    </li>
                );
            }
            case 'root': {
                const bodyError = error && !failing;
                return (
                    <li
                        key={entry.key}
                        {...rowProps(entry)}
                        className={`ft-row root ${current === ROOT ? 'current' : ''} ${bodyError ? 'failed' : ''}`}
                        aria-expanded={isOpen(ROOT)}
                        title={bodyError ? `⚠ ${error}` : `${part.name}${part.description ? ` · ${part.description}` : ''}`}
                    >
                        {lead(i, entry, true)}
                        <span className="ft-icon"><StepIcon name="part" /></span>
                        {nameOrInput(ROOT, part.name, (name) => void tool('parts_update', { updates: [{ id: part.id, name }] }))}
                        {bodyError && <span className="ft-err" aria-label="Build error">⚠</span>}
                    </li>
                );
            }
            case 'folder':
                return (
                    <li
                        key={entry.key}
                        {...rowProps(entry)}
                        className={`ft-row folder ${current === HISTORY ? 'current' : ''}`}
                        aria-expanded={isOpen(HISTORY)}
                        title="Steps added or edited in this session, most recent first"
                    >
                        {lead(i, entry, true)}
                        <span className="ft-icon"><StepIcon name="history" /></span>
                        <span className="ft-name">History</span>
                    </li>
                );
            case 'recent': {
                const feature = entry.stepId ? byId.get(entry.stepId) : undefined;
                if (!feature) {
                    return (
                        <li key={entry.key} {...rowProps(entry)} className={`ft-row recent empty ${current === entry.key ? 'current' : ''}`}>
                            {lead(i, entry, false)}
                            <span className="ft-name">No steps added or edited yet</span>
                        </li>
                    );
                }
                return (
                    <li
                        key={entry.key}
                        {...rowProps(entry)}
                        className={`ft-row recent ${current === entry.key ? 'current' : ''}`}
                        title={`${featureName(feature)}: click to show it in the tree`}
                    >
                        {lead(i, entry, false)}
                        <span className="ft-icon"><StepIcon name={featureIcon(feature)} /></span>
                        <span className="ft-name">{featureName(feature)}</span>
                    </li>
                );
            }
            case 'fixed':
                return (
                    <li
                        key={entry.key}
                        {...rowProps(entry)}
                        className={`ft-row fixed ${current === entry.key ? 'current' : ''}`}
                        title={entry.plane ? `${entry.label}: right-click to sketch on it` : entry.title}
                    >
                        {lead(i, entry, false)}
                        <span className="ft-icon">{entry.icon}</span>
                        <span className="ft-name">{entry.label}</span>
                    </li>
                );
            case 'body':
                return (
                    <li
                        key={entry.key}
                        {...rowProps(entry)}
                        className={[
                            'ft-row body',
                            current === BODY ? 'current' : '',
                            editing?.partId === part.id && editing.featureId === null ? 'editing' : '',
                            error && !failing ? 'failed' : '',
                        ].join(' ')}
                        title={error && !failing ? `⚠ ${error}` : shapeSummary(part.shape)}
                    >
                        {lead(i, entry, false)}
                        <span className="ft-icon"><Icon name={shapeIcon(part.shape)} size={14} /></span>
                        <span className="ft-name">Base body</span>
                        {error && !failing && <span className="ft-err" aria-label="Build error">⚠</span>}
                    </li>
                );
            case 'node': {
                const { node } = entry;
                const feature = node.stepId ? byId.get(node.stepId) : undefined;
                const parent = node.parentId ? byId.get(node.parentId) : undefined;
                const nested = node.parentId !== null;
                const failed = !!failing && (node.stepId === failing || (!isOpen(node.key) && node.children.some((c) => c.stepId === failing)));
                const suppressed = !!(feature?.suppressed || parent?.suppressed);
                const isSketch = !feature || feature.op === 'sketch';
                const shared = feature?.op === 'sketch' && node.users > 1;
                if (confirming === node.key && feature) {
                    const children = dependants(features, feature.id);
                    const plain = deletionIds(features, feature.id, false);
                    const withAbsorbed = deletionIds(features, feature.id, true);
                    const names = children.map(featureName);
                    return (
                        <li
                            key={node.key}
                            className="br-row confirm ft-confirm"
                            style={{ '--depth': entry.depth } as CSSProperties}
                            title={children.length ? `Built on it, deleted with it: ${names.join(', ')}` : undefined}
                        >
                            {lines(i, entry.depth)}
                            <span className="br-confirm-text">
                                Delete {featureName(feature)}
                                {children.length ? ` and ${children.length === 1 ? names[0] : `${children.length} steps built on it (${names.join(', ')})`}` : ''}?
                            </span>
                            <button
                                type="button"
                                className="danger"
                                autoFocus
                                onClick={() => remove(plain)}
                                title={children.length ? 'Also deletes the steps built on it' : undefined}
                            >
                                Delete
                            </button>
                            {withAbsorbed.length > plain.length && (
                                <button
                                    type="button"
                                    className="danger"
                                    onClick={() => remove(withAbsorbed)}
                                    title="Also delete the sketches only these steps use"
                                >
                                    With sketch
                                </button>
                            )}
                            <button type="button" onClick={() => { setConfirming(null); focusList(); }}>Keep</button>
                        </li>
                    );
                }
                const hideable = feature && (feature.op === 'sketch' || REFERENCE_OPS.has(feature.op));
                const visible = !hiddenRefs.includes(`${part.id}/${node.stepId}`);
                const draggable = !nested && !filtering && renaming !== node.key;
                const classes = [
                    'ft-row',
                    nested ? 'nested' : '',
                    isSketch ? 'sketch' : '',
                    feature && REFERENCE_OPS.has(feature.op) ? 'ref' : '',
                    suppressed ? 'suppressed' : '',
                    isRolled(node, greyCount) ? 'rolled' : '',
                    current === node.key ? 'current' : '',
                    node.stepId && editTarget === node.stepId ? 'editing' : '',
                    failed ? 'failed' : '',
                    dragKey === node.key ? 'dragged' : '',
                    dropLine?.key === node.key ? (dropLine.after ? 'drop-after' : 'drop-before') : '',
                ].join(' ');
                return (
                    <li
                        key={node.key}
                        {...rowProps(entry)}
                        className={classes}
                        aria-expanded={node.children.length ? isOpen(node.key) : undefined}
                        title={nodeTitle(node, feature)}
                        draggable={draggable}
                        onDragStart={draggable ? (event) => {
                            event.dataTransfer.effectAllowed = 'move';
                            event.dataTransfer.setData('text/plain', node.key);
                            setDragKey(node.key);
                        } : undefined}
                        onDragOver={(event) => (nested ? dragOver(event, node.parentId!, true) : dragOver(event, node.key))}
                        onDrop={dropOn}
                        onDragEnd={() => {
                            setDragKey(null);
                            setDrop(null);
                        }}
                    >
                        {lead(i, entry, node.children.length > 0)}
                        <span className="ft-icon"><StepIcon name={feature ? featureIcon(feature) : 'sketch'} /></span>
                        {feature
                            ? nameOrInput(node.key, featureName(feature), (name) => void tool('features_update', {
                                partId: part.id,
                                updates: [{ id: feature.id, name }],
                            }), markOf(node, feature))
                            : <span className="ft-name">{markOf(node, feature)}{node.label}</span>}
                        {node.role && feature && <span className="ft-role">{node.role}</span>}
                        {shared && <span className="ft-badge" title={`Shared by ${node.users} steps`}>shared ×{node.users}</span>}
                        {failed && <span className="ft-err" aria-label="Build error">⚠</span>}
                        {hideable && (
                            <button
                                type="button"
                                className={`ft-eye ${visible ? '' : 'off'}`}
                                onClick={(e) => { e.stopPropagation(); setSketchHidden(part.id, feature.id, visible); }}
                                onDoubleClick={(e) => e.stopPropagation()}
                                title={visible ? 'Hide in the viewport' : 'Show in the viewport'}
                                aria-label={`${visible ? 'Hide' : 'Show'} ${featureName(feature)}`}
                                tabIndex={-1}
                            >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                    <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
                                    <circle cx="12" cy="12" r="3" />
                                    {!visible && <path d="M3 3l18 18" />}
                                </svg>
                            </button>
                        )}
                    </li>
                );
            }
        }
    });

    const suppressedCount = features.filter((f) => f.suppressed).length;
    return (
        <>
            <div className="br-head">
                <button type="button" className="br-back" onClick={() => setWorkspace('assembly')} title="Back to assembly">
                    ‹ Assembly
                </button>
                <span className="br-title" title="The part's features in the order they were built">Feature tree</span>
                <button type="button" className="br-min" onClick={onMinimise} title="Minimise" aria-label="Minimise panel">–</button>
            </div>
            <div className="br-part">
                <span className="br-swatch" style={{ background: part.material.color }} />
                <select
                    value={part.id}
                    onChange={(event) => (event.target.value === NEW_PART ? void newPart(parts) : setWorkspace('part', event.target.value))}
                    aria-label="Part being edited"
                    title="Parts: switch the design being edited"
                >
                    <optgroup label="Parts">
                        {parts.filter((p) => !p.instanceOf).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </optgroup>
                    <option value={NEW_PART}>+ New part</option>
                </select>
            </div>
            <PartViewToggle instances={parts.filter((p) => p.instanceOf === part.id).length} />
            <div className="ft-filter">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                    <circle cx="10.5" cy="10.5" r="6.5" />
                    <path d="M15.5 15.5L21 21" />
                </svg>
                <input
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape' && !filter) {
                            return;
                        }
                        // Keep typed letters away from the viewport shortcuts.
                        event.stopPropagation();
                        if (event.key === 'Escape') {
                            setFilter('');
                        } else if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            focusList();
                            choose(keys[0]);
                        }
                    }}
                    placeholder="Filter"
                    aria-label="Filter the feature tree by name"
                    spellCheck={false}
                />
                {filter && (
                    <button type="button" onClick={() => setFilter('')} title="Clear filter" aria-label="Clear filter">×</button>
                )}
            </div>
            <div className="br-scroll">
                <ol className="br-list ft-tree" ref={list} role="tree" aria-label="Feature tree" tabIndex={0} onKeyDown={onKey}>
                    {rows}
                    {filtering && keys.length === 1 && <li className="br-empty" role="none">Nothing matches “{filter.trim()}”.</li>}
                </ol>
                <DecalPanel part={part} />
            </div>
            <div className="br-foot">
                {shownCount < total ? (
                    <>
                        <span>Rolled back · {shownCount} of {total}</span>
                        <button type="button" onClick={() => placeCount(total)}>Roll to end</button>
                    </>
                ) : (
                    <span>
                        {total} feature{total === 1 ? '' : 's'}
                        {suppressedCount ? ` · ${suppressedCount} suppressed` : ''}
                        {total > 1 ? ' · drag to reorder' : ''}
                    </span>
                )}
            </div>
            {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
        </>
    );
}
