// Many sketch lines and points in a few draw calls. Fat lines of one style (width, dashes, opacity) share one
// LineSegments2 with a colour per segment; the sketch points are one Points object drawn as the DOM dots were: a
// 5 px disc (a 7 px square when locked) with a thin dark ring. Neither is ever hit by the pointer: the sketcher picks
// by distance in sketch coordinates.
//
// Materials are kept, never disposed: disposing the last material of a shader makes three.js throw the compiled
// program away and compile it again for the next line drawn with it (drei's Line does that on every change of its
// points, a recompile per pointer move for a preview or a dimension). Only geometry is replaced and disposed.

import { memo, useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import {
    BufferAttribute, BufferGeometry, Color, InstancedInterleavedBuffer, InterleavedBufferAttribute, Points, ShaderMaterial,
} from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

type V3 = [number, number, number];

/** One polyline of a batch, in the frame the batch is drawn in. */
export interface BatchLine {
    points: V3[];
    color: string;
    /** Width in screen pixels. */
    width: number;
    dashed?: boolean;
    dashSize?: number;
    gapSize?: number;
    opacity?: number;
    renderOrder?: number;
}

interface LineStyle {
    width: number;
    dashed: boolean;
    dashSize: number;
    gapSize: number;
    opacity: number;
    renderOrder: number;
}

const noRaycast = () => undefined;
const colours = new Map<string, Color>();

/** A CSS colour in the renderer's working (linear) space, as a material colour would take it. */
function linear(css: string): Color {
    let c = colours.get(css);
    if (!c) {
        c = new Color(css);
        colours.set(css, c);
    }
    return c;
}

function styleOf(l: BatchLine): LineStyle {
    return {
        width: l.width, dashed: !!l.dashed, dashSize: l.dashed ? l.dashSize ?? 2 : 0, gapSize: l.dashed ? l.gapSize ?? 1.5 : 0,
        opacity: l.opacity ?? 1, renderOrder: l.renderOrder ?? 20,
    };
}

const styleKey = (s: LineStyle) => `${s.width}|${s.dashed}|${s.dashSize}|${s.gapSize}|${s.opacity}|${s.renderOrder}`;

/** Segments, colours and (for dashes) the distance along each polyline, which starts at 0 for every one of them. */
function lineGeometry(lines: BatchLine[], dashed: boolean): LineSegmentsGeometry | null {
    let count = 0;
    for (const l of lines) {
        count += Math.max(0, l.points.length - 1);
    }
    if (count === 0) {
        return null;
    }
    const positions = new Float32Array(count * 6);
    const colors = new Float32Array(count * 6);
    const distances = dashed ? new Float32Array(count * 2) : null;
    let k = 0;
    for (const l of lines) {
        const c = linear(l.color);
        let along = 0;
        for (let i = 1; i < l.points.length; i++) {
            const a = l.points[i - 1];
            const b = l.points[i];
            positions.set(a, k * 6);
            positions.set(b, k * 6 + 3);
            colors[k * 6] = colors[k * 6 + 3] = c.r;
            colors[k * 6 + 1] = colors[k * 6 + 4] = c.g;
            colors[k * 6 + 2] = colors[k * 6 + 5] = c.b;
            if (distances) {
                distances[k * 2] = along;
                along += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
                distances[k * 2 + 1] = along;
            }
            k++;
        }
    }
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    geometry.setColors(colors);
    if (distances) {
        const buffer = new InstancedInterleavedBuffer(distances, 2, 1);
        geometry.setAttribute('instanceDistanceStart', new InterleavedBufferAttribute(buffer, 1, 0));
        geometry.setAttribute('instanceDistanceEnd', new InterleavedBufferAttribute(buffer, 1, 1));
    }
    return geometry;
}

/** Asks for a frame when the drawn geometry is replaced or removed (while sketching frames come on demand). */
function useRedraw(geometry: unknown): void {
    const invalidate = useThree((s) => s.invalidate);
    useEffect(() => {
        invalidate();
        // Also once it is gone.
        return () => invalidate();
    }, [geometry, invalidate]);
}

const LineGroup = memo(function LineGroup({ style, lines }: { style: LineStyle; lines: BatchLine[] }) {
    const width = useThree((s) => s.size.width);
    const height = useThree((s) => s.size.height);
    const material = useMemo(() => new LineMaterial({
        color: 0xffffff, vertexColors: true, linewidth: style.width, dashed: style.dashed, dashSize: style.dashSize, gapSize: style.gapSize,
        transparent: style.opacity < 1, opacity: style.opacity, depthTest: false,
    }), [styleKey(style)]);
    const object = useMemo(() => {
        const o = new LineSegments2(undefined, material);
        o.raycast = noRaycast;
        return o;
    }, [material]);
    const geometry = useMemo(() => lineGeometry(lines, style.dashed), [lines, style.dashed]);
    useEffect(() => () => geometry?.dispose(), [geometry]);
    useRedraw(geometry);
    if (!geometry) {
        return null;
    }
    return (
        <primitive object={object} renderOrder={style.renderOrder}>
            <primitive object={geometry} attach="geometry" />
            <primitive object={material} attach="material" resolution={[width, height]} />
        </primitive>
    );
});

/** Polylines drawn over everything (no depth test), one draw call per line style. */
export function LineBatch({ lines }: { lines: BatchLine[] }) {
    const groups = useMemo(() => {
        const out = new Map<string, { style: LineStyle; lines: BatchLine[] }>();
        for (const l of lines) {
            if (l.points.length < 2) {
                continue;
            }
            const style = styleOf(l);
            const key = styleKey(style);
            const group = out.get(key);
            if (group) {
                group.lines.push(l);
            } else {
                out.set(key, { style, lines: [l] });
            }
        }
        return [...out];
    }, [lines]);
    return (
        <>
            {groups.map(([key, g]) => <LineGroup key={key} style={g.style} lines={g.lines} />)}
        </>
    );
}

// ---- Points -----------------------------------------------------------------------------------------------------

/** One sketch point: where, its colour, its size in screen pixels and whether it is drawn square (locked). */
export interface BatchPoint {
    at: V3;
    color: string;
    size: number;
    square?: boolean;
}

const RING = '#04060b';

const POINT_VERTEX = /* glsl */ `
    uniform float ratio;
    attribute vec3 tint;
    attribute float size;
    attribute float square;
    varying vec3 vTint;
    varying float vSize;
    varying float vSquare;
    void main() {
        vTint = tint;
        vSize = size;
        vSquare = square;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = (size + 4.0) * ratio;
    }
`;

// The dot, then a 1 px ring of 80 % dark around it (the DOM dots' box shadow), edges smoothed over a device pixel.
const POINT_FRAGMENT = /* glsl */ `
    uniform float ratio;
    uniform vec3 ring;
    varying vec3 vTint;
    varying float vSize;
    varying float vSquare;
    void main() {
        vec2 p = (gl_PointCoord - 0.5) * (vSize + 4.0);
        float h = vSize * 0.5;
        float d;
        if (vSquare > 0.5) {
            vec2 q = abs(p) - vec2(h - 1.0);
            d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 1.0;
        } else {
            d = length(p) - h;
        }
        float aa = 1.0 / ratio;
        float fill = clamp(0.5 - d / aa, 0.0, 1.0);
        float outer = clamp(0.5 - (d - 1.0) / aa, 0.0, 1.0);
        float shade = 0.8 * max(outer - fill, 0.0);
        float alpha = fill + shade;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4((vTint * fill + ring * shade) / alpha, alpha);
        #include <colorspace_fragment>
    }
`;

/** Sketch points over everything, in one draw call. */
export function PointBatch({ points, renderOrder = 25 }: { points: BatchPoint[]; renderOrder?: number }) {
    const ratio = useThree((s) => s.viewport.dpr);
    const material = useMemo(() => new ShaderMaterial({
        uniforms: { ratio: { value: 1 }, ring: { value: linear(RING) } },
        vertexShader: POINT_VERTEX, fragmentShader: POINT_FRAGMENT, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    }), []);
    const object = useMemo(() => {
        const o = new Points(undefined, material);
        o.raycast = noRaycast;
        o.frustumCulled = false;
        return o;
    }, [material]);
    const geometry = useMemo(() => {
        const g = new BufferGeometry();
        const position = new Float32Array(points.length * 3);
        const tint = new Float32Array(points.length * 3);
        const size = new Float32Array(points.length);
        const square = new Float32Array(points.length);
        points.forEach((p, i) => {
            position.set(p.at, i * 3);
            const c = linear(p.color);
            tint[i * 3] = c.r;
            tint[i * 3 + 1] = c.g;
            tint[i * 3 + 2] = c.b;
            size[i] = p.size;
            square[i] = p.square ? 1 : 0;
        });
        g.setAttribute('position', new BufferAttribute(position, 3));
        g.setAttribute('tint', new BufferAttribute(tint, 3));
        g.setAttribute('size', new BufferAttribute(size, 1));
        g.setAttribute('square', new BufferAttribute(square, 1));
        return g;
    }, [points]);
    useEffect(() => () => geometry.dispose(), [geometry]);
    useRedraw(geometry);
    material.uniforms.ratio.value = ratio;
    return (
        <primitive object={object} renderOrder={renderOrder}>
            <primitive object={geometry} attach="geometry" />
        </primitive>
    );
}
