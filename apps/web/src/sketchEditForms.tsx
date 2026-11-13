// The sketch edit tools (trim, extend, fillet, chamfer, offset, mirror) as PropertyManager forms: the form holds the
// tool's options while clicks in the view do the work; OK applies what is pending and closes, Esc cancels.

import { useEffect, useRef, type ReactNode } from 'react';
import type { Field, PopupApi, Result, ToolDef, Values } from './toolDefs';
import {
    finishEditTool, setEditOptions, setTool, startEditTool, useSketcher, type EditOptions, type EditTool,
} from './sketcher';

const opts = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

/** Keeps the sketcher on this tool while the form is open; closes the form when another tool is picked. */
function EditSession({ tool, api }: { tool: EditTool; api: PopupApi }) {
    const current = useSketcher((s) => s.tool);
    const seen = useRef(false);
    useEffect(() => {
        startEditTool(tool);
        return () => {
            if (useSketcher.getState().tool === tool) {
                setTool('select');
            }
        };
    }, [tool]);
    useEffect(() => {
        if (current === tool) {
            seen.current = true;
        } else if (seen.current) {
            api.run(async () => ({ text: '', isError: false }));
        }
    }, [current]);
    return null;
}

/** Form values are text; options are numbers and flags. */
function toOptions(fields: Field[], v: Values): Partial<EditOptions> {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
        const value = v[f.key];
        if (f.kind === 'check') {
            out[f.key] = !!value;
        } else if (f.kind === 'number') {
            const n = Number(value);
            if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(n)) {
                out[f.key] = n;
            }
        } else {
            out[f.key] = value;
        }
    }
    return out as Partial<EditOptions>;
}

function fromOptions(fields: Field[]): Values {
    const o = useSketcher.getState().editOptions as unknown as Record<string, unknown>;
    return Object.fromEntries(fields.map((f) => [f.key, f.kind === 'check' ? !!o[f.key] : String(o[f.key] ?? '')]));
}

interface EditForm {
    id: EditTool;
    label: string;
    icon: string;
    hint: string;
    shortcut?: string;
    fields: Field[];
    note: () => ReactNode;
}

function editTool({ id, label, icon, hint, shortcut, fields, note: Note }: EditForm): ToolDef {
    return {
        id: `sk-${id}`,
        label,
        icon,
        hint,
        shortcut,
        panel: true,
        width: 300,
        active: (_, s) => s.sketchTool === id,
        fields: () => fields,
        defaults: () => fromOptions(fields),
        onChange: (_key, v) => {
            setEditOptions(toOptions(fields, v));
        },
        top: () => <Note />,
        extra: (api) => <EditSession tool={id} api={api} />,
        apply: async (): Promise<Result> => {
            const error = finishEditTool(id);
            return { text: error ?? '', isError: !!error };
        },
    };
}

// ---- Trim and extend ------------------------------------------------------------------------------------

const TRIM_NOTES: Record<EditOptions['trimMode'], string> = {
    power: 'Drag the pointer across curves to trim each where it crosses · or click a piece to remove it.',
    corner: 'Click two lines on the sides to keep: they are trimmed or extended to meet.',
    inside: 'Click two boundaries, then the curves to cut away between them.',
    outside: 'Click two boundaries, then the curves to cut away outside them.',
    closest: 'Click the piece of a curve to remove, up to the nearest crossings.',
};

function TrimNote() {
    const mode = useSketcher((s) => s.editOptions.trimMode);
    const picked = useSketcher((s) => s.trimPicks.length);
    const between = mode === 'inside' || mode === 'outside';
    return (
        <p className="tb-note">
            {TRIM_NOTES[mode]}
            {between && <> <b>{Math.min(picked, 2)}</b> of 2 boundaries picked.</>}
        </p>
    );
}

const trim = editTool({
    id: 'trim',
    label: 'Trim',
    icon: 'trim',
    hint: 'drag across curves, or click a piece, to cut it away',
    shortcut: 'T',
    fields: [
        {
            key: 'trimMode', label: 'Mode', kind: 'select', options: opts(
                ['power', 'Power trim'], ['corner', 'Corner'], ['inside', 'Trim away inside'], ['outside', 'Trim away outside'],
                ['closest', 'Trim to closest'],
            ),
        },
        { key: 'trimConstruction', label: 'Keep trimmed entities as construction geometry', kind: 'check', section: 'Options' },
        { key: 'trimIgnoreConstruction', label: 'Ignore trimming of construction geometry', kind: 'check', section: 'Options' },
    ],
    note: TrimNote,
});

const extend = editTool({
    id: 'extend',
    label: 'Extend',
    icon: 'extend',
    hint: 'click near an end to lengthen it to the next curve',
    fields: [],
    note: () => <p className="tb-note">Point near the end of a line or arc to see where it goes, then click to extend it to the next curve.</p>,
});

/** In the Modify group, in place of the plain click tools. */
export const editToolForms: ToolDef[] = [trim, extend];
