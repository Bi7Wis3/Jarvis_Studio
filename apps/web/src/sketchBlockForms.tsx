// The block tools in the left panel (SolidWorks Blocks toolbar): Make Block (entities, with text, equation curves and
// blocks inside, and insertion point), Insert Block (a block of this sketch or a saved block file, Link to file;
// position, angle and scale; clicks in the view place copies), the Block PropertyManager of a selected instance
// (Definition: Link to file, Edit; Parameters; Lock angle; For construction; colour), Edit Block (the block opens in the
// sketcher; Rebuild applies it to the sketch without closing it; OK changes every instance), Add/Remove, Explode Block
// and Save Block (a file in the blocks folder of the projects folder).

import { useEffect, useRef, useState } from 'react';
import type { SketchBlock, SketchGeometry } from '@jarvis/core';
import type { Field, PopupApi, Result, ToolDef, Values } from './toolDefs';
import { commitGeometry, setBeforeOutput, setViewPicker, useSketcher } from './sketcher';
import { geometryEntities } from './sketchGeometry';
import { entityPoints } from './sketchMath';
import { ownerOf } from './sketchItems';
import { solveGeometry } from './solver';
import {
    addBlockDefinition, addRemoveEntities, blockAt, blockContains, blockFileOf, blockFrom, deleteBlockDefinition, entitiesCentre, explodeWithNote,
    insertBlock, insertOf, makeBlock, placeInsert, placeOf, redefineBlock, setBlockProps, shiftGeometry, updateFromFile, type BlockFileData,
} from './sketchBlocks';
import { CurveList } from './sketchTextForm';
import { clearExtras, useSketchExtras } from './sketchExtrasState';
import { valueText } from './numberText';
import './sketchExtras.css';

/** One empty list for store fields that are not there: a selector must not build a new array on every call. */
const NO_LIST: never[] = [];

type Pt = [number, number];
const fmt = valueText;
const ok = (error: string | null): Result => ({ text: error ?? '', isError: !!error });
const say = (message: string | null) => useSketcher.setState({ message });

const num = (v: Values, key: string): number => {
    const raw = v[key];
    return typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
};

/** The block instance selected in the sketch, if any. */
function selectedInsert(g: SketchGeometry) {
    for (const x of useSketcher.getState().selection) {
        const i = insertOf(g, x.id);
        if (i) {
            return i;
        }
    }
    return null;
}

/** The block's entities as polylines at a placement (the ghost of an instance about to be placed). */
function blockGhost(block: SketchBlock, p: { at: Pt; angle: number; scale: number }): Pt[][] {
    const place = placeOf(p);
    return geometryEntities(block.geometry).map((e) => entityPoints(e).map(place));
}

function PlacePicker({ api, label, onPlace, ghost }: { api: PopupApi; label: string; onPlace: (at: Pt) => void; ghost?: (at: Pt) => Pt[][] }) {
    const [on, setOn] = useState(false);
    const latest = useRef({ onPlace, ghost, api });
    latest.current = { onPlace, ghost, api };
    useEffect(() => {
        if (!on) {
            return;
        }
        setViewPicker({
            click: (raw) => {
                latest.current.onPlace(raw);
                return true;
            },
            move: (raw) => {
                const g = latest.current.ghost;
                useSketchExtras.setState({ preview: g ? g(raw) : [], marker: raw });
            },
        });
        return () => {
            setViewPicker(null);
            useSketchExtras.setState({ preview: [], marker: null });
        };
    }, [on]);
    useEffect(() => () => clearExtras(), []);
    return (
        <button type="button" className={`sx-small ${on ? 'on' : ''}`} onClick={() => setOn(!on)}>
            {on ? 'Click in the view… (click here to stop)' : label}
        </button>
    );
}

// ---- Make Block -------------------------------------------------------------------------------------------------

