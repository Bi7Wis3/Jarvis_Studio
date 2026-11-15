// The Sketch Text PropertyManager in the left panel: Curves (the text runs along them), Text (with Bold, Italic and
// Rotate for selected characters), Alignment and Flip, Width factor and Spacing, Font and height, and where it
// starts. The text shows as a ghost while it is typed; OK builds it into the sketch, and it stays editable.

import { useEffect, useRef, useState } from 'react';
import type { SketchGeometry, SketchText } from '@jarvis/core';
import { layoutText, type FontGlyphs, type FontStyle, type Outline } from '@jarvis/core/text';
import type { Field, PopupApi, Result, ToolDef, Values } from './toolDefs';
import { curveOf } from './solver';
import { commitGeometry, setViewPicker, useSketcher } from './sketcher';
import { startPicker, stopPicker } from './sketchMoreTools';
import { ownerOf } from './sketchItems';
import { CURVE_NOUN } from './sketchCurves';
import { DEFAULT_TEXT, buildText, deleteText, dissolveText, loadFonts, textFonts, textPath, wrapCode, type FontInfo } from './sketchTextItems';
import { clearExtras, useSketchExtras } from './sketchExtrasState';
import { valueText } from './numberText';
import './sketchExtras.css';

type Pt = [number, number];
const fmt = valueText;

let fonts: FontInfo[] = [];
void loadFonts().then((list) => {
    fonts = list;
});

const ok = (error: string | null): Result => ({ text: error ?? '', isError: !!error });

/** The selected text, if a curve of one is selected. */
function selectedText(g: SketchGeometry): SketchText | null {
    const s = useSketcher.getState();
    for (const x of s.selection) {
        const owner = ownerOf(g, x.id);
        if (owner?.kind === 'text') {
            return g.texts?.find((t) => t.id === owner.id) ?? null;
        }
    }
    return null;
}

function valuesOf(t: Omit<SketchText, 'id' | 'curves' | 'points'> & { id?: string }): Values {
    return {
        id: t.id ?? '', text: t.text, font: t.font, height: fmt(t.height), widthFactor: fmt(t.widthFactor ?? 100), spacing: fmt(t.spacing ?? 100),
        bold: !!t.bold, italic: !!t.italic, align: t.align ?? 'left', flipV: !!t.flipV, flipH: !!t.flipH,
        atX: fmt(t.at[0]), atY: fmt(t.at[1]), along: t.along ?? [],
    };
}

function number(v: Values, key: string, label: string): number {
    const raw = v[key];
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) {
        throw new Error(`${label} must be a number.`);
    }
    return n;
}

const alongOf = (v: Values): string[] => (Array.isArray(v.along) ? (v.along as string[]) : []);

/** The text item the form's values describe (its entities are filled in when it is built). */
function itemOf(v: Values): SketchText {
    const along = alongOf(v);
    const widthFactor = number(v, 'widthFactor', 'Width factor');
    const spacing = number(v, 'spacing', 'Spacing');
    if (!(widthFactor > 0) || !(spacing > 0)) {
        throw new Error('Width factor and spacing must be above zero.');
    }
    return {
        id: String(v.id || `t${Date.now().toString(36)}`), text: String(v.text ?? ''), font: String(v.font), height: number(v, 'height', 'Height'),
        widthFactor, spacing, at: [number(v, 'atX', 'X'), number(v, 'atY', 'Y')], curves: [], points: [],
        ...(v.bold ? { bold: true } : {}), ...(v.italic ? { italic: true } : {}),
        ...(along.length ? { along, align: (v.align as SketchText['align']) ?? 'left', ...(v.flipV ? { flipV: true } : {}) } : {}),
        ...(v.flipH ? { flipH: true } : {}),
    };
}

// ---- Following the curves the text runs along -------------------------------------------------------------------

/** The glyphs each text was last built with, so it can be rebuilt at once when its curves move. */
const builtFonts = new Map<string, Partial<Record<FontStyle, FontGlyphs>>>();
const pathKeys = new Map<string, string>();

function pathKey(g: SketchGeometry, t: SketchText): string {
    const ids = t.along ?? [];
    const curves = ids.map((id) => curveOf(g, id));
    const points = new Set(curves.flatMap((c) => (c ? Object.values(c).filter((x): x is string => typeof x === 'string' || Array.isArray(x)).flat() : [])));
    return JSON.stringify([curves, g.points.filter((p) => points.has(p.id)).map((p) => [p.id, p.u, p.v])]);
}

