// Helix and spiral steps of the active part drawn in the 3D view as curves, like the other reference geometry (drawn
// inside ReferenceGeometry's part frame), with their names and a small point at each end that lights under the
// pointer. A click on the curve or an end goes to the open form's selection box when it takes references (Plane:
// Perpendicular to the curve, Coincident with an end; Point: On point, Along curve), to the Sweep form as its path, to
// the sketch's Pierce point form; else it selects the step in the feature tree. Right-click offers its menu. While the
// Helix/Spiral form is open, the curve it makes is drawn as a see-through preview over the model.

import { useMemo, useState } from 'react';
import { Line } from '@react-three/drei';
import type { Feature, Part, Vec3 } from '@jarvis/core';
import { helixOfStep, helixPoints, type HelixStep } from '@jarvis/core/helix';
import type { CurvePointRef } from '@jarvis/core/curveRefs';
import { Label } from './SketchDrawing';
import { useToolSession } from './toolSession';
import { viewPick } from './treeSelection';
import { offerTarget } from './viewMenu';
import { draftHelix, type HelixValues } from './helixForm';
import { usePickSession, type PickItem } from './pickField';
import { curveItem, curvePointItem, curvePointValue, curveRefValue } from './curvePicks';
import { toggleHelixPierce } from './sketchHelixPierce';

const COLOR = '#7fb2ff';
const HOVER = '#c48bff';
const CHOSEN = '#35e0ff';
const CLICK_SLOP_PX = 4;

/** Puts a reference into the open form's active box when it takes references; true when it did. */
function pickIntoBox(partId: string, item: PickItem): boolean {
    const picks = usePickSession.getState();
    const box = picks.boxes.find((b) => b.key === picks.active);
    if (item.kind !== 'ref' || !picks.pick || picks.partId !== partId || !box?.entities.includes('ref')) {
        return false;
    }
    picks.pick(item, (i) => i.kind === 'ref' && i.ref === item.ref);
    return true;
}

function EndPoint({ part, step, features, at, where, size, chosen }: {
    part: Part; step: HelixStep; features: Feature[]; at: Vec3; where: CurvePointRef['at']; size: number; chosen: boolean;
}) {
    const [hover, setHover] = useState(false);
    const s = size / 60;
    return (
        <mesh
            position={at}
            renderOrder={20}
            onPointerOver={(e) => {
                e.stopPropagation();
                setHover(true);
            }}
            onPointerOut={() => setHover(false)}
            onClick={(e) => {
                if (e.delta > CLICK_SLOP_PX) {
                    return;
                }
                e.stopPropagation();
                if (!pickIntoBox(part.id, curvePointItem({ curveRef: step.id, at: where }, features)) && !useToolSession.getState().set) {
                    viewPick(part.instanceOf ?? part.id, step.id);
                }
            }}
        >
            <sphereGeometry args={[s * (hover ? 1.1 : 0.7), 12, 8]} />
            <meshBasicMaterial color={hover ? HOVER : chosen ? CHOSEN : COLOR} depthTest={false} transparent opacity={0.95} />
        </mesh>
    );
}

function HelixItem({ part, step, features, chosen, size }: { part: Part; step: HelixStep; features: Feature[]; chosen: Set<string>; size: number }) {
    const [hover, setHover] = useState(false);
    const points = useMemo(() => {
        try {
            return helixPoints(helixOfStep(step, features.slice(0, features.indexOf(step))));
        } catch {
            return null;
        }
    }, [step, features]);
    if (!points) {
        return null;
    }
    const on = chosen.has(step.id) || chosen.has(curveRefValue(step.id));
    const color = hover ? HOVER : on ? CHOSEN : COLOR;
    const end = (where: 'start' | 'end') => chosen.has(curvePointValue({ curveRef: step.id, at: where }));
    return (
        <group>
            <Line
                points={points}
                color={color}
                lineWidth={hover || on ? 2.6 : 1.6}
                renderOrder={13}
                onPointerOver={() => setHover(true)}
                onPointerOut={() => setHover(false)}
                onClick={(e) => {
                    if (e.delta > CLICK_SLOP_PX) {
                        return;
                    }
                    const session = useToolSession.getState();
                    if (pickIntoBox(part.id, curveItem(step.id, features))) {
                        e.stopPropagation();
                    } else if (session.set && session.toolId === 'sweep') {
                        // The Sweep form's path.
                        e.stopPropagation();
                        session.set({ path: step.id });
                    } else if (toggleHelixPierce(step.id)) {
                        e.stopPropagation();
                    } else if (!session.set) {
                        e.stopPropagation();
                        viewPick(part.instanceOf ?? part.id, step.id);
                    }
                }}
                onContextMenu={() => offerTarget({ kind: 'reference', partId: part.id, featureId: step.id })}
            />
            <EndPoint part={part} step={step} features={features} at={points[0]} where="start" size={size} chosen={end('start')} />
            <EndPoint part={part} step={step} features={features} at={points[points.length - 1]} where="end" size={size} chosen={end('end')} />
            <group position={points[points.length - 1]}>
                <Label at={[0, 0]} className="plane">{step.name ?? step.id}</Label>
            </group>
        </group>
    );
}

/** The curve the open Helix/Spiral form makes, see-through and on top of the model. */
function HelixDraft({ part, editing }: { part: Part; editing: string | null }) {
    const toolId = useToolSession((s) => s.toolId);
    const values = useToolSession((s) => s.values);
    const points = useMemo(() => {
        if (toolId !== 'helix') {
            return null;
        }
        const { shape } = draftHelix(values as HelixValues, part.features ?? [], editing);
        return shape ? helixPoints(shape) : null;
    }, [toolId, values, part.features, editing]);
    if (!points) {
        return null;
    }
    return (
        <Line points={points} color={CHOSEN} lineWidth={2.4} transparent opacity={0.7} depthTest={false} renderOrder={21}
            raycast={() => null} />
    );
}

/** The part's helix and spiral steps (part frame), and the open form's preview; `size` scales the end points. */
export function HelixCurves({ part, hidden, chosen, editing, size = 60 }: {
    part: Part; hidden: Set<string>; chosen: Set<string>; editing: string | null; size?: number;
}) {
    const features = part.features ?? [];
    return (
        <group>
            {features.map((f) => (f.op === 'helix' && !f.suppressed && f.id !== editing && !hidden.has(`${part.id}/${f.id}`)
                ? <HelixItem key={f.id} part={part} step={f} features={features} chosen={chosen} size={size} />
                : null))}
            <HelixDraft part={part} editing={editing} />
        </group>
    );
}