const makeBlockTool: ToolDef = {
    id: 'sk-block-make',
    label: 'Make block',
    icon: 'block-make',
    hint: 'selected entities (text, equation curves and blocks too) become one block',
    panel: true,
    width: 300,
    fields: () => [
        { key: 'name', label: 'Block name', kind: 'text', section: 'Block' },
        { key: 'x', label: 'Insertion point X', kind: 'number', unit: 'mm', section: 'Insertion point' },
        { key: 'y', label: 'Insertion point Y', kind: 'number', unit: 'mm', section: 'Insertion point' },
    ] satisfies Field[],
    defaults: () => {
        const s = useSketcher.getState();
        const ids = s.selection.filter((x) => x.type === 'curve').map((x) => x.id);
        const centre = ids.length ? entitiesCentre(s.geometry, ids) : null;
        return { entities: ids, name: `Block${(s.geometry.blocks?.length ?? 0) + 1}`, x: fmt(centre?.[0] ?? 0), y: fmt(centre?.[1] ?? 0) };
    },
    top: (api) => (
        <>
            <CurveList api={api} valueKey="entities" label="Block entities" empty="Click here, then the entities in the view" accept={() => null} />
            <p className="tb-note">Text, equation curves and blocks go into the block whole (a block inside a block is a nested block).</p>
        </>
    ),
    extra: (api) => (
        <div className="sx-row">
            <PlacePicker api={api} label="Pick the insertion point in the view" onPlace={(at) => api.set({ x: fmt(at[0]), y: fmt(at[1]) })} />
            <button type="button" className="sx-small" onClick={() => {
                const c = entitiesCentre(useSketcher.getState().geometry, (api.values.entities as string[]) ?? []);
                if (c) {
                    api.set({ x: fmt(c[0]), y: fmt(c[1]) });
                }
            }}>
                Centre of the entities
            </button>
        </div>
    ),
    apply: async (v) => {
        const ids = Array.isArray(v.entities) ? (v.entities as string[]) : [];
        const at: Pt = [num(v, 'x'), num(v, 'y')];
        if (!ids.length) {
            return ok('Pick the entities for the block.');
        }
        if (!at.every(Number.isFinite)) {
            return ok('The insertion point must be numbers.');
        }
        const r = makeBlock(useSketcher.getState().geometry, ids, at, String(v.name ?? ''));
        if (typeof r === 'string') {
            return ok(r);
        }
        if (!commitGeometry(r.g)) {
            return ok(useSketcher.getState().message ?? 'Not applied.');
        }
        useSketcher.setState({ selection: [] });
        say(`Block ${r.block.name} made.`);
        return ok(null);
    },
};

// ---- Block files ----------------------------------------------------------------------------------------------

let fileList: string[] = [];

async function loadBlockFiles(): Promise<string[]> {
    const r = await fetch('/api/blocks').then((x) => x.json()).catch(() => ({}));
    fileList = Array.isArray(r.blocks) ? r.blocks : [];
    return fileList;
}

async function readBlockFile(name: string): Promise<BlockFileData | string> {
    const r = await fetch(`/api/blocks/${encodeURIComponent(name)}`).then((x) => x.json()).catch(() => ({}));
    return r.block ?? (r.error as string | undefined) ?? 'The block file could not be read.';
}

/** A block file's definition in the sketch (the same file again: the one already brought in). */
async function definitionFromFile(name: string, link: boolean): Promise<string> {
    const file = await readBlockFile(name);
    if (typeof file === 'string') {
        throw new Error(file);
    }
    const g = useSketcher.getState().geometry;
    const added = addBlockDefinition(g, file.name, file.geometry, { colour: file.colour, blocks: file.blocks, ...(link ? { link: name } : {}) });
    if (added.g !== g && JSON.stringify(added.g.blocks) !== JSON.stringify(g.blocks) && !commitGeometry(added.g)) {
        throw new Error(useSketcher.getState().message ?? 'The block could not be added.');
    }
    return added.block.id;
}

/** Link to file: linked blocks take their file's content again; null when none changed. */
export async function refreshLinkedBlocks(): Promise<string | null> {
    let g = useSketcher.getState().geometry;
    const linked = (g.blocks ?? []).filter((b) => b.link);
    const changed: string[] = [];
    for (const b of linked) {
        const file = await readBlockFile(b.link!);
        if (typeof file === 'string') {
            continue;
        }
        const next = updateFromFile(g, b.id, file);
        if (next) {
            g = next;
            changed.push(b.name);
        }
    }
    if (!changed.length || !commitGeometry(g)) {
        return null;
    }
    const text = `Updated from their files: ${changed.join(', ')}.`;
    say(text);
    return text;
}

