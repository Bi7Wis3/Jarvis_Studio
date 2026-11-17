// Helix and spiral steps of the active part drawn in the 3D view as curves, like the other reference geometry (drawn
// inside ReferenceGeometry's part frame), with their names. A click picks one: as the open Sweep form's path, else the
// step in the feature tree; right-click offers its menu. While the Helix/Spiral form is open, the curve it makes is
// drawn as a see-through preview over the model.

import { useMemo, useState } from 'react';
import { Line } from '@react-three/drei';
import type { Feature, Part } from '@jarvis/core';
import { helixOfStep, helixPoints, type HelixStep } from '@jarvis/core/helix';
import { Label } from './SketchDrawing';
import { useToolSession } from './toolSession';
import { viewPick } from './treeSelection';
import { offerTarget } from './viewMenu';
import { draftHelix, type HelixValues } from './helixForm';

const COLOR = '#7fb2ff';
const HOVER = '#c48bff';
const CHOSEN = '#35e0ff';
const CLICK_SLOP_PX = 4;

function HelixItem({ part, step, features, chosen }: { part: Part; step: HelixStep; features: Feature[]; chosen: boolean }) {
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
    const color = hover ? HOVER : chosen ? CHOSEN : COLOR;
    return (
        <group>
            <Line
                points={points}
                color={color}
                lineWidth={hover || chosen ? 2.6 : 1.6}
                renderOrder={13}
                onPointerOver={() => setHover(true)}
                onPointerOut={() => setHover(false)}
                onClick={(e) => {
                    if (e.delta > CLICK_SLOP_PX) {
                        return;
                    }
                    const session = useToolSession.getState();
                    if (session.set && session.toolId === 'sweep') {
                        // The Sweep form's path.
                        e.stopPropagation();
                        session.set({ path: step.id });
                    } else if (!session.set) {
                        e.stopPropagation();
                        viewPick(part.instanceOf ?? part.id, step.id);
                    }
                }}
                onContextMenu={() => offerTarget({ kind: 'reference', partId: part.id, featureId: step.id })}
            />
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

/** The part's helix and spiral steps (part frame), and the open form's preview. */
export function HelixCurves({ part, hidden, chosen, editing }: { part: Part; hidden: Set<string>; chosen: Set<string>; editing: string | null }) {
    const features = part.features ?? [];
    return (
        <group>
            {features.map((f) => (f.op === 'helix' && !f.suppressed && f.id !== editing && !hidden.has(`${part.id}/${f.id}`)
                ? <HelixItem key={f.id} part={part} step={f} features={features} chosen={chosen.has(f.id)} />
                : null))}
            <HelixDraft part={part} editing={editing} />
        </group>
    );
}
