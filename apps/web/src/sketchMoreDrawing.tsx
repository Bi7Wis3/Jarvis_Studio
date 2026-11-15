// What the tools of sketchMoreTools.ts draw over the sketch: the selection box (dashed when it crosses), the dynamic
// mirror line with its symmetry marks, the jog being placed and what a click would pick.

import { memo } from 'react';
import { LineBatch } from './sketchBatch';
import type { SketchGeometry } from '@jarvis/core';
import { AXIS_U, AXIS_V, curveOf, pointOf } from './solver';
import { geometryEntities } from './sketchGeometry';
import { crossing, useSketchMore } from './sketchMoreTools';
import { useSketcher } from './sketcher';
import { EntityLine, Label, v3 } from './SketchDrawing';
import type { Pt } from './sketchMath';

const BOX = '#8fc7ff';
const PICK = '#ffd166';
const DRAFT = '#35e0ff';
const MIRROR = '#c48bff';

/** The ends of a line or an axis (an axis: a long piece through the origin). */
function lineEnds(g: SketchGeometry, id: string, reach: number): [Pt, Pt] | null {
    if (id === AXIS_U || id === AXIS_V) {
        return id === AXIS_U ? [[-reach, 0], [reach, 0]] : [[0, -reach], [0, reach]];
    }
    const line = curveOf(g, id);
    const a = line?.kind === 'line' ? pointOf(g, line.a) : undefined;
    const b = line?.kind === 'line' ? pointOf(g, line.b) : undefined;
    return a && b ? [[a.u, a.v], [b.u, b.v]] : null;
}

export const MoreDrawing = memo(function MoreDrawing({ unit }: { unit: number }) {
    const { box, dynamicMirror, hover, preview } = useSketchMore();
    const g = useSketcher((s) => s.geometry);
    const tool = useSketcher((s) => s.tool);
    const hovered = hover && tool.startsWith('m:') ? geometryEntities(g).find((e) => e.id === hover) : null;
    const hoverPoint = hover && tool.startsWith('m:') && !hovered ? pointOf(g, hover) : null;
    const mirror = dynamicMirror ? lineEnds(g, dynamicMirror.line, unit * 40) : null;
    return (
        <>
            {box && (
                <LineBatch
                    lines={[{
                        points: [box.from, [box.to[0], box.from[1]], box.to, [box.from[0], box.to[1]], box.from].map((p) => v3(p as Pt)),
                        color: BOX, width: 1.2, dashed: crossing(box), dashSize: unit * 0.6, gapSize: unit * 0.5, renderOrder: 22,
                    }]}
                />
            )}
            {mirror && (
                <>
                    <EntityLine entity={{ kind: 'line', a: mirror[0], b: mirror[1] }} color={MIRROR} width={3} />
                    {mirror.map((p, i) => (
                        <Label key={i} at={p}>
                            <span className="sk-glyph" title="Dynamic mirror: what you draw is mirrored about this line">⇋</span>
                        </Label>
                    ))}
                </>
            )}
            {hovered && <EntityLine entity={hovered} color={PICK} width={3.8} />}
            {hoverPoint && (
                <Label at={[hoverPoint.u, hoverPoint.v]} className="pt picked">
                    <span />
                </Label>
            )}
            {preview.map((e, i) => <EntityLine key={`more-${i}`} entity={e} color={DRAFT} dashed width={2.4} />)}
        </>
    );
});
