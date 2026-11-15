// The Add Relations PropertyManager (SolidWorks: Add Relations): the selected entities, the relations they have,
// and one button for each relation that fits exactly this selection; For construction under Options. While it is
// open, clicks in the view add to the selection, and the origin and the axes can be picked too.

import { useEffect, useMemo } from 'react';
import type { SketchGeometry } from '@jarvis/core';
import type { ToolDef } from './toolDefs';
import { AXIS_U, AXIS_V, ORIGIN, curveOf, isDimension } from './solver';
import {
    addRelationToSelection, deleteConstraints, describe, replaceGeometry, selectConstraint, setHighlight, setRelationPicking, useSketcher,
    type Selected,
} from './sketcher';
import { constraintRefs, relationsFromPicks, type ConstraintTool, type Pick } from './sketchGeometry';
import { definedEntities } from './sketchStatus';
import { CURVE_NOUN } from './sketchCurves';
import { RELATION_NAMES, relationName } from './sketchRelationNames';
import { PmSection } from './sketchPm';

/** The relation buttons, in the order SolidWorks lists them. */
export const ADD_RELATIONS: { tool: ConstraintTool; label: string }[] = [
    { tool: 'horizontal', label: 'Horizontal' },
    { tool: 'vertical', label: 'Vertical' },
    { tool: 'collinear', label: 'Collinear' },
    { tool: 'coradial', label: 'Coradial' },
    { tool: 'perpendicular', label: 'Perpendicular' },
    { tool: 'parallel', label: 'Parallel' },
    { tool: 'tangent', label: 'Tangent' },
    { tool: 'concentric', label: 'Concentric' },
    { tool: 'midpoint', label: 'Midpoint' },
    { tool: 'coincident', label: 'Coincident' },
    { tool: 'equal', label: 'Equal' },
    { tool: 'symmetric', label: 'Symmetric' },
    { tool: 'merge', label: 'Merge points' },
    { tool: 'intersection', label: 'Intersection' },
    { tool: 'equalSlots', label: 'Equal slots' },
    { tool: 'fixSlot', label: 'Fix slot' },
    { tool: 'fix', label: 'Fix' },
];

/** A short name of a selected item. */
export function entityLabel(g: SketchGeometry, id: string): string {
    if (id === ORIGIN) {
        return 'Origin';
    }
    if (id === AXIS_U || id === AXIS_V) {
        return id === AXIS_U ? 'Horizontal axis' : 'Vertical axis';
    }
    const curve = curveOf(g, id);
    const noun = curve ? CURVE_NOUN[curve.kind] : 'point';
    return `${noun[0].toUpperCase()}${noun.slice(1)} ${id}`;
}

/** The relations that fit the selection exactly (what the Add Relations group lists). */
export function fittingRelations(g: SketchGeometry, picks: Pick[]): ConstraintTool[] {
    if (!picks.length) {
        return [];
    }
    return ADD_RELATIONS.map((r) => r.tool).filter((tool) => {
        if (tool === 'fix') {
            return picks.every((p) => p.id !== ORIGIN && p.id !== AXIS_U && p.id !== AXIS_V);
        }
        return !('need' in relationsFromPicks(g, tool, picks));
    });
}

/** For construction: all the selected curves to construction, or all back when they all are. */
function setConstruction(g: SketchGeometry, ids: string[], on: boolean): void {
    const set = new Set(ids);
    replaceGeometry({ ...g, curves: g.curves.map((c) => (set.has(c.id) ? { ...c, construction: on || undefined } : c)) });
}

