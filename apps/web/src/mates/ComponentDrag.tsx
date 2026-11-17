// Dragging a component in the assembly (SolidWorks: drag a component in the graphics area, with System Options >
// Assemblies > Move components by dragging on): it moves within the freedom its mates leave, the solver running on
// every frame, and the floating components mated to it follow. A fixed or fully defined component does not move, so a
// drag on it turns the view as before. On release the new placements are saved as one change (one undo); Esc puts
// everything back where it was. The drag itself is dragSession.ts.

import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { Raycaster, Vector2, type Object3D } from 'three';
import type { Vec3 } from '@jarvis/core';
import type { CameraControlsImpl } from '@react-three/drei';
import { movesComponentsByDragging } from '../options';
import { usePropertyManager } from '../PropertyManager';
import { runTool, useStudio } from '../state';
import { useSketcher } from '../sketcher';
import { rayFromCamera } from '../viewProjection';
import { DragSession } from './dragSession';

/** A press that moves less than this (pixels) is a click. */
const SLOP_PX = 4;

interface Drag {
    session: DragSession;
    pointerId: number;
    at: [number, number];
    moving: boolean;
    controlsWere: boolean | null;
}

/** Whether a drag may start now: allowed in Options, the assembly, plainly selecting, nothing else in hand, not exploded. */
function canDrag(): boolean {
    const s = useStudio.getState();
    return movesComponentsByDragging() && s.workspace === 'assembly' && s.mode === 'select' && !s.placingDecal && !usePropertyManager.getState().open
        && !useSketcher.getState().active && (s.history?.view.explode ?? 0) === 0;
}

function partHit(object: Object3D | null): { part: string; copy: number } | null {
    for (let o = object; o; o = o.parent) {
        if (typeof o.userData.partId === 'string') {
            return { part: o.userData.partId, copy: typeof o.userData.copy === 'number' ? o.userData.copy : 0 };
        }
    }
    return null;
}

export function ComponentDrag() {
    const gl = useThree((s) => s.gl);
    const camera = useThree((s) => s.camera);
    const scene = useThree((s) => s.scene);
    const controls = useThree((s) => s.controls) as CameraControlsImpl | null;
    const latest = useRef({ camera, scene, controls });
    latest.current = { camera, scene, controls };

    useEffect(() => {
        const canvas = gl.domElement;
        const raycaster = new Raycaster();
        let drag: Drag | null = null;
        let frame = 0;
        let pending: { x: number; y: number } | null = null;
        let swallowClick = false;

        const ndc = (x: number, y: number): Vector2 => {
            const rect = canvas.getBoundingClientRect();
            return new Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
        };
        const rayAt = (x: number, y: number) => {
            rayFromCamera(raycaster, ndc(x, y), latest.current.camera);
            return { origin: raycaster.ray.origin.toArray() as Vec3, direction: raycaster.ray.direction.toArray() as Vec3 };
        };
        const step = () => {
            frame = 0;
            if (!drag || !pending) {
                return;
            }
            drag.session.pull(rayAt(pending.x, pending.y));
            pending = null;
            const project = useStudio.getState().project;
            if (project) {
                useStudio.setState({ project: drag.session.shown(project) });
            }
        };
        const finish = (commit: boolean) => {
            if (!drag) {
                return;
            }
            cancelAnimationFrame(frame);
            frame = 0;
            const { controls: c } = latest.current;
            if (c && drag.controlsWere !== null) {
                c.enabled = drag.controlsWere;
            }
            if (canvas.hasPointerCapture?.(drag.pointerId)) {
                canvas.releasePointerCapture(drag.pointerId);
            }
            const { moving, session } = drag;
            drag = null;
            canvas.style.cursor = '';
            if (!moving) {
                return;
            }
            swallowClick = true;
            const updates = session.updates();
            const { project, history } = useStudio.getState();
            if (commit && updates) {
                // One call: one undo step puts back everything the drag moved.
                void runTool('parts_update', { updates });
            } else if (project && history) {
                useStudio.setState({ project: session.restored(project, history) });
            }
        };

        const down = (e: PointerEvent) => {
            if (e.button !== 0 || e.target !== canvas || drag || e.altKey || e.ctrlKey || e.metaKey || !canDrag()) {
                return;
            }
            rayFromCamera(raycaster, ndc(e.clientX, e.clientY), latest.current.camera);
            const hit = raycaster.intersectObjects(latest.current.scene.children, true).find((h) => partHit(h.object));
            const target = hit ? partHit(hit.object) : null;
            const history = useStudio.getState().history;
            if (!hit || !target || !history) {
                return;
            }
            const local = hit.object.worldToLocal(hit.point.clone());
            const session = DragSession.start(history, target.part, target.copy, [local.x, local.y, local.z]);
            if (!session) {
                return;
            }
            const { controls: c } = latest.current;
            drag = { session, pointerId: e.pointerId, at: [e.clientX, e.clientY], moving: false, controlsWere: c ? c.enabled : null };
            // The view must not turn while the component is dragged.
            if (c) {
                c.enabled = false;
            }
        };
        const move = (e: PointerEvent) => {
            if (!drag || e.pointerId !== drag.pointerId) {
                return;
            }
            if (!drag.moving) {
                if (Math.hypot(e.clientX - drag.at[0], e.clientY - drag.at[1]) < SLOP_PX) {
                    return;
                }
                drag.moving = true;
                canvas.style.cursor = 'move';
                try {
                    canvas.setPointerCapture(drag.pointerId);
                } catch {
                    // Not capturable: the window listeners still follow the pointer.
                }
            }
            e.stopPropagation();
            pending = { x: e.clientX, y: e.clientY };
            if (!frame) {
                frame = requestAnimationFrame(step);
            }
        };
        const up = (e: PointerEvent) => {
            if (drag && e.pointerId === drag.pointerId) {
                if (drag.moving) {
                    step();
                }
                finish(true);
            }
        };
        // A pointer the browser takes away (a touch turned into a scroll) puts everything back.
        const cancel = (e: PointerEvent) => {
            if (drag && e.pointerId === drag.pointerId) {
                finish(false);
            }
        };
        const click = (e: MouseEvent) => {
            if (swallowClick) {
                swallowClick = false;
                e.stopPropagation();
            }
        };
        const key = (e: KeyboardEvent) => {
            if (drag && e.key === 'Escape') {
                e.stopImmediatePropagation();
                e.preventDefault();
                finish(false);
            }
        };
        window.addEventListener('pointerdown', down, true);
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', cancel, true);
        window.addEventListener('click', click, true);
        window.addEventListener('keydown', key, true);
        return () => {
            finish(false);
            window.removeEventListener('pointerdown', down, true);
            window.removeEventListener('pointermove', move, true);
            window.removeEventListener('pointerup', up, true);
            window.removeEventListener('pointercancel', cancel, true);
            window.removeEventListener('click', click, true);
            window.removeEventListener('keydown', key, true);
        };
    }, [gl]);
    return null;
}
