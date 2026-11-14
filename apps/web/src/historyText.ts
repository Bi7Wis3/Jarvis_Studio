// Short, engineer-style text for the history browser: names, icons and parameter summaries of bodies and features.

import type {
    AxisRef, EdgeSelect, Feature, FastenerType, Part, PlaneRef, PointRef, Repeat, RevolveAxis, Shape, Sketch, SketchPlane, SketchSource, Vec3,
} from '@jarvis/core';
import { valueText } from './numberText';

/** Number in mm without trailing zeros: 4, 2.5, 0.25. */
export function mm(value: number): string {
    return valueText(value);
}

const FASTENERS: Record<FastenerType, string> = {
    socketCap: 'socket cap',
    buttonHead: 'button head',
    countersunk: 'countersunk',
    hexBolt: 'hex bolt',
    hexNut: 'hex nut',
    nylocNut: 'nyloc nut',
    squareNut: 'square nut',
    washer: 'washer',
    heatsetInsert: 'heat-set insert',
};

const OPS: Record<Feature['op'], string> = {
    fillet: 'Fillet',
    chamfer: 'Chamfer',
    shell: 'Shell',
    add: 'Boss',
    cut: 'Cut',
    hole: 'Hole',
    extrude: 'Extrude',
    revolve: 'Revolve',
    mirror: 'Mirror',
    thread: 'Thread',
    sketch: 'Sketch',
    loft: 'Loft',
    plane: 'Plane',
    axis: 'Axis',
    point: 'Point',
    sweep: 'Sweep',
    pattern: 'Pattern',
    combine: 'Combine',
    split: 'Split',
    draft: 'Draft',
};

/** Construction steps: they build nothing, other steps use them by id. */
export const REFERENCE_OPS: ReadonlySet<Feature['op']> = new Set(['plane', 'axis', 'point']);

