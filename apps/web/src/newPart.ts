import type { Part } from '@jarvis/core';
import { showError, tool } from './menus';
import { setWorkspace, useStudio } from './state';

/** The material new parts start with: shown as "not specified". */
export const DEFAULT_COLOR = '#9aa3b5';

/**
 * Adds an empty part and opens it on its own, like a new SolidWorks part: nothing but its planes. Sketches,
 * reference geometry and features are then added from the part toolbar, in any order.
 */
export async function newPart(parts: Part[] = useStudio.getState().history?.parts ?? []): Promise<void> {
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
    if (result.isError) {
        showError(result.text);
    } else if (id) {
        setWorkspace('part', id, 'isolated');
    }
}
