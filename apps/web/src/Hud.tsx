import { useMemo } from 'react';
import { shapeHalfExtents, type Vec3 } from '@jarvis/core';
import { useKernelMesh, type KernelMesh } from './meshes';
import { countLabel, edgeLength, faceArea, facePlane, formatMeasure, type PickedEntity } from './picking';
import { useStudio } from './state';

const AXES = ['x', 'y', 'z'] as const;

function Coords({ value }: { value: Vec3 }) {
    return (
        <>
            {AXES.map((axis, i) => (
                <span key={axis} className={`hud-c axis-${axis}`}>
                    <b>{axis.toUpperCase()}</b>
                    {value[i].toFixed(1)}
                </span>
            ))}
        </>
    );
}

/** "Face · planar · 1 200 mm²", "Edge · 40 mm", or for several picks "3 faces, 2 edges". */
function pickedLabel(picked: PickedEntity[], kernel: KernelMesh | null): string | null {
    if (picked.length !== 1) {
        return picked.length ? countLabel(picked) : null;
    }
    const [{ kind, index }] = picked;
    if (!kernel) {
        return kind === 'face' ? 'Face' : 'Edge';
    }
    if (kind === 'edge') {
        return `Edge · ${formatMeasure(edgeLength(kernel.edges.getAttribute('position').array, kernel.segEdge, index))} mm`;
    }
    const positions = kernel.surface.getAttribute('position').array;
    const indices = kernel.surface.getIndex()!.array;
    const { planar } = facePlane(positions, indices, kernel.triFace, index);
    return `Face · ${planar ? 'planar' : 'curved'} · ${formatMeasure(faceArea(positions, indices, kernel.triFace, index))} mm²`;
}

/** World readout beside the axis triad: cursor position in mm and the selected part's placement and size. */
export function Hud() {
    const cursor = useStudio((s) => s.cursor);
    const part = useStudio((s) => (s.selected && s.history?.parts.find((p) => p.id === s.selected)) || null);
    const kernel = useKernelMesh(part?.id ?? '');
    const picked = useStudio((s) => s.picked);
    const pickedKernel = useKernelMesh(picked[0]?.partId ?? '');
    const pickText = useMemo(() => pickedLabel(picked, pickedKernel), [picked, pickedKernel]);
    let size: Vec3 | null = null;
    if (part) {
        const geometry = kernel?.surface;
        if (geometry) {
            if (!geometry.boundingBox) {
                geometry.computeBoundingBox();
            }
            const { min, max } = geometry.boundingBox!;
            // An empty body (e.g. rolled back before its first extrude) has no finite bounds.
            size = Number.isFinite(min.x) ? [max.x - min.x, max.y - min.y, max.z - min.z] : null;
        }
        size ??= shapeHalfExtents(part.shape).map((h) => h * 2) as Vec3;
    }
    return (
        <div className="hud" aria-live="off">
            {part && size && (
                <>
                    <div className="hud-row hud-sel">
                        <span className="hud-name" title={part.name}>{part.name}</span>
                        <span className="hud-size" title={kernel ? 'Size of the CAD solid' : 'Approximate size'}>
                            {size.map((v) => Math.round(v * 10) / 10).join(' × ')} mm
                        </span>
                    </div>
                    <div className="hud-row">
                        <span className="hud-k">at</span>
                        <Coords value={part.position} />
                    </div>
                </>
            )}
            {pickText && (
                <div className="hud-row">
                    <span className="hud-k">pick</span>
                    <span className="hud-pick">{pickText}</span>
                </div>
            )}
            <div className="hud-row">
                <span className={`hud-k ${cursor?.onPart ? 'on-part' : ''}`} title="Cursor position in mm">
                    {cursor?.onPart ? 'part' : 'ground'}
                </span>
                {cursor ? <Coords value={cursor.point} /> : <span className="hud-c muted">—</span>}
            </div>
        </div>
    );
}
