// Tools for the folders of a part's feature tree (SolidWorks user folders): add, rename, remove, and move steps and
// folders in the tree. Folders group steps only; moving changes the history order as the tree does. The rules
// live in @jarvis/core/folders; ProjectStore.mutate fits folders to any other change of the step order.

import { z } from 'zod';
import type { Part, Project } from '@jarvis/core';
import {
    addFolder, folderId, moveItems, nextFolderName, removeFolders, renameFolder, type TreeChange, type TreePlace,
} from '@jarvis/core/folders';
import type { ProjectStore } from './store.js';
import { checkHistory, type StudioTool } from './tools.js';

const placeFields = {
    before: z.string().optional().describe('Put it just above this step or folder (same level)'),
    after: z.string().optional().describe('Put it just below this step or folder (same level)'),
    into: z.string().optional().describe('Put it inside this folder, at its end (or start with at: "start")'),
    at: z.enum(['start', 'end']).optional(),
};

function placeOf(args: { before?: string; after?: string; into?: string; at?: 'start' | 'end' }): TreePlace | undefined {
    if (args.before) {
        return { before: args.before };
    }
    if (args.after) {
        return { after: args.after };
    }
    return args.into || args.at ? { into: args.into ?? null, at: args.at } : undefined;
}

function partOf(draft: Project, partId: string): Part {
    const part = draft.parts.find((p) => p.id === partId);
    if (!part) {
        throw new Error(`No part with id "${partId}".`);
    }
    if (part.instanceOf) {
        throw new Error(`${partId} is an instance: its folders are those of ${part.instanceOf}.`);
    }
    return part;
}

function apply(part: Part, next: TreeChange): void {
    const byId = new Map((part.features ?? []).map((f) => [f.id, f]));
    part.features = next.order.map((id) => byId.get(id)!);
    if (next.folders?.length) {
        part.folders = next.folders;
    } else {
        delete part.folders;
    }
    checkHistory(part);
}

export function folderTools(store: ProjectStore): StudioTool[] {
    return [
        {
            name: 'folders_add',
            description: 'Adds a folder to a part\'s feature tree to group steps (SolidWorks user folder). With items: the '
                + 'folder takes those steps or folders, which must follow one another at one level of the tree (the sketch '
                + 'steps a feature is built from go with it). Without items: an empty folder, placed by before, after or '
                + 'into, else at the end. Folders only group steps: the model does not change. They are listed in '
                + 'part.folders (project_get).',
            schema: {
                partId: z.string(),
                name: z.string().optional().describe('Default Folder1, Folder2, ...'),
                items: z.array(z.string()).optional().describe('Step or folder ids to put in it'),
                ...placeFields,
            },
            run: ({ partId, name, items, ...place }) => {
                let result = '';
                store.mutate((draft) => {
                    const part = partOf(draft, partId);
                    const features = part.features ?? [];
                    const label = name?.trim() || nextFolderName(part.folders);
                    const id = folderId(label, features, part.folders);
                    apply(part, addFolder(features, part.folders, { id, name: label, items, place: placeOf(place) }));
                    result = `Added folder "${label}" (id ${id}) to ${partId}.`;
                });
                return result;
            },
        },
        {
            name: 'folders_rename',
            description: 'Renames a folder of a part\'s feature tree.',
            schema: { partId: z.string(), id: z.string(), name: z.string().min(1) },
            run: ({ partId, id, name }) => {
                store.mutate((draft) => {
                    const part = partOf(draft, partId);
                    part.folders = renameFolder(part.folders, id, name);
                });
                return 'Renamed.';
            },
        },
        {
            name: 'folders_remove',
            description: 'Removes folders from a part\'s feature tree. What they hold (steps and sub-folders) stays where '
                + 'it is, in the folder above or at the top of the tree; no step is deleted.',
            schema: { partId: z.string(), ids: z.array(z.string()).min(1) },
            run: ({ partId, ids }) => {
                store.mutate((draft) => {
                    const part = partOf(draft, partId);
                    apply(part, removeFolders(part.features ?? [], part.folders, ids));
                });
                return `Removed ${ids.length} folder(s); the steps stay where they were.`;
            },
        },
        {
            name: 'features_move',
            description: 'Moves steps and/or folders of a part\'s feature tree to a new place: just above (before) or below '
                + '(after) a step or folder, or into a folder (at its end, or start with at: "start"); none of these: the '
                + 'end of the tree. The sketch steps only they are built from move with them. The history order changes '
                + 'as the tree does; an order where a step would use one below it is refused.',
            schema: { partId: z.string(), ids: z.array(z.string()).min(1), ...placeFields },
            run: ({ partId, ids, ...place }) => {
                let result = 'Nothing moved.';
                const project = store.get();
                const before = project.parts.find((p) => p.id === partId);
                const target = placeOf(place) ?? { into: null };
                if (before && !before.instanceOf) {
                    // A move that changes nothing is not an undo step.
                    const next = moveItems(before.features ?? [], before.folders, ids, target);
                    const same = JSON.stringify(next.order) === JSON.stringify((before.features ?? []).map((f) => f.id))
                        && JSON.stringify(next.folders ?? null) === JSON.stringify(before.folders ?? null);
                    if (same) {
                        return result;
                    }
                }
                store.mutate((draft) => {
                    const part = partOf(draft, partId);
                    apply(part, moveItems(part.features ?? [], part.folders, ids, target));
                    result = 'Moved.';
                });
                return result;
            },
        },
    ];
}
