// IGES files (*.igs, *.iges; IGES 5.3, ASCII) to solid bodies in mm. The OpenCascade build has no IGES reader, so
// the file is read here: its trimmed and bounded surfaces become faces (faces.ts) that are knitted into solids,
// manifold solid B-rep objects (186) are built from their shells (msbo.ts), and subfigure instances (408) place
// their definitions' (308) bodies. The Global section's unit and model space scale give millimetres. Free points
// and curves are not imported; surfaces that stay open are left out, as for STEP (the studio has no surface
// bodies). OpenCascade must be loaded (replicad's setOC) before calling.

import type { ImportOptions } from '@jarvis/core/imported';
import type { Shape3D } from 'replicad';
import { ocErrorMessage } from '../sldprt/occ.js';
import { isValidShape, KNIT_TOLERANCE, repaired } from '../solids.js';
import type { ImportedBody, ImportResult } from '../types.js';
import { knitFaces, placed, type Piece, type SolidItem } from './bodies.js';
import { CURVE_TYPES } from './curves.js';
import { boundedPlane, boundedSurface, trimmedSurface, untrimmedSurface, type FaceContext } from './faces.js';
import { IgesGeometryError, IgesModel, int, num, str, type Xf } from './model.js';
import { msboPieces, msboSolid } from './msbo.js';
import { IgesFormatError, parseIges, type IgesEntity } from './parse.js';
import { SURFACE_TYPES } from './surfaces.js';

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

/** The entities an entity points to as its parts (groups and properties do not own their members). */
function parts(e: IgesEntity): number[] {
    const p = e.params;
    const at = (i: number): number[] => (typeof p[i] === 'number' && p[i] as number > 0 ? [p[i] as number] : []);
    const run = (from: number, count: number, stride = 1): number[] => Array.from({ length: Math.max(0, count) }, (_, k) => at(from + k * stride)).flat();
    const n = (i: number): number => int(e, i);
    switch (e.type) {
        case 102: return run(1, n(0));
        case 108: return at(4);
        case 118: return [...at(0), ...at(1)];
        case 120: return [...at(0), ...at(1)];
        case 122: return at(0);
        case 140: return at(4);
        case 141: {
            const out = at(2);
            let k = 4;
            for (let i = 0; i < n(3); i++) {
                out.push(...at(k));
                const count = n(k + 2);
                out.push(...run(k + 3, count));
                k += 3 + count;
            }
            return out;
        }
        case 142: return [...at(1), ...at(2), ...at(3)];
        case 143: return [...at(1), ...run(3, n(2))];
        case 144: return [...at(0), ...at(3), ...run(4, n(2))];
        case 186: return [...at(0), ...run(3, n(2), 2)];
        case 190: return [...at(0), ...at(1), ...at(2)];
        case 192: return [...at(0), ...at(1), ...at(3)];
        case 194: return [...at(0), ...at(1), ...at(4)];
        case 196: return [...at(0), ...at(2), ...at(3)];
        case 198: return [...at(0), ...at(1), ...at(4)];
        case 308: return run(3, n(2));
        case 408: return at(0);
        case 504: return run(1, n(0), 5).concat(run(2, n(0), 5), run(4, n(0), 5));
        case 508: {
            const out: number[] = [];
            let k = 1;
            for (let i = 0; i < n(0); i++) {
                out.push(...at(k + 1));
                const count = n(k + 4);
                for (let j = 0; j < count; j++) {
                    out.push(...at(k + 6 + 2 * j));
                }
                k += 5 + 2 * count;
            }
            return out;
        }
        case 510: return [...at(0), ...run(3, n(1))];
        case 514: return run(1, n(0), 2);
        default: return [];
    }
}

const FACE_ROOTS = new Set([143, 144, 186, 514, 408, ...SURFACE_TYPES]);

interface Collected {
    pieces: Piece[];
    solids: SolidItem[];
}

interface Tally {
    failed: Map<string, number>;
    reasons: Map<string, number>;
    unbounded: number;
}

