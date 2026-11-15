// Sketch text layout: glyph outlines of a font (lines and quadratic or cubic Bezier curves, in font units) placed as
// the SolidWorks Sketch Text places them, straight from a point or along a path. Every glyph is moved rigidly
// (mirrors included), so its lines and Bezier curves stay exact. Shared by the sketcher and the kernel tests.

import type { SketchProfile, SketchSegment, SketchText } from './index';

export type P2 = [number, number];

export type FontStyle = 'regular' | 'bold' | 'italic' | 'boldItalic';
export const FONT_STYLES: readonly FontStyle[] = ['regular', 'bold', 'italic', 'boldItalic'];

/** One piece of a glyph contour, in font units (y up). */
export type GlyphSegment = { kind: 'line'; to: P2 } | { kind: 'quad'; c: P2; to: P2 } | { kind: 'cubic'; c1: P2; c2: P2; to: P2 };

export interface GlyphContour {
    start: P2;
    segments: GlyphSegment[];
}

export interface GlyphData {
    advance: number;
    contours: GlyphContour[];
}

/** The glyphs of one font file that a text needs, as the server reads them. */
export interface FontGlyphs {
    family: string;
    style: FontStyle;
    unitsPerEm: number;
    /** Height of the capital letters (font units). */
    capHeight: number;
    /** Baseline to baseline (font units). */
    lineHeight: number;
    glyphs: Record<string, GlyphData>;
    /** Kerning of adjacent characters, keyed by the two characters. */
    kerning: Record<string, number>;
}

/** A piece of an outline in sketch coordinates: a line, or a Bezier curve with its inner control points. */
export type OutlineSegment = { kind: 'line'; to: P2 } | { kind: 'bezier'; controls: P2[]; to: P2 };

/** One closed outline of a glyph, in sketch coordinates (mm). */
export interface Outline {
    start: P2;
    segments: OutlineSegment[];
}

/** A path to run text along, by arc length: the point there and the unit tangent. */
export interface TextPath {
    length: number;
    at: (s: number) => { p: P2; tangent: P2 };
}

export interface TextChar {
    ch: string;
    style: FontStyle;
    /** Degrees counter-clockwise about the character's centre. */
    rotate: number;
    line: number;
}

const styleOf = (bold: boolean, italic: boolean): FontStyle => (bold ? (italic ? 'boldItalic' : 'bold') : italic ? 'italic' : 'regular');

/**
 * The characters of a text with the style codes worked out: <b>...</b>, <i>...</i> and <r30>...</r> (SolidWorks puts
 * <r30> round characters it rotates). Codes nest; anything else in angle brackets is text. Line breaks start a line.
 */
export function parseText(text: string, base: { bold?: boolean; italic?: boolean } = {}): TextChar[] {
    const out: TextChar[] = [];
    let bold = 0;
    let italic = 0;
    const rotations: number[] = [];
    let line = 0;
    for (let i = 0; i < text.length; i++) {
        const rest = text.slice(i);
        const code = /^<(\/?)(b|i|r(-?\d+(?:\.\d+)?)?)>/i.exec(rest);
        if (code) {
            const closing = code[1] === '/';
            const name = code[2][0].toLowerCase();
            if (name === 'b') {
                bold = Math.max(0, bold + (closing ? -1 : 1));
            } else if (name === 'i') {
                italic = Math.max(0, italic + (closing ? -1 : 1));
            } else if (closing) {
                rotations.pop();
            } else if (code[3] !== undefined) {
                rotations.push(Number(code[3]));
            } else {
                // <r> without an angle is text.
                out.push(...[...code[0]].map((ch) => ({ ch, style: styleOf(!!base.bold || bold > 0, !!base.italic || italic > 0), rotate: 0, line })));
            }
            i += code[0].length - 1;
            continue;
        }
        const ch = text[i];
        if (ch === '\r') {
            continue;
        }
        if (ch === '\n') {
            line += 1;
            continue;
        }
        // A surrogate pair is one character.
        const cp = text.codePointAt(i)!;
        const full = String.fromCodePoint(cp);
        i += full.length - 1;
        out.push({ ch: full, style: styleOf(!!base.bold || bold > 0, !!base.italic || italic > 0), rotate: rotations.reduce((a, b) => a + b, 0), line });
    }
    return out;
}

