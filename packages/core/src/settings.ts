// The studio's settings (the Options page), shared by the server, which keeps them in one local file, and the web,
// which shows and applies them. `normaliseSettings` turns anything read or received into a complete, valid set.

/** How finely the server meshes parts for the view; exports are always meshed at fine. */
export type MeshQuality = 'coarse' | 'normal' | 'fine';
export const MESH_QUALITIES: MeshQuality[] = ['coarse', 'normal', 'fine'];

/** SolidWorks' display styles for the 3D view (View > Display), in its order. */
export type DisplayStyle = 'shadedEdges' | 'shaded' | 'hiddenRemoved' | 'hiddenVisible' | 'wireframe';
export const DISPLAY_STYLE_IDS: DisplayStyle[] = ['shadedEdges', 'shaded', 'hiddenRemoved', 'hiddenVisible', 'wireframe'];

/**
 * The display style the settings show. Shaded with edges and Shaded are Show model edges on and off, so for those two
 * `edges` decides (a settings file from before the styles, or one edited by hand, stays consistent).
 */
export function shownStyle(display: { style: DisplayStyle; edges: boolean }): DisplayStyle {
    return display.style === 'shadedEdges' || display.style === 'shaded' ? (display.edges ? 'shadedEdges' : 'shaded') : display.style;
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** How Jarvis reaches Claude: the Claude Code login on this machine, or an Anthropic API key kept in the settings file. */
export type AiAuth = 'local' | 'apiKey';

export interface AiModelChoice {
    /** A model alias the Claude Code CLI knows (sonnet, opus, haiku) or a full model id. */
    model: string;
    effort: Effort;
}

export interface AiSettings {
    auth: AiAuth;
    fast: AiModelChoice;
    best: AiModelChoice;
}

/** What the web sees of the AI settings: never the key itself. */
export interface AiSettingsView extends AiSettings {
    apiKeySet: boolean;
    /** The key's last four characters behind dots, or '' when none is kept. */
    apiKeyMasked: string;
}

export interface GeneralSettings {
    /** Ask before deleting a project, a part or a history step. */
    confirmDelete: boolean;
    /**
     * Assemblies: a component dragged in the view moves within its freedom (SolidWorks' System Options > Assemblies >
     * Move components by dragging, on by default). Off: only Move and Rotate move components. Absent (older settings): on.
     */
    moveComponentsByDragging?: boolean;
}

/** What every light but the ambient one has (SolidWorks' Directional, Point and Spot Light PropertyManagers). */
export interface LightCommon {
    id: string;
    on: boolean;
    color: string;
    /** Brightness, in the view's light units. */
    intensity: number;
    /** Light of the light's colour falling evenly on every side (SolidWorks: Ambient, per light); 0 for none. */
    ambient: number;
    /**
     * Kept in place relative to the model (SolidWorks: Lock to model). Off: the light turns with the view, its position
     * being where it is as seen from the front view (camera towards -Z, up +Y).
     */
    lockToModel: boolean;
    /** Kept when a preset replaces the lights (SolidWorks: Keep light when scene changes). */
    keep: boolean;
    /** Casts shadows of the model onto itself and the others. */
    shadow: boolean;
}

/** Light direction as SolidWorks gives it: azimuth (longitude, degrees from +Z towards +X) and elevation (latitude). */
export interface DirectionalLight extends LightCommon {
    azimuth: number;
    elevation: number;
}

/** How a point or spot light's position is given and edited (SolidWorks: Light position, Spherical or Cartesian). */
export type LightCoordinates = 'spherical' | 'cartesian';

/**
 * A light at a position, shining every way. The position is kept both ways and in sync: `coordinates` says which way
 * it was given (kept exactly as typed); the other way is worked out from it.
 */
export interface PointLight extends LightCommon {
    coordinates: LightCoordinates;
    /** Spherical, about the origin: degrees from +Z towards +X, degrees above the ground plane, and mm. */
    longitude: number;
    latitude: number;
    distance: number;
    /** Cartesian, mm. */
    x: number;
    y: number;
    z: number;
}

/** A light at a position shining a cone at a target point. */
export interface SpotLight extends PointLight {
    targetX: number;
    targetY: number;
    targetZ: number;
    /** From the cone's axis to its edge, degrees. */
    coneAngle: number;
}

/** A glowing panel in the environment the model reflects. */
export interface Lightformer {
    id: string;
    on: boolean;
    form: 'rect' | 'ring' | 'circle';
    color: string;
    intensity: number;
    azimuth: number;
    elevation: number;
    /** Width and height (ring and circle: width is the size). */
    width: number;
    height: number;
    /** Distance from the model in the environment's own units (kept from the presets, not edited). */
    distance: number;
}

export interface LightingSettings {
    ambient: { on: boolean; color: string; intensity: number };
    directional: DirectionalLight[];
    point: PointLight[];
    spot: SpotLight[];
    environment: { on: boolean; strength: number; formers: Lightformer[] };
}

export type ViewTransition = 'off' | 'fast' | 'normal' | 'slow';

export interface DisplaySettings {
    meshQuality: MeshQuality;
    antialias: boolean;
    /** Largest device pixel ratio the 3D view draws at (sharper but slower above 1). */
    pixelRatio: number;
    groundShadow: boolean;
    groundShadowOpacity: number;
    bloom: boolean;
    bloomIntensity: number;
    edges: boolean;
    edgeColor: string;
    edgeOpacity: number;
    /** Display style; between Shaded with edges and Shaded `edges` decides (see shownStyle). */
    style: DisplayStyle;
    /** The whole model drawn see-through, in the shaded styles. */
    seeThrough: boolean;
    /** Hidden edges in Hidden lines visible (System Options > Display: Hidden edges displayed as). */
    hiddenEdges: 'dashed' | 'solid';
    grid: boolean;
    background: string;
    transition: ViewTransition;
    perspective: { model: boolean; sketch: boolean };
    /** fast: an open sketch is drawn plainly (no bloom, frozen shadows, one pixel per screen pixel, frames on demand). */
    sketchQuality: 'fast' | 'full';
}

export type AngleUnit = 'deg' | 'dm' | 'dms' | 'rad';

export interface UnitSettings {
    /** Decimals of lengths shown in the view's dimensions and readouts. */
    lengthDecimals: number;
    /** Decimals of angles shown in the view's dimensions. */
    angleDecimals: number;
    /** How angles are shown in the view's dimensions. */
    angleUnit: AngleUnit;
    /** Decimals a number field shows while it is not being edited; null: the value as it is. */
    formDecimals: number | null;
}

export type ToolDefaultValue = string | boolean;

/** The app's own file browser (File > Import): the folder it opens at, the folders last imported from, pinned folders. */
export interface FileSettings {
    /** Absolute path of the folder the browser was last in, or '' for the home folder. */
    lastFolder: string;
    /** The folders files were last imported from, newest first. */
    recentFolders: string[];
    /** Folders pinned under Places, in the order they were pinned. */
    favourites: string[];
}

export const MAX_RECENT_FOLDERS = 10;
export const MAX_FAVOURITE_FOLDERS = 40;

export interface StudioSettings {
    general: GeneralSettings;
    /** The web's sketch settings (sketch options, toggles, snaps, splines), as the web's own modules define them. */
    sketch: Record<string, unknown>;
    /** Values new tool forms start with: tool id to field key to value (form text or a check box). */
    defaults: Record<string, Record<string, ToolDefaultValue>>;
    units: UnitSettings;
    display: DisplaySettings;
    lighting: LightingSettings;
    ai: AiSettings;
    /** The toolbar settings, as the toolbar's own module defines them. */
    toolbars: Record<string, unknown>;
    files: FileSettings;
}

/** The settings as the server sends them to the web. */
export interface StudioSettingsView extends Omit<StudioSettings, 'ai'> {
    ai: AiSettingsView;
}

/** The Options page's categories; Reset to defaults works on one of them. */
export type SettingsCategory = 'general' | 'sketch' | 'defaults' | 'units' | 'display' | 'lighting' | 'ai' | 'toolbars' | 'files';
export const SETTINGS_CATEGORIES: SettingsCategory[] = ['general', 'sketch', 'defaults', 'units', 'display', 'lighting', 'ai', 'toolbars', 'files'];

// ---- Lighting presets ----------------------------------------------------------------------------------------

/** A directional light of a preset: fixed to the model, as the view's lights always were. */
const sun = (id: string, color: string, intensity: number, azimuth: number, elevation: number): DirectionalLight => ({
    id, on: true, color, intensity, ambient: 0, lockToModel: true, keep: false, shadow: false, azimuth, elevation,
});

/** Studio: the lights the view has always had. */
const STUDIO: LightingSettings = {
    ambient: { on: true, color: '#ffffff', intensity: 0.25 },
    directional: [
        sun('key', '#ffffff', 2.2, 36.87, 50.19),
        sun('fill', '#6aa8ff', 0.8, -126.87, 21.8),
    ],
    point: [],
    spot: [],
    environment: {
        on: true,
        strength: 1,
        formers: [
            { id: 'top', on: true, form: 'rect', color: '#ffffff', intensity: 5, azimuth: 0, elevation: 75.96, width: 12, height: 6, distance: 8.25 },
            { id: 'left', on: true, form: 'rect', color: '#8fb8ff', intensity: 2.5, azimuth: -69.44, elevation: 13.17, width: 8, height: 5, distance: 8.77 },
            { id: 'right', on: true, form: 'rect', color: '#ffd9b0', intensity: 2, azimuth: 104.04, elevation: 19.99, width: 8, height: 5, distance: 8.77 },
            { id: 'front', on: true, form: 'ring', color: '#ffffff', intensity: 1.5, azimuth: 0, elevation: 5.71, width: 4, height: 4, distance: 10.05 },
        ],
    },
};

const BRIGHT: LightingSettings = {
    ambient: { on: true, color: '#ffffff', intensity: 0.6 },
    directional: [
        sun('key', '#ffffff', 3, 36.87, 50.19),
        sun('fill', '#ffffff', 1.5, -126.87, 21.8),
        sun('back', '#ffffff', 1, 180, 35),
    ],
    point: [],
    spot: [],
    environment: {
        on: true,
        strength: 1.5,
        formers: STUDIO.environment.formers.map((f) => ({ ...f, color: '#ffffff', intensity: f.intensity * 1.2 })),
    },
};

const DARK: LightingSettings = {
    ambient: { on: true, color: '#ffffff', intensity: 0.08 },
    directional: [
        sun('key', '#ffffff', 1.6, 36.87, 50.19),
        sun('rim', '#6aa8ff', 1.2, -150, 15),
    ],
    point: [],
    spot: [],
    environment: {
        on: true,
        strength: 0.45,
        formers: STUDIO.environment.formers.filter((f) => f.id !== 'front').map((f) => ({ ...f, intensity: f.intensity * 0.6 })),
    },
};

export const LIGHTING_PRESETS: Record<'studio' | 'bright' | 'dark', LightingSettings> = { studio: STUDIO, bright: BRIGHT, dark: DARK };

/**
 * Most lights one scene takes besides the ambient one: directional, point and spot lights together (SolidWorks: nine,
 * the ambient light and eight others). The environment's panels have a limit of their own, the same number.
 */
export const MAX_LIGHTS = 8;

/** Farthest a point or spot light (or a spot's target) may stand from the origin, mm. */
export const MAX_LIGHT_REACH = 1_000_000;

/** The point at a longitude and latitude (degrees, as `DirectionalLight` has them) and distance from the origin. */
export function sphericalPoint(longitude: number, latitude: number, distance: number): [number, number, number] {
    const a = (longitude * Math.PI) / 180;
    const e = (latitude * Math.PI) / 180;
    return [distance * Math.sin(a) * Math.cos(e), distance * Math.sin(e), distance * Math.cos(a) * Math.cos(e)];
}

/** Longitude, latitude (degrees) and distance of a point from the origin; straight up or down has longitude 0. */
export function sphericalOf(x: number, y: number, z: number): { longitude: number; latitude: number; distance: number } {
    const distance = Math.hypot(x, y, z);
    const flat = Math.hypot(x, z);
    return {
        longitude: flat > 1e-12 ? (Math.atan2(x, z) * 180) / Math.PI : 0,
        latitude: distance > 0 ? (Math.atan2(y, flat) * 180) / Math.PI : 0,
        distance,
    };
}

/** A worked-out value: to 0.000001 (the app's precision for values it works out), never coarser. */
const worked = (n: number): number => Math.round(n * 1e6) / 1e6 + 0;

/** The light with its position the other way worked out from the way `coordinates` names. */
export function placedLight<T extends PointLight>(light: T): T {
    if (light.coordinates === 'spherical') {
        const [x, y, z] = sphericalPoint(light.longitude, light.latitude, light.distance);
        return { ...light, x: worked(x), y: worked(y), z: worked(z) };
    }
    const s = sphericalOf(light.x, light.y, light.z);
    return { ...light, longitude: worked(s.longitude), latitude: worked(s.latitude), distance: worked(s.distance) };
}

/** Where a point or spot light stands (model frame, or the front view's frame when it is not locked to the model), mm. */
export function lightPoint(light: PointLight): [number, number, number] {
    return light.coordinates === 'spherical' ? sphericalPoint(light.longitude, light.latitude, light.distance) : [light.x, light.y, light.z];
}

/** How many lights there are besides the ambient one and the panels. */
export const lightCount = (l: Pick<LightingSettings, 'directional' | 'point' | 'spot'>): number => l.directional.length + l.point.length + l.spot.length;

// ---- Defaults --------------------------------------------------------------------------------------------------

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const DEFAULT_SETTINGS: StudioSettings = {
    general: { confirmDelete: true, moveComponentsByDragging: true },
    sketch: {},
    defaults: {},
    units: { lengthDecimals: 4, angleDecimals: 4, angleUnit: 'deg', formDecimals: null },
    display: {
        meshQuality: 'normal',
        antialias: true,
        pixelRatio: 2,
        groundShadow: true,
        groundShadowOpacity: 0.55,
        bloom: true,
        bloomIntensity: 0.8,
        edges: true,
        edgeColor: '#000000',
        edgeOpacity: 0.35,
        style: 'shadedEdges',
        seeThrough: false,
        hiddenEdges: 'dashed',
        grid: true,
        background: '#04060b',
        transition: 'normal',
        perspective: { model: true, sketch: false },
        sketchQuality: 'fast',
    },
    lighting: clone(STUDIO),
    ai: { auth: 'local', fast: { model: 'sonnet', effort: 'medium' }, best: { model: 'opus', effort: 'high' } },
    toolbars: {},
    files: { lastFolder: '', recentFolders: [], favourites: [] },
};

export function defaultSettings(): StudioSettings {
    return clone(DEFAULT_SETTINGS);
}

// ---- Normalising -----------------------------------------------------------------------------------------------

type Raw = Record<string, unknown>;

const isObject = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
const obj = (v: unknown): Raw => (isObject(v) ? v : {});
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const num = (v: unknown, fallback: number, min: number, max: number): number =>
    (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
const int = (v: unknown, fallback: number, min: number, max: number): number => Math.round(num(v, fallback, min, max));
const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
const colour = (v: unknown, fallback: string): string => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback);
const ident = (v: unknown, fallback: string): string => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : fallback);

