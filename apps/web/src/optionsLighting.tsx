// Options > Lighting (SolidWorks: the Lights folder and the light PropertyManagers): the overview of the model with its
// lights and the view's camera, presets, the ambient light, directional, point and spot lights, and the environment's
// light panels. Everything edits the page's draft; nothing applies before Apply or OK.

import { useEffect, useState, type ReactNode } from 'react';
import {
    LIGHTING_PRESETS, lightCount, MAX_LIGHT_REACH, MAX_LIGHTS, placedLight, withPreset, type DirectionalLight, type LightCommon,
    type LightCoordinates, type Lightformer, type LightingSettings, type PointLight, type SpotLight,
} from '@jarvis/core/settings';
import { lightKey, lockDirectional, lockPoint, lockSpot } from './lightMath';
import { LightOverview, overviewModel } from './lightOverview';
import { niceStep, roundTo } from './numberText';
import { Check, Choice, ColourRow, Note, NumberRow, Section, withCategory, type PageProps } from './optionsPages';
import { viewCamera } from './viewLights';

const PRESETS: ['studio' | 'bright' | 'dark', string][] = [['studio', 'Studio'], ['bright', 'Bright'], ['dark', 'Dark']];

const newId = (prefix: string, taken: { id: string }[]) => {
    for (let n = 1; ; n++) {
        if (!taken.some((t) => t.id === `${prefix}${n}`)) {
            return `${prefix}${n}`;
        }
    }
};

const rowId = (key: string) => `op-light-${key.replace(':', '-')}`;

/** How far from the origin a light or a spot's target may be (the settings file keeps no more). */
const REACH = { min: -MAX_LIGHT_REACH, max: MAX_LIGHT_REACH };

const changed = <T extends { id: string }>(list: T[], id: string, change: (item: T) => T): T[] =>
    list.map((item) => (item.id === id ? change(item) : item));

/** A light in the list: a line with its name and On, and its settings under it while it is picked. */
function Row(props: {
    rowKey: string; title: string; color: string; on: boolean; turns?: boolean; picked: boolean; onPick: (key: string | null) => void;
    onOn: (on: boolean) => void; onDelete: () => void; children: ReactNode;
}) {
    const { rowKey, title, color, on, turns, picked, onPick, onOn, onDelete, children } = props;
    return (
        <div id={rowId(rowKey)} className={`op-light ${picked ? 'picked' : ''} ${on ? '' : 'off'}`}>
            <div className="op-light-head">
                <button type="button" className="op-light-pick" aria-expanded={picked} onClick={() => onPick(picked ? null : rowKey)}>
                    <span className="op-caret">{picked ? '▾' : '▸'}</span>
                    <span className="op-swatch" style={{ background: color }} />
                    <span>{title}</span>
                    {turns && <span className="op-tag">turns with the view</span>}
                </button>
                <label className="op-light-on">
                    <input type="checkbox" checked={on} onChange={(e) => onOn(e.target.checked)} />
                    <span>On</span>
                </label>
                <button type="button" className="sk-small danger" onClick={onDelete}>Delete</button>
            </div>
            {picked && <div className="op-light-body">{children}</div>}
        </div>
    );
}

/** What directional, point and spot lights all have (SolidWorks' Basic tab), then the Light position heading. */
function CommonFields({ light, change, onLock }: { light: LightCommon; change: (patch: Partial<LightCommon>) => void; onLock: (lock: boolean) => void }) {
    return (
        <>
            <Check label="Keep light when a preset is chosen" value={light.keep} onChange={(keep) => change({ keep })} />
            <ColourRow label="Colour" value={light.color} onChange={(color) => change({ color })} />
            <NumberRow label="Ambient" value={light.ambient} min={0} max={10} onChange={(ambient) => change({ ambient })} />
            <NumberRow label="Brightness" value={light.intensity} min={0} max={50} onChange={(intensity) => change({ intensity })} />
            <Check label="Cast shadows" value={light.shadow} onChange={(shadow) => change({ shadow })} />
            <div className="op-subhead">Light position</div>
            <Check label="Lock to model" value={light.lockToModel} onChange={onLock} />
            {!light.lockToModel && (
                <Note>
                    Turns with the view: the position below is as seen from the front view, and the overview shows the light where it
                    is for the view as it is now. Lock to model keeps it where it is now.
                </Note>
            )}
        </>
    );
}

