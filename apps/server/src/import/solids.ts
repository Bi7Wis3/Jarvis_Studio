// Solid bodies out of whatever a file holds: its solids as they are, surfaces knitted and closed ones made into
// solids (SolidWorks: Try forming solid(s), Knit surface(s)), and a check with repairs when asked (Perform full entity
// check and repair errors). The studio has no surface bodies, so surfaces that stay open are left out with a warning.

import { cast, getOC, type Shape3D } from 'replicad';
import type { ImportOptions } from '@jarvis/core/imported';
import { explore, type Raw } from './topology.js';
import type { ImportedBody, ImportResult } from './types.js';

/** Gap the knitting closes when no curve tolerance is given, in mm. */
export const KNIT_TOLERANCE = 0.01;

const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

export function isValidShape(shape: Raw): boolean {
    const oc = getOC();
    const analyzer = new oc.BRepCheck_Analyzer(shape, true, false);
    try {
        return analyzer.IsValid();
    } finally {
        analyzer.delete();
    }
}

/** A closed shell as a solid, oriented so its volume is positive; null when it does not make one. */
export function shellSolid(shell: Raw): Shape3D | null {
    const oc = getOC();
    const maker = new oc.BRepBuilderAPI_MakeSolid(oc.TopoDS.Shell(shell));
    try {
        if (!maker.IsDone()) {
            return null;
        }
        const fix = new oc.ShapeFix_Solid(maker.Solid());
        try {
            fix.Perform(new oc.Message_ProgressRange());
            const solid = cast(fix.Solid()) as Shape3D;
            return solid.solids.length ? solid : (solid.delete(), null);
        } finally {
            fix.delete();
        }
    } finally {
        maker.delete();
    }
}

/** Knits faces and shells into as few shells as the gaps allow. */
export function knit(pieces: Raw[], tolerance: number): Raw {
    const oc = getOC();
    const sewing = new oc.BRepBuilderAPI_Sewing(tolerance, true, true, true, false);
    try {
        pieces.forEach((p) => sewing.Add(p));
        sewing.Perform(new oc.Message_ProgressRange());
        return sewing.SewedShape();
    } finally {
        sewing.delete();
    }
}

/** Repairs a solid that fails the check; returns it unchanged when it passes or cannot be repaired. */
export function repaired(solid: Shape3D): { solid: Shape3D; state: 'valid' | 'repaired' | 'faulty' } {
    if (isValidShape(solid.wrapped)) {
        return { solid, state: 'valid' };
    }
    const oc = getOC();
    const fix = new oc.ShapeFix_Solid(oc.TopoDS.Solid(solid.wrapped));
    try {
        fix.Perform(new oc.Message_ProgressRange());
        const fixed = cast(fix.Solid()) as Shape3D;
        if (fixed.solids.length && isValidShape(fixed.wrapped)) {
            solid.delete();
            return { solid: fixed, state: 'repaired' };
        }
        fixed.delete();
        return { solid, state: 'faulty' };
    } finally {
        fix.delete();
    }
}

/** The bodies in a file's shape: one per solid, knitting loose surfaces when asked. */
export function looseGeometry(whole: Shape3D, options: ImportOptions): ImportResult {
    const oc = getOC();
    const warnings: string[] = [];
    const solids: Shape3D[] = explore(oc, whole.wrapped, 'TopAbs_SOLID').map((s) => cast(s) as Shape3D);
    const shells = explore(oc, whole.wrapped, 'TopAbs_SHELL', 'TopAbs_SOLID');
    const faces = explore(oc, whole.wrapped, 'TopAbs_FACE', 'TopAbs_SHELL');
    const curves = explore(oc, whole.wrapped, 'TopAbs_EDGE', 'TopAbs_FACE').length;
    if (shells.length || faces.length) {
        const surfaces = shells.length + faces.length;
        if (options.knit === false) {
            warnings.push(`${plural(surfaces, 'surface')} left out: the studio has no surface bodies (turn on Knit surfaces to make solids of closed ones)`);
        } else {
            const sewn = knit([...shells, ...faces], options.tolerance && options.tolerance > 0 ? options.tolerance : KNIT_TOLERANCE);
            let open = 0;
            let made = 0;
            const pieces = explore(oc, sewn, 'TopAbs_SHELL');
            for (const shell of pieces) {
                const solid = oc.BRep_Tool.IsClosed(shell) ? shellSolid(shell) : null;
                if (solid) {
                    solids.push(solid);
                    made++;
                } else {
                    open++;
                }
            }
            const loose = explore(oc, sewn, 'TopAbs_FACE', 'TopAbs_SHELL').length;
            if (made) {
                warnings.push(`Knitted the file's surfaces into ${plural(made, 'solid body', 'solid bodies')}`);
            }
            if (open || loose) {
                warnings.push(`${plural(open + loose, 'surface body', 'surface bodies')} could not be knitted closed and ${open + loose === 1 ? 'was' : 'were'} `
                    + 'left out: the studio has no surface bodies (a larger curve tolerance may close the gaps)');
            }
        }
    }
    if (curves) {
        warnings.push(`${plural(curves, 'free curve')} left out: curves and points in the file are not imported`);
    }
    if (!solids.length) {
        throw new Error(warnings.length ? `nothing came in as a solid body. ${warnings.join('. ')}` : 'the file holds no solid bodies');
    }
    const bodies: ImportedBody[] = [];
    let fixed = 0;
    let faulty = 0;
    for (const solid of solids) {
        if (options.repair) {
            const check = repaired(solid);
            fixed += check.state === 'repaired' ? 1 : 0;
            faulty += check.state === 'faulty' ? 1 : 0;
            bodies.push({ shape: check.solid });
        } else {
            bodies.push({ shape: solid });
        }
    }
    if (fixed) {
        warnings.push(`Repaired ${plural(fixed, 'body', 'bodies')} that failed the check`);
    }
    if (faulty) {
        warnings.push(`${plural(faulty, 'body', 'bodies')} still ${faulty === 1 ? 'fails' : 'fail'} the check after repair: later features on ${faulty === 1 ? 'it' : 'them'} may fail`);
    }
    return { bodies, warnings };
}
