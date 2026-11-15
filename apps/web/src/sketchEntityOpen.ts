// Which PropertyManager a click on a line, circle, arc or point opens (sketchEntityForms.tsx), and opening it. Kept
// apart from the forms so the sketcher can call it without loading them.

import type { SketchGeometry } from '@jarvis/core';
import { entityOf, type EntityKind } from './sketchEntityParams';
import { useToolSession } from './toolSession';

/** The forms that follow the selection while open: another entity of the same kind needs no new form. */
export const ENTITY_FORM_IDS: Record<EntityKind, string> = { line: 'sk-pm-line', circle: 'sk-pm-circle', arc: 'sk-pm-arc', point: 'sk-pm-point' };

/** The form a click on this entity opens, or null. */
export function entityFormId(g: SketchGeometry, pick: { type: string; id: string }): string | null {
    const kind = (Object.keys(ENTITY_FORM_IDS) as EntityKind[]).find((k) => entityOf(g, k, pick));
    return kind ? ENTITY_FORM_IDS[kind] : null;
}

/** Forms of a selected item, and the exit panel of a feature's sketch, which a click on an entity may replace. */
const ITEM_FORMS = ['sk-text', 'sk-equation-curve', 'sk-block-insert', 'sk-belt', 'sk-finish'];

/** Whether a click may open an entity's form now: no form is open, or only the form of another selected item. */
export function entityFormMayOpen(open: string | null): boolean {
    return !open || open.startsWith('sk-pm-') || ITEM_FORMS.includes(open);
}

/**
 * Opens the entity's PropertyManager in the left panel (the same one open already just shows the new selection).
 * With a command's form open (Fully define, a pattern...), a click selects for that command instead, as in SolidWorks.
 */
export function openEntityForm(g: SketchGeometry, pick: { type: string; id: string }): void {
    const id = entityFormId(g, pick);
    const open = useToolSession.getState().toolId;
    if (!id || typeof window === 'undefined' || typeof CustomEvent === 'undefined' || open === id || !entityFormMayOpen(open)) {
        return;
    }
    window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: id }));
}
