// Sketch text in the sketcher: the fonts the server finds, the glyphs a text needs, and the text item built into the
// sketch as fixed lines and Bezier style splines (rebuilt from its stored text and options whenever it changes).

import type { SketchGeometry, SketchText } from '@jarvis/core';
import { charactersByStyle, layoutText, polylinePath, type FontGlyphs, type FontStyle, type TextPath } from '@jarvis/core/text';
import { ellipseAt, segmentPoints } from '@jarvis/core/curves';
import { curveOf, pointOf } from './solver';
import { curveSegment, ellipseOfCurve, isExtra } from './sketchCurves';
import { addOutlines, removeOwned, releaseOwned } from './sketchItems';

type Pt = [number, number];

export interface FontInfo {
    family: string;
    styles: FontStyle[];
}

let fontList: Promise<FontInfo[]> | null = null;

/** The fonts on the server's machine (asked once). */
export function loadFonts(): Promise<FontInfo[]> {
    fontList ??= fetch('/api/fonts').then(async (r) => {
        const body = await r.json().catch(() => ({}));
        return Array.isArray(body.fonts) ? body.fonts as FontInfo[] : [];
    }).catch(() => {
        fontList = null;
        return [];
    });
    return fontList;
}

const glyphCache = new Map<string, Promise<FontGlyphs | null>>();