/** A point or spot light's position: spherical (longitude, latitude, distance) or Cartesian (X, Y, Z). */
function PositionFields<T extends PointLight>({ light, change }: { light: T; change: (next: T) => void }) {
    const set = (patch: Partial<PointLight>) => change(placedLight({ ...light, ...patch }));
    return (
        <>
            <Choice<LightCoordinates>
                label="Given as"
                value={light.coordinates}
                options={[['spherical', 'Spherical'], ['cartesian', 'Cartesian']]}
                onChange={(coordinates) => set({ coordinates })}
            />
            {light.coordinates === 'spherical' ? (
                <>
                    <NumberRow label="Longitude" unit="deg" value={light.longitude} min={-360} max={360} onChange={(longitude) => set({ longitude })} />
                    <NumberRow label="Latitude" unit="deg" value={light.latitude} min={-90} max={90} onChange={(latitude) => set({ latitude })} />
                    <NumberRow label="Distance" unit="mm" value={light.distance} min={0} max={MAX_LIGHT_REACH} onChange={(distance) => set({ distance })} />
                </>
            ) : (
                <>
                    <NumberRow label="X" unit="mm" value={light.x} {...REACH} onChange={(x) => set({ x })} />
                    <NumberRow label="Y" unit="mm" value={light.y} {...REACH} onChange={(y) => set({ y })} />
                    <NumberRow label="Z" unit="mm" value={light.z} {...REACH} onChange={(z) => set({ z })} />
                </>
            )}
        </>
    );
}

