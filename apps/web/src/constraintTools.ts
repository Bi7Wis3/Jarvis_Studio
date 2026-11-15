// The relation tools of the sketch (Add Relations), and which of them fit a selection. A module of its own, without the
// tool definitions, so that drawing code (the context toolbar) can use it without importing toolDefs.tsx.

import type { SketchGeometry } from '@jarvis/core';
import { relationsFromPicks, type ConstraintTool, type Pick } from './sketchGeometry';

export const CONSTRAINT_TOOLS: { id: ConstraintTool; label: string; hint: string }[] = [
    { id: 'coincident', label: 'Coincident', hint: 'two points, or points and a curve' },
    { id: 'merge', label: 'Merge points', hint: 'two or more points become one' },
    { id: 'horizontal', label: 'Horizontal', hint: 'one or more lines, or two or more points' },
    { id: 'vertical', label: 'Vertical', hint: 'one or more lines, or two or more points' },
    { id: 'collinear', label: 'Collinear', hint: 'two or more lines on one line' },
    { id: 'parallel', label: 'Parallel', hint: 'two or more lines' },
    { id: 'perpendicular', label: 'Perpendicular', hint: 'two lines' },
    { id: 'tangent', label: 'Tangent', hint: 'a line and an arc/circle, or two arcs' },
    { id: 'concentric', label: 'Concentric', hint: 'two or more arcs/circles, or a point and an arc/circle' },
    { id: 'coradial', label: 'Coradial', hint: 'two or more arcs/circles: same centre and radius' },
    { id: 'equal', label: 'Equal', hint: 'two or more lines, or two or more arcs/circles' },
    { id: 'midpoint', label: 'Midpoint', hint: 'a point and a line' },
    { id: 'symmetric', label: 'Symmetric', hint: 'two points and a line' },
    { id: 'fix', label: 'Lock', hint: 'a point, line or circle stays where it is (a circle keeps its radius) · click it again to unlock' },
];

/** The relation tools that fit the selection, by the rule the relation buttons use (relationsFromPicks). */
export function fittingRelationTools(g: SketchGeometry, picks: Pick[]): typeof CONSTRAINT_TOOLS {
    if (!picks.length) {
        return [];
    }
    return CONSTRAINT_TOOLS.filter((r) => r.id !== 'fix' && !('need' in relationsFromPicks(g, r.id, picks)));
}