async function fetchGlyphs(family: string, style: FontStyle, text: string): Promise<FontGlyphs | null> {
    const key = `${family}\u0000${style}\u0000${text}`;
    let entry = glyphCache.get(key);
    if (!entry) {
        entry = fetch('/api/fonts/glyphs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ family, style, text }) })
            .then(async (r) => (r.ok ? ((await r.json()).glyphs as FontGlyphs) : null))
            .catch(() => null);
        glyphCache.set(key, entry);
        if (glyphCache.size > 200) {
            glyphCache.delete(glyphCache.keys().next().value!);
        }
    }
    return entry;
}

/** The glyphs of every style a text uses (kerning needs the text as written, so each style is asked with it all). */
export async function textFonts(t: Pick<SketchText, 'text' | 'font' | 'bold' | 'italic'>): Promise<Partial<Record<FontStyle, FontGlyphs>> | string> {
    const fonts = await loadFonts();
    const info = fonts.find((f) => f.family === t.font) ?? null;
    if (!info) {
        return fonts.length ? `The font ${t.font} is not on this machine.` : 'The server lists no fonts.';
    }
    const wanted = charactersByStyle(t.text, t);
    const plain = t.text.replace(/<\/?(b|i|r-?\d*(\.\d+)?)>/gi, '');
    const styles = new Set<FontStyle>(['regular', ...(Object.keys(wanted) as FontStyle[])]);
    const out: Partial<Record<FontStyle, FontGlyphs>> = {};
    await Promise.all([...styles].map(async (style) => {
        // A style the family lacks falls back to regular in the layout.
        if (info.styles.includes(style)) {
            const glyphs = await fetchGlyphs(t.font, style, plain || ' ');
            if (glyphs) {
                out[style] = glyphs;
            }
        }
    }));
    return out.regular ? out : `The font ${t.font} could not be read.`;
}

// ---- Text along curves ---------------------------------------------------------------------------------------

const STEPS = 2048;

/** A curve as a fine polyline: open curves from start to end, circles and ellipses clockwise from their bottom. */
function curvePolyline(g: SketchGeometry, id: string): Pt[] | null {
    const c = curveOf(g, id);
    const P = (pid: string): Pt | null => {
        const p = pointOf(g, pid);
        return p ? [p.u, p.v] : null;
    };
    if (!c) {
        return null;
    }
    if (c.kind === 'line') {
        const [a, b] = [P(c.a), P(c.b)];
        return a && b ? [a, b] : null;
    }
    if (c.kind === 'circle') {
        const o = P(c.center);
        return o ? Array.from({ length: STEPS + 1 }, (_, i) => {
            const t = -Math.PI / 2 - (2 * Math.PI * i) / STEPS;
            return [o[0] + c.radius * Math.cos(t), o[1] + c.radius * Math.sin(t)] as Pt;
        }) : null;
    }
    if (c.kind === 'arc') {
        const [o, s, e] = [P(c.center), P(c.start), P(c.end)];
        if (!o || !s || !e) {
            return null;
        }
        const r = Math.hypot(s[0] - o[0], s[1] - o[1]);
        const a0 = Math.atan2(s[1] - o[1], s[0] - o[0]);
        const sweep = ((Math.atan2(e[1] - o[1], e[0] - o[0]) - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
        return Array.from({ length: STEPS + 1 }, (_, i) => [o[0] + r * Math.cos(a0 + (sweep * i) / STEPS), o[1] + r * Math.sin(a0 + (sweep * i) / STEPS)] as Pt);
    }
    if (c.kind === 'ellipse') {
        const e = ellipseOfCurve(g, c);
        // Clockwise from the bottom of its first axis frame.
        return e ? Array.from({ length: STEPS + 1 }, (_, i) => ellipseAt(e, -Math.PI / 2 - (2 * Math.PI * i) / STEPS)) : null;
    }
    if (isExtra(c)) {
        const s = curveSegment(g, c);
        return s ? [s.from, ...segmentPoints(s.from, s.seg, STEPS)] : null;
    }
    return null;
}

const near = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;

/**
 * The curves as one path, end to end in the order they connect (each turned round where needed). An open path runs
 * the way that reads left to right (upward when it is about vertical), so text sits upright on its upper side.
 */
export function textPath(g: SketchGeometry, ids: string[]): TextPath | string {
    const pieces = ids.map((id) => curvePolyline(g, id));
    if (!pieces.length || pieces.some((p) => !p)) {
        return 'A curve to run the text along is missing.';
    }
    const rest = pieces as Pt[][];
    let chain = rest.shift()!;
    while (rest.length) {
        const k = rest.findIndex((p) => near(p[0], chain[chain.length - 1]) || near(p[p.length - 1], chain[chain.length - 1])
            || near(p[0], chain[0]) || near(p[p.length - 1], chain[0]));
        if (k < 0) {
            return 'The curves for the text must join end to end.';
        }
        const [p] = rest.splice(k, 1);
        const end = chain[chain.length - 1];
        if (near(p[0], end)) {
            chain = [...chain, ...p.slice(1)];
        } else if (near(p[p.length - 1], end)) {
            chain = [...chain, ...[...p].reverse().slice(1)];
        } else if (near(p[p.length - 1], chain[0])) {
            chain = [...p, ...chain.slice(1)];
        } else {
            chain = [...[...p].reverse(), ...chain.slice(1)];
        }
    }
    const closed = near(chain[0], chain[chain.length - 1]);
    if (!closed) {
        const [a, b] = [chain[0], chain[chain.length - 1]];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        if (dx < -1e-9 * Math.hypot(dx, dy) || (Math.abs(dx) <= 1e-9 * Math.hypot(dx, dy) && dy < 0)) {
            chain = [...chain].reverse();
        }
    }
    return polylinePath(chain) ?? 'The curve for the text has no length.';
}

// ---- The text item in the sketch -----------------------------------------------------------------------------

export const DEFAULT_TEXT: Omit<SketchText, 'id' | 'curves' | 'points'> = {
    text: 'Text', font: 'DejaVu Sans', height: 5, widthFactor: 100, spacing: 100, at: [0, 0], align: 'left',
};

/**
 * The sketch with the text item built (or rebuilt in place of its old entities). Returns the new item too, and the
 * characters the font lacks.
 */
export function buildText(g: SketchGeometry, item: SketchText, fonts: Partial<Record<FontStyle, FontGlyphs>>): { g: SketchGeometry; item: SketchText; missing: string[] } | string {
    const path = item.along?.length ? textPath(g, item.along) : null;
    if (typeof path === 'string') {
        return path;
    }
    if (!(item.height > 0)) {
        return 'The height must be above zero.';
    }
    const { outlines, missing } = layoutText(item, fonts, path);
    const old = g.texts?.find((t) => t.id === item.id) ?? null;
    const { g: added, owned } = addOutlines(removeOwned(g, old), outlines, item.construction);
    const next: SketchText = { ...item, ...owned };
    const texts = [...(g.texts ?? []).filter((t) => t.id !== item.id), next];
    return { g: { ...added, texts }, item: next, missing };
}

/** Dissolve sketch text: the glyph curves stay as plain lines and splines; the text item goes. */
export function dissolveText(g: SketchGeometry, id: string): SketchGeometry {
    const item = g.texts?.find((t) => t.id === id);
    if (!item) {
        return g;
    }
    return { ...releaseOwned(g, item), texts: g.texts!.filter((t) => t.id !== id) };
}

/** Deletes a text with its curves. */
export function deleteText(g: SketchGeometry, id: string): SketchGeometry {
    const item = g.texts?.find((t) => t.id === id);
    return item ? { ...removeOwned(g, item), texts: g.texts!.filter((t) => t.id !== id) } : g;
}

/** Wraps the selected part of a text in a style code (Bold, Italic, Rotate buttons), or the whole text without one. */
export function wrapCode(text: string, from: number, to: number, code: 'b' | 'i' | 'r30'): { text: string; from: number; to: number } {
    const [a, b] = from < to ? [from, to] : [0, text.length];
    const open = `<${code}>`;
    const close = code === 'r30' ? '</r>' : `</${code}>`;
    return { text: text.slice(0, a) + open + text.slice(a, b) + close + text.slice(b), from: a + open.length, to: b + open.length };
}