// A sketch opened with linked blocks: they follow their files.
useSketcher.subscribe((s, prev) => {
    if (s.active && s.stage === 'draw' && !(prev.active && prev.stage === 'draw') && (s.geometry.blocks ?? []).some((b) => b.link)) {
        window.setTimeout(() => void refreshLinkedBlocks(), 0);
    }
});

// ---- Insert Block and the Block PropertyManager -------------------------------------------------------------------

function BlockChooser({ api }: { api: PopupApi }) {
    // The fields themselves: a selector that returns `?? []` builds a new array on every call, and React loops.
    const blocks = useSketcher((s) => s.geometry.blocks) ?? NO_LIST;
    const inserts = useSketcher((s) => s.geometry.inserts) ?? NO_LIST;
    const [files, setFiles] = useState<string[]>(fileList);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        void loadBlockFiles().then(setFiles);
    }, []);
    if (api.values.insert) {
        const insert = inserts.find((i) => i.id === api.values.insert);
        const block = blocks.find((b) => b.id === insert?.block);
        return (
            <p className="tb-note">
                Instance of block <b>{block?.name ?? '?'}</b>. It moves as one rigid body: drag it, or add relations to its entities or its insertion point.
                {block?.link ? <> Linked to the file <b>{block.link}</b>.</> : null}
            </p>
        );
    }
    const fromFile = async (name: string) => {
        setError(null);
        try {
            api.set({ block: await definitionFromFile(name, !!api.values.link), file: name });
        } catch (e) {
            setError((e as Error).message);
        }
    };
    const editing = blockEditing();
    return (
        <>
            <div className="tb-field">
                <span>Open blocks</span>
                <ul className="sx-list" aria-label="Blocks of this sketch">
                    {!blocks.length && <li><span>None yet: make one, or open a block file below.</span></li>}
                    {blocks.map((b) => (
                        <li key={b.id} className={api.values.block === b.id ? 'on' : ''} onClick={() => api.set({ block: b.id, file: '' })}>
                            <span>{b.name}{b.link ? ' (linked)' : ''}</span>
                            <em>{editing?.block === b.id ? 'open' : `${inserts.filter((i) => i.block === b.id).length} placed`}</em>
                        </li>
                    ))}
                </ul>
            </div>
            <div className="tb-field">
                <span>Block files (projects folder)</span>
                <ul className="sx-list" aria-label="Block files">
                    {!files.length && <li><span>No saved blocks.</span></li>}
                    {files.map((f) => (
                        <li key={f} className={api.values.file === f ? 'on' : ''} onClick={() => void fromFile(f)}>
                            <span>{f}</span>
                        </li>
                    ))}
                </ul>
            </div>
            {error && <p className="tb-note sx-warn">{error}</p>}
        </>
    );
}

function placementOf(v: Values): { at: Pt; angle: number; scale: number } {
    return { at: [num(v, 'x'), num(v, 'y')], angle: num(v, 'angle'), scale: num(v, 'scale') };
}

/** Why a block cannot be placed here (inside itself while it is open), or null. */
function insertRefusal(blockId: string): string | null {
    const e = blockEditing();
    const blocks = useSketcher.getState().geometry.blocks ?? [];
    return e && (blockId === e.block || blockContains(blocks, blockId, e.block)) ? 'A block cannot hold an instance of itself.' : null;
}

