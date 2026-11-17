// The part history as a feature tree: which sketches nest under the step that uses them, and how tree positions map
// to the real (flat) history for rollback and reorder. Nesting is display only; every action works on real steps.

import type { Feature, Sketch, SketchSource } from '@jarvis/core';
import { featureName, stepRefs } from './historyText';

/** What a nested sketch is to its parent. */
export type SketchRole = 'sketch' | 'section' | 'profile' | 'path';

export interface TreeNode {
    /**
     * Unique in the tree: the step id, `<parent id>:<role><n>` for a sketch stored inline in its parent, or
     * `<sketch id>@<parent id>` where a shared sketch shows again under a further step that uses it.
     */
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
    /** A nested sketch that other steps use too: it shows under each of them and does not move with any. */
    shared?: boolean;
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
            const sources: Source[] = feature.profile ? [{ role: 'profile', label: 'Profile', source: feature.profile }] : [];
            // A helix or spiral step it follows stays a step of its own, as in SolidWorks.
            if (!('helix' in feature.path) && !('curveRef' in feature.path)) {
                sources.push({ role: 'path', label: 'Path', source: feature.path });
            }
            return sources;
        }
        case 'helix':
            return [{ role: 'sketch', label: 'Sketch', source: feature }];
        default:
            return [];
    }
}

/**
 * Builds the display tree. A `sketch` step nests under every later step that uses it through a sketch reference
 * (an extrude and a cut from one sketch both show it), and so do sketches stored inline. Only sketch steps that
 * nothing uses yet stay at top level.
 */
export function buildFeatureTree(features: Feature[]): TreeNode[] {
    const index = new Map(features.map((f, i) => [f.id, i]));
    const users = new Map<string, number>();
    for (const feature of features) {
        for (const id of stepRefs(feature)) {
            users.set(id, (users.get(id) ?? 0) + 1);
        }
    }
    /** Is `ref` an earlier sketch step that step `i` can show as its child? */
    const usable = (ref: string | undefined, i: number): ref is string => {
        const at = ref ? index.get(ref) : undefined;
        return at !== undefined && at < i && features[at].op === 'sketch';
    };
    const nested = new Set<string>();
    features.forEach((feature, i) => {
        for (const { source } of sketchSources(feature)) {
            if (usable(source.sketchRef, i)) {
                nested.add(source.sketchRef);
            }
        }
    });

    const shown = new Set<string>();
    const nodes: TreeNode[] = [];
    features.forEach((feature, i) => {
        if (nested.has(feature.id)) {
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
            } else if (usable(ref, i) && !children.some((c) => c.stepId === ref)) {
                const at = index.get(ref)!;
                const count = users.get(ref) ?? 1;
                children.push({
                    // The first place a sketch shows keeps its own id as key, so it is found by step id.
                    key: shown.has(ref) ? `${ref}@${feature.id}` : ref,
                    stepId: ref,
                    index: at,
                    parentId: feature.id,
                    label: featureName(features[at]),
                    role: sources.length > 1 ? label : null,
                    users: count,
                    shared: count > 1,
                    children: [],
                });
                shown.add(ref);
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

/**
 * The real steps a top-level node stands for: itself and the sketch steps only it uses, in history order. A shared
 * sketch belongs to none of its users.
 */
export function blockIds(node: TreeNode): string[] {
    return [node, ...node.children.filter((c) => !c.shared)]
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

/** The sketch a sketch node shows: a sketch step's own, or the inline sketch of its parent step. */
export function nodeSketch(node: TreeNode, byId: Map<string, Feature>): Sketch | undefined {
    const feature = node.stepId ? byId.get(node.stepId) : undefined;
    if (feature) {
        return feature.op === 'sketch' ? feature.sketch : undefined;
    }
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const n = /(\d+)$/.exec(node.key)?.[1];
    return parent && n !== undefined ? sketchSources(parent)[Number(n)]?.source.sketch : undefined;
}

/** Connector lines of one tree line: the levels whose vertical line passes through it, and its own elbow. */
export interface Guide {
    /** Depths (1 and up) of the vertical lines that run through the whole line. */
    through: number[];
    /** Last child of its parent: its elbow stops at the middle of the line. */
    last: boolean;
}

/**
 * Connector lines for the visible lines in order, given their depths (0 is the root). A null depth is a spacer
 * between rows (the rollback gaps): the lines of depth 1 up to `spacer(i)` (1 by default; deeper inside folders)
 * pass through it, where more rows follow.
 */
export function treeGuides(depths: (number | null)[], spacer: (i: number) => number = () => 1): Guide[] {
    // more[k]: a later line at depth k follows before any shallower one, so the line at depth k continues.
    const more: boolean[] = [];
    const guides: Guide[] = new Array(depths.length);
    for (let i = depths.length - 1; i >= 0; i--) {
        const d = depths[i];
        if (d === null) {
            const through: number[] = [];
            for (let k = 1; k <= spacer(i); k++) {
                if (more[k]) {
                    through.push(k);
                }
            }
            guides[i] = { through, last: true };
            continue;
        }
        const through: number[] = [];
        for (let k = 1; k < d; k++) {
            if (more[k]) {
                through.push(k);
            }
        }
        guides[i] = { through, last: !more[d] };
        more[d] = true;
        more.length = d + 1;
    }
    return guides;
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
