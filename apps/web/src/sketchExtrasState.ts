// What the forms of sketch text, pictures, equation curves, blocks and spline fitting show in the view while they are
// open: ghost previews, the place picked for a text, the scale tool's points on a picture.

import { create } from 'zustand';

type Pt = [number, number];

export interface ExtrasState {
    /** Ghost of what OK would add (sketch coordinates, polylines). */
    preview: Pt[][];
    /** Curves of the sketch the open form works on (drawn lit). */
    lit: string[];
    /** A point the form marks (where the text starts, the insertion point). */
    marker: Pt | null;
    /** Picture scale tool: the points clicked on the picture so far, and the pointer. */
    scale: { picture: string; picks: Pt[]; cursor: Pt | null } | null;
    /** The picture whose form is open (drawn with its outline). */
    picture: string | null;
    /** Edit Block: the rest of the sketch, drawn faintly behind the block being edited. */
    backdrop: Pt[][];
}

export const useSketchExtras = create<ExtrasState>(() => ({ preview: [], lit: [], marker: null, scale: null, picture: null, backdrop: [] }));

export const clearExtras = () => useSketchExtras.setState({ preview: [], lit: [], marker: null, scale: null, picture: null });
