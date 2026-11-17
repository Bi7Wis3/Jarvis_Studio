import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FeatureFolder, Part } from '@jarvis/core';
import {
    componentTreeRows, dropPlace, dropZone, folderPrefix, folderShown, isDragged, placeArgs, rangeKeys, rowIndex, rowParts, shownKeys,
    withHidden, type FolderRow,
} from './componentTree';
import { ComponentTreeView, componentTreeMenu, useComponentTreeUi } from './ComponentTree';
import { folderKey } from './treeFolders';

const material = { color: '#888888', metalness: 0, roughness: 1 };
const part = (id: string, instanceOf?: string): Part => ({
    id, name: id.toUpperCase(), shape: { kind: 'empty' }, position: [0, 0, 0], rotation: [0, 0, 0], material, ...(instanceOf ? { instanceOf } : {}),
});

// base, Drive[ wheel (wheel-2 under it), Pins[ pin ] ], cap
const parts = [part('base'), part('wheel'), part('pin'), part('cap'), part('wheel-2', 'wheel')];
const folders: FeatureFolder[] = [
    { id: 'folder_drive', name: 'Drive', items: ['wheel', 'folder_pins'] },
    { id: 'folder_pins', name: 'Pins', items: ['pin'] },
];
const rows = componentTreeRows(parts, folders);
const index = rowIndex(rows);
const drive = index.get(folderKey('folder_drive')) as FolderRow;
const pins = index.get(folderKey('folder_pins')) as FolderRow;

describe('the assembly tree rows', () => {
    it('wraps the designs in their folders, instances staying under their design', () => {
        expect(rows.map((r) => r.key)).toEqual(['base', folderKey('folder_drive'), 'cap']);
        expect(drive.items.map((r) => r.key)).toEqual(['wheel', folderKey('folder_pins')]);
        expect([drive.start, drive.end]).toEqual([1, 3]);
        expect(index.has('wheel-2')).toBe(false);
        // A folder stands for its designs' parts, sub-folders and instances included.
        expect(rowParts(parts, [drive])).toEqual(['wheel', 'pin', 'wheel-2']);
        expect(rowParts(parts, [index.get('cap')!])).toEqual(['cap']);
    });

    it('lists the rows as they show for Shift+click, a closed folder hiding its rows', () => {
        const all = shownKeys(rows, () => true);
        expect(all).toEqual(['base', folderKey('folder_drive'), 'wheel', folderKey('folder_pins'), 'pin', 'cap']);
        expect(shownKeys(rows, (id) => id !== 'folder_drive')).toEqual(['base', folderKey('folder_drive'), 'cap']);
        expect(rangeKeys(all, 'cap', 'wheel')).toEqual(['wheel', folderKey('folder_pins'), 'pin', 'cap']);
        expect(rangeKeys(all, 'gone', 'cap')).toEqual(['cap']);
    });
});

describe('dropping in the assembly tree', () => {
    it('finds the zone on a row as the part tree does', () => {
        const cap = index.get('cap')!;
        expect(dropZone(cap, 0.3, false)).toBe('before');
        expect(dropZone(cap, 0.6, false)).toBe('after');
        expect(dropZone(drive, 0.1, false)).toBe('before');
        expect(dropZone(drive, 0.5, false)).toBe('into');
        expect(dropZone(drive, 0.9, false)).toBe('after');
        // An open folder's lower edge is its first row's: still into it.
        expect(dropZone(drive, 0.9, true)).toBe('into');
    });

    it('places the drop: above or below a row, into a folder at its start from above, else at its end', () => {
        const base = index.get('base')!;
        const cap = index.get('cap')!;
        expect(dropPlace(cap, 'before', [base])).toEqual({ before: 'cap' });
        expect(dropPlace(base, 'after', [cap])).toEqual({ after: 'base' });
        expect(dropPlace(pins, 'into', [base])).toEqual({ into: 'folder_pins', at: 'start' });
        expect(dropPlace(pins, 'into', [cap])).toEqual({ into: 'folder_pins', at: 'end' });
        expect(placeArgs({ into: null, at: 'start' })).toEqual({ at: 'start' });
        expect(placeArgs({ into: 'folder_pins' })).toEqual({ into: 'folder_pins', at: 'end' });
    });

    it('lands nothing on a dragged row or inside a dragged folder', () => {
        const dragged = new Set([folderKey('folder_drive')]);
        expect(isDragged(index.get('pin'), dragged)).toBe(true);
        expect(isDragged(pins, dragged)).toBe(true);
        expect(isDragged(index.get('cap'), dragged)).toBe(false);
    });
});