useSketcher.subscribe((s, prev) => {
    if (s.geometry === prev.geometry || !s.active || !s.geometry.texts?.length) {
        return;
    }
    let g = s.geometry;
    for (const t of s.geometry.texts) {
        if (!t.along?.length) {
            continue;
        }
        const key = pathKey(g, t);
        const before = pathKeys.get(t.id);
        pathKeys.set(t.id, key);
        if (before === undefined || before === key) {
            if (!builtFonts.has(t.id)) {
                // Fetch the glyphs once, to be ready when the curves move.
                void textFonts(t).then((f) => typeof f !== 'string' && builtFonts.set(t.id, f));
            }
            continue;
        }
        const f = builtFonts.get(t.id);
        const built = f ? buildText(g, t, f) : null;
        if (built && typeof built !== 'string') {
            g = built.g;
        }
    }
    if (g !== s.geometry) {
        // The text follows its curves (SolidWorks updates sketch text with the curves it is on).
        useSketcher.setState({ geometry: g });
    }
});

// ---- The form's parts ---------------------------------------------------------------------------------------------

function curveName(g: SketchGeometry, id: string): string {
    const c = curveOf(g, id);
    return c ? `${CURVE_NOUN[c.kind][0].toUpperCase()}${CURVE_NOUN[c.kind].slice(1)} ${id}` : `${id} (deleted)`;
}

