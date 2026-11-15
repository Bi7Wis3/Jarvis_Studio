// The pages of the Options panel (OptionsPage.tsx). Each edits the draft; nothing is saved until Apply or OK.

import { useEffect, useState, type ReactNode } from 'react';
import {
    EFFORTS, LIGHTING_PRESETS, MAX_LIGHTS, shownStyle, type DirectionalLight, type DisplayStyle, type Effort, type Lightformer,
    type StudioSettings, type StudioSettingsView,
} from '@jarvis/core/settings';
import { DISPLAY_STYLES } from './displayStyle';
import { testAiConnection, type AiTestResult } from './options';
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

// ---- Rows ------------------------------------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <fieldset className="op-section">
            <legend>{title}</legend>
            {children}
        </fieldset>
    );
}

const Note = ({ children }: { children: ReactNode }) => <p className="tb-note op-note">{children}</p>;

function Check({ label, value, onChange, disabled }: { label: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
    return (
        <label className="tb-check">
            <input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
            <span>{label}</span>
        </label>
    );
}

function Choice<T extends string>(props: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
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
function NumberRow(props: { label: string; value: number; unit?: string; min?: number; max?: number; onChange: (v: number) => void }) {
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

function ColourRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
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
function withCategory<K extends keyof StudioSettings>(draft: Draft, key: K, value: StudioSettings[K]): Draft {
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

// ---- Units, display, lighting ------------------------------------------------------------------------------------

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

const newId = (prefix: string, taken: { id: string }[]) => {
    for (let n = 1; ; n++) {
        if (!taken.some((t) => t.id === `${prefix}${n}`)) {
            return `${prefix}${n}`;
        }
    }
};

function Card({ title, onDelete, children }: { title: string; onDelete: () => void; children: ReactNode }) {
    return (
        <div className="op-card">
            <div className="op-card-head">
                <span>{title}</span>
                <button type="button" className="sk-small danger" onClick={onDelete}>Delete</button>
            </div>
            {children}
        </div>
    );
}

export function LightingPage({ draft, setDraft }: PageProps) {
    const l = draft.settings.lighting;
    const set = (patch: Partial<typeof l>) => setDraft(withCategory(draft, 'lighting', { ...l, ...patch }));
    const setLight = (i: number, patch: Partial<DirectionalLight>) =>
        set({ directional: l.directional.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
    const setFormer = (i: number, patch: Partial<Lightformer>) =>
        set({ environment: { ...l.environment, formers: l.environment.formers.map((x, j) => (j === i ? { ...x, ...patch } : x)) } });
    return (
        <>
            <Section title="Presets">
                <div className="op-list">
                    {(['studio', 'bright', 'dark'] as const).map((name) => (
                        <button key={name} type="button" className="sk-small" onClick={() => set(JSON.parse(JSON.stringify(LIGHTING_PRESETS[name])))}>
                            {name === 'studio' ? 'Studio' : name === 'bright' ? 'Bright' : 'Dark'}
                        </button>
                    ))}
                </div>
                <Note>Studio is the view's usual lighting. A preset replaces every light below.</Note>
            </Section>
            <Section title="Ambient light">
                <Check label="On" value={l.ambient.on} onChange={(on) => set({ ambient: { ...l.ambient, on } })} />
                <ColourRow label="Colour" value={l.ambient.color} onChange={(color) => set({ ambient: { ...l.ambient, color } })} />
                <NumberRow label="Intensity" value={l.ambient.intensity} min={0} max={10} onChange={(intensity) => set({ ambient: { ...l.ambient, intensity } })} />
            </Section>
            <Section title="Directional lights">
                {l.directional.map((light, i) => (
                    <Card key={light.id} title={`Light ${i + 1}`} onDelete={() => set({ directional: l.directional.filter((_, j) => j !== i) })}>
                        <Check label="On" value={light.on} onChange={(on) => setLight(i, { on })} />
                        <ColourRow label="Colour" value={light.color} onChange={(color) => setLight(i, { color })} />
                        <NumberRow label="Intensity" value={light.intensity} min={0} max={50} onChange={(intensity) => setLight(i, { intensity })} />
                        <NumberRow label="Azimuth" unit="deg" value={light.azimuth} min={-360} max={360} onChange={(azimuth) => setLight(i, { azimuth })} />
                        <NumberRow label="Elevation" unit="deg" value={light.elevation} min={-90} max={90} onChange={(elevation) => setLight(i, { elevation })} />
                        <Check label="Cast shadows" value={light.shadow} onChange={(shadow) => setLight(i, { shadow })} />
                    </Card>
                ))}
                <button
                    type="button"
                    className="sk-small"
                    disabled={l.directional.length >= MAX_LIGHTS}
                    onClick={() => set({
                        directional: [...l.directional, {
                            id: newId('light', l.directional), on: true, color: '#ffffff', intensity: 1, azimuth: 0, elevation: 45, shadow: false,
                        }],
                    })}
                >
                    Add directional light
                </button>
                <Note>Azimuth turns about the vertical from the front (towards the right is positive); elevation is the height above the ground.</Note>
            </Section>
            <Section title="Environment">
                <Check label="Environment reflections" value={l.environment.on} onChange={(on) => set({ environment: { ...l.environment, on } })} />
                <NumberRow
                    label="Strength"
                    value={l.environment.strength}
                    min={0}
                    max={10}
                    onChange={(strength) => set({ environment: { ...l.environment, strength } })}
                />
                <Note>Glowing panels around the model that shiny parts reflect.</Note>
                {l.environment.formers.map((f, i) => (
                    <Card
                        key={f.id}
                        title={`Panel ${i + 1}`}
                        onDelete={() => set({ environment: { ...l.environment, formers: l.environment.formers.filter((_, j) => j !== i) } })}
                    >
                        <Check label="On" value={f.on} onChange={(on) => setFormer(i, { on })} />
                        <Choice
                            label="Shape"
                            value={f.form}
                            options={[['rect', 'Rectangle'], ['ring', 'Ring'], ['circle', 'Disc']]}
                            onChange={(form) => setFormer(i, { form })}
                        />
                        <ColourRow label="Colour" value={f.color} onChange={(color) => setFormer(i, { color })} />
                        <NumberRow label="Intensity" value={f.intensity} min={0} max={100} onChange={(intensity) => setFormer(i, { intensity })} />
                        <NumberRow label="Azimuth" unit="deg" value={f.azimuth} min={-360} max={360} onChange={(azimuth) => setFormer(i, { azimuth })} />
                        <NumberRow label="Elevation" unit="deg" value={f.elevation} min={-90} max={90} onChange={(elevation) => setFormer(i, { elevation })} />
                        <NumberRow label={f.form === 'rect' ? 'Width' : 'Size'} value={f.width} min={0.01} max={100} onChange={(width) => setFormer(i, { width })} />
                        {f.form === 'rect' && <NumberRow label="Height" value={f.height} min={0.01} max={100} onChange={(height) => setFormer(i, { height })} />}
                    </Card>
                ))}
                <button
                    type="button"
                    className="sk-small"
                    disabled={l.environment.formers.length >= MAX_LIGHTS}
                    onClick={() => set({
                        environment: {
                            ...l.environment,
                            formers: [...l.environment.formers, {
                                id: newId('panel', l.environment.formers), on: true, form: 'rect', color: '#ffffff', intensity: 2,
                                azimuth: 0, elevation: 30, width: 8, height: 5, distance: 9,
                            }],
                        },
                    })}
                >
                    Add panel
                </button>
            </Section>
        </>
    );
}

// ---- AI assistant --------------------------------------------------------------------------------------------------

const ALIASES: [string, string][] = [['sonnet', 'Sonnet (latest)'], ['opus', 'Opus (latest)'], ['haiku', 'Haiku (latest)']];

const credentialText = (source?: string) => source === 'ANTHROPIC_API_KEY' ? 'the API key'
    : source === 'none' ? 'the Claude login' : source === '/login managed key' ? 'the Claude Code login (Console key)' : source ?? 'unknown';

function ModelChoice(props: {
    title: string; value: { model: string; effort: Effort }; models: AiTestResult['models']; onChange: (v: { model: string; effort: Effort }) => void;
    onTest: () => void; testing: boolean;
}) {
    const { title, value, models, onChange, onTest, testing } = props;
    const known: [string, string][] = [...ALIASES, ...(models ?? []).filter((m) => !ALIASES.some(([a]) => a === m.value)).map((m) => [m.value, m.name] as [string, string])];
    const listed = known.some(([v]) => v === value.model);
    const [other, setOther] = useState(!listed);
    return (
        <Section title={title}>
            <Choice
                label="Model"
                value={other ? 'other' : value.model}
                options={[...known, ['other', 'Another model id…']]}
                onChange={(v) => {
                    setOther(v === 'other');
                    if (v !== 'other') {
                        onChange({ ...value, model: v });
                    }
                }}
            />
            {other && (
                <label className="tb-field">
                    <span>Model id</span>
                    <span className="tb-input">
                        <input value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value.trim() })} placeholder="claude-…" spellCheck={false} />
                    </span>
                </label>
            )}
            <Choice
                label="Effort"
                value={value.effort}
                options={EFFORTS.map((e): [Effort, string] => [e, e === 'xhigh' ? 'Extra high' : e[0].toUpperCase() + e.slice(1)])}
                onChange={(effort) => onChange({ ...value, effort })}
            />
            <div className="op-row">
                <button type="button" className="sk-small" disabled={testing} onClick={onTest}>{testing ? 'Testing…' : 'Test connection'}</button>
            </div>
        </Section>
    );
}

export function AiPage({ draft, setDraft, saved }: PageProps) {
    const ai = draft.settings.ai;
    const set = (patch: Partial<typeof ai>) => setDraft(withCategory(draft, 'ai', { ...ai, ...patch }));
    const [testing, setTesting] = useState<'fast' | 'best' | null>(null);
    const [result, setResult] = useState<{ which: 'fast' | 'best'; r: AiTestResult } | null>(null);
    const keyKept = saved.ai.apiKeySet && draft.apiKey === null;
    const removing = saved.ai.apiKeySet && draft.apiKey === '';
    const test = async (which: 'fast' | 'best') => {
        setTesting(which);
        setResult(null);
        const r = await testAiConnection({ auth: ai.auth, apiKey: draft.apiKey || undefined, ...ai[which] });
        setTesting(null);
        setResult({ which, r });
    };
    return (
        <>
            <Section title="Connection">
                <label className="tb-check">
                    <input type="radio" name="op-auth" checked={ai.auth === 'local'} onChange={() => set({ auth: 'local' })} />
                    <span>Claude Code on this computer (its own login, as before)</span>
                </label>
                <label className="tb-check">
                    <input type="radio" name="op-auth" checked={ai.auth === 'apiKey'} onChange={() => set({ auth: 'apiKey' })} />
                    <span>An Anthropic API key</span>
                </label>
                {ai.auth === 'apiKey' && (
                    <>
                        {keyKept && (
                            <div className="op-row">
                                <span className="op-key">Key kept: {saved.ai.apiKeyMasked}</span>
                                <button type="button" className="sk-small" onClick={() => setDraft({ ...draft, apiKey: '' })}>Remove key</button>
                            </div>
                        )}
                        {removing && (
                            <div className="op-row">
                                <span className="op-key">The kept key is removed when you apply.</span>
                                <button type="button" className="sk-small" onClick={() => setDraft({ ...draft, apiKey: null })}>Keep it</button>
                            </div>
                        )}
                        <label className="tb-field">
                            <span>{saved.ai.apiKeySet ? 'New API key' : 'API key'}</span>
                            <span className="tb-input">
                                <input
                                    type="password"
                                    autoComplete="new-password"
                                    spellCheck={false}
                                    value={draft.apiKey ?? ''}
                                    placeholder="sk-ant-…"
                                    onChange={(e) => setDraft({ ...draft, apiKey: e.target.value === '' ? null : e.target.value })}
                                />
                            </span>
                        </label>
                        {!saved.ai.apiKeySet && !draft.apiKey && <Note>No key is kept yet: Jarvis cannot answer until one is applied.</Note>}
                    </>
                )}
                <Note>
                    The key is kept only on this computer, in the studio's settings file, which only you can read; it is never written into
                    projects or logs, and only Jarvis's own requests to Anthropic use it.
                </Note>
            </Section>
            <ModelChoice title="Fast" value={ai.fast} models={result?.r.models} onChange={(fast) => set({ fast })} onTest={() => void test('fast')} testing={testing === 'fast'} />
            <ModelChoice title="Best" value={ai.best} models={result?.r.models} onChange={(best) => set({ best })} onTest={() => void test('best')} testing={testing === 'best'} />
            {result && (
                <p className={`op-test ${result.r.ok ? 'ok' : 'error'}`} role="status">
                    {result.which === 'fast' ? 'Fast' : 'Best'}:{' '}
                    {result.r.ok
                        ? `connected. ${result.r.model ?? 'The model'} answered in ${(result.r.ms / 1000).toFixed(1)} s, using ${credentialText(result.r.credential)}.`
                        : `not connected. ${result.r.error ?? ''}`}
                </p>
            )}
            <Note>A change applies to Jarvis's next request: its conversation starts afresh; the project is not touched.</Note>
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
