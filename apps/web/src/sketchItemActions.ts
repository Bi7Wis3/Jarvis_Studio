// What the right-click entries of sketch text and block instances do (sketchItemsMenu.ts).

import type { ItemAction } from './sketchItemsMenu';
import { dissolveTextById } from './sketchTextForm';
import { editInsert, explodeInsert, hideInsert, showHiddenBlocks } from './sketchBlockForms';
import { startPatternEdit, togglePatternCount } from './sketchPatternForms';

export function runItemAction(action: ItemAction, id: string): void {
    if (action === 'dissolveText') {
        dissolveTextById(id);
    } else if (action === 'explodeBlock') {
        explodeInsert(id);
    } else if (action === 'editBlock') {
        editInsert(id);
    } else if (action === 'hideBlock') {
        hideInsert(id);
    } else if (action === 'showBlocks') {
        showHiddenBlocks();
    } else if (action === 'editPattern') {
        startPatternEdit(id);
    } else if (action === 'patternCount') {
        togglePatternCount(id);
    }
}