/** A model alias or id: letters, digits and . - _ [ ] : only (it goes on a command line and in the logs). */
export function validModel(model: unknown): model is string {
    return typeof model === 'string' && /^[A-Za-z0-9][\w.\-:[\]]{0,99}$/.test(model);
}

/** A JSON object of plain data, cut off where it nests deeper than `depth` or grows past `maxBytes`; else {}. */
export function plainData(value: unknown, maxBytes = 64 * 1024, depth = 6): Record<string, unknown> {
    const strip = (v: unknown, level: number): unknown => {
        if (v === null || typeof v === 'boolean' || typeof v === 'string') {
            return v;
        }
        if (typeof v === 'number') {
            return Number.isFinite(v) ? v : null;
        }
        if (level >= depth) {
            return null;
        }
        if (Array.isArray(v)) {
            return v.slice(0, 500).map((x) => strip(x, level + 1));
        }
        if (isObject(v)) {
            return Object.fromEntries(Object.entries(v).slice(0, 500).map(([k, x]) => [k.slice(0, 80), strip(x, level + 1)]));
        }
        return null;
    };
    const out = isObject(value) ? strip(value, 0) as Record<string, unknown> : {};
    return JSON.stringify(out).length <= maxBytes ? out : {};
}

/** The fields every light has; a settings file from before they were added gets the view's old behaviour. */
function lightCommon(r: Raw, id: string, intensity: number): LightCommon {
    return {
        id,
        on: bool(r.on, true),
        color: colour(r.color, '#ffffff'),
        intensity: num(r.intensity, intensity, 0, 50),
        ambient: num(r.ambient, 0, 0, 10),
        lockToModel: bool(r.lockToModel, true),
        keep: bool(r.keep, false),
        shadow: bool(r.shadow, false),
    };
}

