// What the spline tools draw over the sketch: curvature combs with their bounding curve, inflection points, the
// minimum radius, spline handles (circle, arrow head and diamond on each side; active ones bright), curvature
// pointers with their ball, control polygons, and where Add Tangency / Curvature Control would go. All of it is
// batched (sketchBatch.tsx) and worked out again only when the sketch or what the spline tools show changes.

import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { SketchGeometry } from '@jarvis/core';
import { curvatureComb, inflectionPoints, minimumRadius } from '@jarvis/core/splines';
import { useSketcher } from './sketcher';
import { Label } from './SketchDrawing';
import { LineBatch, PointBatch, type BatchLine, type BatchPoint } from './sketchBatch';
import { curvePieces, handleInfo, handleValues, solvedSpline, splinePointIds, splinePolygon } from './sketchSplines';
import { combFactor, handleGrips, handleSplines, pointerTip, polygonShown, useSplineView } from './sketchSplineTools';
import { shownText } from './numberText';
import './sketchSplines.css';

type Pt = [number, number];
type V3 = [number, number, number];

const COMB = '#e86fb0';
const HANDLE = '#2bd9a8';
const IDLE_HANDLE = '#7d8a9c';
const POINTER = '#ff9f43';
const POLYGON = '#9aa7b8';
const INFLECTION = '#ffd166';
const RADIUS = '#8fc7ff';
const UNMET = '#ff5d6c';

const v3 = (p: Pt): V3 => [p[0], p[1], 0];
const line = (points: Pt[], color: string, width = 1, dashed = false, opacity = 1): BatchLine => ({
    points: points.map(v3), color, width, dashed, dashSize: 1.5, gapSize: 1, opacity, renderOrder: 22,
});
/** A small ring of radius r about c. */
const ring = (c: Pt, r: number): Pt[] => Array.from({ length: 17 }, (_, i) => [c[0] + r * Math.cos((i / 16) * 2 * Math.PI), c[1] + r * Math.sin((i / 16) * 2 * Math.PI)]);

interface Drawn {
    lines: BatchLine[];
    points: BatchPoint[];
    labels: { key: string; at: Pt; text: string }[];
}

/** Combs, inflection points and minimum radius of the curves that show them. */
function curvatureDrawn(g: SketchGeometry, unit: number, combs: string[], inflections: string[], minRadius: string[], density: number, bounding: boolean): Drawn {
    const out: Drawn = { lines: [], points: [], labels: [] };
    const factor = combFactor(g);
    for (const id of combs) {
        const pieces = curvePieces(g, id);
        if (!pieces) {
            continue;
        }
        // Density: teeth along the whole curve; more pieces, more teeth.
        const comb = curvatureComb(pieces, Math.max(density, pieces.length * 4), factor);
        comb.teeth.forEach(([a, b]) => out.lines.push(line([a as Pt, b as Pt], COMB, 1, false, 0.75)));
        if (bounding) {
            out.lines.push(line(comb.tips as Pt[], COMB, 1.4));
        }
    }
    for (const id of inflections) {
        const pieces = curvePieces(g, id);
        pieces && inflectionPoints(pieces).forEach((s) => out.points.push({ at: v3(s.at as Pt), color: INFLECTION, size: 8 }));
    }
    for (const id of minRadius) {
        const pieces = curvePieces(g, id);
        const m = pieces ? minimumRadius(pieces) : null;
        if (!m) {
            continue;
        }
        // The tightest circle, shown as an arc either side of the point, with its radius.
        const a = Math.atan2(m.at[1] - m.centre[1], m.at[0] - m.centre[0]);
        const reach = Math.min(Math.PI / 3, (unit * 12) / m.radius);
        out.lines.push(line(Array.from({ length: 33 }, (_, i): Pt => {
            const t = a - reach + (2 * reach * i) / 32;
            return [m.centre[0] + m.radius * Math.cos(t), m.centre[1] + m.radius * Math.sin(t)];
        }), RADIUS, 1.4, true));
        const far = m.radius > unit * 30;
        const from: Pt = far ? [m.at[0] + (m.centre[0] - m.at[0]) * ((unit * 6) / m.radius), m.at[1] + (m.centre[1] - m.at[1]) * ((unit * 6) / m.radius)] : m.centre as Pt;
        out.lines.push(line([from, m.at as Pt], RADIUS, 1));
        out.labels.push({ key: `r-${id}`, at: far ? from : [(m.at[0] + m.centre[0]) / 2, (m.at[1] + m.centre[1]) / 2], text: `Min R ${shownText(m.radius)}` });
    }
    return out;
}

