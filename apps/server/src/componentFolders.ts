// Tools for the assembly tree (SolidWorks: reordering components and folders of components in an assembly): the
// order of the components, and folders to group them. The rules live in @jarvis/core/componentFolders;
// ProjectStore.mutate fits the folders to parts added and deleted.

import { z } from 'zod';
import type { FeatureFolder, Project } from '@jarvis/core';
import { renameFolder, type LayoutItem } from '@jarvis/core/folders';
import {
    addComponentFolder, applyComponentChange, applyPartsOrder, componentFolderId, componentLayout, componentRowOf, moveComponents,
    nextComponentFolderName, partsInRowOrder, removeComponentFolders, reorderComponents, type ComponentTreeChange,
} from '@jarvis/core/componentFolders';
import { placeOf } from './folders.js';
import type { ProjectStore } from './store.js';
import type { StudioTool } from './tools.js';

const placeFields = {
    before: z.string().optional().describe('Put them just above this component or folder (same level)'),
    after: z.string().optional().describe('Put them just below this component or folder (same level)'),
    into: z.string().optional().describe('Put them inside this folder, at its end (or start with at: "start")'),
    at: z.enum(['start', 'end']).optional().describe('With into: the start or end of the folder; alone: of the tree'),
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Whether a tree change leaves the project as it is (no undo step for it). */
function unchanged(project: Project, change: ComponentTreeChange): boolean {
    return same(partsInRowOrder(project.parts, change.order).map((p) => p.id), project.parts.map((p) => p.id))
        && same(change.folders, project.componentFolders);
}

/** The assembly tree as the assistant reads it: folders with what they hold, components with their instances. */
export function componentTreeJson(project: Project): unknown[] {
    const rowOf = componentRowOf(project.parts);
    const walk = (items: readonly LayoutItem[]): unknown[] => items.map((item) => {
        if (item.kind === 'folder') {
            return { folder: item.id, name: item.name, items: walk(item.items) };
        }
        const part = project.parts.find((p) => p.id === item.id);
        const instances = project.parts.filter((p) => p.id !== item.id && rowOf.get(p.id) === item.id).map((p) => p.id);
        return { part: item.id, name: part?.name, ...(instances.length ? { instances } : {}) };
    });
    return walk(componentLayout(project.parts, project.componentFolders));
}

export function componentFolderTools(store: ProjectStore): StudioTool[] {
    return [
        {
            name: 'parts_reorder',
            description: 'Reorders components in the assembly tree, which is the order of the parts and of the bill of materials, '
                + 'and moves components and component folders into, out of and between folders. With a place (before or after '
                + 'a component or folder, into a folder, or at the start or end of the tree): ids (components and/or folders, '
                + 'anywhere in the tree) go there together, in tree order. Without a place: ids lists every component that is '
                + 'not an instance once, first to last (or every part once for the exact order). A part\'s instances and '
                + 'pattern stay under it and move with it; an instance cannot move on its own. The fixed part stays fixed.',
            schema: { ids: z.array(z.string()).min(1).describe('Component (part) and folder ids'), ...placeFields },
            run: ({ ids, ...args }) => {
                const target = placeOf(args);
                const project = store.get();
                if (!target) {
                    let next: { parts: string[]; folders: FeatureFolder[] | undefined };
                    try {
                        next = reorderComponents(project.parts, project.componentFolders, ids);
                    } catch (e) {
                        throw new Error(`${e instanceof Error ? e.message : String(e)} To move only some, give before, after, into or at.`);
                    }
                    if (same(next.parts, project.parts.map((p) => p.id)) && same(next.folders, project.componentFolders)) {
                        return 'Nothing moved.';
                    }
                    store.mutate((draft) => {
                        const change = reorderComponents(draft.parts, draft.componentFolders, ids);
                        applyPartsOrder(draft, change.parts, change.folders);
                    });
                    return 'Reordered.';
                }
                // A move that changes nothing is not an undo step.
                if (unchanged(project, moveComponents(project.parts, project.componentFolders, ids, target))) {
                    return 'Nothing moved.';
                }
                store.mutate((draft) => {
                    applyComponentChange(draft, moveComponents(draft.parts, draft.componentFolders, ids, target));
                });
                return 'Moved.';
            },
        },
        {
            name: 'component_folders_add',
            description: 'Adds a folder to the assembly tree to group components (SolidWorks folder of components). With items '
                + '(components and/or folders, anywhere in the tree, in any order): the folder goes where the first of them is '
                + 'and takes them all, which brings them together in the order. Without items: an empty folder, placed by '
                + 'before, after or into, else at the end of the tree. Folders only group: nothing moves in the model.',
            schema: {
                name: z.string().optional().describe('Default Folder1, Folder2, ...'),
                items: z.array(z.string()).optional().describe('Component (part) or folder ids to put in it; not instances'),
                ...placeFields,
            },
            run: ({ name, items, ...place }) => {
                let result = '';
                store.mutate((draft) => {
                    const label = name?.trim() || nextComponentFolderName(draft.componentFolders);
                    const id = componentFolderId(label, draft.parts, draft.componentFolders);
                    applyComponentChange(draft, addComponentFolder(draft.parts, draft.componentFolders, { id, name: label, items, place: placeOf(place) }));
                    result = `Added folder "${label}" (id ${id}) to the assembly tree.`;
                });
                return result;
            },
        },
        {
            name: 'component_folders_rename',
            description: 'Renames a folder of the assembly tree.',
            schema: { id: z.string(), name: z.string().min(1) },
            run: ({ id, name }) => {
                store.mutate((draft) => {
                    draft.componentFolders = renameFolder(draft.componentFolders, id, name);
                });
                return 'Renamed.';
            },
        },
        {
            name: 'component_folders_remove',
            description: 'Removes folders from the assembly tree. What they hold (components and sub-folders) stays where it is, '
                + 'in the folder above or at the top of the tree; no component is deleted.',
            schema: { ids: z.array(z.string()).min(1) },
            run: ({ ids }) => {
                store.mutate((draft) => {
                    applyComponentChange(draft, removeComponentFolders(draft.parts, draft.componentFolders, ids));
                });
                return `Removed ${ids.length} folder(s); the components stay where they were.`;
            },
        },
        {
            name: 'component_folders_get',
            description: 'Returns the assembly tree as JSON: its components in order, each with its instances, inside their '
                + 'folders ({ folder, name, items }).',
            schema: {},
            run: () => JSON.stringify(componentTreeJson(store.get())),
        },
    ];
}