function directional(v: unknown, i: number): DirectionalLight {
    const r = obj(v);
    const base = STUDIO.directional[i] ?? STUDIO.directional[0];
    return {
        ...lightCommon(r, ident(r.id, `light${i + 1}`), base.intensity),
        azimuth: num(r.azimuth, base.azimuth, -360, 360),
        elevation: num(r.elevation, base.elevation, -90, 90),
    };
}

const reach = (v: unknown, fallback: number): number => num(v, fallback, -MAX_LIGHT_REACH, MAX_LIGHT_REACH);

function pointLight(v: unknown, i: number, prefix = 'point'): PointLight {
    const r = obj(v);
    return placedLight({
        ...lightCommon(r, ident(r.id, `${prefix}${i + 1}`), 1),
        coordinates: pick(r.coordinates, ['spherical', 'cartesian'] as const, 'spherical'),
        longitude: num(r.longitude, 0, -360, 360),
        latitude: num(r.latitude, 45, -90, 90),
        distance: num(r.distance, 300, 0, MAX_LIGHT_REACH),
        x: reach(r.x, 0),
        y: reach(r.y, 0),
        z: reach(r.z, 0),
    });
}

function spotLight(v: unknown, i: number): SpotLight {
    const r = obj(v);
    return {
        ...pointLight(r, i, 'spot'),
        targetX: reach(r.targetX, 0),
        targetY: reach(r.targetY, 0),
        targetZ: reach(r.targetZ, 0),
        coneAngle: num(r.coneAngle, 30, 0, 90),
    };
}