describe('folder prefixes and visibility', () => {
    it('shows (+), (-) or (f) as SolidWorks does for a folder of components', () => {
        expect(folderPrefix(['fixed', 'under', 'over'])).toBe('(+) ');
        expect(folderPrefix(['fixed', 'under', 'defined'])).toBe('(-) ');
        expect(folderPrefix(['fixed', 'fixed'])).toBe('(f) ');
        expect(folderPrefix(['fixed', 'defined'])).toBe('');
        expect(folderPrefix([])).toBe('');
    });

    it('hides and shows every part of a folder', () => {
        expect(folderShown(['a', 'b'], ['b'])).toBe('mixed');
        expect(folderShown(['a', 'b'], ['a', 'b', 'c'])).toBe('hidden');
        expect(folderShown(['a'], undefined)).toBe('shown');
        expect(folderShown([], ['a'])).toBe('empty');
        expect(withHidden(['c', 'a'], ['a', 'b'], true)).toEqual(['c', 'a', 'b']);
        expect(withHidden(['c', 'a'], ['a', 'b'], false)).toEqual(['c']);
    });
});

describe('the folder rows', () => {
    const render = (open: string[]) => renderToStaticMarkup(createElement(ComponentTreeView, {
        parts, folders, renameComponent: () => undefined,
        renderDesign: (design: Part) => createElement('span', { className: 'design' }, design.name),
        open: new Set(open), renaming: null, selected: null, hidden: ['pin'],
        states: { base: 'fixed', wheel: 'under', 'wheel-2': 'defined', pin: 'defined', cap: 'under' },
    }));

    it('draws folders with their count, prefix and eye, and what is inside the open ones', () => {
        const html = render(['folder_drive']);
        // Drive is open: its wheel and the closed Pins folder show; base and cap around it.
        expect(html.match(/class="design">[A-Z0-9-]+</g)).toEqual(['class="design">BASE<', 'class="design">WHEEL<', 'class="design">CAP<']);
        expect(html).toContain('>Drive</span>');
        expect(html).toContain('>Pins</span>');
        // Drive holds an under defined component (-); Pins only fully defined ones (no prefix).
        expect(html).not.toMatch(/mt-prefix[^>]*>[^<]*<\/span><span class="br-text one-line"><span class="br-name ft-name">Pins/);
        expect(html).toMatch(/mt-prefix under[^>]*>\(-\)<\/span><span class="br-text one-line"><span class="br-name ft-name">Drive/);
        // Pins holds only the hidden pin: its eye shows it hidden; Drive's is half (some hidden).
        expect(html).toMatch(/◌<\/button><button[^>]*aria-label="More actions for Pins"/);
        expect(html).toMatch(/◐<\/button><button[^>]*aria-label="More actions for Drive"/);
        expect(html).toContain('--ct-depth:1');
        expect(render([]).match(/class="design">[A-Z0-9-]+</g)).toEqual(['class="design">BASE<', 'class="design">CAP<']);
    });

    it('offers Create new folder and Expand / Collapse all folders on the tree', () => {
        useComponentTreeUi.setState({ open: new Set(['folder_drive']) });
        const menu = componentTreeMenu(folders);
        expect(menu.map((e) => (typeof e === 'string' ? e : 'label' in e ? `${e.label}${'disabled' in e && e.disabled ? ' (off)' : ''}` : ''))).toEqual([
            'Create new folder', 'separator', 'Expand all folders', 'Collapse all folders',
        ]);
        useComponentTreeUi.setState({ open: new Set(['folder_drive', 'folder_pins']) });
        expect(componentTreeMenu(folders).find((e): e is { label: string; disabled?: boolean; onSelect: () => void } => typeof e !== 'string' && 'label' in e && e.label === 'Expand all folders')?.disabled).toBe(true);
    });
});
