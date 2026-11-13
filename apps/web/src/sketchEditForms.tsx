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
    const s = useSketcher.getState();
    const o = { ...s.editOptions, filletRadius: s.filletRadius, chamferDistance: s.chamferDistance } as unknown as Record<string, unknown>;
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

// ---- Offset -----------------------------------------------------------------------------------------------

function OffsetNote() {
    const picked = useSketcher((s) => (s.offsetCurve ? s.picks.length || 1 : 0));
    return (
        <p className="tb-note">
            {picked
                ? <><b>{picked}</b> picked. Click on the side where the offset goes (at the pointer's distance), or press OK for the distance below.</>
                : 'Click a curve to offset (or select curves first), then click where the offset goes.'}
        </p>
    );
}

const offset = editTool({
    id: 'offset',
    label: 'Offset',
    icon: 'offset',
    hint: 'a copy of curves or a chain at a distance, tied to them',
    shortcut: 'O',
    fields: [
        { key: 'offsetDistance', label: 'Offset distance', kind: 'number', unit: 'mm', min: 0, step: 0.5, section: 'Parameters' },
        { key: 'offsetDimension', label: 'Add dimensions', kind: 'check', section: 'Parameters' },
        { key: 'offsetReverse', label: 'Reverse', kind: 'check', section: 'Parameters' },
        { key: 'offsetChain', label: 'Select chain', kind: 'check', section: 'Parameters' },
        { key: 'offsetBoth', label: 'Bi-directional', kind: 'check', section: 'Parameters' },
        { key: 'offsetCap', label: 'Cap ends', kind: 'select', options: opts(['none', 'None'], ['arcs', 'Arcs'], ['lines', 'Lines']), section: 'Parameters' },
        { key: 'offsetBaseConstruction', label: 'Base geometry', kind: 'check', section: 'Construction geometry' },
        { key: 'offsetConstruction', label: 'Offset geometry', kind: 'check', section: 'Construction geometry' },
    ],
    note: OffsetNote,
});

// ---- Fillet and chamfer ---------------------------------------------------------------------------------------

function CornerNote({ tool }: { tool: 'fillet' | 'chamfer' }) {
    const picked = useSketcher((s) => s.picks.filter((p) => p.type === 'point').length + (s.picks.filter((p) => p.type === 'curve').length === 2 ? 1 : 0));
    return (
        <p className="tb-note">
            {picked ? <><b>{picked}</b> corner{picked === 1 ? '' : 's'} selected: OK {tool === 'fillet' ? 'rounds' : 'cuts'} them. </> : null}
            {tool === 'fillet' ? 'Click a corner, or two lines or arcs, to round it.' : 'Click a corner, or two lines, to cut it.'}
        </p>
    );
}

const fillet = editTool({
    id: 'fillet',
    label: 'Fillet',
    icon: 'sk-fillet',
    hint: 'round a corner of lines or arcs',
    fields: [
        { key: 'filletRadius', label: 'Radius', kind: 'number', unit: 'mm', min: 0, step: 0.5, section: 'Fillet parameters' },
        { key: 'filletKeepCorners', label: 'Keep constrained corners', kind: 'check', section: 'Fillet parameters' },
        { key: 'filletDimensionEach', label: 'Dimension each fillet', kind: 'check', section: 'Fillet parameters' },
    ],
    note: () => <CornerNote tool="fillet" />,
});

const chamfer = editTool({
    id: 'chamfer',
    label: 'Chamfer',
    icon: 'sk-chamfer',
    hint: 'cut a corner of two lines',
    fields: [
        { key: 'chamferType', label: 'Type', kind: 'select', options: opts(['distance', 'Distance-distance'], ['angle', 'Angle-distance']), section: 'Chamfer parameters' },
        { key: 'chamferEqual', label: 'Equal distance', kind: 'check', section: 'Chamfer parameters', show: (v) => v.chamferType === 'distance' },
        { key: 'chamferDistance', label: 'Distance 1', kind: 'number', unit: 'mm', min: 0, step: 0.5, section: 'Chamfer parameters' },
        {
            key: 'chamferDistance2', label: 'Distance 2', kind: 'number', unit: 'mm', min: 0, step: 0.5, section: 'Chamfer parameters',
            show: (v) => v.chamferType === 'distance' && !v.chamferEqual,
        },
        { key: 'chamferAngle', label: 'Direction 1 angle', kind: 'number', unit: 'deg', section: 'Chamfer parameters', show: (v) => v.chamferType === 'angle' },
    ],
    note: () => <CornerNote tool="chamfer" />,
});

// ---- Mirror -----------------------------------------------------------------------------------------------

function MirrorNote() {
    const picked = useSketcher((s) => s.picks.length);
    const about = useSketcher((s) => s.mirrorAbout);
    return (
        <p className="tb-note">
            <b>{picked}</b> to mirror. {about ? 'Click any line to mirror about.' : 'Click the curves, then an axis or a centreline (or press Enter, then any line).'}
        </p>
    );
}

const mirror = editTool({
    id: 'mirror',
    label: 'Mirror',
    icon: 'mirror',
    hint: 'mirror curves about a line or axis',
    shortcut: 'M',
    fields: [{ key: 'mirrorCopy', label: 'Copy', kind: 'check', section: 'Options' }],
    note: MirrorNote,
});

/** In the Modify group, in place of the plain click tools. */
export const editToolForms: ToolDef[] = [trim, extend, fillet, chamfer, offset, mirror];
