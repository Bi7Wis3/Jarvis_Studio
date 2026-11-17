import { describe, expect, it } from 'vitest';
import {
    applyPatch, DEFAULT_SETTINGS, defaultSettings, LIGHTING_PRESETS, lightCount, lightPoint, maskKey, MAX_LIGHTS, MAX_RECENT_FOLDERS,
    normaliseSettings, placedLight, plainData, resetCategory, sphericalOf, sphericalPoint, validModel, withPreset,
} from './settings';

describe('normaliseSettings', () => {
    it('fills everything missing with the defaults', () => {
        expect(normaliseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
        expect(normaliseSettings({ display: { bloom: false } }).display).toEqual({ ...DEFAULT_SETTINGS.display, bloom: false });
    });

    it('clamps numbers, refuses bad colours, choices and model ids', () => {
        const s = normaliseSettings({
            units: { lengthDecimals: 12, angleDecimals: -3, angleUnit: 'grad', formDecimals: 2.6 },
            display: { meshQuality: 'ultra', edgeColor: '#ABCDEF', edgeOpacity: 4, transition: 'warp' },
            ai: { auth: 'cloud', fast: { model: 'rm -rf /', effort: 'huge' }, best: { model: ' claude-opus-5-5 ', effort: 'max' } },
        });
        expect(s.units).toEqual({ lengthDecimals: 8, angleDecimals: 0, angleUnit: 'deg', formDecimals: 3 });
        expect(s.display).toMatchObject({ meshQuality: 'normal', edgeColor: '#abcdef', edgeOpacity: 1, transition: 'normal' });
        expect(s.ai).toEqual({ auth: 'local', fast: DEFAULT_SETTINGS.ai.fast, best: { model: 'claude-opus-5-5', effort: 'max' } });
    });

    it('keeps up to the light limit with unique ids', () => {
        const many = Array.from({ length: 12 }, () => ({ id: 'same', intensity: 1 }));
        const s = normaliseSettings({ lighting: { directional: many } });
        expect(s.lighting.directional).toHaveLength(MAX_LIGHTS);
        expect(new Set(s.lighting.directional.map((l) => l.id)).size).toBe(MAX_LIGHTS);
        // An empty list stays empty (all lights deleted).
        expect(normaliseSettings({ lighting: { directional: [] } }).lighting.directional).toEqual([]);
    });

    it('keeps only plain text and check-box defaults with sensible keys', () => {
        const s = normaliseSettings({ defaults: { fillet: { r: '3', tangent: false, bad: { x: 1 }, n: 4 }, 'no way!': { r: '1' }, empty: {} } });
        expect(s.defaults).toEqual({ fillet: { r: '3', tangent: false } });
    });

    it("keeps the file browser's folders as absolute paths, each once, the recent ones up to their limit", () => {
        const recent = Array.from({ length: 15 }, (_, i) => `/home/me/f${i}`);
        const s = normaliseSettings({ files: { lastFolder: 'relative', recentFolders: ['/home/me/a', '/home/me/a', 'b', 7, ...recent], favourites: ['/x', '/x\0y'] } });
        expect(s.files.lastFolder).toBe('');
        expect(s.files.recentFolders).toHaveLength(MAX_RECENT_FOLDERS);
        expect(s.files.recentFolders.slice(0, 2)).toEqual(['/home/me/a', '/home/me/f0']);
        expect(s.files.favourites).toEqual(['/x']);
        expect(normaliseSettings({}).files).toEqual({ lastFolder: '', recentFolders: [], favourites: [] });
    });

    it('keeps the presets as valid settings', () => {
        for (const preset of Object.values(LIGHTING_PRESETS)) {
            expect(normaliseSettings({ lighting: preset }).lighting).toEqual(preset);
        }
    });
});

describe('lights', () => {
    // The lighting as a settings file kept it before point and spot lights, lock to model, ambient and keep.
    const OLD_FILE = {
        ambient: { on: true, color: '#ffeedd', intensity: 0.3 },
        directional: [
            { id: 'key', on: true, color: '#ffffff', intensity: 2.2, azimuth: 36.87, elevation: 50.19, shadow: true },
            { id: 'fill', on: false, color: '#6aa8ff', intensity: 0.8, azimuth: -126.87, elevation: 21.8, shadow: false },
        ],
        environment: { on: true, strength: 1, formers: [{ id: 'top', on: true, form: 'rect', color: '#ffffff', intensity: 5, azimuth: 0, elevation: 75.96, width: 12, height: 6, distance: 8.25 }] },
    };

    it('loads an old settings file unchanged: its lights stay fixed to the model, with no extra ambient', () => {
        const s = normaliseSettings({ lighting: OLD_FILE }).lighting;
        expect(s.ambient).toEqual(OLD_FILE.ambient);
        expect(s.environment).toEqual(OLD_FILE.environment);
        expect(s.directional).toEqual(OLD_FILE.directional.map((l) => ({ ...l, ambient: 0, lockToModel: true, keep: false })));
        expect(s.point).toEqual([]);
        expect(s.spot).toEqual([]);
        // Saved again and read back, nothing moves.
        expect(normaliseSettings({ lighting: s }).lighting).toEqual(s);
    });

    it('keeps a point light as typed and works out the other way of giving its position', () => {
        const [spherical] = normaliseSettings({ lighting: { point: [{ longitude: 30, latitude: 45, distance: 200 }] } }).lighting.point;
        expect(spherical).toMatchObject({ id: 'point1', coordinates: 'spherical', longitude: 30, latitude: 45, distance: 200, lockToModel: true });
        const [x, y, z] = sphericalPoint(30, 45, 200);
        expect([spherical.x, spherical.y, spherical.z]).toEqual([x, y, z].map((v) => Math.round(v * 1e6) / 1e6));
        expect(lightPoint(spherical)).toEqual([x, y, z]);
        const [cartesian] = normaliseSettings({ lighting: { point: [{ coordinates: 'cartesian', x: 0.1234567, y: 100, z: -100, longitude: 99 }] } }).lighting.point;
        expect(cartesian).toMatchObject({ x: 0.1234567, y: 100, z: -100, longitude: 179.929265, latitude: 44.999978, distance: 141.42141 });
        expect(lightPoint(cartesian)).toEqual([0.1234567, 100, -100]);
    });

    it('gives a spot light its target and cone, within range', () => {
        const [spot] = normaliseSettings({ lighting: { spot: [{ targetX: 5, targetY: 'x', coneAngle: 120, coordinates: 'polar', distance: -4 }] } }).lighting.spot;
        expect(spot).toMatchObject({ id: 'spot1', targetX: 5, targetY: 0, targetZ: 0, coneAngle: 90, coordinates: 'spherical', distance: 0 });
        expect(placedLight({ ...spot, coordinates: 'cartesian', x: 3, y: 4, z: 0 })).toMatchObject({ distance: 5, longitude: 90, latitude: 53.130102 });
    });

    it('counts directional, point and spot lights against one limit, with ids unique across them', () => {
        const many = (n: number, id: string) => Array.from({ length: n }, () => ({ id }));
        const s = normaliseSettings({ lighting: { directional: many(3, 'a'), point: many(4, 'a'), spot: many(4, 'a') } }).lighting;
        expect([s.directional.length, s.point.length, s.spot.length]).toEqual([3, 4, 1]);
        expect(lightCount(s)).toBe(MAX_LIGHTS);
        const ids = [...s.directional, ...s.point, ...s.spot].map((l) => l.id);
        expect(new Set(ids).size).toBe(MAX_LIGHTS);
        expect(normaliseSettings({ lighting: { directional: many(9, 'd'), spot: many(2, 's') } }).lighting.spot).toEqual([]);
    });

    it('works out spherical positions both ways', () => {
        for (const [lon, lat, d] of [[0, 0, 10], [90, 0, 3], [-135, 30, 250.5], [12.345678, -60, 0.001]]) {
            const back = sphericalOf(...sphericalPoint(lon, lat, d));
            expect(back.longitude).toBeCloseTo(lon, 9);
            expect(back.latitude).toBeCloseTo(lat, 9);
            expect(back.distance).toBeCloseTo(d, 9);
        }
        expect(sphericalOf(0, 5, 0)).toEqual({ longitude: 0, latitude: 90, distance: 5 });
        expect(sphericalOf(0, 0, 0)).toEqual({ longitude: 0, latitude: 0, distance: 0 });
    });

    it('keeps the lights marked to be kept when a preset replaces the rest', () => {
        const own = normaliseSettings({
            lighting: {
                directional: [{ id: 'key', keep: true, azimuth: 10 }, { id: 'other' }],
                point: [{ id: 'lamp', keep: true }, { id: 'gone' }],
            },
        }).lighting;
        const next = withPreset(own, LIGHTING_PRESETS.dark);
        expect(next.ambient).toEqual(LIGHTING_PRESETS.dark.ambient);
        expect(next.directional.map((l) => l.id)).toEqual(['key', 'rim', 'key-2']);
        expect(next.directional[2]).toMatchObject({ azimuth: 10, keep: true });
        expect(next.point.map((l) => l.id)).toEqual(['lamp']);
        expect(withPreset(LIGHTING_PRESETS.studio, LIGHTING_PRESETS.bright)).toEqual(LIGHTING_PRESETS.bright);
    });
});

describe('patches and resets', () => {
    it('changes the fields sent and ignores unknown categories', () => {
        const s = applyPatch(defaultSettings(), { units: { lengthDecimals: 2 }, nonsense: 1 });
        expect(s.units).toEqual({ ...DEFAULT_SETTINGS.units, lengthDecimals: 2 });
        expect('nonsense' in s).toBe(false);
    });

    it('keeps the fields a patch leaves out, nested ones too, and replaces lists whole', () => {
        // Seen live: switching only See-through off reset the owner's background, edges, style and the rest to defaults.
        const own = applyPatch(defaultSettings(), {
            display: { ...DEFAULT_SETTINGS.display, background: '#12192b', edges: false, style: 'shaded', seeThrough: true,
                perspective: { model: false, sketch: true } },
        });
        const s = applyPatch(own, { display: { seeThrough: false, perspective: { sketch: false } } });
        expect(s.display).toEqual({ ...own.display, seeThrough: false, perspective: { model: false, sketch: false } });
        const directional = own.lighting.directional.slice(0, 1);
        expect(applyPatch(own, { lighting: { directional } }).lighting.directional).toEqual(directional);
    });

    it('resets one category', () => {
        const s = applyPatch(defaultSettings(), { units: { lengthDecimals: 2 }, display: { bloom: false } });
        const r = resetCategory(s, 'units');
        expect(r.units).toEqual(DEFAULT_SETTINGS.units);
        expect(r.display.bloom).toBe(false);
    });
});

describe('helpers', () => {
    it('masks a key to its last four characters', () => {
        expect(maskKey('sk-ant-abcdefWXYZ')).toBe('••••••••WXYZ');
        expect(maskKey('')).toBe('');
    });

    it('accepts aliases and model ids only', () => {
        expect(validModel('sonnet')).toBe(true);
        expect(validModel('claude-opus-5-5')).toBe(true);
        expect(validModel('opus[1m]')).toBe(true);
        expect(validModel('a b')).toBe(false);
        expect(validModel('')).toBe(false);
    });

    it('drops what is not plain data or too big', () => {
        expect(plainData({ a: 1, b: [true, 'x', Infinity], f: () => 1 } as unknown)).toEqual({ a: 1, b: [true, 'x', null], f: null });
        expect(plainData({ big: 'x'.repeat(70_000) })).toEqual({});
        expect(plainData([1, 2])).toEqual({});
    });
});
