// What Modify Sketch draws in the view while its form is open: the black origin with its flip symbols (the ends of
// its arms and its centre), the centre of rotation, and while dragging a ghost of the sketch moved or turned.

import { memo, useMemo } from 'react';
import { useSketcher } from './sketcher';
import { Label, v3 } from './SketchDrawing';
import { LineBatch, type BatchLine } from './sketchBatch';
import { entityLine } from './sketchShapes';
import { ARM_PX, dragMap, draggedAngle, flipAt, movedEntities, useModifyDrag } from './sketchModifyDrag';
import { valueText } from './numberText';
import { dist, type Pt } from './sketchMath';
import './sketchWhole.css';

const ORIGIN_COLOUR = '#e9eef6';
const HOT = '#ffd166';
const DRAFT = '#35e0ff';

const FLIP_TEXT = { x: 'Right-click: flip along the X axis', y: 'Right-click: flip along the Y axis', both: 'Right-click: flip along both axes' } as const;

/** `unit` is about 9 px in mm, as the sketch drawing uses it. It follows the pointer only while its form is open. */
export const ModifyDragDrawing = memo(function ModifyDragDrawing({ unit }: { unit: number }) {
    const { open, centre, drag } = useModifyDrag();
    const g = useSketcher((s) => s.geometry);
    const cursor = useSketcher((s) => (open ? s.cursor : null));
    const moving = !!drag?.moved && (drag.kind === 'move' || drag.kind === 'rotate');
    const ghost = useMemo(() => (drag && moving ? movedEntities(g, dragMap(drag, centre)) : []), [g, drag, moving, centre]);
    if (!open) {
        return null;
    }
    const px = unit / 9;
    const arm = ARM_PX * px;
    const tolerance = 10 * px;
    const flip = cursor && !drag ? flipAt(cursor, arm, tolerance) : null;
    const onCentre = !!cursor && !drag && dist(cursor, centre) <= tolerance;
    const head = (tip: Pt, dir: Pt): [number, number, number][] => {
        const s = 6 * px;
        const n: Pt = [-dir[1], dir[0]];
        return [v3([tip[0] - dir[0] * s + n[0] * s * 0.5, tip[1] - dir[1] * s + n[1] * s * 0.5]), v3(tip), v3([tip[0] - dir[0] * s - n[0] * s * 0.5, tip[1] - dir[1] * s - n[1] * s * 0.5])];
    };
    const by: Pt | null = drag?.kind === 'move' && moving ? [drag.now[0] - drag.from[0], drag.now[1] - drag.from[1]] : null;
    // The black origin: its arms along the sketch axes, flip symbols at their ends and centre; the moved ghost.
    const lines: BatchLine[] = [
        { points: [v3([0, 0]), v3([arm, 0])], color: flip === 'x' ? HOT : ORIGIN_COLOUR, width: 3, renderOrder: 24 },
        { points: head([arm, 0], [1, 0]), color: flip === 'x' ? HOT : ORIGIN_COLOUR, width: 3, renderOrder: 24 },
        { points: [v3([0, 0]), v3([0, arm])], color: flip === 'y' ? HOT : ORIGIN_COLOUR, width: 3, renderOrder: 24 },
        { points: head([0, arm], [0, 1]), color: flip === 'y' ? HOT : ORIGIN_COLOUR, width: 3, renderOrder: 24 },
        ...ghost.map((e) => entityLine(e, DRAFT, 2.2, true)),
    ];
    if (drag?.kind === 'rotate' && moving) {
        lines.push({ points: [v3(centre), v3(drag.now)], color: DRAFT, width: 1, dashed: true, dashSize: px * 4, gapSize: px * 4, renderOrder: 24 });
    }
    return (
        <>
            <LineBatch lines={lines} />
            <Label at={[0, 0]} className={`pt modify-origin ${flip === 'both' ? 'hot' : ''}`}><span /></Label>
            {/* The centre of rotation: drag it with the left button. */}
            <Label at={centre} className={`pt modify-centre ${onCentre || drag?.kind === 'centre' ? 'hot' : ''}`}><span /></Label>
            {flip && cursor && <Label at={cursor} className="live modify-tip">{FLIP_TEXT[flip]}</Label>}
            {!flip && onCentre && cursor && <Label at={cursor} className="live modify-tip">Drag to move the centre of rotation</Label>}
            {drag?.kind === 'rotate' && moving && <Label at={drag.now} className="live">{`${valueText(draggedAngle(drag.angle))}°`}</Label>}
            {by && drag && <Label at={drag.now} className="live">{`X ${valueText(by[0])} · Y ${valueText(by[1])}`}</Label>}
        </>
    );
});
