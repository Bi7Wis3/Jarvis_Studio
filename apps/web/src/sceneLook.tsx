// The 3D view's look from Options > Display and Lighting: background, the lights (viewLights.tsx), and the numbers the
// view takes from the display settings (transition times, pixel ratio).

import { sphericalPoint, type DisplaySettings, type ViewTransition } from '@jarvis/core/settings';
import { useOptions } from './options';
import { ViewLights } from './viewLights';

/** Unit vector of an azimuth (degrees from +Z towards +X) and elevation (degrees above the ground plane), Y up. */
export function lightDirection(azimuth: number, elevation: number): [number, number, number] {
    return sphericalPoint(azimuth, elevation, 1);
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

/** Background, lights and environment, inside the canvas. */
export function SceneLook() {
    const lighting = useOptions((s) => s.settings.lighting);
    const background = useOptions((s) => s.settings.display.background);
    return (
        <>
            <color attach="background" args={[background]} />
            <ViewLights lighting={lighting} />
        </>
    );
}

/** The display settings, for the parts of the view that follow them. */
export const useDisplay = (): DisplaySettings => useOptions((s) => s.settings.display);
