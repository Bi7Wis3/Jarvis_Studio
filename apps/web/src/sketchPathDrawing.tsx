// What the Belt/Chain and Align Grid/Origin forms show over the sketch while they are open: the belt the form would
// build, and the new origin with its X axis, as see-through ghosts.

import { create } from 'zustand';
import { EntityLine, Label } from './SketchDrawing';
import type { NewEntity, Pt } from './sketchMath';

interface PathPreview {
    entities: NewEntity[];
    /** Align Grid/Origin: where the origin goes and its X axis's direction. */
    origin: { at: Pt; x: Pt } | null;
}

export const usePathPreview = create<PathPreview>(() => ({ entities: [], origin: null }));

export function setPathPreview(patch: Partial<PathPreview>): void {
    usePathPreview.setState(patch);
}

const GHOST = '#35e0ff';

export function PathDrawing() {
    const { entities, origin } = usePathPreview();
    return (
        <>
            {entities.map((e, i) => <EntityLine key={`path-${i}`} entity={e} color={GHOST} dashed width={2.4} />)}
            {origin && (
                <>
                    <EntityLine entity={{ kind: 'line', a: origin.at, b: [origin.at[0] + origin.x[0] * 12, origin.at[1] + origin.x[1] * 12] }} color="#ff6b6b" width={2.4} />
                    <EntityLine entity={{ kind: 'line', a: origin.at, b: [origin.at[0] - origin.x[1] * 12, origin.at[1] + origin.x[0] * 12] }} color="#5ad17a" width={2.4} />
                    <Label at={origin.at} className="pt origin picked">
                        <span />
                    </Label>
                </>
            )}
        </>
    );
}
