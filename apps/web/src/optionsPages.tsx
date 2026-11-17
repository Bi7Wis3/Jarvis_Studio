// The pages of the Options panel (OptionsPage.tsx). Each edits the draft; nothing is saved until Apply or OK. The
// Lighting and AI assistant pages have modules of their own (optionsLighting.tsx, optionsAi.tsx).

import { useEffect, useState, type ReactNode } from 'react';
import { shownStyle, type DisplayStyle, type StudioSettings, type StudioSettingsView } from '@jarvis/core/settings';
import { DISPLAY_STYLES } from './displayStyle';
import { changeDefault, defaultsOf, DEFAULTS_TOOLS, shownDefaults } from './optionsDefaults';
import type { Draft, PageId } from './optionsDraft';
import { SKETCH_SETTING_FIELDS } from './sketchSettingsForm';
import { SPLINE_OPTION_FIELDS } from './sketchSplineForms';
import type { SketchToggles } from './sketchToggles';
import { QUICK_SNAPS } from './snapping';
import { ToolbarOptions } from './toolbarOptions';
import { FieldInput } from './toolForm';
import type { Field, Values } from './toolDefs';

export interface PageProps {
    draft: Draft;
    setDraft: (next: Draft) => void;
    saved: StudioSettingsView;
    page: PageId;
    onPage: (page: PageId) => void;
}

// ---- Rows (also used by the Lighting page, optionsLighting.tsx) ---------------------------------------------------

export function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <fieldset className="op-section">
            <legend>{title}</legend>
            {children}
        </fieldset>
    );
}

export const Note = ({ children }: { children: ReactNode }) => <p className="tb-note op-note">{children}</p>;

