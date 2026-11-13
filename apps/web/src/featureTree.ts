// The part history as a feature tree: which sketches nest under the step that uses them, and how tree positions map
// to the real (flat) history for rollback and reorder. Nesting is display only; every action works on real steps.

import type { Feature, SketchSource } from '@jarvis/core';
import { featureName, stepRefs } from './historyText';

/** What a nested sketch is to its parent. */
export type SketchRole = 'sketch' | 'section' | 'profile' | 'path';

export interface TreeNode {
    /** Unique in the tree: the step id, or `<parent id>:<role><n>` for a sketch stored inline in its parent. */
    key: string;
    /** The real history step this node shows; null for an inline sketch (it is part of its parent step). */
    stepId: string | null;
    /** Position in the real history: the step's own, or for an inline sketch its parent's. */
    index: number;
    /** The step this node is nested under; null at top level. */
    parentId: string | null;
    label: string;
    /** For nested sketches: what the sketch is to its parent, e.g. "Section 2". */
    role: string | null;
    /** How many steps use this step. */
    users: number;
    children: TreeNode[];
}

interface Source {
    role: SketchRole;
    label: string;
    source: SketchSource;
}

/** The sketches a step is built from, in order, with what each is to it. */
export function sketchSources(feature: Feature): Source[] {
    switch (feature.op) {
        case 'extrude':
        case 'revolve':
            return [{ role: 'sketch', label: 'Sketch', source: feature }];
        case 'loft':
            return feature.sections.map((source, i) => ({ role: 'section', label: `Section ${i + 1}`, source }));
        case 'sweep': {
            const sources: Source[] = [{ role: 'profile', label: 'Profile', source: feature.profile }];
            if (!('helix' in feature.path)) {
                sources.push({ role: 'path', label: 'Path', source: feature.path });
            }
            return sources;
        }
        default:
            return [];
    }
}

/**
 * Builds the display tree. A `sketch` step used by exactly one later step, through a sketch reference, nests under
 * that step; so do sketches stored inline. Shared and unused sketch steps stay at top level.
 */
export function buildFeatureTree(features: Feature[]): TreeNode[] {
    const index = new Map(features.map((f, i) => [f.id, i]));
    const users = new Map<string, number>();
    for (const feature of features) {
        for (const id of stepRefs(feature)) {
            users.set(id, (users.get(id) ?? 0) + 1);
        }
    }
    const owner = new Map<string, string>();
    features.forEach((feature, i) => {
        for (const { source } of sketchSources(feature)) {
            const ref = source.sketchRef;
            const at = ref ? index.get(ref) : undefined;
            if (ref && at !== undefined && at < i && features[at].op === 'sketch' && users.get(ref) === 1) {
                owner.set(ref, feature.id);
            }
        }
    });

    const nodes: TreeNode[] = [];
    features.forEach((feature, i) => {
        if (owner.has(feature.id)) {
            return;
        }
        const children: TreeNode[] = [];
        const sources = sketchSources(feature);
        sources.forEach(({ role, label, source }, n) => {
            const ref = source.sketchRef;
            if (source.sketch) {
                children.push({
                    key: `${feature.id}:${role}${n}`,
                    stepId: null,
                    index: i,
                    parentId: feature.id,
                    label,
                    role: label,
                    users: 1,
                    children: [],
                });
            } else if (ref && owner.get(ref) === feature.id && !children.some((c) => c.stepId === ref)) {
                const at = index.get(ref)!;
                children.push({
                    key: ref,
                    stepId: ref,
                    index: at,
                    parentId: feature.id,
                    label: featureName(features[at]),
                    role: sources.length > 1 ? label : null,
                    users: 1,
                    children: [],
                });
            }
        });
        nodes.push({
            key: feature.id,
            stepId: feature.id,
            index: i,
            parentId: null,
            label: featureName(feature),
            role: null,
            users: users.get(feature.id) ?? 0,
            children,
        });
    });
    return nodes;
}

/** The real steps a top-level node stands for: itself and the sketch steps nested under it, in history order. */
export function blockIds(node: TreeNode): string[] {
    return [node, ...node.children]
        .filter((n) => n.stepId !== null)
        .sort((a, b) => a.index - b.index)
        .map((n) => n.stepId!);
}

/**
 * Rollback marker position in the tree for a rollback `count` (steps built): the number of top-level rows built.
 * Gap g sits between top-level rows g - 1 and g.
 */
export function markerGap(nodes: TreeNode[], count: number): number {
    return nodes.filter((n) => n.index < count).length;
}

/** Rollback count for the marker at gap g: everything up to and including the top-level row above it. */
export function gapCount(nodes: TreeNode[], gap: number): number {
    return gap <= 0 ? 0 : nodes[Math.min(gap, nodes.length) - 1].index + 1;
}

/** Is the node after the rollback marker (not built)? */
export function isRolled(node: TreeNode, count: number): boolean {
    return node.index >= count;
}

/**
 * New feature order for dropping top-level row `dragKey` before or after row `targetKey`. The dragged row's nested
 * sketch steps move with it; null when nothing changes. Whether the order is valid is left to the server's check.
 */
export function reorderIds(features: Feature[], nodes: TreeNode[], dragKey: string, targetKey: string, after: boolean): string[] | null {
    const drag = nodes.find((n) => n.key === dragKey);
    const target = nodes.find((n) => n.key === targetKey);
    if (!drag || !target || drag === target) {
        return null;
    }
    const all = features.map((f) => f.id);
    const block = new Set(blockIds(drag));
    const moving = all.filter((id) => block.has(id));
    const ids = all.filter((id) => !block.has(id));
    const at = after
        ? ids.indexOf(target.stepId!) + 1
        : Math.min(...blockIds(target).map((id) => ids.indexOf(id)));
    ids.splice(at, 0, ...moving);
    return ids.every((id, i) => id === all[i]) ? null : ids;
}

/** Keys of the nodes whose label contains `query` (any case), plus their parents. Null for an empty query. */
export function filterKeys(nodes: TreeNode[], query: string): Set<string> | null {
    const q = query.trim().toLowerCase();
    if (!q) {
        return null;
    }
    const keys = new Set<string>();
    for (const node of nodes) {
        const hits = node.children.filter((c) => c.label.toLowerCase().includes(q) || (c.role ?? '').toLowerCase().includes(q));
        hits.forEach((c) => keys.add(c.key));
        if (hits.length || node.label.toLowerCase().includes(q)) {
            keys.add(node.key);
        }
    }
    return keys;
}
