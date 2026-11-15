// What Instant2D draws: the handle of the selected dimension and, while it is dragged, the ruler along which the
// value is measured (a straight ruler from the fixed end, or a protractor at the vertex of an angle).

import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSketcher } from './sketcher';
import { LineBatch, type BatchLine } from './sketchBatch';
import { Label, v3 } from './SketchDrawing';
import { rulerStep, shownHandle, useInstant2d, type Handle } from './sketchInstant2d';
import { useSketchToggles } from './sketchToggles';
import { valueText } from './numberText';
import { dist, type Pt } from './sketchMath';

const RULER = '#8fa3bf';
const HOT = '#ffd166';

type P3 = [number, number, number];

function linearMarks(h: Handle, value: number, pointer: Pt, px: number): { lines: P3[][]; labels: { at: Pt; text: string; on: boolean }[] } {
    const { minor, major } = rulerStep(px, false);
    const along = Math.max(value / h.factor, (pointer[0] - h.zero[0]) * h.dir[0] + (pointer[1] - h.zero[1]) * h.dir[1]);
    const length = Math.max(along * 1.25, 30 * px);
    const n: Pt = [-h.dir[1], h.dir[0]];
    const at = (t: number, off = 0): Pt => [h.zero[0] + h.dir[0] * t + n[0] * off, h.zero[1] + h.dir[1] * t + n[1] * off];
    const lines: P3[][] = [[v3(at(0)), v3(at(length))]];
    const labels: { at: Pt; text: string; on: boolean }[] = [];
    const count = Math.min(400, Math.floor((length * h.factor) / minor));
    for (let i = 0; i <= count; i++) {
        const v = i * minor;
        const big = Math.abs(v / major - Math.round(v / major)) < 1e-9;
        const t = v / h.factor;
        lines.push([v3(at(t)), v3(at(t, (big ? 8 : 4) * px))]);
        if (big) {
            labels.push({ at: at(t, 15 * px), text: valueText(v), on: Math.abs(v - value) < minor / 2 });
        }
    }
    return { lines, labels };
}

function angularMarks(h: Handle, value: number, px: number): { lines: P3[][]; labels: { at: Pt; text: string; on: boolean }[] } {
    const r = dist(h.at, h.zero);
    // The side of the fixed direction the handle is on.
    const side = Math.sign(h.dir[0] * (h.at[1] - h.zero[1]) - h.dir[1] * (h.at[0] - h.zero[0])) || 1;
    const base = Math.atan2(h.dir[1], h.dir[0]);
    const at = (deg: number, rr: number): Pt => {
        const a = base + side * (deg * Math.PI) / 180;
        return [h.zero[0] + rr * Math.cos(a), h.zero[1] + rr * Math.sin(a)];
    };
    const arc: P3[] = [];
    for (let d = 0; d <= 180; d += 3) {
        arc.push(v3(at(d, r)));
    }
    const lines: P3[][] = [arc, [v3(h.zero), v3(at(0, r))]];
    const labels: { at: Pt; text: string; on: boolean }[] = [];
    for (let d = 0; d <= 180; d += 1) {
        const big = d % 15 === 0;
        lines.push([v3(at(d, r)), v3(at(d, r + (big ? 8 : d % 5 === 0 ? 6 : 3) * px))]);
        if (big) {
            labels.push({ at: at(d, r + 16 * px), text: `${d}°`, on: Math.abs(d - value) < 0.5 });
        }
    }
    return { lines, labels };
}

/**
 * `unit` is about 9 px in mm, as the sketch drawing uses it. Redrawn when what decides the handle changes, and with
 * the pointer only near the handle or while it is dragged.
 */
export const Instant2dDrawing = memo(function Instant2dDrawing({ unit }: { unit: number }) {
    const on = useSketchToggles((t) => t.instant2d);
    const decides = useSketcher(useShallow((s) => ({
        active: s.active, stage: s.stage, tool: s.tool, selection: s.selection, dimDraft: s.dimDraft, geometry: s.geometry, labels: s.labels,
    })));
    const drag = useInstant2d((i) => i.drag);
    const handle = useMemo(() => drag?.handle ?? shownHandle(useSketcher.getState()), [drag, decides, on]);
    const px = unit / 9;
    // The pointer, while it is near enough to light the handle up.
    const near = useSketcher((s) => (handle && !drag && s.cursor && dist(s.cursor, handle.at) <= 10 * px ? s.cursor : null));
    const marks = useMemo(() => {
        if (!drag || !handle) {
            return null;
        }
        return handle.kind === 'angular' ? angularMarks(handle, drag.value, px) : linearMarks(handle, drag.value, drag.pointer, px);
    }, [drag, handle, px]);
    if (!handle) {
        return null;
    }
    const hot = !!drag || !!near;
    const live = drag ? decides.geometry.constraints.find((c) => c.id === handle.id) : null;
    const shownAt: Pt = drag
        ? handle.kind === 'angular'
            ? drag.pointer
            : [handle.zero[0] + handle.dir[0] * (drag.value / handle.factor), handle.zero[1] + handle.dir[1] * (drag.value / handle.factor)]
        : handle.at;
    const lines: BatchLine[] = (marks?.lines ?? []).map((points, i) => ({ points, color: RULER, width: i === 0 ? 1.4 : 1, opacity: 0.9, renderOrder: 23 }));
    if (drag) {
        lines.push({ points: [v3(shownAt), v3(drag.pointer)], color: HOT, width: 1, opacity: 0.5, renderOrder: 23 });
    }
    return (
        <>
            <LineBatch lines={lines} />
            {marks?.labels.map((l, i) => (
                <Label key={`i2d-t-${i}`} at={l.at} className={`i2d-tick ${l.on ? 'on' : ''}`}>{l.text}</Label>
            ))}
            <Label at={shownAt} className={`pt i2d-handle ${hot ? 'hot' : ''}`}><span /></Label>
            {!drag && near && <Label at={near} className="live modify-tip">Drag to change the value · on the ruler it steps</Label>}
            {drag && live && 'value' in live && (
                <Label at={drag.pointer} className="live">
                    <b>{`${valueText(live.value)}${handle.kind === 'angular' ? '°' : ''}`}</b>
                </Label>
            )}
        </>
    );
});