const insertBlockTool: ToolDef = {
    id: 'sk-block-insert',
    label: 'Insert block',
    icon: 'block-insert',
    hint: 'another instance of a block, or a block from a file; with an instance selected, its properties',
    panel: true,
    width: 300,
    fields: () => [
        { key: 'link', label: 'Link to file', kind: 'check', section: 'Definition' },
        { key: 'x', label: 'Insertion point X', kind: 'number', unit: 'mm', section: 'Parameters' },
        { key: 'y', label: 'Insertion point Y', kind: 'number', unit: 'mm', section: 'Parameters' },
        { key: 'angle', label: 'Block rotation', kind: 'number', unit: 'deg', section: 'Parameters' },
        { key: 'scale', label: 'Block scale', kind: 'number', min: 0, step: 0.1, section: 'Parameters' },
        { key: 'lockAngle', label: 'Lock angle', kind: 'check', section: 'Parameters' },
        { key: 'construction', label: 'For construction', kind: 'check', section: 'Parameters' },
        { key: 'colour', label: 'Block colour', kind: 'color', section: 'Appearance', show: (x) => !!x.insert },
        { key: 'ownColour', label: 'Own colour for this block', kind: 'check', section: 'Appearance', show: (x) => !!x.insert },
    ] satisfies Field[],
    defaults: () => {
        const g = useSketcher.getState().geometry;
        const insert = selectedInsert(g);
        if (insert) {
            const block = g.blocks?.find((b) => b.id === insert.block);
            return {
                insert: insert.id, block: insert.block, x: fmt(insert.at[0]), y: fmt(insert.at[1]), angle: fmt(insert.angle), scale: fmt(insert.scale),
                lockAngle: !!insert.lockAngle, construction: !!insert.construction, link: !!block?.link,
                colour: block?.colour ?? '#ffd166', ownColour: !!block?.colour, file: '',
            };
        }
        return {
            insert: '', block: g.blocks?.[g.blocks.length - 1]?.id ?? '', x: '0', y: '0', angle: '0', scale: '1', lockAngle: false, construction: false, link: false, file: '',
            colour: '#ffd166', ownColour: false,
        };
    },
    onChange: (key, v) => {
        const g = useSketcher.getState().geometry;
        if (!v.insert) {
            // Link to file after a file was chosen: that file's definition, linked or not.
            if (key === 'link' && v.file) {
                void definitionFromFile(String(v.file), !!v.link).then((id) => window.dispatchEvent(new CustomEvent('jarvis:block-chosen', { detail: id }))).catch(() => undefined);
            }
            return undefined;
        }
        const insert = g.inserts?.find((i) => i.id === v.insert);
        const block = g.blocks?.find((b) => b.id === insert?.block);
        if (!insert || !block) {
            return undefined;
        }
        // An instance's properties change it at once.
        if (['x', 'y', 'angle', 'scale', 'lockAngle', 'construction'].includes(key)) {
            const r = placeInsert(g, insert.id, placementOf(v), { lockAngle: !!v.lockAngle || undefined, construction: !!v.construction || undefined });
            if (typeof r !== 'string') {
                commitGeometry(r);
            } else {
                say(r);
            }
        }
        if (key === 'colour' || key === 'ownColour') {
            commitGeometry(setBlockProps(g, block.id, { colour: v.ownColour ? String(v.colour) : undefined }));
        }
        if (key === 'link') {
            if (!v.link) {
                // Cleared: the block is this sketch's own again, and can be edited here.
                commitGeometry(setBlockProps(g, block.id, { link: undefined }));
                say(`Block ${block.name} is no longer linked to its file.`);
            } else {
                const name = block.name;
                if (!fileList.includes(name)) {
                    say(`There is no block file named ${name}: save the block first (Save block), then link it.`);
                    return { link: false };
                }
                if (commitGeometry(setBlockProps(g, block.id, { link: name }))) {
                    void refreshLinkedBlocks();
                }
            }
        }
        return undefined;
    },
    top: (api) => <BlockChooser api={api} />,
    extra: (api) => <InsertExtra api={api} />,
    apply: async (v) => {
        if (v.insert) {
            return ok(null);
        }
        const refused = insertRefusal(String(v.block ?? ''));
        if (refused) {
            return ok(refused);
        }
        const r = insertBlock(useSketcher.getState().geometry, String(v.block ?? ''), placementOf(v), insertOptions(v));
        if (typeof r === 'string') {
            return ok(r);
        }
        return ok(commitGeometry(r.g) ? null : useSketcher.getState().message ?? 'Not applied.');
    },
};

const insertOptions = (v: Values) => ({ ...(v.lockAngle ? { lockAngle: true } : {}), ...(v.construction ? { construction: true } : {}) });