/** Handles of the shown splines, their curvature pointers, and the control polygons. */
function handlesDrawn(g: SketchGeometry, unit: number, picked: { curve: string; index: number } | null, vertex: { curve: string; index: number } | null): Drawn {
    const out: Drawn = { lines: [], points: [], labels: [] };
    const factor = combFactor(g);
    const r = unit * 0.45;
    for (const c of handleSplines(g)) {
        const solved = solvedSpline(g, c);
        if (!solved) {
            continue;
        }
        splinePointIds(c).forEach((_, i) => {
            const h = handleInfo(g, c, i, solved);
            if (!h) {
                return;
            }
            const color = h.active ? HANDLE : IDLE_HANDLE;
            const lit = picked?.curve === c.id && picked.index === i;
            for (const end of [h.prev, h.next]) {
                if (end) {
                    out.lines.push(line([h.at, end], color, lit ? 2.2 : 1.2, !h.active));
                }
            }
            for (const grip of handleGrips(h)) {
                const end = grip.side === 'after' ? h.next! : h.prev!;
                const d: Pt = [end[0] - h.at[0], end[1] - h.at[1]];
                const l = Math.hypot(d[0], d[1]) || 1;
                const u: Pt = [d[0] / l, d[1] / l];
                const w: Pt = [-u[1], u[0]];
                const q = grip.at;
                if (grip.grip === 'end') {
                    out.lines.push(line(ring(q, r), color, 1.4));
                } else if (l >= unit * 3 && grip.grip === 'weight') {
                    // Grips too close together on a short side are left out; the circle still drags it.
                    const back: Pt = [q[0] - u[0] * r * 1.6, q[1] - u[1] * r * 1.6];
                    out.lines.push(line([[back[0] + w[0] * r, back[1] + w[1] * r], q, [back[0] - w[0] * r, back[1] - w[1] * r]], color, 1.4));
                } else if (l >= unit * 3) {
                    out.lines.push(line([[q[0] + u[0] * r, q[1] + u[1] * r], [q[0] + w[0] * r, q[1] + w[1] * r], [q[0] - u[0] * r, q[1] - u[1] * r],
                        [q[0] - w[0] * r, q[1] - w[1] * r], [q[0] + u[0] * r, q[1] + u[1] * r]], color, 1.4));
                }
            }
            if (h.curvature !== null) {
                const a = handleValues(h).angle;
                const tip = pointerTip(h.at, [-Math.sin(a), Math.cos(a)], h.curvature, factor);
                out.lines.push(line([h.at, tip], POINTER, 1.6), line(ring(tip, r * 1.2), POINTER, 2));
            }
            if (solved.unmet.includes(i)) {
                // A held curvature or the continuity that has no free spline point beside it to come from.
                out.lines.push(line(ring(h.at, unit * 0.8), UNMET, 2));
            }
        });
    }
    const s = unit * 0.35;
    for (const c of g.curves) {
        if (c.kind !== 'spline' || !polygonShown(c.id)) {
            continue;
        }
        const solved = solvedSpline(g, c);
        if (!solved) {
            continue;
        }
        const poly = splinePolygon(solved);
        out.lines.push(line(poly, POLYGON, 1, true));
        poly.forEach((q, i) => {
            const on = vertex?.curve === c.id && vertex.index === i;
            out.lines.push(line([[q[0] - s, q[1] - s], [q[0] + s, q[1] - s], [q[0] + s, q[1] + s], [q[0] - s, q[1] + s], [q[0] - s, q[1] - s]], on ? HANDLE : POLYGON, on ? 2 : 1.2));
        });
    }
    return out;
}

/** Where Add Tangency / Curvature Control would go (follows the pointer while placing). */
const AddPreview = memo(function AddPreview({ unit }: { unit: number }) {
    const { adding, addHover } = useSplineView(useShallow((s) => ({ adding: s.adding, addHover: s.addHover })));
    const g = useSketcher((s) => s.geometry);
    const lines = useMemo((): BatchLine[] => {
        if (!adding || !addHover) {
            return [];
        }
        const { at, tangent, normal, curvature } = addHover;
        if (adding.kind === 'tangency') {
            const l = unit * 4;
            return [line([[at[0] - tangent[0] * l, at[1] - tangent[1] * l], [at[0] + tangent[0] * l, at[1] + tangent[1] * l]], HANDLE, 2)];
        }
        const tip = pointerTip(at, normal, curvature, combFactor(g));
        return [line([at, tip], POINTER, 2), line(ring(tip, unit * 0.55), POINTER, 2)];
    }, [adding, addHover, unit, g]);
    return lines.length ? <LineBatch lines={lines} /> : null;
});

/** Everything the spline tools draw; mounted inside the sketch's drawing. */
export const SplineOverlays = memo(function SplineOverlays({ unit }: { unit: number }) {
    const g = useSketcher((s) => s.geometry);
    const selection = useSketcher((s) => s.selection);
    const v = useSplineView(useShallow((s) => ({
        combs: s.combs, inflections: s.inflections, minRadius: s.minRadius, density: s.density, scale: s.scale, options: s.options,
        polygonFlip: s.polygonFlip, handlesHidden: s.handlesHidden, picked: s.picked, vertex: s.vertex, dragged: s.drag?.what ?? null,
    })));
    const curvature = useMemo(() => curvatureDrawn(g, unit, v.combs, v.inflections, v.minRadius, v.density, v.options.bounding),
        [g, unit, v.combs, v.inflections, v.minRadius, v.density, v.scale, v.options.bounding]);
    const handles = useMemo(() => handlesDrawn(g, unit, v.picked, v.vertex),
        [g, unit, selection, v.picked, v.vertex, v.options, v.handlesHidden, v.polygonFlip, v.scale, v.dragged]);
    const lines = useMemo(() => [...curvature.lines, ...handles.lines], [curvature, handles]);
    return (
        <>
            <LineBatch lines={lines} />
            {curvature.points.length > 0 && <PointBatch points={curvature.points} renderOrder={26} />}
            {curvature.labels.map((l) => (
                <Label key={l.key} at={l.at} className="sp-radius">
                    <span>{l.text}</span>
                </Label>
            ))}
            <AddPreview unit={unit} />
        </>
    );
});
