// What the Linear and Circular Sketch Pattern forms add to their base forms (toolDefs.tsx), after the SolidWorks
// PropertyManagers: Display instance count (the count shown in the view; a double-click there changes it), the
// circular pattern's centre picked from a sketch point or the origin by a click, its Radius and Arc Angle (the centre
// as a distance and angle from the middle of the selected entities), Instances to Skip picked by clicking instances,
// and editing a pattern after it is made (right-click an instance > Edit linear/circular pattern).

import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { SketchGeometry, SketchPatternRecord } from '@jarvis/core';
import { Html } from '@react-three/drei';
import type { Field, PopupApi, Result, ToolDef, Values } from './toolDefs';
import { commitGeometry, setViewPicker, useSketcher } from './sketcher';
import { pickAt } from './sketchGeometry';
import { fragmentOf } from './sketchClipboard';
import { ORIGIN, pointOf } from './solver';
import { circularSketchPattern, linearSketchPattern, type CircularPatternOptions, type LinearPatternOptions } from './sketchPattern';
import { countSpot, editPattern, patternRecordOf } from './sketchPatternRecord';
import { valueText } from './numberText';
import { Label, v3 } from './SketchDrawing';
import type { Pt } from './sketchMath';

type Kind = 'linear' | 'circular';
const fmt = valueText;
const say = (message: string | null) => useSketcher.setState({ message });

/** The pattern a right-click asked to edit, waiting for its form to open. */
let pendingEdit: string | null = null;

/** Right-click > Edit pattern: the form opens with the pattern's values; OK makes it again with the new ones. */
export function startPatternEdit(id: string): void {
    const g = useSketcher.getState().geometry;
    const r = g.patterns?.find((x) => x.id === id);
    if (!r) {
        return;
    }
    pendingEdit = id;
    useSketcher.setState({ selection: r.seed.map((c) => ({ type: 'curve' as const, id: c })) });
    window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: r.kind === 'linear' ? 'sk-pattern-linear' : 'sk-pattern-circular' }));
}

/** Runs a pattern on the seed curves of `g` (no selection involved). */
function makeWith(kind: Kind) {
    return (g: SketchGeometry, seed: string[], o: object) => (kind === 'linear'
        ? linearSketchPattern(g, seed, o as LinearPatternOptions)
        : circularSketchPattern(g, seed, o as CircularPatternOptions));
}

/** Changes a pattern's options (its count, from the view) and makes it again. */
export function repattern(id: string, patch: Record<string, unknown>, formPatch: Values = {}): string | null {
    const g = useSketcher.getState().geometry;
    const r = g.patterns?.find((x) => x.id === id);
    if (!r) {
        return 'That pattern is gone.';
    }
    const options = { ...r.options, ...patch };
    const next = editPattern(g, id, options, makeWith(r.kind));
    if (typeof next === 'string') {
        return next;
    }
    const { edit: _, ...plain } = formPatch;
    const form = { ...((r.options.form ?? {}) as Values), ...plain };
    const patched = { ...next, patterns: next.patterns!.map((x) => (x.id === id ? { ...x, options: { ...x.options, form } } : x)) };
    return commitGeometry(patched) ? null : useSketcher.getState().message ?? 'The pattern does not solve.';
}

/** The middle of the selected curves (where the circular pattern's Radius and Arc Angle are measured from). */
function seedCentre(): Pt | null {
    const s = useSketcher.getState();
    const ids = s.selection.filter((x) => x.type === 'curve').map((x) => x.id);
    return ids.length ? fragmentOf(s.geometry, ids)?.centre ?? null : null;
}

