import { Vector3, type Camera } from 'three';
import { shapeHalfExtents, type Project, type Vec3 } from '@jarvis/core';

const ROW_GAP = 36;
const COLUMN_GAP = 120;
const ELBOW = 44;
const EDGE = 24;
const SIDE_THRESHOLD = 40;

/** Screen space on the left taken by other panels, which the label column must stay clear of. */
export const labelInsets = { left: 0 };

const point = new Vector3();
const edge = new Vector3();
const right = new Vector3();

interface Anchor {
    id: string;
    x: number;
    y: number;
    labelY: number;
    side: 'left' | 'right';
    visible: boolean;
}

function spread(rows: Anchor[], height: number): void {
    rows.sort((a, b) => a.y - b.y);
    for (let i = 0; i < rows.length; i++) {
        rows[i].labelY = i === 0 ? rows[i].y : Math.max(rows[i].y, rows[i - 1].labelY + ROW_GAP);
    }
    const limit = height - 130;
    for (let i = rows.length - 1; i >= 0; i--) {
        const max = i === rows.length - 1 ? limit : rows[i + 1].labelY - ROW_GAP;
        rows[i].labelY = Math.min(rows[i].labelY, max);
    }
}

/**
 * Positions the callout pills and leader lines for the current frame.
 * Runs inside the render loop and writes straight to the DOM, so React does not re-render per frame.
 */
export function layoutLabels(
    project: Project, offsets: Record<string, Vec3>, explode: number, camera: Camera, width: number, height: number,
): void {
    if (!project.view.labels) {
        return;
    }
    right.setFromMatrixColumn(camera.matrixWorld, 0);
    const anchors: Anchor[] = [];
    let minX = Infinity;
    let maxX = -Infinity;
    for (const part of project.parts) {
        const offset = offsets[part.id];
        point.set(
            part.position[0] + offset[0] * explode,
            part.position[1] + offset[1] * explode,
            part.position[2] + offset[2] * explode,
        );
        const half = shapeHalfExtents(part.shape);
        edge.copy(point).addScaledVector(right, Math.max(half[0], half[2]));
        point.project(camera);
        edge.project(camera);
        const x = (point.x * 0.5 + 0.5) * width;
        const y = (-point.y * 0.5 + 0.5) * height;
        const radius = Math.abs((edge.x * 0.5 + 0.5) * width - x);
        minX = Math.min(minX, x - radius);
        maxX = Math.max(maxX, x + radius);
        anchors.push({ id: part.id, x, y, labelY: y, side: part.labelSide ?? 'left', visible: point.z < 1 });
    }
    const centre = (minX + maxX) / 2;
    for (const anchor of anchors) {
        const part = project.parts.find((p) => p.id === anchor.id)!;
        if (!part.labelSide && anchor.x - centre > SIDE_THRESHOLD) {
            anchor.side = 'right';
        }
    }
    const leftX = Math.max(minX - COLUMN_GAP, 190 + labelInsets.left);
    const rightX = Math.min(maxX + COLUMN_GAP, width - 190);
    spread(anchors.filter((a) => a.side === 'left'), height);
    spread(anchors.filter((a) => a.side === 'right'), height);

    for (const a of anchors) {
        const pill = document.getElementById(`label-${a.id}`);
        const line = document.getElementById(`leader-${a.id}`);
        const dot = document.getElementById(`dot-${a.id}`);
        if (!pill || !line || !dot) {
            continue;
        }
        const shown = a.visible && a.y > -EDGE && a.y < height + EDGE;
        pill.style.opacity = line.style.opacity = dot.style.opacity = shown ? '1' : '0';
        const columnX = a.side === 'left' ? leftX : rightX;
        const sign = a.side === 'left' ? 1 : -1;
        pill.style.transform = `translate(${columnX}px, ${a.labelY}px) translate(${a.side === 'left' ? '-100%' : '0'}, -50%)`;
        line.setAttribute(
            'points',
            `${columnX + sign * 12},${a.labelY} ${columnX + sign * ELBOW},${a.labelY} ${a.x},${a.y}`,
        );
        dot.setAttribute('cx', String(a.x));
        dot.setAttribute('cy', String(a.y));
    }
}

export function Labels({ project }: { project: Project }) {
    return (
        <div className={`labels ${project.view.labels ? 'on' : ''}`}>
            <svg>
                {project.parts.map((part) => (
                    <g key={part.id}>
                        <polyline id={`leader-${part.id}`} />
                        <circle id={`dot-${part.id}`} r={4} />
                    </g>
                ))}
            </svg>
            {project.parts.map((part) => (
                <div key={part.id} id={`label-${part.id}`} className="label">
                    {part.name}
                </div>
            ))}
        </div>
    );
}
