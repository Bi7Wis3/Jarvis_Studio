// Right-click menu entries for the open sketch: what applies to pieces of curves picked with Alt (sketchPieces.ts),
// and Trim with each of its modes, for curves.

import type { SketchGeometry } from '@jarvis/core';
import type { MenuEntry } from './menus';
import { fittingRelationTools } from './constraintTools';
import { CURVE_NOUN } from './sketchCurves';
import { curveOf } from './solver';
import { setEditOptions, type EditOptions } from './sketcher';
import { splitOutPieces, usePieces } from './sketchPieces';

interface Actions {
    openTool(id: string): void;
    deleteSelected(): void;
}

const TRIM_MODES: [EditOptions['trimMode'], string][] = [
    ['power', 'Power trim'], ['corner', 'Corner'], ['inside', 'Trim away inside'], ['outside', 'Trim away outside'], ['closest', 'Trim to closest'],
];

/** Trim, opened in the mode picked from the submenu. */
export function trimMenuEntry(a: Pick<Actions, 'openTool'>): MenuEntry {
    return {
        label: 'Trim',
        icon: 'trim',
        title: 'Cut curves back to where others cross them',
        items: TRIM_MODES.map(([mode, label]): MenuEntry => ({
            label,
            onSelect: () => {
                setEditOptions({ trimMode: mode });
                a.openTool('sk-trim');
            },
        })),
    };
}

/** The entries for the pieces picked with Alt, or null when none is picked. */
export function pieceMenuEntries(g: SketchGeometry, a: Actions): MenuEntry[] | null {
    const picked = usePieces.getState().picked;
    if (!picked.length) {
        return null;
    }
    const noun = CURVE_NOUN[curveOf(g, picked[0].id)?.kind ?? 'line'];
    // The relations that fit the pieces as curves of their own (nothing changes until one is chosen).
    const split = splitOutPieces(g, picked);
    const relations = split ? fittingRelationTools(split.g, split.ids.map((id) => ({ type: 'curve' as const, id }))) : [];
    return [
        { header: picked.length === 1 ? `Piece of ${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}` : `${picked.length} pieces` },
        { label: 'Delete', icon: 'delete', hint: 'Del', danger: true, title: 'Trims the piece away, up to the crossings', onSelect: () => a.deleteSelected() },
        { label: 'Construction geometry', icon: 'c-construction', hint: 'X', title: 'Splits the piece out and makes it construction', onSelect: () => a.openTool('sk-construction') },
        'separator',
        ...relations.map((r): MenuEntry => ({ label: r.label, icon: `c-${r.id}`, title: r.hint, onSelect: () => a.openTool(`sk-c-${r.id}`) })),
        { label: 'Lock', icon: 'c-fix', title: 'Splits the piece out and keeps it where it is', onSelect: () => a.openTool('sk-c-fix') },
        'separator',
        trimMenuEntry(a),
    ];
}
