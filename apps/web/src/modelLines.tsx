// A part's lines in the display styles (displayStyle.ts): its edges and the outline of its curved faces, drawn where
// they are seen, depth-tested against the shaded or hiding faces of every part, and in Hidden lines visible the ones
// behind the model again in grey, dashed or solid. Line widths are one pixel; dashes are measured on the screen.

import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { Color, GreaterDepth, LessEqualDepth, ShaderMaterial, type BufferGeometry } from 'three';
import type { Vec3 } from '@jarvis/core';
import type { PartLook } from './displayStyle';
import { edgesWithDistance, outlineGeometry } from './edgeLines';
import type { KernelMesh } from './meshes';

const noRaycast = () => null;

/** Shared by every line material: the drawing buffer's height in pixels, for dashes measured on the screen. */
const viewport = { value: 800 };

const VERTEX = /* glsl */ `
attribute float lineDistance;
#ifdef OUTLINE
attribute vec3 normalA;
attribute vec3 normalB;
attribute vec3 centre;
#endif
uniform float viewportHeight;
varying float vDash;
void main() {
#ifdef OUTLINE
    // Keep a mesh edge inside a curved face only where one of its triangles faces the eye and the other does not.
    vec4 mid = modelViewMatrix * vec4(centre, 1.0);
    vec3 eye = projectionMatrix[3][3] == 1.0 ? vec3(0.0, 0.0, 1.0) : -mid.xyz;
    float a = dot(normalize(normalMatrix * normalA), eye);
    float b = dot(normalize(normalMatrix * normalB), eye);
    if (a * b > 0.0) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vDash = 0.0;
        return;
    }
#endif
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * view;
    // Pixels per model unit here: the projection's vertical scale over the depth (none in a flat view).
    float scale = projectionMatrix[1][1] * viewportHeight * 0.5 / (projectionMatrix[3][3] == 1.0 ? 1.0 : max(-view.z, 1e-6));
    vDash = lineDistance * scale;
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform float opacity;
uniform float dash;
uniform float gap;
varying float vDash;
void main() {
    if (dash > 0.0 && mod(vDash, dash + gap) > dash) {
        discard;
    }
    gl_FragColor = vec4(color, opacity);
}
`;

export interface LineLook {
    color: string;
    opacity: number;
    /** Dash and gap lengths in pixels; 0: solid. */
    dash?: number;
    gap?: number;
    /** Behind the model: drawn only where the faces hide it. */
    hidden?: boolean;
    /** The outline shader (outlineGeometry) instead of plain edges. */
    outline?: boolean;
}

function lineMaterial(look: LineLook): ShaderMaterial {
    return new ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        defines: look.outline ? { OUTLINE: '' } : {},
        uniforms: {
            color: { value: new Color(look.color) },
            opacity: { value: look.opacity },
            dash: { value: look.dash ?? 0 },
            gap: { value: look.gap ?? 0 },
            viewportHeight: viewport,
        },
        transparent: true,
        depthWrite: false,
        depthFunc: look.hidden ? GreaterDepth : LessEqualDepth,
        toneMapped: false,
    });
}

function Lines({ geometry, look, renderOrder }: { geometry: BufferGeometry; look: LineLook; renderOrder: number }) {
    const material = useMemo(() => lineMaterial(look), [look.color, look.opacity, look.dash, look.gap, look.hidden, look.outline]);
    useEffect(() => () => material.dispose(), [material]);
    return <lineSegments geometry={geometry} material={material} raycast={noRaycast} renderOrder={renderOrder} frustumCulled={false} />;
}

/** Edge colours: dark over the shading, light on the background in the line styles, grey behind the model. */
export const LINE_COLORS = {
    shaded: '#000000',
    lines: '#d6dde8',
    hidden: '#7d8798',
    sketch: '#9fb4d0',
    hover: '#e4c6ff',
} as const;

/** Pixels of a dash and of the gap after it, for hidden edges drawn dashed. */
const DASH: [number, number] = [6, 4];

/**
 * A part's lines in its look. `edges`: its edge geometry (the kernel's with hidden bodies left out, or a stand-in while
 * that builds); `surface`: the faces drawn (hidden bodies left out), whose curved faces give outlines. `color` overrides
 * the style's colour (a selected part); `edgeColor` and `edgeOpacity` are the Options page's, for Shaded with edges.
 */
export function ModelLines({ edges, kernel, surface, look, sketching, color, edgeColor = LINE_COLORS.shaded, edgeOpacity = 0.35,
    hovered = false, position, rotation }: {
    edges: BufferGeometry;
    kernel: KernelMesh | null;
    surface: BufferGeometry;
    look: PartLook;
    sketching: boolean;
    color?: string;
    edgeColor?: string;
    edgeOpacity?: number;
    /** Under the pointer: in the line styles, whose faces show no glow, the lines light up instead. */
    hovered?: boolean;
    position: Vec3;
    rotation: Vec3;
}) {
    const height = useThree((s) => s.size.height * s.viewport.dpr);
    useEffect(() => {
        viewport.value = height;
    }, [height]);
    const outline = useMemo(() => (kernel && look.silhouettes ? outlineGeometry(surface) : null), [kernel, surface, look.silhouettes]);
    const dashed = useMemo(() => (kernel && look.hidden === 'dashed' ? edgesWithDistance(edges, kernel.segEdge) : null),
        [kernel, edges, look.hidden]);
    const lines = look.edges === 'lines';
    const seen: LineLook = {
        color: color ?? (sketching ? LINE_COLORS.sketch : lines ? (hovered ? LINE_COLORS.hover : LINE_COLORS.lines) : edgeColor),
        opacity: color ? 1 : sketching ? (lines ? 0.7 : 0.45) : lines ? 0.95 : edgeOpacity,
    };
    const behind: LineLook | null = look.hidden === 'none' ? null : {
        color: color ?? LINE_COLORS.hidden, opacity: color ? 0.5 : 0.85, hidden: true,
        ...(look.hidden === 'dashed' ? { dash: DASH[0], gap: DASH[1] } : {}),
    };
    return (
        <group position={position} rotation={rotation}>
            <Lines geometry={edges} look={seen} renderOrder={1} />
            {outline && <Lines geometry={outline} look={{ ...seen, outline: true }} renderOrder={1} />}
            {behind && <Lines geometry={dashed ?? edges} look={behind} renderOrder={1} />}
            {behind && outline && <Lines geometry={outline} look={{ ...behind, outline: true }} renderOrder={1} />}
        </group>
    );
}
