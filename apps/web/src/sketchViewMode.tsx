// While a sketch is being drawn the view is drawn plainly, for a quick response: no bloom, no shadow map, the ground's
// contact shadow kept as it was, one pixel per screen pixel, and a frame only when something changed (frameloop
// "demand"). Leaving the sketch brings the full look back.

import { useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { anim } from './anim';
import { useSketcher } from './sketcher';
import { useStudio } from './state';
import { useOptions } from './options';

/** True while a sketch is open on its plane (not while its plane is being picked). */
export const useSketchView = (): boolean => useSketcher((s) => s.active && s.stage === 'draw');

/** True while the view is drawn plainly: a sketch is open and Options > Display > Sketch view quality is Fast. */
export const usePlainSketchView = (): boolean => {
    const sketching = useSketchView();
    const fast = useOptions((s) => s.settings.display.sketchQuality === 'fast');
    return sketching && fast;
};

/** The canvas settings that change with it; `pixelRatio` is the largest the full view draws at (Options > Display). */
export function sketchCanvas(plain: boolean, pixelRatio = 2): { frameloop: 'always' | 'demand'; dpr: number | [number, number] } {
    return plain ? { frameloop: 'demand', dpr: 1 } : { frameloop: 'always', dpr: [Math.min(1, pixelRatio), pixelRatio] };
}

/**
 * Inside the canvas: draws the frame while the effect composer is off (the axis triad only draws itself over a frame),
 * freezes the shadow map, and in the on-demand frame loop asks for frames while anything moves that does not ask by
 * itself: the camera eased by camera-controls, the explode and turntable animations, a changed projection, and the
 * pointer (the cursor readout follows it every frame).
 */
export function SketchViewMode({ plain, explode, spin }: { plain: boolean; explode: number; spin: boolean }) {
    const gl = useThree((s) => s.gl);
    const invalidate = useThree((s) => s.invalidate);
    const get = useThree((s) => s.get);
    const controls = useThree((s) => s.controls) as unknown as { _needsUpdate?: boolean } | null;
    const connected = useThree((s) => s.events.connected) as HTMLElement | undefined;
    const perspective = useStudio((s) => s.perspective);

    useFrame(({ gl: renderer, scene, camera }) => {
        if (!plain) {
            return;
        }
        // The composer keeps autoClear off while it is mounted.
        const clear = renderer.autoClear;
        renderer.autoClear = true;
        renderer.render(scene, camera);
        renderer.autoClear = clear;
    }, plain ? 1 : 0);

    useEffect(() => {
        // In a sketch the parts cast no shadow: the map is drawn once without them and then left alone.
        gl.shadowMap.autoUpdate = !plain;
        gl.shadowMap.needsUpdate = true;
        invalidate();
    }, [plain, gl, invalidate]);

    useEffect(() => {
        if (!plain) {
            return;
        }
        let frame = 0;
        const watch = () => {
            const state = get();
            if (state.internal.frames === 0) {
                // No frame due: keep the clock current, so the first frame after a pause steps an eased camera move
                // by one frame's time rather than the whole pause (which would make it jump to its end).
                state.clock.getDelta();
            }
            // camera-controls applies programmatic moves (setLookAt, transitions) only in its update on a frame.
            const moving = !controls || controls._needsUpdate !== false;
            if (moving || spin || Math.abs(anim.explode - explode) > 1e-4) {
                invalidate();
            }
            frame = requestAnimationFrame(watch);
        };
        frame = requestAnimationFrame(watch);
        const element = connected ?? gl.domElement;
        const pointer = () => invalidate();
        element.addEventListener('pointermove', pointer);
        return () => {
            cancelAnimationFrame(frame);
            element.removeEventListener('pointermove', pointer);
        };
    }, [plain, controls, connected, gl, invalidate, get, explode, spin]);

    useEffect(() => {
        invalidate();
    }, [perspective, invalidate]);
    return null;
}