function former(v: unknown, i: number): Lightformer {
    const r = obj(v);
    const base = STUDIO.environment.formers[i] ?? STUDIO.environment.formers[0];
    return {
        id: ident(r.id, `panel${i + 1}`),
        on: bool(r.on, true),
        form: pick(r.form, ['rect', 'ring', 'circle'] as const, 'rect'),
        color: colour(r.color, '#ffffff'),
        intensity: num(r.intensity, base.intensity, 0, 100),
        azimuth: num(r.azimuth, base.azimuth, -360, 360),
        elevation: num(r.elevation, base.elevation, -90, 90),
        width: num(r.width, base.width, 0.01, 100),
        height: num(r.height, base.height, 0.01, 100),
        distance: num(r.distance, 9, 1, 100),
    };
}

/** Unique ids in a list, and against `seen` (a duplicate gets a number). */
function uniqueIds<T extends { id: string }>(list: T[], seen = new Set<string>()): T[] {
    return list.map((item) => {
        let id = item.id;
        for (let n = 2; seen.has(id); n++) {
            id = `${item.id}-${n}`;
        }
        seen.add(id);
        return { ...item, id };
    });
}

function lighting(v: unknown): LightingSettings {
    const r = obj(v);
    const ambient = obj(r.ambient);
    const env = obj(r.environment);
    const d = DEFAULT_SETTINGS.lighting;
    // Directional, point and spot lights share the limit, in that order, and their ids are unique across them.
    const ids = new Set<string>();
    const directionals = uniqueIds(Array.isArray(r.directional) ? r.directional.slice(0, MAX_LIGHTS).map(directional) : clone(d.directional), ids);
    let room = MAX_LIGHTS - directionals.length;
    const points = uniqueIds(Array.isArray(r.point) ? r.point.slice(0, room).map((p, i) => pointLight(p, i)) : [], ids);
    room -= points.length;
    const spots = uniqueIds(Array.isArray(r.spot) ? r.spot.slice(0, room).map(spotLight) : [], ids);
    return {
        ambient: {
            on: bool(ambient.on, d.ambient.on),
            color: colour(ambient.color, d.ambient.color),
            intensity: num(ambient.intensity, d.ambient.intensity, 0, 10),
        },
        directional: directionals,
        point: points,
        spot: spots,
        environment: {
            on: bool(env.on, d.environment.on),
            strength: num(env.strength, d.environment.strength, 0, 10),
            formers: Array.isArray(env.formers)
                ? uniqueIds(env.formers.slice(0, MAX_LIGHTS).map(former)) : clone(d.environment.formers),
        },
    };
}

