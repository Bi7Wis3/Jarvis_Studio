// Derived Sketch in the sketcher (SolidWorks: Insert > Derived Sketch makes a rigid copy of a sketch that follows it,
// on another plane or face; it is positioned by dragging; entities cannot be added or deleted; right-click > Underive
// breaks the link). Here: the sketch is picked in the form, then the plane or face is clicked; the copy opens with
// Modify Sketch to drag or type it into place. The kernel builds a derived sketch from its parent (core derived.ts).

import type { Feature, Sketch, SketchGeometry } from '@jarvis/core';
import { resolvedSketch } from '@jarvis/core/derived';
import { isDimension } from './solver';
import { profilesToGeometry } from './sketchGeometry';
import { startSketch, useSketcher } from './sketcher';
import { runTool, useStudio } from './state';

interface Session {
    partId: string;
    from: string;
    /** What the parent's entities are: the derived sketch keeps exactly these. */
    key: string;
}

let session: Session | null = null;

/** The entities and their places, to tell a change of them (refused) from a move of the whole sketch (allowed). */
export function contentKey(g: SketchGeometry): string {
    const r = (x: number) => Math.round(x * 1e6) / 1e6;
    return JSON.stringify([g.points.map((p) => [p.id, r(p.u), r(p.v)]), g.curves.map((c) => JSON.stringify(c))]);
}

const featuresOf = (partId: string): Feature[] => useStudio.getState().history?.parts.find((p) => p.id === partId)?.features ?? [];

/** The parent sketch's geometry as it is now (its own derivation resolved). */
export function parentGeometry(features: Feature[], from: string): SketchGeometry | null {
    const i = features.findIndex((f) => f.id === from);
    const sketch = i >= 0 ? resolvedSketch(features, i) : null;
    return sketch ? sketch.geometry ?? profilesToGeometry(sketch.profiles) : null;
}

const DERIVED_NOTE = 'Derived sketch: it follows the sketch it comes from. Move or turn it with Modify sketch; its entities cannot be added, deleted or changed here.';

function begin(partId: string, from: string, g: SketchGeometry): void {
    session = { partId, from, key: contentKey(g) };
    useSketcher.setState({
        geometry: g, undo: [], redo: [], selection: [], notice: DERIVED_NOTE, tool: 'select',
        labels: Object.fromEntries(g.constraints.flatMap((c) => (isDimension(c) && c.at ? [[c.id, c.at]] : []))),
    });
    if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        setTimeout(() => window.dispatchEvent(new CustomEvent('jarvis:open-tool', { detail: 'sk-modify-sketch' })), 0);
    }
}

/** Insert Derived Sketch: the plane or face is picked next; the copy of `from` opens there. */
export function startDerivedSketch(partId: string, from: string): string | null {
    const g = parentGeometry(featuresOf(partId), from);
    if (!g) {
        return 'Pick a sketch step of this part to derive from.';
    }
    startSketch(partId, 'sketch');
    useSketcher.setState({ message: 'Click the plane or flat face for the derived sketch.' });
    const stop = useSketcher.subscribe((s) => {
        if (!s.active) {
            stop();
        } else if (s.stage === 'draw') {
            stop();
            begin(partId, from, g);
        }
    });
    return null;
}

/** What the sketch being saved carries besides its geometry: its derivation, and the 2D to 3D view it is. */
export function sketchOutputExtras(): Partial<Sketch> {
    if (session) {
        return { derived: { from: session.from } };
    }
    const s = useSketcher.getState();
    const step = s.edit?.featureId ? featuresOf(s.edit.partId).find((f) => f.id === s.edit!.featureId) : undefined;
    return step?.op === 'sketch' && step.sketch.view ? { view: step.sketch.view } : {};
}

/** Underive: the sketch keeps its parent's entities as they are now as its own, and no longer follows it. */
export async function underive(partId: string, featureId: string): Promise<{ text: string; isError: boolean }> {
    const features = featuresOf(partId);
    const i = features.findIndex((f) => f.id === featureId);
    const f = features[i];
    if (f?.op !== 'sketch' || !f.sketch.derived) {
        return { text: 'That sketch is not derived.', isError: true };
    }
    const { derived: _d, ...now } = resolvedSketch(features, i) ?? f.sketch;
    return runTool('features_update', { partId, updates: [{ id: featureId, sketch: now }] });
}

let watching = false;

/** Keeps a derived sketch to its parent's entities while it is open (once). */
export function watchDerived(): void {
    if (watching) {
        return;
    }
    watching = true;
    useSketcher.subscribe((s, prev) => {
        if (!s.active) {
            session = null;
            return;
        }
        // An existing derived sketch opened for editing: it shows its parent as it is now.
        const opened = s.edit?.featureId && (!prev.active || prev.edit?.featureId !== s.edit.featureId) ? s.edit : null;
        if (opened?.featureId) {
            const features = featuresOf(opened.partId);
            const step = features.find((f) => f.id === opened.featureId);
            const from = step?.op === 'sketch' ? step.sketch.derived?.from : undefined;
            const g = from ? parentGeometry(features, from) : null;
            session = null;
            if (from && g) {
                begin(opened.partId, from, g);
            }
            return;
        }
        if (session && s.geometry !== prev.geometry && contentKey(s.geometry) !== session.key) {
            useSketcher.setState({ geometry: prev.geometry, undo: prev.undo, redo: prev.redo, message: DERIVED_NOTE });
        }
    });
}

/** For tests: the open derived session, if any. */
export const derivedSession = (): Session | null => session;
