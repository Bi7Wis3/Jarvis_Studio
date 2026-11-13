// Evaluate tools (measure, mass properties, ...), kept apart from toolDefs.tsx. The Inspect group of the part and
// assembly toolbars includes them after Check. Neither changes the model.

import { useEffect, useMemo, useState } from 'react';
import type { Part } from '@jarvis/core';
import type { Ctx, ToolDef, Values } from './toolDefs';
import { measureSections, sectionsText, type MeasureMesh, type MeasureSection } from './measure';
import { useKernelMesh, type KernelMesh } from './meshes';
import { clearPicked, runTool, useStudio } from './state';

// ---- Shared readout -------------------------------------------------------------------------------------------

/** Number with thin-space thousands and up to `decimals` decimals (trailing zeros dropped). */
function group(n: number, decimals = 2): string {
    const r = Number(n.toFixed(decimals));
    const [whole, fraction] = String(Object.is(r, -0) ? 0 : r).split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return fraction ? `${grouped}.${fraction}` : grouped;
}

function copyText(text: string, done: () => void): void {
    void navigator.clipboard?.writeText(text).then(done, () => undefined);
}

function Readout({ sections }: { sections: MeasureSection[] }) {
    return (
        <>
            {sections.map((section, i) => (
                <div key={`${section.title}-${i}`} className="ev-block">
                    <div className="ev-title">{section.title}</div>
                    <dl className="ev-list">
                        {section.rows.map(([label, value], k) => (
                            <div key={`${label}-${k}`}>
                                <dt>{label}</dt>
                                <dd>{value}</dd>
                            </div>
                        ))}
                    </dl>
                </div>
            ))}
        </>
    );
}

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) {
            return;
        }
        const timer = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(timer);
    }, [copied]);
    return (
        <button type="button" disabled={!text} onClick={() => copyText(text, () => setCopied(true))}>
            {copied ? 'Copied' : 'Copy'}
        </button>
    );
}

// ---- Mass properties ------------------------------------------------------------------------------------------

/** Densities in g/cm³. */
export const DENSITIES: { value: string; label: string; density: number }[] = [
    { value: 'pla', label: 'PLA', density: 1.24 },
    { value: 'petg', label: 'PETG', density: 1.27 },
    { value: 'abs', label: 'ABS', density: 1.04 },
    { value: 'tpu', label: 'TPU', density: 1.21 },
    { value: 'nylon', label: 'Nylon', density: 1.15 },
    { value: 'aluminium', label: 'Aluminium', density: 2.7 },
    { value: 'steel', label: 'Steel', density: 7.85 },
    { value: 'brass', label: 'Brass', density: 8.5 },
];

// Parts carry no material name, only looks: these are the colours of the material presets (toolDefs.tsx).
const PRESET_COLOURS: Record<string, string> = {
    '#b8bcc4': 'pla', '#3a7bd5': 'petg', '#2b2e33': 'tpu', '#8d97a5': 'aluminium', '#c4c8cd': 'steel', '#c9a24a': 'brass',
};

function materialOf(part: Part): string | undefined {
    return PRESET_COLOURS[part.material.color.toLowerCase()];
}

/** The preset the part's look comes from; for several parts, the one they share; else PLA. */
function defaultDensity(ctx: Ctx): (typeof DENSITIES)[number] {
    const parts = ctx.part ? [ctx.part] : (ctx.project?.parts ?? []);
    const kinds = new Set(parts.map(materialOf));
    const only = kinds.size === 1 ? [...kinds][0] : undefined;
    return DENSITIES.find((d) => d.value === only) ?? DENSITIES[0];
}

interface PartNumbers {
    id: string;
    name: string;
    copies: number;
    note?: string;
    volume?: number;
    area?: number;
    mass?: number;
    centre?: number[];
    bounds?: { min: number[]; max: number[] };
    principalMoments?: number[];
}

interface MassNumbers {
    density: number;
    parts: PartNumbers[];
    total?: { bodies: number; volume: number; area: number; mass: number; centre: number[]; principalMoments: number[] };
}

/** Splits the tool's answer into its readable text and the JSON numbers. */
export function parseMassAnswer(text: string): { text: string; numbers: MassNumbers | null } {
    const match = /\n*```json\n([\s\S]*?)\n```\s*$/.exec(text);
    if (!match) {
        return { text, numbers: null };
    }
    try {
        return { text: text.slice(0, match.index).trimEnd(), numbers: JSON.parse(match[1]) as MassNumbers };
    } catch {
        return { text, numbers: null };
    }
}

const massLabel = (g: number) => (g >= 1000 ? `${group(g / 1000, 3)} kg` : `${group(g, g < 1 ? 4 : 2)} g`);
const xyz = (v: number[]) => v.map((x) => group(x)).join(', ');

function massSections(numbers: MassNumbers): MeasureSection[] {
    const sections: MeasureSection[] = numbers.parts.map((p) => {
        const rows: [string, string][] = [];
        if (p.note) {
            rows.push(['Note', p.note]);
        }
        if (p.volume !== undefined && p.mass !== undefined) {
            const size = p.bounds ? p.bounds.max.map((v, i) => v - p.bounds!.min[i]) : null;
            rows.push(
                ['Mass', massLabel(p.mass)],
                ['Volume', `${group(p.volume / 1000, 3)} cm³ (${group(p.volume)} mm³)`],
                ['Surface area', `${group(p.area ?? 0)} mm²`],
                ['Centre of mass', `${xyz(p.centre ?? [])} mm`],
                ...(size ? [['Bounding box', `${size.map((v) => group(v)).join(' × ')} mm`]] as [string, string][] : []),
                ['Principal moments', `${(p.principalMoments ?? []).map((m) => group(m, 1)).join(', ')} g·mm²`],
            );
        }
        return { title: p.copies > 1 ? `${p.name} (one of ${p.copies})` : p.name, rows };
    });
    const t = numbers.total;
    if (t) {
        sections.push({
            title: `Total, ${t.bodies} bodies`,
            rows: [
                ['Mass', massLabel(t.mass)],
                ['Volume', `${group(t.volume / 1000, 3)} cm³`],
                ['Surface area', `${group(t.area)} mm²`],
                ['Centre of mass', `${xyz(t.centre)} mm (world)`],
                ['Principal moments', `${t.principalMoments.map((m) => group(m, 1)).join(', ')} g·mm²`],
            ],
        });
    }
    return sections;
}

