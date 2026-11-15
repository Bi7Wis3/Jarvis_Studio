// What sketch pictures and the forms of text, pictures, equation curves, blocks and spline fitting draw in the open
// sketch: the pictures as a backdrop on the plane, the ghost of what OK would add, the curves a form works on, the
// point it marks and the picture scale tool.

import { memo, useEffect, useMemo, useState } from 'react';
import { LineBatch } from './sketchBatch';
import { CanvasTexture, DoubleSide, SRGBColorSpace, type Texture } from 'three';
import type { SketchPicture } from '@jarvis/core';
import { geometryEntities } from './sketchGeometry';
import { useSketcher } from './sketcher';
import { useSketchExtras } from './sketchExtrasState';
import { EntityLine, Label, v3 } from './SketchDrawing';
import { PatternMarks } from './sketchPatternForms';

type Pt = [number, number];

const GHOST = '#35e0ff';
const LIT = '#ffd166';

// ---- Pictures --------------------------------------------------------------------------------------------------

const images = new Map<string, Promise<HTMLImageElement>>();

function loadImage(asset: string): Promise<HTMLImageElement> {
    let entry = images.get(asset);
    if (!entry) {
        entry = new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('picture'));
            img.src = `/api/assets/${encodeURIComponent(asset)}`;
        });
        images.set(asset, entry);
        entry.catch(() => images.delete(asset));
    }
    return entry;
}

const hex = (c: string): [number, number, number] => {
    const m = /^#?([0-9a-f]{6})$/i.exec(c);
    const n = m ? parseInt(m[1], 16) : 0xffffff;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** The picture as a texture with its transparency setting applied (pixels of the chosen colour see-through). */
function usePictureTexture(p: SketchPicture): Texture | null {
    const [texture, setTexture] = useState<Texture | null>(null);
    const mode = p.transparency ?? 'none';
    const key = `${p.asset}|${mode}|${mode === 'colour' ? `${p.colour}|${p.tolerance}|${p.amount}` : ''}`;
    useEffect(() => {
        let live = true;
        let made: Texture | null = null;
        void loadImage(p.asset).then((img) => {
            if (!live) {
                return;
            }
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(img, 0, 0);
            if (mode !== 'file') {
                const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const px = data.data;
                const [r, g, b] = hex(p.colour ?? '#ffffff');
                const reach = (p.tolerance ?? 0.1) * 441.7;
                const keep = 1 - (p.amount ?? 1);
                for (let i = 0; i < px.length; i += 4) {
                    if (mode === 'colour' && Math.hypot(px[i] - r, px[i + 1] - g, px[i + 2] - b) <= reach) {
                        px[i + 3] = Math.round(px[i + 3] * keep);
                    } else if (mode === 'none' || mode === 'full') {
                        px[i + 3] = 255;
                    }
                }
                ctx.putImageData(data, 0, 0);
            }
            made = new CanvasTexture(canvas);
            made.colorSpace = SRGBColorSpace;
            setTexture(made);
        }).catch(() => undefined);
        return () => {
            live = false;
            made?.dispose();
        };
    }, [key]);
    return texture;
}

function Picture({ p, outlined }: { p: SketchPicture; outlined: boolean }) {
    const texture = usePictureTexture(p);
    const rad = (p.angle * Math.PI) / 180;
    const opacity = p.transparency === 'full' ? 1 - (p.amount ?? 0.5) : 1;
    const corners: Pt[] = [[0, 0], [p.width, 0], [p.width, p.height], [0, p.height], [0, 0]];
    return (
        <group position={[p.at[0], p.at[1], -0.01]} rotation={[0, 0, rad]}>
            {texture && (
                <mesh position={[p.width / 2, p.height / 2, 0]} scale={[p.flipH ? -1 : 1, p.flipV ? -1 : 1, 1]} renderOrder={1}>
                    <planeGeometry args={[p.width, p.height]} />
                    <meshBasicMaterial map={texture} transparent opacity={opacity} depthWrite={false} depthTest={false} side={DoubleSide} toneMapped={false} />
                </mesh>
            )}
            {outlined && <LineBatch lines={[{ points: corners.map((c) => v3(c)), color: LIT, width: 1.4, dashed: true, dashSize: 2, gapSize: 1.5, renderOrder: 19 }]} />}
        </group>
    );
}

export function SketchPictures() {
    const pictures = useSketcher((s) => s.geometry.pictures);
    const open = useSketchExtras((s) => s.picture);
    return (
        <>
            {(pictures ?? []).filter((p) => !p.hidden || p.id === open).map((p) => <Picture key={p.id} p={p} outlined={p.id === open} />)}
        </>
    );
}

// ---- The open form's marks --------------------------------------------------------------------------------------

/** The insertion point of each block instance that is selected or pointed at (it drags the instance; relations can use it). */
function InsertionPoints() {
    const g = useSketcher((s) => s.geometry);
    const selection = useSketcher((s) => s.selection);
    const hover = useSketcher((s) => s.hover);
    const on = new Set([...selection.map((x) => x.id), ...(hover ? [hover.id] : [])]);
    return (
        <>
            {(g.inserts ?? []).filter((i) => !i.hidden && i.origin && [...i.curves, ...i.points].some((id) => on.has(id))).map((i) => {
                const p = g.points.find((q) => q.id === i.origin);
                return p && (
                    <Label key={`ins-${i.id}`} at={[p.u, p.v]} className={`pt insertion ${on.has(p.id) ? 'selected' : ''}`}>
                        <span title="Insertion point" />
                    </Label>
                );
            })}
        </>
    );
}

export const ItemsDrawing = memo(function ItemsDrawing() {
    const { preview, lit, marker, scale, backdrop } = useSketchExtras();
    const g = useSketcher((s) => s.geometry);
    const litEntities = useMemo(() => (lit.length ? geometryEntities(g).filter((e) => lit.includes(e.id)) : []), [g, lit]);
    const backdropLines = useMemo(() => backdrop.map((pts) => ({ points: pts.map((p) => v3(p)), color: '#7d8796', width: 1.2, opacity: 0.55, renderOrder: 18 })), [backdrop]);
    const previewLines = useMemo(() => preview.map((pts) => ({ points: pts.map((p) => v3(p)), color: GHOST, width: 1.8, opacity: 0.85, renderOrder: 21 })), [preview]);
    return (
        <>
            <SketchPictures />
            <InsertionPoints />
            <PatternMarks />
            <LineBatch lines={backdropLines} />
            {litEntities.map((e) => <EntityLine key={`lit-${e.id}`} entity={e} color={LIT} width={3.6} />)}
            <LineBatch lines={previewLines} />
            {marker && (
                <Label at={marker} className="snap point">
                    <span />
                </Label>
            )}
            {scale && scale.picks.map((p, i) => (
                <Label key={`scale-${i}`} at={p} className="pt picked">
                    <span />
                </Label>
            ))}
            {scale && scale.picks.length === 1 && scale.cursor && (
                <EntityLine entity={{ kind: 'line', a: scale.picks[0], b: scale.cursor }} color={LIT} dashed width={2} />
            )}
            {scale && scale.picks.length === 2 && <EntityLine entity={{ kind: 'line', a: scale.picks[0], b: scale.picks[1] }} color={LIT} width={2.4} />}
        </>
    );
});