/** A selection box of sketch curves (more than one); active, it takes the curves clicked in the view. */
export function CurveList({ api, valueKey, label, accept, empty, models }: {
    api: PopupApi; valueKey: string; label: string; empty: string;
    accept: (g: SketchGeometry, id: string) => string | null;
    /** A click on a model edge (any curve) brings it into the sketch to pick. */
    models?: boolean;
}) {
    const g = useSketcher((s) => s.geometry);
    const [active, setActive] = useState(false);
    const latest = useRef(api);
    latest.current = api;
    const ids = Array.isArray(api.values[valueKey]) ? (api.values[valueKey] as string[]) : [];
    useEffect(() => {
        if (!active) {
            stopPicker();
            return;
        }
        startPicker({
            back: 'select',
            ...(models ? { models: 'curve' as const } : {}),
            accept: (geometry, pick) => (pick.type !== 'curve' || !curveOf(geometry, pick.id) ? 'Pick a sketch curve.' : accept(geometry, pick.id)),
            onPick: (pick) => {
                const now = Array.isArray(latest.current.values[valueKey]) ? (latest.current.values[valueKey] as string[]) : [];
                latest.current.set({ [valueKey]: now.includes(pick.id) ? now.filter((id) => id !== pick.id) : [...now, pick.id] });
            },
        });
    }, [active]);
    useEffect(() => () => stopPicker(), []);
    useEffect(() => {
        useSketchExtras.setState({ lit: ids });
    }, [ids.join()]);
    return (
        <div className="tb-field pm-pick">
            <span>{label}</span>
            <ul className={`pm-contours pm-pick-list ${active ? 'active' : ''}`} tabIndex={0} aria-label={label} onClick={() => setActive(true)} onFocus={() => setActive(true)}>
                {!ids.length && <li className="pm-contours-all">{active ? 'Click curves in the view' : empty}</li>}
                {ids.map((id) => (
                    <li key={id}>
                        <span>{curveName(g, id)}</span>
                        <button type="button" title="Remove from the selection" aria-label={`Remove ${curveName(g, id)}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                api.set({ [valueKey]: ids.filter((x) => x !== id) });
                            }}
                        >
                            ×
                        </button>
                    </li>
                ))}
            </ul>
            {active && <button type="button" className="sx-small" onClick={() => setActive(false)}>Done picking</button>}
        </div>
    );
}

function TextBox({ api }: { api: PopupApi }) {
    const box = useRef<HTMLTextAreaElement>(null);
    const style = (code: 'b' | 'i' | 'r30') => {
        const el = box.current;
        const text = String(api.values.text ?? '');
        const next = wrapCode(text, el?.selectionStart ?? 0, el?.selectionEnd ?? 0, code);
        api.set({ text: next.text });
        window.setTimeout(() => {
            el?.focus();
            el?.setSelectionRange(next.from, next.to);
        }, 0);
    };
    return (
        <div className="tb-field sx-text">
            <span>Text</span>
            <textarea
                ref={box}
                rows={3}
                value={String(api.values.text ?? '')}
                aria-label="Text"
                onChange={(e) => api.set({ text: e.target.value })}
                onKeyDown={(e) => e.stopPropagation()}
            />
            <div className="sx-row" role="group" aria-label="Style of the selected characters">
                <button type="button" title="Bold: the selected characters (codes <b> </b>)" onClick={() => style('b')}><b>B</b></button>
                <button type="button" title="Italic: the selected characters (codes <i> </i>)" onClick={() => style('i')}><i>I</i></button>
                <button type="button" title="Rotate the selected characters 30° counter-clockwise (code <r30>; edit the number for other angles)" onClick={() => style('r30')}>
                    ⟲ 30°
                </button>
            </div>
        </div>
    );
}

/** Samples outlines for the ghost. */
function outlinePolylines(outlines: Outline[]): Pt[][] {
    return outlines.map((o) => {
        const pts: Pt[] = [o.start];
        let at = o.start;
        for (const s of o.segments) {
            if (s.kind === 'line') {
                pts.push(s.to);
            } else {
                const poles = [at, ...s.controls, s.to];
                for (let k = 1; k <= 12; k++) {
                    pts.push(bezier(poles, k / 12));
                }
            }
            at = s.to;
        }
        return pts;
    });
}

function bezier(poles: Pt[], t: number): Pt {
    let p = poles;
    while (p.length > 1) {
        p = p.slice(1).map((q, i) => [p[i][0] + (q[0] - p[i][0]) * t, p[i][1] + (q[1] - p[i][1]) * t] as Pt);
    }
    return p[0];
}

/** The ghost of the text as the form describes it, rebuilt as it is typed. */
function TextGhost({ api }: { api: PopupApi }) {
    const g = useSketcher((s) => s.geometry);
    const [note, setNote] = useState<string | null>(null);
    const key = JSON.stringify(api.values);
    useEffect(() => {
        let live = true;
        const timer = window.setTimeout(() => {
            let item: SketchText;
            try {
                item = itemOf(api.values);
            } catch (e) {
                setNote(e instanceof Error ? e.message : String(e));
                return;
            }
            useSketchExtras.setState({ marker: item.along?.length ? null : item.at });
            void textFonts(item).then((f) => {
                if (!live) {
                    return;
                }
                if (typeof f === 'string') {
                    setNote(f);
                    useSketchExtras.setState({ preview: [] });
                    return;
                }
                const path = item.along?.length ? textPath(g, item.along) : null;
                if (typeof path === 'string') {
                    setNote(path);
                    return;
                }
                const { outlines, missing } = layoutText(item, f, path);
                setNote(missing.length ? `The font has no ${missing.map((c) => `“${c}”`).join(' ')}; left out.` : null);
                useSketchExtras.setState({ preview: outlinePolylines(outlines) });
            });
        }, 80);
        return () => {
            live = false;
            window.clearTimeout(timer);
        };
    }, [key, g]);
    useEffect(() => () => {
        setViewPicker(null);
        clearExtras();
    }, []);
    return note ? <p className="tb-note sx-warn">{note}</p> : null;
}

function PlaceButton({ api }: { api: PopupApi }) {
    const [placing, setPlacing] = useState(false);
    const latest = useRef(api);
    latest.current = api;
    useEffect(() => {
        if (!placing) {
            return;
        }
        setViewPicker({
            click: (raw) => {
                latest.current.set({ atX: fmt(raw[0]), atY: fmt(raw[1]) });
                setPlacing(false);
                return true;
            },
        });
        return () => setViewPicker(null);
    }, [placing]);
    if (alongOf(api.values).length) {
        return null;
    }
    return (
        <button type="button" className={`sx-small ${placing ? 'on' : ''}`} onClick={() => setPlacing(!placing)}>
            {placing ? 'Click where the text starts…' : 'Place in the view'}
        </button>
    );
}

// ---- The tool --------------------------------------------------------------------------------------------------

const onCurves = (v: Values) => alongOf(v).length > 0;

export const sketchTextTool: ToolDef = {
    id: 'sk-text',
    label: 'Text',
    icon: 'sketch-text',
    hint: 'text as sketch curves, straight or along curves, to extrude or cut',
    panel: true,
    width: 300,
    fields: () => [
        { key: 'align', label: 'Alignment', kind: 'select', section: 'Text', show: onCurves,
            options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }, { value: 'full', label: 'Full justify' }] },
        { key: 'flipV', label: 'Flip vertical (other side of the curve)', kind: 'check', section: 'Text', show: onCurves },
        { key: 'flipH', label: 'Flip horizontal (mirror)', kind: 'check', section: 'Text' },
        { key: 'widthFactor', label: 'Width factor', kind: 'number', unit: '%', min: 0, section: 'Text' },
        { key: 'spacing', label: 'Spacing', kind: 'number', unit: '%', min: 0, section: 'Text', show: (v) => !(onCurves(v) && v.align === 'full') },
        { key: 'font', label: 'Font', kind: 'select', section: 'Font',
            options: (fonts.length ? fonts : [{ family: DEFAULT_TEXT.font, styles: [] }]).map((f) => ({ value: f.family, label: f.family })) },
        { key: 'height', label: 'Height (capital letters)', kind: 'number', unit: 'mm', min: 0, section: 'Font' },
        { key: 'bold', label: 'Bold', kind: 'check', section: 'Font' },
        { key: 'italic', label: 'Italic', kind: 'check', section: 'Font' },
        { key: 'atX', label: 'Start X', kind: 'number', unit: 'mm', section: 'Position', show: (v) => !onCurves(v) },
        { key: 'atY', label: 'Start Y', kind: 'number', unit: 'mm', section: 'Position', show: (v) => !onCurves(v) },
    ] satisfies Field[],
    defaults: () => {
        const s = useSketcher.getState();
        const editing = selectedText(s.geometry);
        if (editing) {
            return valuesOf(editing);
        }
        // Curves selected before the tool: the text runs along them.
        const along = s.selection.filter((x) => x.type === 'curve' && curveOf(s.geometry, x.id) && !ownerOf(s.geometry, x.id)).map((x) => x.id);
        return valuesOf({ ...DEFAULT_TEXT, font: fonts.some((f) => f.family === DEFAULT_TEXT.font) ? DEFAULT_TEXT.font : fonts[0]?.family ?? DEFAULT_TEXT.font, along });
    },
    top: (api) => (
        <>
            <CurveList api={api} valueKey="along" label="Curves (optional)" empty="None: the text runs straight from its start point"
                accept={(g, id) => (ownerOf(g, id) ? 'Pick a curve that is not part of a text or block.' : null)} />
            <TextBox api={api} />
            <TextGhost api={api} />
        </>
    ),
    extra: (api) => (
        <div className="sx-row">
            <PlaceButton api={api} />
            {api.values.id && (
                <>
                    <button type="button" className="sx-small" title="Turn the text into plain lines and splines" onClick={() => api.run(async () => {
                        const g = useSketcher.getState().geometry;
                        return ok(commitGeometry(dissolveText(g, String(api.values.id))) ? null : 'Not applied.');
                    })}>
                        Dissolve sketch text
                    </button>
                    <button type="button" className="sx-small danger" onClick={() => api.run(async () => {
                        const g = useSketcher.getState().geometry;
                        return ok(commitGeometry(deleteText(g, String(api.values.id))) ? null : 'Not applied.');
                    })}>
                        Delete text
                    </button>
                </>
            )}
        </div>
    ),
    apply: async (v) => {
        let item: SketchText;
        try {
            item = itemOf(v);
        } catch (e) {
            return ok(e instanceof Error ? e.message : String(e));
        }
        if (!item.text.trim()) {
            return ok('Type the text.');
        }
        const f = await textFonts(item);
        if (typeof f === 'string') {
            return ok(f);
        }
        const g = useSketcher.getState().geometry;
        const built = buildText(g, item, f);
        if (typeof built === 'string') {
            return ok(built);
        }
        if (!commitGeometry(built.g)) {
            return ok(useSketcher.getState().message ?? 'Not applied.');
        }
        builtFonts.set(item.id, f);
        pathKeys.set(item.id, pathKey(built.g, built.item));
        useSketcher.setState({
            selection: [],
            message: built.missing.length ? `The font has no ${built.missing.join(' ')}: left out of the text.` : null,
        });
        return ok(null);
    },
};

/** Dissolve sketch text from the right-click menu. */
export function dissolveTextById(id: string): void {
    commitGeometry(dissolveText(useSketcher.getState().geometry, id));
}
