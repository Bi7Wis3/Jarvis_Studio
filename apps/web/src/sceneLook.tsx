// The 3D view's look from Options > Display and Lighting: background, ambient and directional lights, the environment's
// light panels, and the numbers the view takes from the display settings (transition times, pixel ratio).

import { Environment, Lightformer } from '@react-three/drei';
import type { DirectionalLight as LightSpec, DisplaySettings, Lightformer as FormerSpec, ViewTransition } from '@jarvis/core/settings';
import { useOptions } from './options';

/** Unit vector of an azimuth (degrees from +Z towards +X) and elevation (degrees above the ground plane), Y up. */
export function lightDirection(azimuth: number, elevation: number): [number, number, number] {
    const a = (azimuth * Math.PI) / 180;
    const e = (elevation * Math.PI) / 180;
    return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
}

/** Camera easing of view changes (camera-controls smooth time, seconds) and how long a framing takes to settle (ms). */
export function transitionTimes(transition: ViewTransition): { smoothTime: number; settleMs: number; smooth: boolean } {
    switch (transition) {
        case 'off':
            return { smoothTime: SMOOTH_TIME, settleMs: 0, smooth: false };
        case 'fast':
            return { smoothTime: 0.1, settleMs: 900, smooth: true };
        case 'slow':
            return { smoothTime: 0.45, settleMs: 3200, smooth: true };
        default:
            return { smoothTime: SMOOTH_TIME, settleMs: 1800, smooth: true };
    }
}

/** The camera's usual easing (camera-controls smooth time, seconds): wheel zoom and the like keep it. */
export const SMOOTH_TIME = 0.22;

interface Eased {
    smoothTime: number;
    addEventListener(type: 'rest' | 'controlstart', listener: () => void): void;
    removeEventListener(type: 'rest' | 'controlstart', listener: () => void): void;
}

/** Eases the next move (a view change) at `smoothTime`, and goes back to the usual easing once it has come to rest. */
export function easeOnce(controls: Eased, smoothTime: number): void {
    controls.smoothTime = smoothTime;
    if (smoothTime === SMOOTH_TIME) {
        return;
    }
    const restore = () => {
        controls.smoothTime = SMOOTH_TIME;
        controls.removeEventListener('rest', restore);
        controls.removeEventListener('controlstart', restore);
    };
    controls.addEventListener('rest', restore);
    controls.addEventListener('controlstart', restore);
}

/** The canvas pixel ratio range for the 3D view: the screen's, up to the largest set. */
export function pixelRatioRange(max: number): [number, number] {
    return [Math.min(1, max), max];
}

/** Distance of a directional light from the origin, and the size of the box its shadow covers (mm). */
const LIGHT_DISTANCE = 1500;
const SHADOW_HALF = 1000;

function DirectionalLight({ light }: { light: LightSpec }) {
    const [x, y, z] = lightDirection(light.azimuth, light.elevation);
    const p: [number, number, number] = [x * LIGHT_DISTANCE, y * LIGHT_DISTANCE, z * LIGHT_DISTANCE];
    return light.shadow ? (
        <directionalLight
            position={p}
            color={light.color}
            intensity={light.intensity}
            castShadow
            shadow-mapSize={[2048, 2048]}
            shadow-bias={-0.0004}
            shadow-normalBias={0.5}
            shadow-camera-left={-SHADOW_HALF}
            shadow-camera-right={SHADOW_HALF}
            shadow-camera-top={SHADOW_HALF}
            shadow-camera-bottom={-SHADOW_HALF}
            shadow-camera-near={1}
            shadow-camera-far={LIGHT_DISTANCE * 3}
        />
    ) : (
        <directionalLight position={p} color={light.color} intensity={light.intensity} />
    );
}

function Former({ former }: { former: FormerSpec }) {
    const [x, y, z] = lightDirection(former.azimuth, former.elevation);
    const d = former.distance;
    return (
        <Lightformer
            form={former.form}
            color={former.color}
            intensity={former.intensity}
            position={[x * d, y * d, z * d]}
            scale={former.form === 'rect' ? [former.width, former.height, 1] : former.width}
            // Faces the model.
            target={[0, 0, 0]}
        />
    );
}

/** Background, lights and environment, inside the canvas. */
export function SceneLook() {
    const lighting = useOptions((s) => s.settings.lighting);
    const background = useOptions((s) => s.settings.display.background);
    const { ambient, directional, environment } = lighting;
    const formers = environment.formers.filter((f) => f.on);
    return (
        <>
            <color attach="background" args={[background]} />
            {ambient.on && <ambientLight color={ambient.color} intensity={ambient.intensity} />}
            {directional.filter((l) => l.on).map((l) => <DirectionalLight key={l.id} light={l} />)}
            {environment.on && (
                // The environment map is drawn once; a new key draws it again when its panels change.
                <Environment key={JSON.stringify([formers, environment.strength])} resolution={256} environmentIntensity={environment.strength}>
                    {formers.map((f) => <Former key={f.id} former={f} />)}
                </Environment>
            )}
        </>
    );
}

/** The display settings, for the parts of the view that follow them. */
export const useDisplay = (): DisplaySettings => useOptions((s) => s.settings.display);