export function LightingPage({ draft, setDraft }: PageProps) {
    const l = draft.settings.lighting;
    const [picked, setPicked] = useState<string | null>(null);
    const set = (next: LightingSettings) => setDraft(withCategory(draft, 'lighting', next));
    const patch = (p: Partial<LightingSettings>) => set({ ...l, ...p });
    const all = [...l.directional, ...l.point, ...l.spot];
    const full = lightCount(l) >= MAX_LIGHTS;
    // The view's camera as it is now: lights that turn with the view keep their place when they are locked or unlocked.
    const view = () => viewCamera.quaternion.clone();

    // A light picked in the overview comes into sight in the list.
    useEffect(() => {
        if (picked) {
            document.getElementById(rowId(picked))?.scrollIntoView({ block: 'nearest' });
        }
    }, [picked]);

    const directional = (id: string, change: (x: DirectionalLight) => DirectionalLight) => patch({ directional: changed(l.directional, id, change) });
    const point = (id: string, change: (x: PointLight) => PointLight) => patch({ point: changed(l.point, id, change) });
    const spot = (id: string, change: (x: SpotLight) => SpotLight) => patch({ spot: changed(l.spot, id, change) });
    const panel = (id: string, change: (x: Lightformer) => Lightformer) =>
        patch({ environment: { ...l.environment, formers: changed(l.environment.formers, id, change) } });

    const common = (id: string): LightCommon => ({ id, on: true, color: '#ffffff', intensity: 1, ambient: 0, lockToModel: true, keep: false, shadow: false });
    // New point and spot lights stand a little way off the model, the spot aimed at its middle.
    const reach = () => niceStep(overviewModel.radius * 3);
    const add = (kind: 'directional' | 'point' | 'spot') => {
        if (kind === 'directional') {
            const light: DirectionalLight = { ...common(newId('light', all)), azimuth: 0, elevation: 45 };
            patch({ directional: [...l.directional, light] });
            setPicked(lightKey(kind, light.id));
        } else if (kind === 'point') {
            const light = placedLight<PointLight>({
                ...common(newId('point', all)), coordinates: 'spherical', longitude: 45, latitude: 45, distance: reach(), x: 0, y: 0, z: 0,
            });
            patch({ point: [...l.point, light] });
            setPicked(lightKey(kind, light.id));
        } else {
            const [targetX, targetY, targetZ] = overviewModel.centre.map((v) => roundTo(v));
            const light = placedLight<SpotLight>({
                ...common(newId('spot', all)), coordinates: 'spherical', longitude: -45, latitude: 50, distance: reach(), x: 0, y: 0, z: 0,
                targetX, targetY, targetZ, coneAngle: 25,
            });
            patch({ spot: [...l.spot, light] });
            setPicked(lightKey(kind, light.id));
        }
    };
    const rowProps = (kind: 'directional' | 'point' | 'spot' | 'panel', id: string) => ({
        rowKey: lightKey(kind, id), picked: picked === lightKey(kind, id), onPick: setPicked,
    });
    const drop = (key: string, next: Partial<LightingSettings>) => {
        patch(next);
        if (picked === key) {
            setPicked(null);
        }
    };

    return (
        <>
            <div className="op-light-top">
                <LightOverview
                    lighting={l}
                    background={draft.settings.display.background}
                    selected={picked}
                    onSelect={setPicked}
                    onChange={set}
                />
            </div>
            <Section title="Presets">
                <div className="op-list">
                    {PRESETS.map(([name, label]) => (
                        <button key={name} type="button" className="sk-small" onClick={() => set(withPreset(l, LIGHTING_PRESETS[name]))}>{label}</button>
                    ))}
                </div>
                <Note>Studio is the view's usual lighting. A preset replaces every light below but those with Keep light when a preset is chosen on.</Note>
            </Section>
            <Section title="Ambient light">
                <Check label="On" value={l.ambient.on} onChange={(on) => patch({ ambient: { ...l.ambient, on } })} />
                <ColourRow label="Colour" value={l.ambient.color} onChange={(color) => patch({ ambient: { ...l.ambient, color } })} />
                <NumberRow label="Intensity" value={l.ambient.intensity} min={0} max={10} onChange={(intensity) => patch({ ambient: { ...l.ambient, intensity } })} />
            </Section>
            <Section title="Lights">
                {l.directional.map((light, i) => (
                    <Row
                        key={light.id}
                        {...rowProps('directional', light.id)}
                        title={`Directional ${i + 1}`}
                        color={light.color}
                        on={light.on}
                        turns={!light.lockToModel}
                        onOn={(on) => directional(light.id, (x) => ({ ...x, on }))}
                        onDelete={() => drop(lightKey('directional', light.id), { directional: l.directional.filter((x) => x.id !== light.id) })}
                    >
                        <CommonFields
                            light={light}
                            change={(p) => directional(light.id, (x) => ({ ...x, ...p }))}
                            onLock={(lock) => directional(light.id, (x) => lockDirectional(x, lock, view()))}
                        />
                        <NumberRow label="Longitude" unit="deg" value={light.azimuth} min={-360} max={360} onChange={(azimuth) => directional(light.id, (x) => ({ ...x, azimuth }))} />
                        <NumberRow label="Latitude" unit="deg" value={light.elevation} min={-90} max={90} onChange={(elevation) => directional(light.id, (x) => ({ ...x, elevation }))} />
                    </Row>
                ))}
                {l.point.map((light, i) => (
                    <Row
                        key={light.id}
                        {...rowProps('point', light.id)}
                        title={`Point ${i + 1}`}
                        color={light.color}
                        on={light.on}
                        turns={!light.lockToModel}
                        onOn={(on) => point(light.id, (x) => ({ ...x, on }))}
                        onDelete={() => drop(lightKey('point', light.id), { point: l.point.filter((x) => x.id !== light.id) })}
                    >
                        <CommonFields
                            light={light}
                            change={(p) => point(light.id, (x) => ({ ...x, ...p }))}
                            onLock={(lock) => point(light.id, (x) => lockPoint(x, lock, view()))}
                        />
                        <PositionFields light={light} change={(next) => point(light.id, () => next)} />
                    </Row>
                ))}
                {l.spot.map((light, i) => (
                    <Row
                        key={light.id}
                        {...rowProps('spot', light.id)}
                        title={`Spot ${i + 1}`}
                        color={light.color}
                        on={light.on}
                        turns={!light.lockToModel}
                        onOn={(on) => spot(light.id, (x) => ({ ...x, on }))}
                        onDelete={() => drop(lightKey('spot', light.id), { spot: l.spot.filter((x) => x.id !== light.id) })}
                    >
                        <CommonFields
                            light={light}
                            change={(p) => spot(light.id, (x) => ({ ...x, ...p }))}
                            onLock={(lock) => spot(light.id, (x) => lockSpot(x, lock, view()))}
                        />
                        <PositionFields light={light} change={(next) => spot(light.id, () => next)} />
                        <NumberRow label="Target X" unit="mm" value={light.targetX} {...REACH} onChange={(targetX) => spot(light.id, (x) => ({ ...x, targetX }))} />
                        <NumberRow label="Target Y" unit="mm" value={light.targetY} {...REACH} onChange={(targetY) => spot(light.id, (x) => ({ ...x, targetY }))} />
                        <NumberRow label="Target Z" unit="mm" value={light.targetZ} {...REACH} onChange={(targetZ) => spot(light.id, (x) => ({ ...x, targetZ }))} />
                        <NumberRow label="Cone angle" unit="deg" value={light.coneAngle} min={0} max={90} onChange={(coneAngle) => spot(light.id, (x) => ({ ...x, coneAngle }))} />
                        <Note>The cone angle is from the cone's axis to its edge.</Note>
                    </Row>
                ))}
                <div className="op-list">
                    <button type="button" className="sk-small" disabled={full} onClick={() => add('directional')}>Add directional light</button>
                    <button type="button" className="sk-small" disabled={full} onClick={() => add('point')}>Add point light</button>
                    <button type="button" className="sk-small" disabled={full} onClick={() => add('spot')}>Add spot light</button>
                </div>
                <Note>
                    Directional lights shine from far off, all one way; a point light shines every way from where it stands; a spot light
                    shines a cone at its target. Longitude turns about the vertical from the front (towards the right is positive) and
                    latitude is the height above the ground. At most {MAX_LIGHTS} lights besides the ambient one.
                </Note>
            </Section>
            <Section title="Environment">
                <Check label="Environment reflections" value={l.environment.on} onChange={(on) => patch({ environment: { ...l.environment, on } })} />
                <NumberRow
                    label="Strength"
                    value={l.environment.strength}
                    min={0}
                    max={10}
                    onChange={(strength) => patch({ environment: { ...l.environment, strength } })}
                />
                <Note>Glowing panels around the model that shiny parts reflect. They stay with the model as the view turns.</Note>
                {l.environment.formers.map((f, i) => (
                    <Row
                        key={f.id}
                        {...rowProps('panel', f.id)}
                        title={`Panel ${i + 1}`}
                        color={f.color}
                        on={f.on}
                        onOn={(on) => panel(f.id, (x) => ({ ...x, on }))}
                        onDelete={() => drop(lightKey('panel', f.id), { environment: { ...l.environment, formers: l.environment.formers.filter((x) => x.id !== f.id) } })}
                    >
                        <Choice
                            label="Shape"
                            value={f.form}
                            options={[['rect', 'Rectangle'], ['ring', 'Ring'], ['circle', 'Disc']]}
                            onChange={(form) => panel(f.id, (x) => ({ ...x, form }))}
                        />
                        <ColourRow label="Colour" value={f.color} onChange={(color) => panel(f.id, (x) => ({ ...x, color }))} />
                        <NumberRow label="Intensity" value={f.intensity} min={0} max={100} onChange={(intensity) => panel(f.id, (x) => ({ ...x, intensity }))} />
                        <NumberRow label="Longitude" unit="deg" value={f.azimuth} min={-360} max={360} onChange={(azimuth) => panel(f.id, (x) => ({ ...x, azimuth }))} />
                        <NumberRow label="Latitude" unit="deg" value={f.elevation} min={-90} max={90} onChange={(elevation) => panel(f.id, (x) => ({ ...x, elevation }))} />
                        <NumberRow label={f.form === 'rect' ? 'Width' : 'Size'} value={f.width} min={0.01} max={100} onChange={(width) => panel(f.id, (x) => ({ ...x, width }))} />
                        {f.form === 'rect' && <NumberRow label="Height" value={f.height} min={0.01} max={100} onChange={(height) => panel(f.id, (x) => ({ ...x, height }))} />}
                    </Row>
                ))}
                <button
                    type="button"
                    className="sk-small"
                    disabled={l.environment.formers.length >= MAX_LIGHTS}
                    onClick={() => {
                        const id = newId('panel', l.environment.formers);
                        patch({
                            environment: {
                                ...l.environment,
                                formers: [...l.environment.formers, {
                                    id, on: true, form: 'rect', color: '#ffffff', intensity: 2, azimuth: 0, elevation: 30, width: 8, height: 5, distance: 9,
                                }],
                            },
                        });
                        setPicked(lightKey('panel', id));
                    }}
                >
                    Add panel
                </button>
            </Section>
        </>
    );
}
