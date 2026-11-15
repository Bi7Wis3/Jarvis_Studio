import type { ToolDef } from './toolDefs';

export interface ToolFamily {
    id: string;
    label: string;
}

/**
 * Tools that are variants of one another share one toolbar button with a flyout, as in SolidWorks (Line,
 * Rectangle, Arc...). Listed by tool id in flyout order; ids that do not exist are skipped.
 */
const FAMILIES: (ToolFamily & { tools: string[] })[] = [
    { id: 'line', label: 'Line', tools: ['sk-line', 'sk-midpointLine', 'sk-centerline'] },
    { id: 'rectangle', label: 'Rectangle', tools: ['sk-rect', 'sk-centerRect', 'sk-rect3', 'sk-centerRect3', 'sk-parallelogram'] },
    { id: 'slot', label: 'Slot', tools: ['sk-slot', 'sk-centerSlot', 'sk-arcSlot3', 'sk-centerArcSlot'] },
    { id: 'circle', label: 'Circle', tools: ['sk-circle', 'sk-perimeterCircle'] },
    { id: 'arc', label: 'Arc', tools: ['sk-centerArc', 'sk-tangentArc', 'sk-arc'] },
    { id: 'ellipse', label: 'Ellipse', tools: ['sk-ellipse', 'sk-partialEllipse', 'sk-parabola', 'sk-conic'] },
    { id: 'spline', label: 'Spline', tools: ['sk-spline', 'sk-styleSpline', 'sk-equation-curve'] },
    { id: 'corner', label: 'Fillet', tools: ['sk-fillet', 'sk-chamfer'] },
    { id: 'trim', label: 'Trim', tools: ['sk-trim', 'sk-extend', 'sk-split', 'sk-segment', 'sk-jog'] },
    { id: 'sk-pattern', label: 'Sketch pattern', tools: ['sk-pattern-linear', 'sk-pattern-circular'] },
    { id: 'sk-transform', label: 'Move', tools: ['sk-move', 'sk-copy', 'sk-rotate', 'sk-scale', 'sk-stretch', 'sk-modify-sketch', 'sk-align-grid'] },
    { id: 'sk-mirror', label: 'Mirror', tools: ['sk-mirror', 'sk-dynamic-mirror'] },
    { id: 'sk-check', label: 'Repair sketch', tools: ['sk-repair', 'sk-check-feature'] },
    { id: 'sk-spline-tools', label: 'Spline tools', tools: ['sk-fit-spline', 'sk-simplify-spline', 'sk-add-tangency', 'sk-add-curvature', 'sk-show-combs',
        'sk-show-inflections', 'sk-show-min-radius', 'sk-show-handles', 'sk-show-polygon', 'sk-convert-spline'] },
    { id: 'sk-block', label: 'Blocks', tools: ['sk-block-make', 'sk-block-insert', 'sk-block-edit', 'sk-block-rebuild', 'sk-block-addremove', 'sk-block-explode', 'sk-block-save'] },
    { id: 'sk-convert', label: 'Convert entities', tools: ['sk-convert', 'sk-intersection', 'sk-silhouette', 'sk-pierce', 'sk-copy-model'] },
    { id: 'sk-dim', label: 'Smart dimension', tools: ['sk-dimension', 'sk-dim-horizontal', 'sk-dim-vertical', 'sk-dim-ordinate', 'sk-dim-ordinate-v', 'sk-dim-path', 'sk-dim-ordinate-auto', 'sk-dim-running'] },
    { id: 'primitive', label: 'Primitives', tools: ['prim-box', 'prim-cylinder', 'prim-sphere', 'prim-cone', 'prim-torus', 'prim-tube', 'prim-wedge', 'prim-capsule'] },
];

const RELATIONS: ToolFamily = { id: 'relation', label: 'Add relation' };

function entryOf(toolId: string): { family: ToolFamily; order: number } | null {
    // Every relation tool (sk-c-...) is one flyout.
    if (toolId.startsWith('sk-c-')) {
        return { family: RELATIONS, order: 0 };
    }
    for (const { tools, ...family } of FAMILIES) {
        const order = tools.indexOf(toolId);
        if (order >= 0) {
            return { family, order };
        }
    }
    return null;
}

export const familyOf = (toolId: string): ToolFamily | null => entryOf(toolId)?.family ?? null;

export type ToolbarItem = { tool: ToolDef } | { family: ToolFamily; tools: ToolDef[] };

/** A group's tools as toolbar items: a family's tools become one item where its first tool stood. */
export function toolbarItems(tools: ToolDef[]): ToolbarItem[] {
    const items: ToolbarItem[] = [];
    const members = new Map<string, ToolDef[]>();
    for (const tool of tools) {
        const family = familyOf(tool.id);
        const known = family && members.get(family.id);
        if (!family) {
            items.push({ tool });
        } else if (known) {
            known.push(tool);
        } else {
            const list = [tool];
            members.set(family.id, list);
            items.push({ family, tools: list });
        }
    }
    for (const list of members.values()) {
        // Stable: tools the family does not rank (all relations) keep the order they were listed in.
        list.sort((a, b) => entryOf(a.id)!.order - entryOf(b.id)!.order);
    }
    // A family of one is just a button.
    return items.map((item) => ('family' in item && item.tools.length === 1 ? { tool: item.tools[0] } : item));
}