function InsertExtra({ api }: { api: PopupApi }) {
    const g = useSketcher((s) => s.geometry);
    const latest = useRef(api);
    latest.current = api;
    useEffect(() => {
        const chosen = (e: Event) => latest.current.set({ block: (e as CustomEvent<string>).detail });
        window.addEventListener('jarvis:block-chosen', chosen);
        return () => window.removeEventListener('jarvis:block-chosen', chosen);
    }, []);
    const block = g.blocks?.find((b) => b.id === api.values.block);
    if (api.values.insert) {
        const id = String(api.values.insert);
        return (
            <>
                <div className="sx-row">
                    <button type="button" className="sx-small" onClick={() => api.run(async () => ok(startBlockEdit(id)))}>Edit block</button>
                    <button type="button" className="sx-small" onClick={() => api.run(async () => ok(explodeById(id)))}>Explode block</button>
                    <button type="button" className="sx-small" onClick={() => say(setHidden(id, true))}>Hide</button>
                    {block?.link && <button type="button" className="sx-small" onClick={() => void refreshLinkedBlocks().then((t) => say(t ?? 'The block is the same as its file.'))}>Update from file</button>}
                </div>
                {block?.link && <p className="tb-note">Linked to its file: edits go to the file (open it in its own sketch, Save block), or clear Link to file to edit it here.</p>}
            </>
        );
    }
    return (
        <div className="sx-row">
            {block && (
                <PlacePicker api={api} label="Place copies by clicking in the view"
                    ghost={(at) => blockGhost(block, { ...placementOf(api.values), at })}
                    onPlace={(at) => {
                        const refused = insertRefusal(block.id);
                        const r = refused ?? insertBlock(useSketcher.getState().geometry, block.id, { ...placementOf(api.values), at }, insertOptions(api.values));
                        if (typeof r === 'string' || !commitGeometry(r.g)) {
                            say(typeof r === 'string' ? r : useSketcher.getState().message);
                        }
                    }}
                />
            )}
            {block && !(g.inserts ?? []).some((i) => i.block === block.id) && (
                <button type="button" className="sx-small danger" onClick={() => {
                    const r = deleteBlockDefinition(useSketcher.getState().geometry, block.id);
                    if (typeof r === 'string') {
                        say(r);
                    } else if (commitGeometry(r)) {
                        api.set({ block: '' });
                    }
                }}>
                    Delete block definition
                </button>
            )}
        </div>
    );
}

// ---- Hide, show, explode ---------------------------------------------------------------------------------------

/** Hides or shows one instance (it stays part of the sketch). */
export function setHidden(id: string, hidden: boolean): string | null {
    const g = useSketcher.getState().geometry;
    const insert = g.inserts?.find((i) => i.id === id);
    if (!insert) {
        return 'That block instance is gone.';
    }
    const next = { ...g, inserts: g.inserts!.map((i) => (i.id === id ? (hidden ? { ...i, hidden: true } : (({ hidden: _, ...rest }) => rest)(i)) : i)) };
    if (!commitGeometry(next)) {
        return useSketcher.getState().message;
    }
    if (hidden) {
        useSketcher.setState({ selection: useSketcher.getState().selection.filter((x) => !insert.curves.includes(x.id) && !insert.points.includes(x.id)) });
    }
    return hidden ? 'Block hidden: right-click empty space in the sketch to show hidden blocks again.' : null;
}

/** Shows every hidden instance again. */
export function showHiddenBlocks(): void {
    const g = useSketcher.getState().geometry;
    if ((g.inserts ?? []).some((i) => i.hidden)) {
        commitGeometry({ ...g, inserts: g.inserts!.map(({ hidden: _, ...i }) => i) });
    }
}

function explodeById(id: string): string | null {
    const r = explodeWithNote(useSketcher.getState().geometry, id);
    if (!r) {
        return 'Select a block instance to explode.';
    }
    if (!commitGeometry(r.g)) {
        return useSketcher.getState().message ?? 'Not applied.';
    }
    useSketcher.setState({ selection: [], message: r.note });
    return null;
}

