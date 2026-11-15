// The Fully Define Sketch PropertyManager: entities to define, the relations it may add, the dimension schemes and
// datums, and where the dimensions go. Calculate works out what it would add and shows it as ghosts in the view; OK
// adds it (the same calculation, on the sketch as it is then).

import { useEffect } from 'react';
import type { SketchGeometry } from '@jarvis/core';
import type { Field, PopupApi, ToolDef, Values } from './toolDefs';
import { ORIGIN, curveOf, solverReady } from './solver';
import { fullyDefineSketchWith, useSketcher } from './sketcher';
import {
    DEFAULT_FULLY_DEFINE, FULLY_DEFINE_RELATIONS, type FullyDefineOptions, type FullyDefineRelation, type FullyDefineScheme,
} from './sketchFullyDefine';
import { calculateFullyDefine, clearFullyDefinePreview, showFullyDefinePreview, useFullyDefinePreview } from './sketchFullyDefinePreview';
import { entityLabel } from './sketchRelationForms';
import { PmSection } from './sketchPm';
import { FieldInput } from './toolForm';

const SCHEMES = [{ value: 'baseline', label: 'Baseline' }, { value: 'ordinate', label: 'Ordinate' }, { value: 'chain', label: 'Chain' }];

const schemeOf = (v: unknown): FullyDefineScheme => (v === 'chain' || v === 'ordinate' ? v : 'baseline');

/** Datums to choose from: the origin, then the sketch's lines and points. */
function datums(g: SketchGeometry): { value: string; label: string }[] {
    return [
        { value: ORIGIN, label: 'Origin' },
        ...g.curves.filter((c) => c.kind === 'line').map((c) => ({ value: c.id, label: entityLabel(g, c.id) })),
        ...g.points.filter((p) => p.id !== ORIGIN).map((p) => ({ value: p.id, label: entityLabel(g, p.id) })),
    ];
}

export function fullyDefineOptions(v: Values): FullyDefineOptions {
    const s = useSketcher.getState();
    const selected = s.selection.filter((x) => x.type !== 'constraint').map((x) => x.id);
    if (v.scope === 'selected' && !selected.length) {
        throw new Error('Select the entities to fully define in the view first.');
    }
    const present = (id: unknown) => (typeof id === 'string' && (id === ORIGIN || s.geometry.points.some((p) => p.id === id) || curveOf(s.geometry, id)) ? id : ORIGIN);
    return {
        ...(v.scope === 'selected' ? { only: selected } : {}),
        relations: (Array.isArray(v.relations) ? v.relations : []) as FullyDefineRelation[],
        horizontal: schemeOf(v.horizontal),
        vertical: schemeOf(v.vertical),
        datumH: present(v.datumH),
        datumV: present(v.datumV),
        above: v.placeH !== 'below',
        right: v.placeV !== 'left',
    };
}

const SCOPE: Field = {
    key: 'scope', label: 'Entities to fully define', kind: 'select',
    options: [{ value: 'all', label: 'All entities in sketch' }, { value: 'selected', label: 'Selected entities' }],
};

/** Calculate: what OK would add, as ghosts in the view. */
function calculate(v: Values): void {
    if (!solverReady()) {
        useFullyDefinePreview.setState({ preview: null, text: 'The solver is still loading; try again in a moment.' });
        return;
    }
    try {
        showFullyDefinePreview(calculateFullyDefine(useSketcher.getState().geometry, fullyDefineOptions(v)));
    } catch (e) {
        useFullyDefinePreview.setState({ preview: null, text: e instanceof Error ? e.message : String(e) });
    }
}

/** Entities to fully define, with Calculate and what it found; a change of the options or the sketch drops it. */
function Entities({ api }: { api: PopupApi }) {
    const g = useSketcher((s) => s.geometry);
    const selection = useSketcher((s) => s.selection);
    const text = useFullyDefinePreview((s) => s.text);
    const options = JSON.stringify(api.values);
    useEffect(() => clearFullyDefinePreview, []);
    useEffect(() => {
        clearFullyDefinePreview();
    }, [options, g, selection]);
    const change = (key: string, value: Values[string]) => api.set({ [key]: value });
    return (
        <>
            <PmSection title="Entities to fully define">
                <FieldInput field={SCOPE} values={api.values} change={change} />
                <div className="sk-list-actions">
                    <button type="button" className="sk-small" title="Work out the relations and dimensions; they show in the view until OK" onClick={() => calculate(api.values)}>
                        Calculate
                    </button>
                </div>
                <p className="tb-note">{text ?? 'Calculate shows the relations and dimensions it would add; OK adds them.'}</p>
            </PmSection>
            <PmSection title="Relations">
                <div className="sk-list-actions">
                    <button type="button" className="sk-small" onClick={() => change('relations', FULLY_DEFINE_RELATIONS.map((r) => r.value))}>Select all</button>
                    <button type="button" className="sk-small" onClick={() => change('relations', [])}>Deselect all</button>
                </div>
                <FieldInput field={RELATIONS} values={api.values} change={change} />
            </PmSection>
        </>
    );
}

const RELATIONS: Field = { key: 'relations', label: 'Relations it may add', kind: 'multi', options: FULLY_DEFINE_RELATIONS };

export const fullyDefineTool: ToolDef = {
    id: 'sk-fully-define',
    label: 'Fully define',
    icon: 'fully-define',
    hint: 'add the relations and dimensions the sketch still needs',
    panel: true,
    width: 300,
    fields: () => {
        const g = useSketcher.getState().geometry;
        const options = datums(g);
        return [
            { key: 'horizontal', label: 'Horizontal dimensions scheme', kind: 'select', options: SCHEMES, section: 'Dimensions' },
            { key: 'datumH', label: 'Datum (horizontal)', kind: 'select', options, section: 'Dimensions' },
            { key: 'placeH', label: 'Dimension placement', kind: 'select', section: 'Dimensions',
                options: [{ value: 'above', label: 'Above the sketch' }, { value: 'below', label: 'Below the sketch' }] },
            { key: 'vertical', label: 'Vertical dimensions scheme', kind: 'select', options: SCHEMES, section: 'Dimensions' },
            { key: 'datumV', label: 'Datum (vertical)', kind: 'select', options, section: 'Dimensions' },
            { key: 'placeV', label: 'Dimension placement', kind: 'select', section: 'Dimensions',
                options: [{ value: 'right', label: 'Right of the sketch' }, { value: 'left', label: 'Left of the sketch' }] },
        ] as Field[];
    },
    defaults: () => {
        const s = useSketcher.getState();
        return {
            scope: s.selection.some((x) => x.type !== 'constraint') ? 'selected' : 'all',
            relations: [...DEFAULT_FULLY_DEFINE.relations], horizontal: 'baseline', vertical: 'baseline', datumH: ORIGIN, datumV: ORIGIN,
            placeH: 'above', placeV: 'right',
        };
    },
    top: (api) => <Entities api={api} />,
    apply: async (v) => {
        clearFullyDefinePreview();
        try {
            return fullyDefineSketchWith(fullyDefineOptions(v));
        } catch (e) {
            return { text: e instanceof Error ? e.message : String(e), isError: true };
        }
    },
};
