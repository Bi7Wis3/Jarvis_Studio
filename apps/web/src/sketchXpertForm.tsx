// The SketchXpert PropertyManager (SolidWorks: SketchXpert): for an over defined or unsolvable sketch, Diagnose lists
// the solutions (sets of relations and dimensions to delete), steps through them with the result shown as a ghost,
// and Accept applies one; Manual repair lists every item involved, each with Suppressed and Delete.

import { useEffect, useMemo, useState } from 'react';
import type { ToolDef } from './toolDefs';
import { deleteConstraints, describe, setHighlight, setSuppressed, setTool, useSketcher } from './sketcher';
import { constraintRefs, geometryEntities } from './sketchGeometry';
import { diagnose, sketchProblems, type XpertSolution } from './sketchXpert';
import { RELATION_NAMES, relationName } from './sketchRelationNames';
import { PmSection } from './sketchPm';
import type { NewEntity } from './sketchMath';
import { setSketchToggle, useSketchToggles } from './sketchToggles';
import { watchSketchErrors } from './sketchXpertAuto';

watchSketchErrors();

/** SketchXpert's own option: open by itself when a change over defines the sketch or it cannot be solved. */
function AlwaysOpen() {
    const on = useSketchToggles((t) => t.xpertAutoOpen);
    return (
        <label className="tb-check">
            <input type="checkbox" checked={on} onChange={(e) => setSketchToggle('xpertAutoOpen', e.target.checked)} />
            <span>Always open this dialog when sketch error occurs</span>
        </label>
    );
}

/** A short name of a relation or dimension, for the lists. */
function itemName(g: ReturnType<typeof useSketcher.getState>['geometry'], id: string): string {
    const c = g.constraints.find((k) => k.id === id);
    if (!c) {
        return id;
    }
    const value = describe(g, id);
    return 'value' in c ? `${RELATION_NAMES[c.kind]} ${value}` : relationName(c, useSketcher.getState().context);
}

/** Shows a solution: the sketch as it would solve, as a ghost, and lights up what the removed items held. */
function preview(g: ReturnType<typeof useSketcher.getState>['geometry'], solution: XpertSolution | null): void {
    if (!solution) {
        useSketcher.setState({ editPreview: [] });
        setHighlight([]);
        return;
    }
    useSketcher.setState({ editPreview: geometryEntities(solution.geometry) as NewEntity[] });
    setHighlight([...new Set(solution.remove.flatMap((id) => {
        const c = g.constraints.find((k) => k.id === id);
        return c ? constraintRefs(c) : [];
    }))]);
}

function SketchXpert() {
    const g = useSketcher((s) => s.geometry);
    const tool = useSketcher((s) => s.tool);
    const [mode, setMode] = useState<'message' | 'diagnose' | 'manual'>('message');
    const [results, setResults] = useState<XpertSolution[]>([]);
    const [at, setAt] = useState(0);
    const problems = useMemo(() => sketchProblems(g), [g]);
    useEffect(() => () => preview(g, null), []);
    useEffect(() => {
        // The sketch changed (a solution accepted, an item deleted): start over from the message.
        setResults([]);
        setMode((m) => (m === 'diagnose' ? 'message' : m));
        preview(g, null);
    }, [g]);
    const shown = results[at] ?? null;
    useEffect(() => {
        if (mode === 'diagnose') {
            preview(g, shown);
        }
    }, [mode, shown, tool]);
    if (problems.ok) {
        return (
            <>
                <p className="tb-note">The sketch solves and is not over defined: nothing for SketchXpert to do.</p>
                <AlwaysOpen />
            </>
        );
    }
    return (
        <>
            <PmSection title="Message">
                <p className="tb-note">
                    {problems.involved.length} relation{problems.involved.length === 1 ? '' : 's'} or dimension{problems.involved.length === 1 ? '' : 's'} over define the sketch
                    or keep it from solving.
                </p>
                <div className="sk-list-actions">
                    <button
                        type="button"
                        className="sk-small"
                        onClick={() => {
                            setTool('select');
                            setResults(diagnose(g));
                            setAt(0);
                            setMode('diagnose');
                        }}
                    >
                        Diagnose
                    </button>
                    <button type="button" className="sk-small" onClick={() => setMode('manual')}>Manual repair</button>
                </div>
                <AlwaysOpen />
            </PmSection>
            {mode === 'diagnose' && (
                <PmSection title="Results">
                    {!results.length && <p className="tb-note">No solution deletes one or two items; use Manual repair.</p>}
                    {shown && (
                        <>
                            <div className="sk-list-actions">
                                <button type="button" className="sk-small" disabled={at === 0} onClick={() => setAt(at - 1)} aria-label="Previous solution">‹</button>
                                <span className="tb-note">Solution {at + 1} of {results.length}</span>
                                <button type="button" className="sk-small" disabled={at >= results.length - 1} onClick={() => setAt(at + 1)} aria-label="Next solution">›</button>
                            </div>
                            <p className="tb-note">Deletes: <b>{shown.remove.map((id) => itemName(g, id)).join(', ')}</b>. The dashed curves show the sketch as it then solves.</p>
                            <div className="sk-list-actions">
                                <button
                                    type="button"
                                    className="sk-small"
                                    onClick={() => {
                                        preview(g, null);
                                        deleteConstraints(shown.remove);
                                    }}
                                >
                                    Accept
                                </button>
                            </div>
                        </>
                    )}
                </PmSection>
            )}
            {mode === 'manual' && (
                <PmSection title="Conflicting relations and dimensions">
                    <div className="sk-list">
                        {problems.involved.map((id) => {
                            const c = g.constraints.find((k) => k.id === id);
                            return c && (
                                <div key={id} className="sk-row" onMouseEnter={() => setHighlight(constraintRefs(c))} onMouseLeave={() => setHighlight([])}>
                                    <span className="sk-row-text"><b>{itemName(g, id)}</b></span>
                                    <label className="sk-row-check" title="Suppressed: kept, but not solved">
                                        <input type="checkbox" checked={!!c.suppressed} onChange={(e) => setSuppressed([id], e.target.checked)} aria-label="Suppressed" />
                                        <span>Supp.</span>
                                    </label>
                                    <button type="button" className="sk-row-x" title="Delete" aria-label={`Delete ${itemName(g, id)}`} onClick={() => deleteConstraints([id])}>×</button>
                                </div>
                            );
                        })}
                    </div>
                    <div className="sk-list-actions">
                        <button type="button" className="sk-small danger" onClick={() => deleteConstraints(problems.involved)}>Delete all</button>
                    </div>
                </PmSection>
            )}
        </>
    );
}

export const sketchXpertTool: ToolDef = {
    id: 'sk-sketchxpert',
    label: 'SketchXpert',
    icon: 'sketchxpert',
    hint: 'find what over defines the sketch, and repair it',
    noApply: true,
    panel: true,
    width: 320,
    top: () => <SketchXpert />,
};