/**
 * The lighting of a preset, with the current lights that have Keep light when scene changes on after the preset's own
 * (as many as the limit leaves room for; one whose id the preset uses gets a number).
 */
export function withPreset(current: LightingSettings, preset: LightingSettings): LightingSettings {
    const kept = <T extends LightCommon>(list: T[]): T[] => list.filter((l) => l.keep);
    return lighting({
        ...clone(preset),
        directional: [...preset.directional, ...kept(current.directional)],
        point: [...preset.point, ...kept(current.point)],
        spot: [...preset.spot, ...kept(current.spot)],
    });
}

function modelChoice(v: unknown, fallback: AiModelChoice): AiModelChoice {
    const r = obj(v);
    const model = typeof r.model === 'string' ? r.model.trim() : r.model;
    return { model: validModel(model) ? model : fallback.model, effort: pick(r.effort, EFFORTS, fallback.effort) };
}

function toolDefaults(v: unknown): StudioSettings['defaults'] {
    const out: StudioSettings['defaults'] = {};
    for (const [tool, values] of Object.entries(obj(v)).slice(0, 200)) {
        if (!/^[\w-]{1,60}$/.test(tool) || !isObject(values)) {
            continue;
        }
        const kept = Object.entries(values)
            .filter(([key, value]) => /^[\w-]{1,60}$/.test(key) && (typeof value === 'boolean' || (typeof value === 'string' && value.length <= 200)))
            .slice(0, 100);
        if (kept.length) {
            out[tool] = Object.fromEntries(kept) as Record<string, ToolDefaultValue>;
        }
    }
    return out;
}

