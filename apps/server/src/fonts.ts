// Fonts for sketch text: open-licence font files installed on this machine, read with opentype.js. Only the families
// below are offered (DejaVu: Bitstream Vera licence; Liberation: SIL Open Font License), and only when their files
// are found. Glyph outlines are served as the font has them: lines and quadratic or cubic Bezier curves.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as opentypeModule from 'opentype.js';
import type { FontGlyphs, FontStyle, GlyphContour, GlyphData, GlyphSegment } from '@jarvis/core/text';

type OpenTypeFont = ReturnType<typeof opentypeModule.parse>;
// The package is UMD: under Node its functions sit on the default export.
const opentype = ((opentypeModule as unknown as { default?: typeof opentypeModule }).default ?? opentypeModule) as typeof opentypeModule;

const FONT_DIRS = (process.env.JARVIS_FONT_DIRS ?? '/usr/share/fonts/truetype/dejavu:/usr/share/fonts/truetype/liberation:/usr/share/fonts/TTF:/usr/share/fonts/dejavu:/usr/share/fonts/liberation')
    .split(':').filter(Boolean);

/** Family, style and file name of each font offered. */
const KNOWN: { family: string; style: FontStyle; file: string }[] = [
    ...(['DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono'] as const).flatMap((family) => {
        const base = family.replace(/ /g, '');
        const slant = family === 'DejaVu Serif' ? 'Italic' : 'Oblique';
        return [
            { family, style: 'regular' as const, file: `${base}.ttf` },
            { family, style: 'bold' as const, file: `${base}-Bold.ttf` },
            { family, style: 'italic' as const, file: `${base}-${slant}.ttf` },
            { family, style: 'boldItalic' as const, file: `${base}-Bold${slant}.ttf` },
        ];
    }),
    ...(['Liberation Sans', 'Liberation Serif', 'Liberation Mono'] as const).flatMap((family) => {
        const base = family.replace(/ /g, '');
        return [
            { family, style: 'regular' as const, file: `${base}-Regular.ttf` },
            { family, style: 'bold' as const, file: `${base}-Bold.ttf` },
            { family, style: 'italic' as const, file: `${base}-Italic.ttf` },
            { family, style: 'boldItalic' as const, file: `${base}-BoldItalic.ttf` },
        ];
    }),
];

function findFile(file: string): string | null {
    for (const dir of FONT_DIRS) {
        const path = join(dir, file);
        if (existsSync(path)) {
            return path;
        }
    }
    return null;
}

/** The families found on this machine, each with the styles it has (regular always among them). */
export function listFonts(): { family: string; styles: FontStyle[] }[] {
    const out = new Map<string, FontStyle[]>();
    for (const k of KNOWN) {
        if (findFile(k.file)) {
            out.set(k.family, [...(out.get(k.family) ?? []), k.style]);
        }
    }
    return [...out].filter(([, styles]) => styles.includes('regular')).map(([family, styles]) => ({ family, styles }));
}

/** opentype.js's GPOS reader (not in its type definitions). */
interface GposPosition {
    getKerningTables?: (script: string) => unknown[] | undefined;
    getKerningValue: (tables: unknown[], left: number, right: number) => number;
}

const parsed = new Map<string, OpenTypeFont>();

function fontOf(family: string, style: FontStyle): OpenTypeFont | null {
    const known = KNOWN.find((k) => k.family === family && k.style === style);
    const path = known && findFile(known.file);
    if (!path) {
        return null;
    }
    let font = parsed.get(path);
    if (!font) {
        const data = readFileSync(path);
        font = opentype.parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        parsed.set(path, font);
    }
    return font;
}

/** A glyph's contours from its path commands (font units, y up). */
function glyphContours(commands: { type: string; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }[]): GlyphContour[] {
    const out: GlyphContour[] = [];
    let current: GlyphContour | null = null;
    for (const c of commands) {
        const to = (): [number, number] => [c.x!, c.y!];
        if (c.type === 'M') {
            current = { start: to(), segments: [] };
            out.push(current);
        } else if (!current) {
            continue;
        } else if (c.type === 'L') {
            current.segments.push({ kind: 'line', to: to() });
        } else if (c.type === 'Q') {
            current.segments.push({ kind: 'quad', c: [c.x1!, c.y1!], to: to() } satisfies GlyphSegment);
        } else if (c.type === 'C') {
            current.segments.push({ kind: 'cubic', c1: [c.x1!, c.y1!], c2: [c.x2!, c.y2!], to: to() });
        } else if (c.type === 'Z') {
            current = null;
        }
    }
    return out.filter((k) => k.segments.length > 0);
}

/**
 * The glyphs of `text` in one font, with the kerning of its adjacent characters, or null when the family or style
 * is not on this machine. Characters the font lacks are left out (the caller reports them).
 */
export function fontGlyphs(family: string, style: FontStyle, text: string): FontGlyphs | null {
    const font = fontOf(family, style);
    if (!font) {
        return null;
    }
    const chars = [...new Set([...text])];
    const glyphs: Record<string, GlyphData> = {};
    for (const ch of chars) {
        const glyph = font.charToGlyph(ch);
        if (!glyph || glyph.index === 0) {
            continue;
        }
        glyphs[ch] = { advance: glyph.advanceWidth ?? 0, contours: glyphContours(glyph.path.commands as never) };
    }
    const kerning: Record<string, number> = {};
    const list = [...text];
    // Pair kerning of the GPOS table for Latin script (DejaVu and Liberation keep it there), else the kern table.
    const position = (font as unknown as { position?: GposPosition }).position;
    const tables = position?.getKerningTables?.('latn') ?? position?.getKerningTables?.('DFLT');
    for (let i = 0; i + 1 < list.length; i++) {
        const [a, b] = [list[i], list[i + 1]];
        if (glyphs[a] && glyphs[b] && kerning[a + b] === undefined) {
            const [ga, gb] = [font.charToGlyph(a), font.charToGlyph(b)];
            const k = (tables?.length ? position!.getKerningValue(tables, ga.index, gb.index) : 0) || font.getKerningValue(ga, gb);
            if (k) {
                kerning[a + b] = k;
            }
        }
    }
    const os2 = (font.tables as { os2?: { sCapHeight?: number } }).os2;
    const hhea = (font.tables as { hhea?: { lineGap?: number } }).hhea;
    const capHeight = os2?.sCapHeight || font.charToGlyph('H').getBoundingBox().y2 || font.unitsPerEm * 0.7;
    return {
        family, style, unitsPerEm: font.unitsPerEm, capHeight,
        lineHeight: font.ascender - font.descender + (hhea?.lineGap ?? 0),
        glyphs, kerning,
    };
}
