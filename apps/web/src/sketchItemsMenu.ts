// Right-click entries of sketch text, equation curves, block instances and pictures in the open sketch (pure: the
// actions run through the menu's actions, see contextMenus.tsx).

import type { SketchGeometry } from '@jarvis/core';
import type { MenuEntry } from './menus';
import type { Pick } from './sketchGeometry';
import { ownerOf } from './sketchItems';
import { patternRecordOf } from './sketchPatternRecord';

export type ItemAction = 'dissolveText' | 'explodeBlock' | 'editBlock' | 'hideBlock' | 'showBlocks' | 'editPattern' | 'patternCount';

export interface ItemMenuActions {
    openTool(id: string): void;
    itemAction?(action: ItemAction, id: string): void;
}

/** The header name and the entries for a picked curve of a text, equation curve or block instance. */
export function itemEntries(g: SketchGeometry, picks: Pick[], a: ItemMenuActions): { header: string; entries: MenuEntry[] } | null {
    const owner = picks.length ? ownerOf(g, picks[0].id) : null;
    if (!owner) {
        // A curve of a sketch pattern (an instance or the original): edit the pattern, show its count.
        const pattern = picks.length === 1 ? patternRecordOf(g, picks[0].id) : null;
        const word = pattern?.kind === 'linear' ? 'linear' : 'circular';
        return pattern ? {
            header: `${word === 'linear' ? 'Linear' : 'Circular'} sketch pattern`,
            entries: [
                { label: `Edit ${word} pattern`, icon: word === 'linear' ? 'pattern' : 'pattern-circular', title: 'Opens the pattern with its values; OK makes it again', onSelect: () => a.itemAction?.('editPattern', pattern.id) },
                { label: 'Display instance count', checked: !!pattern.showCount, title: 'Shows the number of instances in the view (double-click it to change it)', onSelect: () => a.itemAction?.('patternCount', pattern.id) },
            ],
        } : null;
    }
    // An offset of curves has no entries of its own here (its form opens from the Offset tool).
    if (owner.kind === 'offset' || picks.some((p) => ownerOf(g, p.id)?.id !== owner.id)) {
        return null;
    }
    const act = (action: ItemAction) => () => a.itemAction?.(action, owner.id);
    if (owner.kind === 'text') {
        return {
            header: 'Sketch text',
            entries: [
                { label: 'Edit text', icon: 'sketch-text', title: 'Opens the Sketch Text form', onSelect: () => a.openTool('sk-text') },
                { label: 'Dissolve sketch text', icon: 'block-explode', title: 'Turns the text into plain lines and splines', onSelect: act('dissolveText') },
            ],
        };
    }
    if (owner.kind === 'equation') {
        return {
            header: 'Equation driven curve',
            entries: [{ label: 'Edit equation curve', icon: 'equation-curve', onSelect: () => a.openTool('sk-equation-curve') }],
        };
    }
    const insert = g.inserts?.find((i) => i.id === owner.id);
    const block = g.blocks?.find((b) => b.id === insert?.block);
    return {
        header: block ? `Block ${block.name}` : 'Block',
        entries: [
            { label: 'Edit block', icon: 'block-edit', title: 'Opens the block: changes go to every instance', onSelect: act('editBlock') },
            { label: 'Explode block', icon: 'block-explode', title: 'This instance becomes plain entities', onSelect: act('explodeBlock') },
            { label: 'Block properties', icon: 'block-insert', title: 'Position, angle, scale, lock angle, construction, colour and link of this instance', onSelect: () => a.openTool('sk-block-insert') },
            { label: 'Add/remove entities', icon: 'block-addremove', title: 'Moves sketch entities into the block, or out of it', onSelect: () => a.openTool('sk-block-addremove') },
            { label: 'Hide block', icon: 'block-explode', title: 'Hides this instance in the view (it stays in the sketch)', onSelect: act('hideBlock') },
            { label: 'Save block', icon: 'block-save', title: 'Writes the block to a file in the projects folder', onSelect: () => a.openTool('sk-block-save') },
        ],
    };
}

/** Empty space in a sketch with pictures: their form; with hidden blocks: show them. */
export function pictureEntries(g: SketchGeometry, a: ItemMenuActions): MenuEntry[] {
    const hidden = (g.inserts ?? []).filter((i) => i.hidden).length;
    return [
        ...(g.pictures?.length
            ? [{ label: g.pictures.length === 1 ? 'Sketch picture' : `Sketch pictures (${g.pictures.length})`, icon: 'sketch-picture', onSelect: () => a.openTool('sk-picture') }]
            : []),
        ...(hidden ? [{ label: `Show hidden blocks (${hidden})`, icon: 'block-insert', onSelect: () => a.itemAction?.('showBlocks', '') }] : []),
    ];
}