const polar = (from: Pt, to: Pt) => ({ radius: Math.hypot(to[0] - from[0], to[1] - from[1]), angle: (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI });

/** Radius and Arc Angle for a centre. */
function polarValues(v: Values): Values {
    const from = seedCentre();
    const c: Pt = [Number(v.centre0), Number(v.centre1)];
    if (!from || !c.every(Number.isFinite)) {
        return {};
    }
    const p = polar(from, c);
    return { radiusAt: fmt(p.radius), arcAngle: fmt(p.angle) };
}

/** The centre for a Radius and Arc Angle. */
function centreValues(v: Values): Values {
    const from = seedCentre();
    const [r, a] = [Number(v.radiusAt), (Number(v.arcAngle) * Math.PI) / 180];
    if (!from || !Number.isFinite(r) || !Number.isFinite(a)) {
        return {};
    }
    return { centre0: fmt(from[0] + r * Math.cos(a)), centre1: fmt(from[1] + r * Math.sin(a)) };
}

// ---- Instances in the view (Instances to Skip, Display instance count) -------------------------------------------

interface Marks {
    /** Instance spots while Instances to Skip takes clicks: where each instance is, and whether it is skipped. */
    spots: { at: Pt; skipped: boolean; key: string }[];
}

const useMarks = create<Marks>(() => ({ spots: [] }));

/** Every instance's spot (the middle of the original moved there), keyed as the skip list counts them (from 1). */
function instanceSpots(kind: Kind, o: LinearPatternOptions | (Omit<CircularPatternOptions, 'centre'> & { centre: Pt })): { at: Pt; key: string }[] {
    const from = seedCentre();
    if (!from) {
        return [];
    }
    if (kind === 'linear') {
        const l = o as LinearPatternOptions;
        const rad = (d: number) => (d * Math.PI) / 180;
        const d1: Pt = [Math.cos(rad(l.angle)) * l.spacing, Math.sin(rad(l.angle)) * l.spacing];
        const d2: Pt = [Math.cos(rad(l.angle2 ?? 90)) * (l.spacing2 ?? 0), Math.sin(rad(l.angle2 ?? 90)) * (l.spacing2 ?? 0)];
        const out: { at: Pt; key: string }[] = [];
        for (let j = 0; j < Math.max(1, l.count2 ?? 1); j++) {
            for (let i = 0; i < l.count; i++) {
                if (i || j) {
                    out.push({ at: [from[0] + d1[0] * i + d2[0] * j, from[1] + d1[1] * i + d2[1] * j], key: `${i + 1},${j + 1}` });
                }
            }
        }
        return out;
    }
    const c = o as Omit<CircularPatternOptions, 'centre'> & { centre: Pt };
    const full = Math.abs(Math.abs(c.angle) - 360) < 1e-9;
    const step = (((c.equal !== false ? c.angle / (full ? c.count : c.count - 1) : c.angle)) * Math.PI) / 180;
    return Array.from({ length: c.count - 1 }, (_, k) => {
        const a = step * (k + 1);
        const [x, y] = [from[0] - c.centre[0], from[1] - c.centre[1]];
        return { at: [c.centre[0] + x * Math.cos(a) - y * Math.sin(a), c.centre[1] + x * Math.sin(a) + y * Math.cos(a)] as Pt, key: `${k + 2}` };
    });
}

/** The skip list as typed, with `key` added or taken out. */
function toggleSkip(text: string, key: string): string {
    const linear = key.includes(',');
    const parts = String(text ?? '').split(linear ? ';' : /[,;\s]+/).map((p) => p.trim().replace(/\s+/g, '')).filter(Boolean);
    const next = parts.includes(key) ? parts.filter((p) => p !== key) : [...parts, key];
    return next.join(linear ? '; ' : ', ');
}

function skipKeys(text: string, linear: boolean): Set<string> {
    return new Set(String(text ?? '').split(linear ? ';' : /[,;\s]+/).map((p) => p.trim().replace(/\s+/g, '')).filter(Boolean));
}

/** Instances to Skip: clicks on instances in the view add them to the list (again: take them out). */
function SkipPicker({ api, kind, toOptions }: { api: PopupApi; kind: Kind; toOptions: (v: Values) => object }) {
    const [on, setOn] = useState(false);
    const latest = useRef(api);
    latest.current = api;
    const spots = () => {
        try {
            return instanceSpots(kind, toOptions(latest.current.values) as never);
        } catch {
            return [];
        }
    };
    const show = () => {
        const skipped = skipKeys(String(latest.current.values.skip ?? ''), kind === 'linear');
        useMarks.setState({ spots: spots().map((s) => ({ ...s, skipped: skipped.has(s.key) })) });
    };
    useEffect(() => {
        if (!on) {
            useMarks.setState({ spots: [] });
            return;
        }
        show();
        setViewPicker({
            click: (raw, tolerance) => {
                const near = spots().map((s) => ({ ...s, d: Math.hypot(s.at[0] - raw[0], s.at[1] - raw[1]) })).sort((a, b) => a.d - b.d)[0];
                if (!near || near.d > tolerance * 4) {
                    say('Click an instance of the pattern (its dot) to skip it, or click it again to keep it.');
                    return true;
                }
                latest.current.set({ skip: toggleSkip(String(latest.current.values.skip ?? ''), near.key) });
                window.setTimeout(show, 0);
                return true;
            },
        });
        return () => {
            setViewPicker(null);
            useMarks.setState({ spots: [] });
        };
    }, [on]);
    useEffect(() => {
        if (on) {
            show();
        }
    }, [api.values]);
    return (
        <button type="button" className={`sx-small ${on ? 'on' : ''}`} onClick={() => setOn(!on)}>
            {on ? 'Click instances in the view… (click here to stop)' : 'Pick instances to skip in the view'}
        </button>
    );
}

/** Centre: a click on a sketch point or the origin sets it. */
function CentrePicker({ api }: { api: PopupApi }) {
    const [on, setOn] = useState(false);
    const latest = useRef(api);
    latest.current = api;
    useEffect(() => {
        if (!on) {
            return;
        }
        setViewPicker({
            click: (raw, tolerance) => {
                const g = useSketcher.getState().geometry;
                const pick = pickAt(g, raw, tolerance);
                const p = pick?.type === 'point' ? pointOf(g, pick.id) : null;
                if (!p) {
                    say('Click a sketch point or the origin for the centre.');
                    return true;
                }
                const values = { ...latest.current.values, centre0: fmt(p.u), centre1: fmt(p.v) };
                latest.current.set({ centre0: values.centre0, centre1: values.centre1, ...polarValues(values) });
                say(pick!.id === ORIGIN ? 'Centre: the sketch origin.' : 'Centre: the point picked.');
                setOn(false);
                return true;
            },
        });
        return () => setViewPicker(null);
    }, [on]);
    return (
        <div className="sx-row">
            <button type="button" className={`sx-small ${on ? 'on' : ''}`} onClick={() => setOn(!on)}>
                {on ? 'Click a point or the origin… (click here to stop)' : 'Pick the centre: a sketch point or the origin'}
            </button>
            <button type="button" className="sx-small" onClick={() => api.set({ centre0: '0', centre1: '0', ...polarValues({ ...api.values, centre0: '0', centre1: '0' }) })}>
                Sketch origin
            </button>
        </div>
    );
}

/** Display instance count: each shown pattern's count in the view; a double-click changes it there. */
function CountLabel({ r, g }: { r: SketchPatternRecord; g: SketchGeometry }) {
    const [typing, setTyping] = useState<string | null>(null);
    const at = countSpot(g, r);
    if (!at) {
        return null;
    }
    const count = Number(r.options.count ?? 0);
    const done = (text: string | null) => {
        setTyping(null);
        const n = Number(text);
        if (text === null || !Number.isInteger(n) || n === count) {
            return;
        }
        say(n < (r.kind === 'linear' && Number(r.options.count2 ?? 1) > 1 ? 1 : 2) ? 'The number of instances is too small.'
            : repattern(r.id, { count: n }, { count: String(n) }));
    };
    return (
        <Html position={v3(at)} center zIndexRange={[32, 0]} className="sk-label">
            {typing === null
                ? (
                    <button type="button" className="sk-pattern-count" title="Number of instances · double-click to change it"
                        onPointerDown={(e) => e.stopPropagation()} onDoubleClick={() => setTyping(String(count))}>
                        {count}
                    </button>
                )
                : (
                    <input className="sk-pattern-count" autoFocus value={typing} size={4} aria-label="Number of instances"
                        onPointerDown={(e) => e.stopPropagation()}
                        onChange={(e) => setTyping(e.target.value)}
                        onBlur={() => done(null)}
                        onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') {
                                done(typing);
                            } else if (e.key === 'Escape') {
                                done(null);
                            }
                        }}
                    />
                )}
        </Html>
    );
}