export function Check({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
    return (
        <label className="tb-check">
            <input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
            <span>{label}</span>
        </label>
    );
}

export function Choice<T extends string>(props:{ label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
    const { label, value, options, onChange } = props;
    return (
        <label className="tb-field">
            <span>{label}</span>
            <span className="tb-input">
                <select value={value} onChange={(e) => onChange(e.target.value as T)}>
                    {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
                </select>
            </span>
        </label>
    );
}

/** A number typed freely (any precision); the setting changes once the text is a number in range. */
export function NumberRow(props:{ label: string; value: number; unit?: string; min?: number; max?: number; onChange: (v: number) => void }) {
    const { label, value, unit, min, max, onChange } = props;
    const [text, setText] = useState(String(value));
    useEffect(() => {
        if (Number(text) !== value) {
            setText(String(value));
        }
    }, [value]);
    const n = Number(text);
    const bad = text.trim() === '' || !Number.isFinite(n) || (min !== undefined && n < min) || (max !== undefined && n > max);
    return (
        <label className={`tb-field ${bad ? 'op-bad' : ''}`} title={bad ? `A number${min !== undefined ? ` from ${min}` : ''}${max !== undefined ? ` to ${max}` : ''}` : undefined}>
            <span>{label}</span>
            <span className="tb-input">
                <input
                    type="number"
                    step="any"
                    value={text}
                    onChange={(e) => {
                        setText(e.target.value);
                        const v = Number(e.target.value);
                        if (e.target.value.trim() !== '' && Number.isFinite(v) && !(min !== undefined && v < min) && !(max !== undefined && v > max)) {
                            onChange(v);
                        }
                    }}
                />
                {unit && <em>{unit}</em>}
            </span>
        </label>
    );
}

export function ColourRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
    const [text, setText] = useState(value);
    useEffect(() => setText(value), [value]);
    return (
        <label className="tb-field">
            <span>{label}</span>
            <span className="tb-input tb-color">
                <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label} colour picker`} />
                <input
                    value={text}
                    onChange={(e) => {
                        setText(e.target.value);
                        if (/^#[0-9a-f]{6}$/i.test(e.target.value)) {
                            onChange(e.target.value.toLowerCase());
                        }
                    }}
                    aria-label={`${label} hex`}
                />
            </span>
        </label>
    );
}

/** Fields of a tool-style form (the sketch settings, a tool's defaults), drawn as the property manager draws them. */
function FormFields({ fields, values, change }: { fields: Field[]; values: Values; change: (key: string, value: Values[string]) => void }) {
    return (
        <div className="tb-fields">
            {fields.filter((f) => !f.show || f.show(values)).map((f, i) => <FieldInput key={`${f.key}-${i}`} field={f} values={values} change={change} spin />)}
        </div>
    );
}

/** A draft with one settings category changed. */
export function withCategory<K extends keyof StudioSettings>(draft: Draft, key: K, value: StudioSettings[K]): Draft {
    return { ...draft, settings: { ...draft.settings, [key]: value } };
}

// ---- General and sketch ------------------------------------------------------------------------------------------

export function GeneralPage({ draft, setDraft }: PageProps) {
    const general = draft.settings.general;
    return (
        <>
            <Section title="Confirmations">
                <Check
                    label="Ask before deleting a project, a part or a history step"
                    value={general.confirmDelete}
                    onChange={(confirmDelete) => setDraft(withCategory(draft, 'general', { ...general, confirmDelete }))}
                />
            </Section>
            <Section title="Assemblies">
                <Check
                    label="Move components by dragging"
                    value={general.moveComponentsByDragging !== false}
                    onChange={(moveComponentsByDragging) => setDraft(withCategory(draft, 'general', { ...general, moveComponentsByDragging }))}
                />
                <Note>
                    A component dragged in the view moves within the freedom its mates leave. Off: a drag on a component turns the view,
                    and only Move and Rotate move components.
                </Note>
            </Section>
            <Section title="Saving">
                <Note>Every change is saved to the project file at once, so there is no auto-save interval to set.</Note>
                <Note>These settings are kept on this computer, in the studio's data folder, and apply to every project.</Note>
            </Section>
        </>
    );
}

const sectionFields = (sections: string[], skip: string[] = []) =>
    [...SKETCH_SETTING_FIELDS, ...SPLINE_OPTION_FIELDS].filter((f) => sections.includes(f.section ?? '') && !skip.includes(f.key));

function useSketchChange({ draft, setDraft }: PageProps) {
    return (key: string, value: Values[string]) => setDraft({ ...draft, sketch: { ...draft.sketch, [key]: value } });
}

const TOGGLES: [keyof SketchToggles, string][] = [
    ['shadedContours', 'Shaded sketch contours'],
    ['instant2d', 'Instant2D (drag a clicked dimension to change it)'],
    ['rapidSketch', 'Rapid sketch (pressing on another face or plane starts a sketch there)'],
    ['xpertAutoOpen', 'Open SketchXpert when a sketch becomes over defined or does not solve'],
];

export function SketchPage(props: PageProps) {
    const { draft, setDraft } = props;
    const change = useSketchChange(props);
    const groups: [string, string[]][] = [
        ['Sketch settings', ['Sketch settings']],
        ['Sketch options', ['Sketch options']],
        ['Over defining dimensions', ['Over defining dimensions']],
        ['Splines', ['Splines']],
    ];
    return (
        <>
            {groups.map(([title, sections]) => (
                <Section key={title} title={title}>
                    <FormFields fields={sectionFields(sections, ['autoRelations'])} values={draft.sketch} change={change} />
                </Section>
            ))}
            <Section title="Sketch toolbar">
                {TOGGLES.map(([key, label]) => (
                    <Check
                        key={key}
                        label={label}
                        value={draft.sketchRest.toggles[key]}
                        onChange={(on) => setDraft({ ...draft, sketchRest: { ...draft.sketchRest, toggles: { ...draft.sketchRest.toggles, [key]: on } } })}
                    />
                ))}
            </Section>
        </>
    );
}

export function RelationsPage(props: PageProps) {
    const { draft, setDraft } = props;
    const change = useSketchChange(props);
    const fields: Field[] = [
        { key: 'snap', label: 'Enable snapping', kind: 'check' },
        { key: 'snapModel', label: 'Snap to model geometry', kind: 'check' },
        ...SKETCH_SETTING_FIELDS.filter((f) => f.key === 'autoRelations' || f.key === 'snapAngle'),
    ];
    const off = new Set(draft.sketchRest.snapsOff);
    return (
        <>
            <Section title="Relations and snaps">
                <FormFields fields={fields} values={draft.sketch} change={change} />
            </Section>
            <Section title="Sketch snaps">
                <Note>The snaps kept on or off while sketching (a quick snap from the sketch toolbar overrides them for one entity).</Note>
                <div className="op-columns">
                    {QUICK_SNAPS.map(({ kind, label }) => (
                        <Check
                            key={kind}
                            label={label}
                            value={!off.has(kind)}
                            onChange={(on) => setDraft({
                                ...draft,
                                sketchRest: { ...draft.sketchRest, snapsOff: QUICK_SNAPS.map((q) => q.kind).filter((k) => (k === kind ? !on : off.has(k))) },
                            })}
                        />
                    ))}
                </div>
            </Section>
        </>
    );
}

export function GridPage(props: PageProps) {
    const change = useSketchChange(props);
    return (
        <Section title="Grid/Snap">
            <FormFields fields={sectionFields(['Grid/Snap'])} values={props.draft.sketch} change={change} />
        </Section>
    );
}

// ---- Defaults ------------------------------------------------------------------------------------------------------

export function DefaultsListPage({ onPage, draft }: PageProps) {
    return (
        <Section title="Tool defaults">
            <Note>The values a new form starts with. Editing a step keeps the step's own values. Pick a tool:</Note>
            <div className="op-list">
                {DEFAULTS_TOOLS.map((t) => {
                    const { builtIn } = defaultsOf(t.id);
                    const changed = Object.entries(draft.defaults[t.id] ?? {}).filter(([k, v]) => builtIn[k] !== v).length;
                    return (
                        <button key={t.id} type="button" className="sk-small" onClick={() => onPage(`defaults:${t.id}`)}>
                            {t.label}{changed ? ` (${changed} changed)` : ''}
                        </button>
                    );
                })}
            </div>
        </Section>
    );
}

export function DefaultsToolPage({ draft, setDraft, tool }: PageProps & { tool: string }) {
    const entry = DEFAULTS_TOOLS.find((t) => t.id === tool);
    const { fields } = defaultsOf(tool);
    const values = draft.defaults[tool] ?? {};
    const change = (key: string, value: Values[string]) =>
        setDraft({ ...draft, defaults: { ...draft.defaults, [tool]: changeDefault(tool, values, key, value) } });
    return (
        <Section title={entry?.label ?? tool}>
            <Note>
                {tool === 'sketch'
                    ? 'The sizes the sketch fillet, chamfer and polygon tools start with when the studio opens.'
                    : `A new ${entry?.label.toLowerCase() ?? tool} form starts with these values; what it works out from the model (picks, positions) is not set here.`}
            </Note>
            {fields.length
                ? <FormFields fields={shownDefaults(fields, values)} values={values} change={change} />
                : <Note>This tool has no values to set.</Note>}
        </Section>
    );
}

// ---- Units and display ---------------------------------------------------------------------------------------------

const DECIMALS: [string, string][] = Array.from({ length: 9 }, (_, i) => [String(i), String(i)]);

export function UnitsPage({ draft, setDraft }: PageProps) {
    const units = draft.settings.units;
    const set = (patch: Partial<typeof units>) => setDraft(withCategory(draft, 'units', { ...units, ...patch }));
    return (
        <>
            <Section title="Dimensions in the view">
                <Choice label="Length decimals" value={String(units.lengthDecimals)} options={DECIMALS} onChange={(v) => set({ lengthDecimals: Number(v) })} />
                <Choice
                    label="Angles shown as"
                    value={units.angleUnit}
                    options={[['deg', 'Degrees'], ['dm', 'Degrees and minutes'], ['dms', 'Degrees, minutes and seconds'], ['rad', 'Radians']]}
                    onChange={(angleUnit) => set({ angleUnit })}
                />
                <Choice label="Angle decimals" value={String(units.angleDecimals)} options={DECIMALS} onChange={(v) => set({ angleDecimals: Number(v) })} />
                <Note>Lengths are in millimetres. Angles are typed in degrees whatever is shown.</Note>
            </Section>
            <Section title="Forms">
                <Choice
                    label="Number fields show"
                    value={units.formDecimals === null ? 'all' : String(units.formDecimals)}
                    options={[['all', 'The whole value'], ...DECIMALS.map(([v]) => [v, `${v} decimals`] as [string, string])]}
                    onChange={(v) => set({ formDecimals: v === 'all' ? null : Number(v) })}
                />
                <Note>Only what is shown is rounded: values keep their full precision, and a field shows all of it while it is being edited.</Note>
            </Section>
        </>
    );
}

/** Shaded with edges and Shaded: the two styles Show model edges switches between. */
const shadedPair = (style: DisplayStyle): boolean => style === 'shadedEdges' || style === 'shaded';

export function DisplayPage({ draft, setDraft, onPage }: PageProps) {
    const d = draft.settings.display;
    const set = (patch: Partial<typeof d>) => setDraft(withCategory(draft, 'display', { ...d, ...patch }));
    const style = shownStyle(d);
    return (
        <>
            <Section title="Model display">
                <Choice
                    label="Display quality"
                    value={d.meshQuality}
                    options={[['coarse', 'Coarse (faster, fewer triangles)'], ['normal', 'Normal'], ['fine', 'Fine (smoother, slower)']]}
                    onChange={(meshQuality) => set({ meshQuality })}
                />
                <Note>How finely parts are meshed for the view. Exports are always meshed at fine.</Note>
            </Section>
            <Section title="Rendering">
                <Check label="Anti-aliasing (smooth edges)" value={d.antialias} onChange={(antialias) => set({ antialias })} />
                <Note>Changing anti-aliasing draws the view afresh, and the view is framed again.</Note>
                <Choice
                    label="Largest pixel ratio"
                    value={String(d.pixelRatio)}
                    options={[['1', '1 (fastest)'], ['1.5', '1.5'], ['2', '2'], ['3', '3 (sharpest)']]}
                    onChange={(v) => set({ pixelRatio: Number(v) })}
                />
                <Check label="Glow (bloom) on bright parts" value={d.bloom} onChange={(bloom) => set({ bloom })} />
                {d.bloom && <NumberRow label="Glow strength" value={d.bloomIntensity} min={0} max={5} onChange={(bloomIntensity) => set({ bloomIntensity })} />}
                <Check label="Shadow on the ground" value={d.groundShadow} onChange={(groundShadow) => set({ groundShadow })} />
                {d.groundShadow && (
                    <NumberRow label="Shadow darkness" value={d.groundShadowOpacity} min={0} max={1} onChange={(groundShadowOpacity) => set({ groundShadowOpacity })} />
                )}
                <Note>
                    Shadows cast by the model come from the lights that have Cast shadows on:{' '}
                    <button type="button" className="op-link" onClick={() => onPage('lighting')}>Lighting</button>.
                </Note>
            </Section>
            <Section title="Display style">
                <Choice
                    label="Display style"
                    value={style}
                    options={DISPLAY_STYLES.map((s): [DisplayStyle, string] => [s.id, s.label])}
                    onChange={(next) => set({ style: next, ...(shadedPair(next) ? { edges: next === 'shadedEdges' } : {}) })}
                />
                <Check label="See-through model (shaded styles)" value={d.seeThrough} onChange={(seeThrough) => set({ seeThrough })} />
                <Choice
                    label="Hidden edges displayed as"
                    value={d.hiddenEdges}
                    options={[['dashed', 'Dashed'], ['solid', 'Solid']]}
                    onChange={(hiddenEdges) => set({ hiddenEdges })}
                />
                <Note>Hidden edges are the ones behind the model in Hidden lines visible. The style is on the View toolbar too.</Note>
            </Section>
            <Section title="Edges and grid">
                <Check
                    label="Show model edges (Shaded with edges)"
                    value={d.edges}
                    disabled={!shadedPair(style)}
                    onChange={(edges) => set({ edges, style: edges ? 'shadedEdges' : 'shaded' })}
                />
                <ColourRow label="Edge colour" value={d.edgeColor} onChange={(edgeColor) => set({ edgeColor })} />
                <NumberRow label="Edge opacity" value={d.edgeOpacity} min={0} max={1} onChange={(edgeOpacity) => set({ edgeOpacity })} />
                <Check label="Show the ground grid" value={d.grid} onChange={(grid) => set({ grid })} />
            </Section>
            <Section title="Background">
                <ColourRow label="Background colour" value={d.background} onChange={(background) => set({ background })} />
            </Section>
            <Section title="View">
                <Choice
                    label="View transition"
                    value={d.transition}
                    options={[['off', 'Off (jump at once)'], ['fast', 'Fast'], ['normal', 'Normal'], ['slow', 'Slow']]}
                    onChange={(transition) => set({ transition })}
                />
                <Check label="Perspective in the 3D view" value={d.perspective.model} onChange={(model) => set({ perspective: { ...d.perspective, model } })} />
                <Check label="Perspective while sketching" value={d.perspective.sketch} onChange={(sketch) => set({ perspective: { ...d.perspective, sketch } })} />
                <Choice
                    label="Sketch view quality"
                    value={d.sketchQuality}
                    options={[['fast', 'Fast (plain drawing while a sketch is open)'], ['full', 'Full (as the 3D view)']]}
                    onChange={(sketchQuality) => set({ sketchQuality })}
                />
            </Section>
        </>
    );
}

export function ToolbarsPage(_props: PageProps) {
    return (
        <Section title="Toolbars">
            <ToolbarOptions />
        </Section>
    );
}