const EDGES: Record<EdgeSelect, string> = {
    all: 'all edges',
    top: 'top edges',
    bottom: 'bottom edges',
    vertical: 'vertical edges',
    horizontal: 'horizontal edges',
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a fillet or chamfer rounds: its picks ("3 edges, 1 face", "tangent"), else its edge group. */
function itemsText(f: { edges?: EdgeSelect; at?: unknown[]; faces?: unknown[]; tangent?: boolean }): string {
    const edges = f.at?.length ?? 0;
    const faces = f.faces?.length ?? 0;
    if (!edges && !faces) {
        return EDGES[f.edges ?? 'all'];
    }
    const picks = [edges ? plural(edges, 'edge') : '', faces ? plural(faces, 'face') : ''].filter(Boolean).join(', ');
    return f.tangent ? `${picks}, tangent` : picks;
}

/** Icon name (see icons.tsx) for a base body. */
export function shapeIcon(shape: Shape): string {
    switch (shape.kind) {
        case 'box':
        case 'cylinder':
        case 'sphere':
        case 'cone':
        case 'torus':
        case 'tube':
        case 'fastener':
        case 'sketch':
        case 'extrude':
            return shape.kind;
        case 'capsule':
            return 'cylinder';
        case 'lathe':
            return 'revolve';
        case 'script':
            return 'box';
        case 'empty':
            return 'sketch';
    }
}

/** Icon name for a feature op. */
export function featureIcon(feature: Feature): string {
    switch (feature.op) {
        case 'add':
            return 'boss';
        case 'cut':
            return 'cut';
        case 'extrude':
        case 'revolve':
        case 'sweep':
        case 'loft':
            return `${feature.mode === 'cut' ? 'cut' : 'boss'}-${feature.op}`;
        case 'pattern':
            return `pattern-${feature.kind}`;
        case 'combine':
            return feature.operation === 'cut' ? 'combine-cut' : 'combine';
        default:
            return feature.op;
    }
}

export function featureName(feature: Feature): string {
    return feature.name ?? OPS[feature.op];
}

/** Name of the step with this id in the part, else the id. */
function stepName(part: Part | undefined, id: string): string {
    const step = part?.features?.find((f) => f.id === id);
    return step ? featureName(step) : id;
}

/** A base plane name or a plane step's name. */
export function planeRefText(plane: PlaneRef, part?: Part): string {
    return typeof plane === 'string' ? plane[0].toUpperCase() + plane.slice(1) : stepName(part, plane.planeRef);
}

export function axisRefText(axis: AxisRef | Vec3, part?: Part): string {
    if (typeof axis === 'string') {
        return `${axis.toUpperCase()} axis`;
    }
    return Array.isArray(axis) ? `(${axis.map(mm).join(', ')})` : stepName(part, axis.axisRef);
}

/** Coordinates, or a point step's name. */
export function pointRefText(point: PointRef, part?: Part): string {
    return Array.isArray(point) ? `(${point.map(mm).join(', ')})` : stepName(part, point.pointRef);
}

/** Named plane, a plane step, or "face" for a custom plane picked from a part face. */
export function planeText(plane: SketchPlane, part?: Part): string {
    if (typeof plane === 'string') {
        return plane;
    }
    return 'planeRef' in plane ? stepName(part, plane.planeRef) : 'face';
}

function sketchText(sketch: Sketch): string {
    const offset = sketch.offset ? ` +${mm(sketch.offset)}` : '';
    const count = sketch.profiles.length;
    return `Sketch on ${planeText(sketch.plane)}${offset}${count > 1 ? ` (${count} profiles)` : ''}`;
}

function planeIds(plane: PlaneRef | SketchPlane | undefined): string[] {
    return plane && typeof plane === 'object' && 'planeRef' in plane ? [plane.planeRef] : [];
}

function axisIds(axis: AxisRef | Vec3 | RevolveAxis | undefined): string[] {
    return axis && typeof axis === 'object' && !Array.isArray(axis) && 'axisRef' in axis ? [axis.axisRef] : [];
}

function pointIds(point: PointRef | undefined): string[] {
    return point && !Array.isArray(point) ? [point.pointRef] : [];
}

function sourceIds(source: SketchSource): string[] {
    return source.sketchRef ? [source.sketchRef] : planeIds(source.sketch?.plane);
}

/**
 * Ids of the earlier steps a feature builds from: sketches (sketchRef), planes (planeRef), axes (axisRef) and the
 * steps a pattern repeats.
 */
export function stepRefs(feature: Feature): string[] {
    const ids: string[] = [];
    switch (feature.op) {
        case 'extrude':
            ids.push(...sourceIds(feature));
            break;
        case 'revolve':
            ids.push(...sourceIds(feature), ...axisIds(feature.axis));
            break;
        case 'loft':
            feature.sections.forEach((s) => ids.push(...sourceIds(s)));
            break;
        case 'sketch':
            ids.push(...planeIds(feature.sketch.plane));
            break;
        case 'sweep':
            if (feature.profile) {
                ids.push(...sourceIds(feature.profile));
            }
            ids.push(...('helix' in feature.path ? axisIds(feature.path.helix.axis) : sourceIds(feature.path)));
            break;
        case 'pattern':
            ids.push(...feature.features);
            ids.push(...axisIds(feature.kind === 'circular' ? feature.axis : feature.direction));
            if (feature.kind === 'linear') {
                ids.push(...axisIds(feature.direction2));
            }
            break;
        case 'split':
            ids.push(...planeIds(feature.plane));
            break;
        case 'mirror':
            ids.push(...(feature.features ?? []));
            if (typeof feature.plane === 'object') {
                ids.push(...planeIds(feature.plane));
            }
            break;
        case 'draft':
            ids.push(...planeIds(feature.neutral));
            break;
        case 'plane': {
            const d = feature.definition;
            if (d.kind === 'offset') {
                ids.push(...planeIds(d.base));
            } else if (d.kind === 'angle') {
                ids.push(...planeIds(d.base), ...(d.about === 'u' || d.about === 'v' ? [] : axisIds(d.about)));
            } else if (d.kind === 'midplane') {
                ids.push(...planeIds(d.a), ...planeIds(d.b));
            } else if (d.kind === 'threePoints') {
                d.points.forEach((p) => ids.push(...pointIds(p)));
            } else if (d.kind === 'pointNormal') {
                ids.push(...pointIds(d.point));
            } else if (d.kind === 'parallel') {
                ids.push(...planeIds(d.base), ...pointIds(d.point));
            } else if (d.kind === 'normal') {
                ids.push(...axisIds(d.axis), ...pointIds(d.point));
            }
            break;
        }
        case 'axis': {
            const d = feature.definition;
            if (d.kind === 'planeIntersection') {
                ids.push(...planeIds(d.a), ...planeIds(d.b));
            } else if (d.kind === 'twoPoints') {
                ids.push(...pointIds(d.a), ...pointIds(d.b));
            } else if (d.kind === 'pointDirection') {
                ids.push(...pointIds(d.point));
            } else if (d.kind === 'sketchLine') {
                ids.push(d.sketchRef);
            } else if (d.kind === 'pointPlane') {
                ids.push(...pointIds(d.point), ...planeIds(d.plane));
            }
            break;
        }
    }
    return [...new Set(ids)];
}

/** Later steps of the part that use the step `id`. */
export function stepUsers(part: Part, id: string): Feature[] {
    return (part.features ?? []).filter((f) => stepRefs(f).includes(id));
}

/** Where a sketch-based step gets its profile: "from Sketch 1" or the inline sketch's plane. */
function sourceText(source: SketchSource, part?: Part): string {
    if (source.sketchRef) {
        return `from ${stepName(part, source.sketchRef)}`;
    }
    return source.sketch ? planeText(source.sketch.plane, part) : '';
}

function repeatText(repeat?: Repeat): string {
    return repeat ? ` · ×${repeat.count} ${repeat.kind}` : '';
}

/** One-line parameter summary of a shape, e.g. "Box 60 × 25 × 40". */
export function shapeSummary(shape: Shape): string {
    switch (shape.kind) {
        case 'box':
            return `Box ${shape.size.map(mm).join(' × ')}${shape.radius ? ` · r ${mm(shape.radius)}` : ''}`;
        case 'cylinder':
            return shape.radiusTop != null && shape.radiusTop !== shape.radius
                ? `Cylinder ⌀${mm(shape.radius * 2)}→⌀${mm(shape.radiusTop * 2)} × ${mm(shape.height)}`
                : `Cylinder ⌀${mm(shape.radius * 2)} × ${mm(shape.height)}`;
        case 'tube':
            return `Tube ⌀${mm(shape.outerRadius * 2)}/⌀${mm(shape.innerRadius * 2)} × ${mm(shape.height)}`;
        case 'sphere':
            return `Sphere ⌀${mm(shape.radius * 2)}`;
        case 'torus':
            return `Torus R ${mm(shape.radius)} · r ${mm(shape.tube)}`;
        case 'cone':
            return `Cone ⌀${mm(shape.radius * 2)} × ${mm(shape.height)}`;
        case 'capsule':
            return `Capsule ⌀${mm(shape.radius * 2)} × ${mm(shape.length)}`;
        case 'lathe':
            return `Lathe · ${shape.profile.length} points`;
        case 'extrude':
            return `Outline · extrude ${mm(shape.height)} mm`;
        case 'script':
            return `Script · ${shape.size.map(mm).join(' × ')}`;
        case 'empty':
            return 'Empty part, starts with a sketch';
        case 'fastener':
            return `${shape.size}${shape.length ? ` × ${mm(shape.length)}` : ''} ${FASTENERS[shape.type]}`;
        case 'sketch': {
            const base = sketchText(shape.sketch);
            if (shape.revolve) {
                return `${base} · revolve ${mm(shape.revolve.angle ?? 360)}°`;
            }
            const dir = shape.extrude?.direction === 'symmetric' ? ' symmetric' : '';
            return `${base} · extrude ${mm(shape.extrude?.distance ?? 0)} mm${dir}`;
        }
    }
}

/**
 * One-line parameter summary of a feature, e.g. "r 4 · vertical edges". `part` names referenced steps, `parts`
 * the other parts a combine uses.
 */
export function featureSummary(feature: Feature, part?: Part, parts?: Part[]): string {
    switch (feature.op) {
        case 'fillet':
            return `r ${mm(feature.radius)}${feature.radius2 !== undefined ? ` to ${mm(feature.radius2)}` : ''} · ${itemsText(feature)}`;
        case 'chamfer':
            return `${feature.angle !== undefined ? `${mm(feature.size)} mm × ${mm(feature.angle)}°`
                : feature.distance2 !== undefined ? `${mm(feature.size)} × ${mm(feature.distance2)} mm` : `${mm(feature.size)} mm`} · ${itemsText(feature)}`;
        case 'shell': {
            const removed = [...(feature.open ?? []), ...(feature.remove?.length ? [plural(feature.remove.length, 'picked face')] : [])];
            return `Wall ${mm(feature.thickness)} mm${feature.outward ? ' outward' : ''} · ${removed.length ? `open ${removed.join(', ')}` : 'closed'}`;
        }
        case 'add':
        case 'cut':
            return `${shapeSummary(feature.shape)}${repeatText(feature.repeat)}`;
        case 'hole': {
            const { spec } = feature;
            const size = spec.size ?? (spec.diameter != null ? `⌀${mm(spec.diameter)}` : '');
            const kind = spec.kind === 'nutTrap' ? 'nut trap' : spec.kind;
            const depth = feature.depth != null ? `${mm(feature.depth)} deep` : 'through';
            return `${size} ${kind} · ${depth}${repeatText(feature.repeat)}`.trim();
        }
        case 'extrude': {
            const endText = (end: string | undefined, distance: number | undefined): string =>
                end === 'upToNext' ? 'up to next' : end === 'throughAll' ? 'through' : `${mm(distance ?? 0)} mm`;
            const draftText = (draft: number | undefined, outward: boolean | undefined): string[] =>
                draft ? [`draft ${mm(draft)}°${outward ? ' outward' : ''}`] : [];
            const amount = endText(feature.end ?? (feature.through ? 'throughAll' : 'blind'), feature.distance);
            const dir = feature.direction && feature.direction !== 'normal' ? ` ${feature.direction}` : '';
            const second = feature.second;
            const extras = [
                ...(feature.from ? [`from ${mm(feature.from)} mm`] : []),
                ...draftText(feature.draft, feature.draftOutward),
                ...(feature.flipSide && feature.mode === 'cut' ? ['flip side'] : []),
                ...(second ? [`2nd ${[endText(second.end, second.distance), ...draftText(second.draft, second.draftOutward)].join(' ')}`] : []),
            ];
            return [`Extrude ${amount}${dir}`, ...extras, feature.mode, sourceText(feature, part)].join(' · ');
        }
        case 'revolve': {
            const axis = feature.axis === 'u' || feature.axis === 'v' ? `sketch ${feature.axis.toUpperCase()}`
                : typeof feature.axis === 'object' && 'line' in feature.axis ? 'a sketch line' : axisRefText(feature.axis, part);
            const angle = `${mm(feature.angle ?? 360)}°${feature.type === 'midPlane' ? ' mid plane' : feature.reverse ? ' reversed' : ''}`;
            const second = feature.type !== 'midPlane' && feature.angle2 ? [`2nd ${mm(feature.angle2)}°`] : [];
            return [`Revolve ${angle} about ${axis}`, ...second, feature.mode, sourceText(feature, part)].join(' · ');
        }
        case 'mirror': {
            const old = { YZ: 'right', XY: 'front', XZ: 'top' } as Record<string, PlaneRef>;
            const plane = typeof feature.plane === 'string' && old[feature.plane] ? old[feature.plane] : feature.plane as PlaneRef;
            const what = feature.features?.length
                ? ` · ${feature.features.length} feature${feature.features.length === 1 ? '' : 's'}` : '';
            return `Mirror about ${planeRefText(plane, part)}${feature.offset ? ` +${mm(feature.offset)}` : ''}${what}`
                + (feature.keepOriginal === false ? ' · replace' : '');
        }
        case 'sketch': {
            const { sketch } = feature;
            const count = sketch.profiles.length;
            const chains = sketch.open?.length ?? 0;
            return `Sketch on ${planeText(sketch.plane, part)}${sketch.offset ? ` +${mm(sketch.offset)}` : ''} · ${count} profile${count === 1 ? '' : 's'}`
                + (chains ? ` · ${chains} open chain${chains === 1 ? '' : 's'}` : '');
        }
        case 'loft':
            return `Loft · ${feature.sections.length} sections · ${feature.mode === 'add' ? 'join' : 'cut'}${feature.ruled ? ' · ruled' : ''}`
                + (feature.closed ? ' · closed' : '');
        case 'plane': {
            const d = feature.definition;
            switch (d.kind) {
                case 'offset':
                    return `Offset ${mm(d.distance)} from ${planeRefText(d.base, part)}`;
                case 'angle':
                    return `${mm(d.angle)}° from ${planeRefText(d.base, part)} about `
                        + (d.about === 'u' || d.about === 'v' ? d.about : axisRefText(d.about, part));
                case 'threePoints':
                    return 'Through 3 points';
                case 'pointNormal':
                    return 'Tangent at point';
                case 'midplane':
                    return `Midplane of ${planeRefText(d.a, part)} and ${planeRefText(d.b, part)}`;
                case 'parallel':
                    return `Parallel to ${planeRefText(d.base, part)} through ${pointRefText(d.point, part)}`;
                case 'normal':
                    return `Normal to ${axisRefText(d.axis, part)}${d.point ? ` through ${pointRefText(d.point, part)}` : ''}`;
            }
        }
        case 'axis': {
            const d = feature.definition;
            switch (d.kind) {
                case 'twoPoints':
                    return `Through ${pointRefText(d.a, part)} and ${pointRefText(d.b, part)}`;
                case 'pointDirection':
                    return `Through ${pointRefText(d.point, part)} along (${d.direction.map(mm).join(', ')})`;
                case 'planeIntersection':
                    return `Where ${planeRefText(d.a, part)} meets ${planeRefText(d.b, part)}`;
                case 'sketchLine':
                    return `Along a line of ${stepName(part, d.sketchRef)}`;
                case 'pointPlane':
                    return `Through ${pointRefText(d.point, part)}, normal to ${planeRefText(d.plane, part)}`;
            }
        }
        case 'point':
            return `At (${feature.position.map(mm).join(', ')})`;
        case 'sweep': {
            const mode = feature.mode === 'add' ? 'join' : 'cut';
            if ('helix' in feature.path) {
                const h = feature.path.helix;
                return `Coil · ${mm(h.turns)} turns · pitch ${mm(h.pitch)} · ${mode}`;
            }
            const path = feature.path.sketchRef ? stepName(part, feature.path.sketchRef) : 'a path';
            return [
                `Sweep${feature.profile ? '' : ` ⌀${mm(feature.diameter ?? 0)}`} · along ${path}`,
                ...(feature.twist ? [`twist ${mm(feature.twist)}°`] : []),
                ...(feature.orientation === 'keepNormal' ? ['normal kept constant'] : []),
                mode,
            ].join(' · ');
        }
        case 'pattern': {
            const steps = `${feature.features.length} step${feature.features.length === 1 ? '' : 's'}`;
            const skipped = feature.skip?.length ? ` · ${feature.skip.length} skipped` : '';
            if (feature.kind === 'circular') {
                const angle = feature.equal === false ? ` · ${mm(feature.angle ?? 0)}° apart`
                    : feature.angle != null && feature.angle !== 360 ? ` in ${mm(feature.angle)}°` : '';
                return `Circular pattern · ${feature.count} ×${angle} · ${steps}${skipped}`;
            }
            const second = feature.direction2 !== undefined && feature.count2 !== undefined && feature.spacing2 !== undefined
                ? ` by ${feature.count2} × ${mm(feature.spacing2)} mm` : '';
            return `Linear pattern · ${feature.count} × ${mm(feature.spacing)} mm${second} · ${steps}${skipped}`;
        }
        case 'combine': {
            const other = parts?.find((p) => p.id === feature.part)?.name ?? feature.part;
            const verb = { join: 'Join', cut: 'Cut', intersect: 'Intersect' }[feature.operation];
            return `${verb} with ${other}`;
        }
        case 'split':
            return `By ${planeRefText(feature.plane, part)} · keep ${feature.keep}`;
        case 'draft':
            return [
                `${mm(feature.angle)}°${feature.flip ? ' reversed' : ''}`,
                [...(feature.faces ?? []), ...(feature.picked?.length ? [`${feature.picked.length} picked face${feature.picked.length === 1 ? '' : 's'}`] : [])].join(', '),
                `from ${feature.neutralFace ? 'a picked face' : feature.neutral ? planeRefText(feature.neutral, part) : 'no plane'}`,
            ].join(' · ');
        case 'thread':
            return [
                `${feature.kind}${feature.diameter !== undefined ? ` ⌀${mm(feature.diameter)}` : ''}`,
                `P ${mm(feature.pitch)}${(feature.starts ?? 1) > 1 ? ` × ${feature.starts} starts` : ''}`,
                feature.revolutions !== undefined ? `${mm(feature.revolutions)} turns` : `${mm(feature.length ?? 0)} mm`,
                ...(feature.leftHanded ? ['left hand'] : []),
                ...(feature.at ? ['on a picked edge'] : []),
            ].join(' · ');
    }
}

/** The feature a CAD build error names (`feature "<name or id>"`), or null when the error is about the body. */
export function failingFeature(part: Part, error: string | undefined): string | null {
    if (!error) {
        return null;
    }
    const hit = (part.features ?? []).find((f) => error.includes(`feature "${f.name ?? f.id}"`)
        || error.includes(`feature "${f.id}"`));
    return hit?.id ?? null;
}

/** A build error without its `feature "<name>" (op):` prefix, for showing under that feature. */
export function errorText(error: string): string {
    return error.replace(/^feature "[^"]*" \([^)]*\):\s*/, '');
}

/** The sketch editors a step offers in its menu: label and the id of the step to open (inline: the step itself). */
export function sketchEdits(feature: Feature): { label: string; id: string }[] {
    switch (feature.op) {
        case 'sketch':
            return [{ label: 'Edit sketch', id: feature.id }];
        case 'extrude':
        case 'revolve':
            return [{ label: 'Edit sketch', id: feature.sketchRef ?? feature.id }];
        case 'loft':
            return feature.sections.flatMap((s, i) => (s.sketchRef ? [{ label: `Edit section ${i + 1} sketch`, id: s.sketchRef }] : []));
        case 'sweep': {
            const edits = feature.profile?.sketchRef ? [{ label: 'Edit profile sketch', id: feature.profile.sketchRef }] : [];
            if (!('helix' in feature.path) && feature.path.sketchRef) {
                edits.push({ label: 'Edit path sketch', id: feature.path.sketchRef });
            }
            return edits;
        }
        default:
            return [];
    }
}