/** Drawn in the open sketch: pattern counts and the instance spots of Instances to Skip. */
export function PatternMarks() {
    const g = useSketcher((s) => s.geometry);
    const spots = useMarks((m) => m.spots);
    return (
        <>
            {(g.patterns ?? []).filter((r) => r.showCount).map((r) => <CountLabel key={r.id} r={r} g={g} />)}
            {spots.map((s) => (
                <Label key={`skip-${s.key}`} at={s.at} className={`pt ${s.skipped ? 'fixed' : 'picked'}`}>
                    <span title={s.skipped ? `Instance ${s.key}: skipped` : `Instance ${s.key}`} />
                </Label>
            ))}
        </>
    );
}

// ---- The forms --------------------------------------------------------------------------------------------------

/** Values of the pattern being edited (as its form had them). */
function editValues(kind: Kind): Values | null {
    const id = pendingEdit;
    pendingEdit = null;
    const r = id ? useSketcher.getState().geometry.patterns?.find((x) => x.id === id && x.kind === kind) : null;
    if (!r) {
        return null;
    }
    return { ...((r.options.form ?? {}) as Values), count: String(r.options.count ?? ''), showCount: !!r.showCount, edit: r.id };
}

/** Adds Display instance count, the circular pattern's centre picking, Radius and Arc Angle, skip picking and editing. */
export function withPatternExtras(def: ToolDef, kind: Kind, toOptions: (v: Values) => object): ToolDef {
    const section = kind === 'linear' ? 'Direction 1' : 'Parameters';
    return {
        ...def,
        fields: (ctx) => {
            const base = def.fields?.(ctx) ?? [];
            const at = base.findIndex((f) => f.key === 'count');
            const added: Field[] = [
                { key: 'showCount', label: 'Display instance count', kind: 'check', section },
                ...(kind === 'circular' ? [
                    { key: 'radiusAt', label: 'Radius', kind: 'number', unit: 'mm', section } satisfies Field,
                    { key: 'arcAngle', label: 'Arc angle', kind: 'number', unit: 'deg', section } satisfies Field,
                ] : []),
            ];
            return [...base.slice(0, at + 1), ...added, ...base.slice(at + 1)];
        },
        defaults: (ctx) => {
            const base = def.defaults?.(ctx) ?? {};
            const edit = editValues(kind);
            const values: Values = { ...base, showCount: false, edit: '', ...(edit ?? {}) };
            return kind === 'circular' ? { ...values, ...polarValues(values) } : values;
        },
        onChange: (key, v, ctx) => {
            const patch = (def.onChange?.(key, v, ctx) ?? {}) as Values;
            if (kind === 'circular' && (key === 'centre0' || key === 'centre1')) {
                return { ...patch, ...polarValues({ ...v, ...patch }) };
            }
            if (kind === 'circular' && (key === 'radiusAt' || key === 'arcAngle')) {
                return { ...patch, ...centreValues({ ...v, ...patch }) };
            }
            return patch;
        },
        top: (api, ctx) => (
            <>
                {api.values.edit && <p className="tb-note">Editing the pattern: OK makes it again from its original with these values.</p>}
                {def.top?.(api, ctx)}
                {kind === 'circular' && <CentrePicker api={api} />}
            </>
        ),
        extra: (api, ctx) => (
            <>
                {def.extra?.(api, ctx)}
                <div className="sx-row">
                    <SkipPicker api={api} kind={kind} toOptions={toOptions} />
                </div>
            </>
        ),
        apply: async (v, ctx): Promise<Result> => {
            const before = useSketcher.getState().geometry;
            if (v.edit) {
                let options: object;
                try {
                    options = toOptions(v);
                } catch (e) {
                    return { text: (e as Error).message, isError: true };
                }
                const error = repattern(String(v.edit), { ...options, showCount: !!v.showCount }, v);
                if (!error) {
                    const g = useSketcher.getState().geometry;
                    useSketcher.setState({ geometry: { ...g, patterns: g.patterns!.map((x) => (x.id === v.edit ? withShown(x, !!v.showCount) : x)) } });
                }
                return { text: error ?? '', isError: !!error };
            }
            const r = await def.apply!(v, ctx);
            if (r.isError) {
                return r;
            }
            // The new pattern keeps the form's values (to edit it later) and whether its count shows.
            const g = useSketcher.getState().geometry;
            const had = new Set((before.patterns ?? []).map((x) => x.id));
            if (g !== before && (g.patterns ?? []).some((x) => !had.has(x.id))) {
                const { edit: _, ...form } = v;
                useSketcher.setState({
                    geometry: { ...g, patterns: g.patterns!.map((x) => (had.has(x.id) ? x : withShown({ ...x, options: { ...x.options, form } }, !!v.showCount))) },
                });
            }
            return r;
        },
    };
}

function withShown(r: SketchPatternRecord, shown: boolean): SketchPatternRecord {
    if (shown) {
        return { ...r, showCount: true };
    }
    const { showCount: _, ...rest } = r;
    return rest;
}

/** Right-click entries for a curve of a pattern: edit it, show or hide its count. */
export function patternRecordFor(g: SketchGeometry, id: string): SketchPatternRecord | null {
    return patternRecordOf(g, id);
}

export function togglePatternCount(id: string): void {
    const g = useSketcher.getState().geometry;
    commitGeometry({ ...g, patterns: (g.patterns ?? []).map((r) => (r.id === id ? withShown(r, !r.showCount) : r)) });
}