/** An absolute path ('/' or a drive letter first), without NUL characters, of a sensible length. */
const absolutePath = (v: unknown): v is string =>
    typeof v === 'string' && v.length <= 4096 && /^(\/|[A-Za-z]:[\\/])/.test(v) && !v.includes('\0');

/** Absolute paths, each once, at most `max`. */
function pathList(v: unknown, max: number): string[] {
    const out: string[] = [];
    for (const item of Array.isArray(v) ? v : []) {
        if (absolutePath(item) && !out.includes(item)) {
            out.push(item);
        }
        if (out.length >= max) {
            break;
        }
    }
    return out;
}

function fileSettings(v: unknown): FileSettings {
    const r = obj(v);
    return {
        lastFolder: absolutePath(r.lastFolder) ? r.lastFolder : '',
        recentFolders: pathList(r.recentFolders, MAX_RECENT_FOLDERS),
        favourites: pathList(r.favourites, MAX_FAVOURITE_FOLDERS),
    };
}

/** A complete, valid set of settings from anything: missing or broken values take their defaults. */
export function normaliseSettings(raw: unknown, base: StudioSettings = DEFAULT_SETTINGS): StudioSettings {
    const r = obj(raw);
    const general = obj(r.general);
    const units = obj(r.units);
    const display = obj(r.display);
    const perspective = obj(display.perspective);
    const ai = obj(r.ai);
    const d = base;
    return {
        general: {
            confirmDelete: bool(general.confirmDelete, d.general.confirmDelete),
            moveComponentsByDragging: bool(general.moveComponentsByDragging, d.general.moveComponentsByDragging ?? true),
        },
        sketch: plainData(r.sketch),
        defaults: toolDefaults(r.defaults),
        units: {
            lengthDecimals: int(units.lengthDecimals, d.units.lengthDecimals, 0, 8),
            angleDecimals: int(units.angleDecimals, d.units.angleDecimals, 0, 8),
            angleUnit: pick(units.angleUnit, ['deg', 'dm', 'dms', 'rad'] as const, d.units.angleUnit),
            formDecimals: units.formDecimals === null ? null : typeof units.formDecimals === 'number'
                ? int(units.formDecimals, 6, 0, 8) : d.units.formDecimals,
        },
        display: {
            meshQuality: pick(display.meshQuality, MESH_QUALITIES, d.display.meshQuality),
            antialias: bool(display.antialias, d.display.antialias),
            pixelRatio: num(display.pixelRatio, d.display.pixelRatio, 0.5, 4),
            groundShadow: bool(display.groundShadow, d.display.groundShadow),
            groundShadowOpacity: num(display.groundShadowOpacity, d.display.groundShadowOpacity, 0, 1),
            bloom: bool(display.bloom, d.display.bloom),
            bloomIntensity: num(display.bloomIntensity, d.display.bloomIntensity, 0, 5),
            edges: bool(display.edges, d.display.edges),
            edgeColor: colour(display.edgeColor, d.display.edgeColor),
            edgeOpacity: num(display.edgeOpacity, d.display.edgeOpacity, 0, 1),
            style: pick(display.style, DISPLAY_STYLE_IDS, d.display.style),
            seeThrough: bool(display.seeThrough, d.display.seeThrough),
            hiddenEdges: pick(display.hiddenEdges, ['dashed', 'solid'] as const, d.display.hiddenEdges),
            grid: bool(display.grid, d.display.grid),
            background: colour(display.background, d.display.background),
            transition: pick(display.transition, ['off', 'fast', 'normal', 'slow'] as const, d.display.transition),
            perspective: {
                model: bool(perspective.model, d.display.perspective.model),
                sketch: bool(perspective.sketch, d.display.perspective.sketch),
            },
            sketchQuality: pick(display.sketchQuality, ['fast', 'full'] as const, d.display.sketchQuality),
        },
        lighting: r.lighting === undefined ? clone(d.lighting) : lighting(r.lighting),
        ai: {
            auth: pick(ai.auth, ['local', 'apiKey'] as const, d.ai.auth),
            fast: modelChoice(ai.fast, d.ai.fast),
            best: modelChoice(ai.best, d.ai.best),
        },
        toolbars: plainData(r.toolbars),
        files: r.files === undefined ? clone(d.files) : fileSettings(r.files),
    };
}