/** The characters a text needs from each font style (for asking the server). */
export function charactersByStyle(text: string, base: { bold?: boolean; italic?: boolean } = {}): Partial<Record<FontStyle, string>> {
    const out: Partial<Record<FontStyle, Set<string>>> = {};
    for (const c of parseText(text, base)) {
        (out[c.style] ??= new Set()).add(c.ch);
    }
    return Object.fromEntries(Object.entries(out).map(([k, set]) => [k, [...set!].join('')]));
}

type Placed = { glyph: GlyphData; font: FontGlyphs; x: number; advance: number; rotate: number; line: number; scale: number; wide: number };

export type TextOptions = Pick<SketchText, 'text' | 'height' | 'widthFactor' | 'spacing' | 'at' | 'align' | 'flipV' | 'flipH' | 'bold' | 'italic'>;

/**
 * The outlines of a text, in sketch coordinates. `fonts` holds the styles the text uses (a style the family lacks
 * falls back to regular). Without `path` the text starts at `at` on a horizontal baseline (further lines below);
 * with one it runs along it, each character turned to the path where its centre falls.
 */
export function layoutText(o: TextOptions, fonts: Partial<Record<FontStyle, FontGlyphs>>, path?: TextPath | null): { outlines: Outline[]; width: number; missing: string[] } {
    const regular = fonts.regular ?? Object.values(fonts)[0];
    if (!regular) {
        return { outlines: [], width: 0, missing: [] };
    }
    const chars = parseText(path ? o.text.replace(/\r?\n/g, ' ') : o.text, o);
    const wide = (o.widthFactor ?? 100) / 100;
    const spacing = (o.spacing ?? 100) / 100;
    const missing = new Set<string>();
    const placed: Placed[] = [];
    const lineWidths: number[] = [];
    let x = 0;
    let line = 0;
    let previous: { ch: string; font: FontGlyphs } | null = null;
    for (const c of chars) {
        if (c.line !== line) {
            lineWidths[line] = x;
            line = c.line;
            x = 0;
            previous = null;
        }
        const font = fonts[c.style] ?? regular;
        const scale = o.height / (font.capHeight || font.unitsPerEm * 0.7);
        const glyph = font.glyphs[c.ch];
        if (!glyph) {
            missing.add(c.ch);
            previous = null;
            continue;
        }
        const kern = previous && previous.font === font ? font.kerning[previous.ch + c.ch] ?? 0 : 0;
        x += kern * scale * wide * (path && o.align === 'full' ? 1 : spacing);
        const advance = glyph.advance * scale * wide;
        placed.push({ glyph, font, x, advance, rotate: c.rotate, line: c.line, scale, wide });
        x += path && o.align === 'full' ? advance : advance * spacing;
        previous = { ch: c.ch, font };
    }
    lineWidths[line] = x;
    const width = Math.max(0, ...lineWidths.filter((w) => w !== undefined));
    const lineStep = (regular.lineHeight || regular.unitsPerEm * 1.2) * (o.height / (regular.capHeight || regular.unitsPerEm * 0.7));

    // Along a path, the text's start: alignment, or for full justify the extra gap between characters.
    let offset = 0;
    let gap = 0;
    if (path) {
        const free = path.length - width;
        if (o.align === 'center') {
            offset = free / 2;
        } else if (o.align === 'right') {
            offset = free;
        } else if (o.align === 'full' && placed.length > 1) {
            gap = free / (placed.length - 1);
        }
    }

    const outlines: Outline[] = [];
    placed.forEach((g, index) => {
        const xStart = g.x + gap * index;
        // The character's own frame: its box is advance wide, cap height tall, from (xStart, baseline).
        const cx = xStart + g.advance / 2;
        const cy = o.height / 2;
        const rot = (g.rotate * Math.PI) / 180;
        const [cr, sr] = [Math.cos(rot), Math.sin(rot)];
        const baseline = -g.line * lineStep;
        // Text space: X along the text, Y up from its baseline; then the mirrors, then onto the plane.
        const local = ([u, v]: P2): P2 => {
            const px = u * g.scale * g.wide;
            const py = v * g.scale;
            const dx = xStart + px - cx;
            const dy = py - cy;
            return [cx + dx * cr - dy * sr, cy + dx * sr + dy * cr + baseline];
        };
        const mirror = ([X, Y]: P2): P2 => [o.flipH ? width - X : X, path && o.flipV ? -Y : Y];
        let place: (q: P2) => P2;
        if (path) {
            // Each character sits rigidly on the path where its (mirrored) centre falls.
            const centre = o.flipH ? width - cx : cx;
            const s = offset + centre;
            const { p, tangent: t } = path.at(Math.min(Math.max(s, 0), path.length));
            // Past an end, carry on straight along the end tangent.
            const beyond = s < 0 ? s : s > path.length ? s - path.length : 0;
            const base: P2 = [p[0] + t[0] * beyond, p[1] + t[1] * beyond];
            const n: P2 = [-t[1], t[0]];
            place = ([X, Y]) => {
                const dx = X - centre;
                return [base[0] + dx * t[0] + Y * n[0], base[1] + dx * t[1] + Y * n[1]];
            };
        } else {
            place = ([X, Y]) => [o.at[0] + X, o.at[1] + Y];
        }
        const map = (q: P2): P2 => place(mirror(local(q)));
        for (const contour of g.glyph.contours) {
            const out = contourOutline(contour, map);
            if (out) {
                outlines.push(out);
            }
        }
    });
    return { outlines, width, missing: [...missing] };
}