export function readIges(bytes: Uint8Array, options: ImportOptions): ImportResult {
    let file;
    try {
        file = parseIges(bytes);
    } catch (error) {
        throw new Error(error instanceof IgesFormatError ? error.message : `the file could not be read as IGES (${ocErrorMessage(error)})`);
    }
    const m = new IgesModel(file);
    const warnings: string[] = [];
    const custom = options.tolerance !== undefined && options.tolerance > 0 ? options.tolerance : 0;
    const knitTolerance = custom || KNIT_TOLERANCE;
    const resolution = file.global.resolution * m.unitMm;
    const ctx: FaceContext = {
        precision: custom || Math.min(1e-4, Math.max(1e-7, resolution)),
        maxTolerance: Math.max(knitTolerance, 1e-4),
        largestGap: 0,
        parameterLoops: 0,
        openLoops: 0,
    };
    if (Math.abs(file.global.scale - 1) > 1e-12) {
        warnings.push(`The file's model space scale (${file.global.scale}) was applied`);
    }

    // What each entity is part of: roots are the entities nothing else owns.
    const owned = new Set<number>();
    for (const e of file.order) {
        for (const p of parts(e)) {
            owned.add(p);
        }
    }
    const isRoot = (e: IgesEntity): boolean => !owned.has(e.de) && e.use !== 1 && e.use !== 2;
    const tally: Tally = { failed: new Map(), reasons: new Map(), unbounded: 0 };
    const fail = (what: string, error: unknown): void => {
        tally.failed.set(what, (tally.failed.get(what) ?? 0) + 1);
        const why = error instanceof IgesGeometryError ? error.message : ocErrorMessage(error);
        tally.reasons.set(why, (tally.reasons.get(why) ?? 0) + 1);
    };
    const definitions = new Map<number, SolidItem[]>();
    const unknown = new Map<number, number>();

    /** Faces and solids of some entities in the space `x` maps to mm. */
    const collect = (entities: IgesEntity[], x: Xf, out: Collected, depth: number): void => {
        for (const e of entities) {
            const colour = m.colourOf(e);
            const push = (faces: ReturnType<typeof trimmedSurface>, surface?: IgesEntity): void => {
                const c = colour ?? m.colourOf(surface);
                for (const face of faces) {
                    out.pieces.push({ face, ...(c ? { colour: c } : {}) });
                }
            };
            try {
                switch (e.type) {
                    case 144:
                        push(trimmedSurface(m, e, x, ctx), m.entity(int(e, 0)));
                        break;
                    case 143:
                        push(boundedSurface(m, e, x, ctx), m.entity(int(e, 1)));
                        break;
                    case 108:
                        if (e.form !== 0 && int(e, 4) > 0) {
                            push(boundedPlane(m, e, x, ctx));
                        } else {
                            tally.unbounded++;
                        }
                        break;
                    case 190: case 192: case 194: case 196: case 198:
                        tally.unbounded++;
                        break;
                    case 114: case 118: case 120: case 122: case 128: case 140:
                        push(untrimmedSurface(m, e, x, ctx));
                        break;
                    case 186: {
                        const name = m.nameOf(e, 3 + 2 * int(e, 2));
                        const solid = msboSolid(m, e, x, ctx, knitTolerance);
                        if (solid) {
                            out.solids.push({ ...solid, ...(name ? { name } : {}) });
                        } else {
                            fail('solid B-rep object', new IgesGeometryError('its shell did not close'));
                        }
                        break;
                    }
                    case 514:
                        for (const p of msboPieces(m, e, x, ctx)) {
                            out.pieces.push({ ...p, ...(colour && !p.colour ? { colour } : {}) });
                        }
                        break;
                    case 408: {
                        const def = m.entity(int(e, 0));
                        if (!def || def.type !== 308 || depth > 16) {
                            break;
                        }
                        const solids = definition(def, depth + 1);
                        // In mm: R S q + k (R (X, Y, Z) + t), q a point of the definition in mm (members and
                        // instances are always read in the root frame, so this is the whole placement).
                        const own = m.ownXf(e);
                        const s = num(e, 4, 1) || 1;
                        const xyz: [number, number, number] = [num(e, 1), num(e, 2), num(e, 3)];
                        const t = [0, 1, 2].map((i) => m.unitMm * (own.r[i * 3] * xyz[0] + own.r[i * 3 + 1] * xyz[1] + own.r[i * 3 + 2] * xyz[2] + own.t[i])) as [number, number, number];
                        const place: Xf = { r: own.r.map((v) => v * s), t };
                        const name = str(def, 1) || undefined;
                        for (const solid of solids) {
                            out.solids.push({ shape: placed(solid.shape, place), ...(solid.colour ? { colour: solid.colour } : {}), ...(name ? { name } : {}) });
                        }
                        break;
                    }
                    default:
                        break;
                }
            } catch (error) {
                fail(e.type === 186 ? 'solid B-rep object' : e.type === 144 ? 'trimmed surface' : `entity type ${e.type}`, error);
            }
        }
    };

    /** The solids of a subfigure definition, in mm in its own frame (built once, placed by each instance). */
    const definition = (def: IgesEntity, depth: number): SolidItem[] => {
        const cached = definitions.get(def.de);
        if (cached) {
            return cached;
        }
        definitions.set(def.de, []);
        const members = Array.from({ length: int(def, 2) }, (_, k) => m.entity(int(def, 3 + k))).filter((e): e is IgesEntity => !!e);
        const out: Collected = { pieces: [], solids: [] };
        collect(members, m.root, out, depth);
        const solids = [...form(out), ...out.solids];
        definitions.set(def.de, solids);
        return solids;
    };

    let openTotal = 0;
    let knittedTotal = 0;
    /** Knits collected faces (when Knit surfaces is on) and gives the solids. */
    const form = (c: Collected): SolidItem[] => {
        if (!c.pieces.length) {
            return [];
        }
        if (options.knit === false) {
            openTotal += c.pieces.length;
            for (const p of c.pieces) {
                p.face.delete();
            }
            return [];
        }
        const knitted = knitFaces(c.pieces, knitTolerance);
        for (const p of c.pieces) {
            p.face.delete();
        }
        openTotal += knitted.open;
        knittedTotal += knitted.solids.length;
        return knitted.solids;
    };

    const roots = file.order.filter((e) => isRoot(e) && FACE_ROOTS.has(e.type));
    for (const e of file.order) {
        if (isRoot(e) && !FACE_ROOTS.has(e.type) && !CURVE_TYPES.has(e.type) && ![116, 124, 314, 402, 406, 308, 0].includes(e.type)) {
            unknown.set(e.type, (unknown.get(e.type) ?? 0) + 1);
        }
    }
    const top: Collected = { pieces: [], solids: [] };
    collect(roots, m.root, top, 0);
    const solids = [...form(top), ...top.solids];

    // Warnings, in the words of the STEP import.
    const free = file.order.filter((e) => isRoot(e) && (CURVE_TYPES.has(e.type) || e.type === 116 || e.type === 130)
        && !(e.type === 106 && e.form >= 20)).length;
    if (knittedTotal) {
        warnings.push(`Knitted the file's surfaces into ${plural(knittedTotal, 'solid body', 'solid bodies')}`);
    }
    if (openTotal) {
        warnings.push(options.knit === false
            ? `${plural(openTotal, 'surface')} left out: the studio has no surface bodies (turn on Knit surfaces to make solids of closed ones)`
            : `${plural(openTotal, 'surface body', 'surface bodies')} could not be knitted closed and ${openTotal === 1 ? 'was' : 'were'} `
                + 'left out: the studio has no surface bodies (a larger curve tolerance may close the gaps)');
    }
    for (const [what, count] of tally.failed) {
        warnings.push(`${plural(count, what)} could not be built and ${count === 1 ? 'was' : 'were'} left out`);
    }
    if (tally.reasons.size) {
        const top3 = [...tally.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([why, n]) => `${why}${n > 1 ? ` (${n})` : ''}`);
        warnings.push(`Reasons: ${top3.join('; ')}`);
    }
    if (ctx.parameterLoops) {
        warnings.push(`${plural(ctx.parameterLoops, 'face')} had only parameter-space trimming curves; their edges were rebuilt from them`);
    }
    if (ctx.openLoops) {
        warnings.push(`${plural(ctx.openLoops, 'trimming loop')} did not close`);
    }
    if (tally.unbounded) {
        warnings.push(`${plural(tally.unbounded, 'unbounded surface')} left out`);
    }
    if (unknown.size) {
        warnings.push(`Entities of types the studio does not read were left out: ${[...unknown.entries()].map(([t, n]) => `${n} of type ${t}`).join(', ')}`);
    }
    if (free) {
        warnings.push(`${plural(free, 'free curve or point', 'free curves and points')} left out: curves and points in the file are not imported`);
    }
    if (!solids.length) {
        throw new Error(warnings.length ? `nothing came in as a solid body. ${warnings.join('. ')}` : 'the file holds no solid bodies');
    }

    const bodies: ImportedBody[] = [];
    let fixed = 0;
    let faulty = 0;
    for (const s of solids) {
        let shape: Shape3D = s.shape;
        if (options.repair) {
            const check = repaired(shape);
            shape = check.solid;
            fixed += check.state === 'repaired' ? 1 : 0;
            faulty += check.state === 'faulty' ? 1 : 0;
        } else if (!isValidShape(shape.wrapped)) {
            faulty++;
        }
        bodies.push({ shape, ...(s.name ? { name: s.name } : {}), ...(s.colour ? { color: s.colour } : {}) });
    }
    if (fixed) {
        warnings.push(`Repaired ${plural(fixed, 'body', 'bodies')} that failed the check`);
    }
    if (faulty) {
        warnings.push(options.repair
            ? `${plural(faulty, 'body', 'bodies')} still ${faulty === 1 ? 'fails' : 'fail'} the check after repair: later features on ${faulty === 1 ? 'it' : 'them'} may fail`
            : `${plural(faulty, 'body', 'bodies')} ${faulty === 1 ? 'fails' : 'fail'} the check (turn on Perform full entity check and repair errors)`);
    }
    return { bodies, warnings };
}