const explodeBlockTool: ToolDef = {
    id: 'sk-block-explode',
    label: 'Explode block',
    icon: 'block-explode',
    hint: 'the selected block instance becomes plain entities',
    instant: () => {
        const g = useSketcher.getState().geometry;
        const insert = selectedInsert(g);
        const error = insert ? explodeById(insert.id) : 'Select a block instance first, then Explode block.';
        if (error) {
            say(error);
        }
    },
};

// ---- Edit Block ------------------------------------------------------------------------------------------------

/**
 * The sketch outside the block while a block is open for editing: as it was when the edit began (for undo and
 * Cancel), and as it is now (Rebuild may have applied the block to it).
 */
let editing: { block: string; insert: string; at: Pt; start: SketchGeometry; outer: SketchGeometry; undo: SketchGeometry[]; redo: SketchGeometry[] } | null = null;

export const blockEditing = () => editing;

function backdropOf(outer: SketchGeometry, insertId: string): Pt[][] {
    const insert = outer.inserts?.find((i) => i.id === insertId);
    return geometryEntities(outer).filter((e) => !insert?.curves.includes(e.id)).map((e) => entityPoints(e));
}

/** Opens the instance's block in the sketcher (at the instance's insertion point, unturned and unscaled). */
export function startBlockEdit(insertId: string, openForm = true): string | null {
    if (editing) {
        return 'A block is open for editing already.';
    }
    const s = useSketcher.getState();
    const insert = s.geometry.inserts?.find((i) => i.id === insertId);
    const block = insert && s.geometry.blocks?.find((b) => b.id === insert.block);
    if (!insert || !block) {
        return 'Select a block instance to edit its block.';
    }
    if (block.link) {
        return `Block ${block.name} is linked to the file ${block.link}: clear Link to file in its properties to edit it here.`;
    }
    editing = { block: block.id, insert: insert.id, at: insert.at, start: s.geometry, outer: s.geometry, undo: s.undo, redo: s.redo };
    useSketchExtras.setState({ backdrop: backdropOf(s.geometry, insert.id) });
    // The block's own content, with the sketch's block definitions (for blocks inside it).
    const inside: SketchGeometry = { ...blockAt(block, insert.at), blocks: s.geometry.blocks };
    useSketcher.setState({ geometry: inside, undo: [], redo: [], selection: [] });
    commitGeometry(inside);
    useSketcher.setState({ undo: [] });
    setBeforeOutput(() => finishBlockEdit(true));
    if (openForm) {
        window.setTimeout(() => window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: 'sk-block-edit' })), 0);
    }
    return null;
}

/** The sketch with the block as it is open now. */
function appliedEdit(e: NonNullable<typeof editing>): SketchGeometry {
    const inside = useSketcher.getState().geometry;
    return redefineBlock({ ...e.outer, blocks: inside.blocks ?? e.outer.blocks }, e.block, blockFrom(inside, e.at));
}

/**
 * Rebuild Block: the block as it is open now goes to the sketch, which is solved (relations to the instances hold
 * again), while the block stays open.
 */
export function rebuildBlockEdit(): string | null {
    const e = editing;
    if (!e) {
        return 'Rebuild block works while a block is open for editing (Edit block).';
    }
    const solved = solveGeometry(appliedEdit(e));
    if (!solved.ok) {
        return 'The sketch does not solve with the block as it is: change the block, or its relations to the sketch.';
    }
    e.outer = solved.geometry;
    // The instance may have moved to meet its relations: the open block goes with it.
    const insert = solved.geometry.inserts?.find((i) => i.id === e.insert);
    if (insert && (insert.at[0] !== e.at[0] || insert.at[1] !== e.at[1])) {
        const by: Pt = [insert.at[0] - e.at[0], insert.at[1] - e.at[1]];
        e.at = insert.at;
        useSketcher.setState({ geometry: shiftGeometry(useSketcher.getState().geometry, by) });
    }
    useSketchExtras.setState({ backdrop: backdropOf(e.outer, e.insert) });
    return null;
}