/** The settings with one category put back to its defaults. */
export function resetCategory(settings: StudioSettings, category: SettingsCategory, base: StudioSettings = DEFAULT_SETTINGS): StudioSettings {
    return { ...settings, [category]: clone(base[category]) };
}

/** A settings patch: whole categories, each replacing the one it names. */
export type SettingsPatch = Partial<StudioSettings>;

/** Merges a patch (whole categories) into settings and normalises the result. */
export function applyPatch(settings: StudioSettings, patch: unknown, base: StudioSettings = DEFAULT_SETTINGS): StudioSettings {
    const p = obj(patch);
    const merged: Raw = { ...settings };
    // A category's fields that the patch leaves out keep their values (a nested group such as perspective too): only
    // what is sent changes. Lists are replaced whole.
    const plain = (v: unknown): v is Raw => !!v && typeof v === 'object' && !Array.isArray(v);
    const merge = (was: unknown, change: unknown): unknown => {
        if (!plain(was) || !plain(change)) {
            return change;
        }
        const out: Raw = { ...was };
        for (const [key, value] of Object.entries(change)) {
            out[key] = merge(was[key], value);
        }
        return out;
    };
    for (const category of SETTINGS_CATEGORIES) {
        if (p[category] !== undefined) {
            merged[category] = merge((settings as unknown as Raw)[category], p[category]);
        }
    }
    return normaliseSettings(merged, base);
}

/** A kept key as the web shows it: dots and the last four characters. */
export function maskKey(key: string): string {
    return key ? `${'•'.repeat(8)}${key.slice(-4)}` : '';
}
