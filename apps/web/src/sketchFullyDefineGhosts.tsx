// The relations and dimensions Fully Define Sketch's Calculate found, drawn as see-through ghosts over the sketch until
// OK adds them (sketchFullyDefinePreview.ts). The drawing helpers come from SketchDrawing.tsx, which mounts this.

import { useMemo } from 'react';
import { Html } from '@react-three/drei';
import type { SketchConstraint, SketchGeometry } from '@jarvis/core';
import { isDimension } from './solver';
import { dimensionAnchor, useSketcher } from './sketcher';
import { LineBatch, type BatchLine } from './sketchBatch';
import { useFullyDefinePreview } from './sketchFullyDefinePreview';
import type { Pt } from './sketchMath';
import './sketchFullyDefine.css';

type V3 = [number, number, number];
type Dimension = Extract<SketchConstraint, { value: number }>;

const GHOST = '#35e0ff';

export interface GhostHelpers {
    /** A size that reads about 9 px on screen. */
    unit: number;
    lines: (g: SketchGeometry, c: SketchConstraint, at: Pt, size: number) => V3[][];
    text: (c: Dimension) => string;
    spots: (g: SketchGeometry, c: SketchConstraint, offset: number) => Pt[];
    glyphs: Partial<Record<SketchConstraint['kind'], string>>;
}

export function FullyDefineGhosts({ unit, lines, text, spots, glyphs }: GhostHelpers) {
    const preview = useFullyDefinePreview((s) => s.preview);
    const g = useSketcher((s) => s.geometry);
    const shown = useMemo(() => {
        if (!preview || preview.base !== g) {
            return null;
        }
        const r = preview.result;
        const leaders: BatchLine[] = [];
        const labels: { key: string; at: Pt; text: string; dimension: boolean }[] = [];
        for (const c of preview.added) {
            if (isDimension(c)) {
                const at = c.at ?? dimensionAnchor(r, c);
                for (const points of lines(r, c, at, unit)) {
                    leaders.push({ points, color: GHOST, width: 1, dashed: true, dashSize: unit * 0.5, gapSize: unit * 0.4, opacity: 0.6, renderOrder: 21 });
                }
                labels.push({ key: c.id, at, text: text(c as Dimension), dimension: true });
            } else {
                spots(r, c, unit * 0.9).forEach((at, i) => labels.push({ key: `${c.id}-${i}`, at, text: glyphs[c.kind] ?? '•', dimension: false }));
            }
        }
        return { leaders, labels };
    }, [preview, g, unit]);
    if (!shown) {
        return null;
    }
    return (
        <>
            <LineBatch lines={shown.leaders} />
            {shown.labels.map((l) => (
                <Html key={l.key} position={[l.at[0], l.at[1], 0]} center zIndexRange={[30, 0]} className="sk-label">
                    <span className={`${l.dimension ? 'sk-dim' : 'sk-glyph'} sk-fd-ghost`} title="Fully define: OK adds this">{l.text}</span>
                </Html>
            ))}
        </>
    );
}