/** Closes the block: with save, its new entities go to every instance (one undo step); else it is dropped. */
export function finishBlockEdit(save: boolean): string | null {
    const e = editing;
    if (!e) {
        return null;
    }
    const next = save ? appliedEdit(e) : null;
    editing = null;
    setBeforeOutput(null);
    useSketchExtras.setState({ backdrop: [] });
    useSketcher.setState({ geometry: e.start, undo: e.undo, redo: e.redo, selection: [] });
    if (!next) {
        return null;
    }
    return commitGeometry(next) ? null : useSketcher.getState().message ?? 'The block could not be applied.';
}

// A sketch closed or discarded mid-edit leaves nothing behind.
useSketcher.subscribe((s, prev) => {
    if (prev.active && !s.active && editing) {
        editing = null;
        setBeforeOutput(null);
        useSketchExtras.setState({ backdrop: [] });
    }
});

function EditSession() {
    // Cancel (the form closing without OK) drops the changes.
    useEffect(() => () => {
        if (editing) {
            finishBlockEdit(false);
        }
    }, []);
    return null;
}

const editBlockTool: ToolDef = {
    id: 'sk-block-edit',
    label: 'Edit block',
    icon: 'block-edit',
    hint: 'open the selected instance\'s block: changes go to every instance',
    panel: true,
    width: 300,
    fields: () => [
        { key: 'ownColour', label: 'Own colour for this block', kind: 'check', section: 'Appearance' },
        { key: 'colour', label: 'Sketch/curve colour', kind: 'color', section: 'Appearance', show: (v) => !!v.ownColour },
    ] satisfies Field[],
    defaults: () => {
        if (!editing) {
            const insert = selectedInsert(useSketcher.getState().geometry);
            const error = insert ? startBlockEdit(insert.id, false) : null;
            if (error) {
                say(error);
            }
        }
        const block = editing && editing.outer.blocks?.find((b) => b.id === editing!.block);
        return { ownColour: !!block?.colour, colour: block?.colour ?? '#ffd166' };
    },
    onChange: (key, v) => {
        const e = editing;
        if (e && (key === 'colour' || key === 'ownColour')) {
            // The colour is the block's (saved with it), applied with OK.
            e.outer = setBlockProps(e.outer, e.block, { colour: v.ownColour ? String(v.colour) : undefined });
        }
        return undefined;
    },
    top: () => {
        const e = editing;
        const block = e && e.outer.blocks?.find((b) => b.id === e.block);
        return (
            <>
                <EditSession />
                <p className="tb-note">
                    {block
                        ? <>Editing block <b>{block.name}</b>: draw, delete, add relations and dimensions with the sketch tools; Make block here makes a block inside
                            it. Rebuild applies it to the sketch and keeps it open; OK applies the changes to every instance; Cancel drops them. The rest of the
                            sketch is shown in grey.</>
                        : 'Select a block instance in the view, then Edit block.'}
                </p>
            </>
        );
    },
    extra: (api) => editing && (
        <div className="sx-row">
            <button type="button" className="sx-small" onClick={() => api.run(async () => ok(rebuildBlockEdit()), false)}>Rebuild block</button>
        </div>
    ),
    apply: async () => ok(editing ? finishBlockEdit(true) : 'Select a block instance in the view, then Edit block.'),
};

const rebuildBlockTool: ToolDef = {
    id: 'sk-block-rebuild',
    label: 'Rebuild block',
    icon: 'block-rebuild',
    hint: 'while a block is open: apply it to the sketch so relations to it hold again, and keep it open',
    instant: () => say(rebuildBlockEdit() ?? 'Block rebuilt in the sketch.'),
};

// ---- Add/Remove ------------------------------------------------------------------------------------------------