const same = (a: P2, b: P2, size: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= size * 1e-9;

/** A glyph contour moved onto the plane: closed, without zero-length pieces; null when nothing is left of it. */
function contourOutline(contour: GlyphContour, map: (q: P2) => P2): Outline | null {
    const start = map(contour.start);
    const segments: OutlineSegment[] = [];
    let at = start;
    let size = 0;
    for (const s of contour.segments) {
        const to = map(s.to);
        size = Math.max(size, Math.abs(to[0] - start[0]), Math.abs(to[1] - start[1]));
        if (s.kind === 'line') {
            if (!same(at, to, 1)) {
                segments.push({ kind: 'line', to });
            }
        } else {
            const controls = s.kind === 'quad' ? [map(s.c)] : [map(s.c1), map(s.c2)];
            // A curve whose control points all sit on its ends is a point.
            if (same(at, to, 1) && controls.every((c) => same(c, to, 1))) {
                continue;
            }
            segments.push({ kind: 'bezier', controls, to });
        }
        at = to;
    }
    const scale = Math.max(size, 1e-9);
    if (segments.length && !same(at, start, scale)) {
        segments.push({ kind: 'line', to: start });
    } else if (segments.length) {
        // Close exactly on the start.
        segments[segments.length - 1].to = start;
    }
    // A closed outline needs two pieces at least (or one closed curve).
    if (!segments.length || (segments.length === 1 && segments[0].kind === 'line')) {
        return null;
    }
    return { start, segments };
}

/** Outlines as closed sketch profiles: lines, and Bezier curves as style spline segments (exact). */
export function outlineProfiles(outlines: Outline[]): SketchProfile[] {
    return outlines.map((o) => ({
        kind: 'path',
        start: o.start,
        segments: o.segments.map((s): SketchSegment => (s.kind === 'line'
            ? { kind: 'line', to: s.to }
            : { kind: 'bspline', to: s.to, poles: s.controls, degree: s.controls.length + 1 })),
    }));
}

/** A polyline as a text path (arc length and tangent along it). */
export function polylinePath(points: P2[]): TextPath | null {
    const pts = points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-12);
    if (pts.length < 2) {
        return null;
    }
    const lengths = [0];
    for (let i = 1; i < pts.length; i++) {
        lengths.push(lengths[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    const length = lengths[lengths.length - 1];
    return {
        length,
        at: (s) => {
            let lo = 0;
            let hi = pts.length - 1;
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (lengths[mid] <= s) {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            const seg = Math.max(lengths[hi] - lengths[lo], 1e-12);
            const f = Math.min(1, Math.max(0, (s - lengths[lo]) / seg));
            const [a, b] = [pts[lo], pts[hi]];
            const tangent: P2 = [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg];
            return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], tangent };
        },
    };
}