function AddRelations() {
    const g = useSketcher((s) => s.geometry);
    const selection = useSketcher((s) => s.selection);
    const message = useSketcher((s) => s.message);
    const context = useSketcher((s) => s.context);
    useEffect(() => {
        setRelationPicking(true);
        return () => {
            setRelationPicking(false);
            setHighlight([]);
        };
    }, []);
    const picks = selection.filter((x): x is Pick & Selected => x.type !== 'constraint');
    const ids = new Set(picks.map((p) => p.id));
    const fits = useMemo(() => fittingRelations(g, picks), [g, selection]);
    const defined = useMemo(() => (picks.length ? definedEntities(g) : null), [g, picks.length]);
    const existing = g.constraints.filter((c) => !isDimension(c) && constraintRefs(c).some((r) => ids.has(r)));
    const curves = picks.filter((p) => p.type === 'curve' && curveOf(g, p.id)).map((p) => p.id);
    const allConstruction = curves.length > 0 && curves.every((id) => curveOf(g, id)?.construction);
    return (
        <>
            <PmSection title="Selected entities">
                {!picks.length && <p className="tb-note">Click the entities to relate in the view; each click adds one.</p>}
                <div className="sk-list">
                    {picks.map((p) => (
                        <div key={p.id} className="sk-row" onMouseEnter={() => setHighlight([p.id])} onMouseLeave={() => setHighlight([])}>
                            <span className="sk-row-text">
                                <b>{entityLabel(g, p.id)}</b>
                                {defined && <small>{defined.has(p.id) ? 'Fully defined' : 'Under defined'}</small>}
                            </span>
                            <button
                                type="button"
                                className="sk-row-x"
                                title="Take out of the selection"
                                aria-label={`Take ${entityLabel(g, p.id)} out of the selection`}
                                onClick={() => useSketcher.setState((s) => ({ selection: s.selection.filter((x) => x.id !== p.id) }))}
                            >
                                ×
                            </button>
                        </div>
                    ))}
                </div>
            </PmSection>
            {picks.length > 0 && (
                <>
                    <PmSection title="Existing relations">
                        {!existing.length && <p className="tb-note">None.</p>}
                        <div className="sk-list">
                            {existing.map((c) => (
                                <div
                                    key={c.id}
                                    className="sk-row"
                                    onMouseEnter={() => setHighlight(constraintRefs(c))}
                                    onMouseLeave={() => setHighlight([])}
                                    onClick={() => selectConstraint(c.id, true)}
                                >
                                    <span className="sk-row-text">
                                        <b>{relationName(c, context)}</b>
                                        <small>{constraintRefs(c).map((r) => entityLabel(g, r)).join(', ')}{c.suppressed ? ' · suppressed' : ''}</small>
                                    </span>
                                    <button
                                        type="button"
                                        className="sk-row-x"
                                        title="Delete"
                                        aria-label={`Delete ${describe(g, c.id)}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            deleteConstraints([c.id]);
                                        }}
                                    >
                                        ×
                                    </button>
                                </div>
                            ))}
                        </div>
                    </PmSection>
                    <PmSection title="Add relations">
                        {!fits.length && <p className="tb-note">No relation fits exactly this selection.</p>}
                        <div className="sk-relation-buttons">
                            {ADD_RELATIONS.filter((r) => fits.includes(r.tool)).map((r) => (
                                <button key={r.tool} type="button" className="sk-small" onClick={() => addRelationToSelection(r.tool)}>
                                    {r.label}
                                </button>
                            ))}
                        </div>
                        {message && <p className="tb-note">{message}</p>}
                    </PmSection>
                    {curves.length > 0 && (
                        <PmSection title="Options">
                            <label className="tb-check">
                                <input type="checkbox" checked={allConstruction} onChange={() => setConstruction(g, curves, !allConstruction)} />
                                For construction
                            </label>
                        </PmSection>
                    )}
                </>
            )}
        </>
    );
}

export const addRelationsTool: ToolDef = {
    id: 'sk-add-relation',
    label: 'Add relations',
    icon: 'add-relation',
    hint: 'select entities; the relations that fit them are listed',
    noApply: true,
    panel: true,
    width: 300,
    top: () => <AddRelations />,
};