const addRemoveTool: ToolDef = {
    id: 'sk-block-addremove',
    label: 'Add/remove block entities',
    icon: 'block-addremove',
    hint: 'move sketch entities into the selected block instance, or out of it',
    panel: true,
    width: 300,
    defaults: () => {
        const g = useSketcher.getState().geometry;
        const insert = selectedInsert(g);
        return { insert: insert?.id ?? '', entities: [] };
    },
    top: (api) => {
        const g = useSketcher.getState().geometry;
        const insert = g.inserts?.find((i) => i.id === api.values.insert);
        const block = g.blocks?.find((b) => b.id === insert?.block);
        if (!insert || !block) {
            return <p className="tb-note">Select a block instance in the view first, then Add/remove block entities.</p>;
        }
        const ids = Array.isArray(api.values.entities) ? (api.values.entities as string[]) : [];
        const out = ids.filter((id) => insert.curves.includes(id)).length;
        return (
            <>
                <p className="tb-note">Block <b>{block.name}</b>: click its entities to take them out (they stay in the sketch), or other entities of the sketch to put them in.
                    Every instance changes.</p>
                <CurveList api={api} valueKey="entities" label="Block entities to add or remove" empty="Click here, then the entities in the view"
                    accept={(geometry, id) => (insert.curves.includes(id) || !ownerOf(geometry, id) ? null : 'Text, equation curves and other blocks cannot be added this way: make a block of them first.')} />
                <p className="tb-note">{out} to take out, {ids.length - out} to put in.</p>
            </>
        );
    },
    apply: async (v) => {
        const g = useSketcher.getState().geometry;
        const insert = g.inserts?.find((i) => i.id === v.insert);
        if (!insert) {
            return ok('Select a block instance in the view first.');
        }
        const ids = Array.isArray(v.entities) ? (v.entities as string[]) : [];
        const r = addRemoveEntities(g, insert.id, ids.filter((id) => !insert.curves.includes(id)), ids.filter((id) => insert.curves.includes(id)));
        if (typeof r === 'string') {
            return ok(r);
        }
        if (!commitGeometry(r)) {
            return ok(useSketcher.getState().message ?? 'Not applied.');
        }
        useSketcher.setState({ selection: [] });
        return ok(null);
    },
};

// ---- Save Block ------------------------------------------------------------------------------------------------

const saveBlockTool: ToolDef = {
    id: 'sk-block-save',
    label: 'Save block',
    icon: 'block-save',
    hint: 'write a block to a file in the projects folder',
    panel: true,
    width: 300,
    fields: () => {
        const blocks = useSketcher.getState().geometry.blocks ?? [];
        return [
            { key: 'block', label: 'Block', kind: 'select', section: 'Block', options: blocks.map((b) => ({ value: b.id, label: b.name })) },
            { key: 'name', label: 'File name', kind: 'text', section: 'Block' },
        ] satisfies Field[];
    },
    defaults: () => {
        const g = useSketcher.getState().geometry;
        const insert = selectedInsert(g);
        const block = g.blocks?.find((b) => b.id === insert?.block) ?? g.blocks?.[0];
        return { block: block?.id ?? '', name: block?.name ?? '' };
    },
    onChange: (key, v) => {
        if (key === 'block') {
            const b = useSketcher.getState().geometry.blocks?.find((x) => x.id === v.block);
            return b ? { name: b.name } : undefined;
        }
    },
    top: () => (
        <p className="tb-note">Saved as a block file in the blocks folder of the projects folder, with its colour and the blocks inside it; Insert block lists the files.
            Saving under the same name replaces the file, and blocks linked to it follow when their sketch is opened.</p>
    ),
    apply: async (v) => {
        const data = blockFileOf(useSketcher.getState().geometry, String(v.block ?? ''), String(v.name ?? ''));
        if (!data) {
            return ok('This sketch has no block to save.');
        }
        const r = await fetch('/api/blocks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
            .then(async (x) => ({ ok: x.ok, body: await x.json().catch(() => ({})) })).catch(() => ({ ok: false, body: { error: 'The server could not be reached.' } }));
        if (!r.ok) {
            return ok(r.body.error ?? 'The block could not be saved.');
        }
        void loadBlockFiles();
        say(`Saved block file ${r.body.name}.`);
        return ok(null);
    },
};

export const blockTools: ToolDef[] = [makeBlockTool, insertBlockTool, editBlockTool, rebuildBlockTool, addRemoveTool, explodeBlockTool, saveBlockTool];

/** Right-click: Explode block, Edit block, Hide block. */
export function explodeInsert(id: string): void {
    const error = explodeById(id);
    if (error) {
        say(error);
    }
}

export function editInsert(id: string): void {
    say(startBlockEdit(id));
}

export function hideInsert(id: string): void {
    say(setHidden(id, true));
}