function MassResults({ values, ctx }: { values: Values; ctx: Ctx }) {
    const density = Number(values.density);
    const valid = Number.isFinite(density) && density > 0 && density <= 30;
    const partId = ctx.part?.id;
    // Rerun when any part is rebuilt (an edit, undo, another part combined into this one).
    const meshes = useStudio((s) => JSON.stringify(s.meshes.keys));
    const [answer, setAnswer] = useState<{ text: string; isError: boolean } | null>(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!valid) {
            return;
        }
        let live = true;
        const timer = setTimeout(() => {
            setBusy(true);
            void runTool('mass_properties', { ...(partId ? { partIds: [partId] } : {}), density }).then((r) => {
                if (live) {
                    setAnswer(r);
                    setBusy(false);
                }
            });
        }, 250);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [partId, density, valid, meshes]);
    const parsed = useMemo(() => (answer && !answer.isError ? parseMassAnswer(answer.text) : null), [answer]);
    return (
        <div className="ev">
            <p className="tb-note">
                {partId ? `${ctx.part!.name}, from its CAD solid.` : 'All parts, as placed in the assembly.'} Centres are in the
                part's own frame; the total is in world coordinates.
            </p>
            {!valid && <p className="tb-note ev-error">Enter a density above 0 g/cm³.</p>}
            {busy && !answer && <p className="tb-note">Calculating…</p>}
            {answer?.isError && <pre className="tb-result error">{answer.text}</pre>}
            {parsed?.numbers ? <Readout sections={massSections(parsed.numbers)} /> : parsed && <pre className="tb-result">{parsed.text}</pre>}
            <div className="ev-actions">
                <CopyButton text={parsed?.text ?? ''} />
                {busy && answer && <span className="ev-busy">Updating…</span>}
            </div>
        </div>
    );
}

const massTool: ToolDef = {
    id: 'mass',
    label: 'Mass properties',
    icon: 'mass',
    hint: 'mass, volume, centre of mass, inertia',
    noApply: true,
    width: 340,
    fields: () => [
        {
            key: 'material', label: 'Material', kind: 'select',
            options: [...DENSITIES.map((d) => ({ value: d.value, label: `${d.label} (${d.density} g/cm³)` })), { value: 'custom', label: 'Custom' }],
        },
        { key: 'density', label: 'Density', kind: 'number', unit: 'g/cm³', step: 0.01, min: 0.01 },
    ],
    defaults: (ctx) => {
        const d = defaultDensity(ctx);
        return { material: d.value, density: String(d.density) };
    },
    onChange: (key, v): Values | undefined => {
        if (key === 'material') {
            const preset = DENSITIES.find((d) => d.value === v.material);
            return preset ? { density: String(preset.density) } : undefined;
        }
        if (key === 'density') {
            return { material: DENSITIES.find((d) => d.density === Number(v.density))?.value ?? 'custom' };
        }
    },
    extra: (api, ctx) => <MassResults values={api.values} ctx={ctx} />,
};

// ---- Measure --------------------------------------------------------------------------------------------------

export function measureMesh(kernel: KernelMesh): MeasureMesh {
    return {
        positions: kernel.surface.getAttribute('position').array,
        indices: kernel.surface.getIndex()?.array ?? [],
        triFace: kernel.triFace,
        edges: kernel.edges.getAttribute('position').array,
        segEdge: kernel.segEdge,
    };
}

function MeasurePanel() {
    const workspace = useStudio((s) => s.workspace);
    const picked = useStudio((s) => s.picked);
    const partId = picked[0]?.partId ?? '';
    const kernel = useKernelMesh(partId);
    const sections = useMemo(() => {
        if (!kernel || picked.length === 0) {
            return [];
        }
        return measureSections(measureMesh(kernel), picked.filter((p) => p.partId === partId));
    }, [kernel, picked, partId]);
    const text = sectionsText(sections);
    return (
        <div className="ev">
            {workspace !== 'part' ? (
                <p className="tb-note">Open a part to measure it: faces and edges are picked in the part workspace.</p>
            ) : picked.length === 0 ? (
                <p className="tb-note">
                    Click a face or edge of the part. Shift+click adds a second one, for the distance and angle between them.
                </p>
            ) : (
                <>
                    {!kernel && <p className="tb-note">Loading the part's mesh…</p>}
                    <Readout sections={sections} />
                    <p className="tb-note ev-small">
                        Coordinates in the part's frame, mm. ≈ marks values read from the tessellated surface.
                    </p>
                </>
            )}
            <div className="ev-actions">
                <button type="button" disabled={picked.length === 0} onClick={clearPicked}>Clear selection</button>
                <CopyButton text={text} />
            </div>
        </div>
    );
}

const measureTool: ToolDef = {
    id: 'measure',
    label: 'Measure',
    icon: 'measure',
    hint: 'sizes, distances and angles of picked faces and edges',
    noApply: true,
    width: 340,
    top: () => <MeasurePanel />,
};

export const evaluateTools: ToolDef[] = [measureTool, massTool];
