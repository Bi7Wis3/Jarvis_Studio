// B-rep text into OpenCascade solids: read as written (topology shared as in the file), then ShapeFix adds the
// pcurves and seam edges OpenCascade needs; sewing the faces is only the fallback when that is not valid.

import { cast, getOC, localGC, type Shape3D } from 'replicad';

type OC = ReturnType<typeof getOC>;
type TopoShape = InstanceType<OC['TopoDS_Shape']>;

export function isValidShape(shape: TopoShape): boolean {
    const oc = getOC();
    const analyzer = new oc.BRepCheck_Analyzer(shape, true, false);
    try {
        return analyzer.IsValid();
    } finally {
        analyzer.delete();
    }
}

export function shapeVolume(shape: TopoShape): number {
    const oc = getOC();
    const props = new oc.GProp_GProps();
    try {
        oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
        return props.Mass();
    } finally {
        props.delete();
    }
}

function listOf(shape: TopoShape, type: unknown): TopoShape[] {
    const oc = getOC();
    const out: TopoShape[] = [];
    const ex = new oc.TopExp_Explorer(shape, type as never, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; ex.More(); ex.Next()) {
        out.push(ex.Current());
    }
    ex.delete();
    return out;
}

export function faceCount(shape: TopoShape): number {
    return listOf(shape, getOC().TopAbs_ShapeEnum.TopAbs_FACE).length;
}

/** Readable message for a JS error or an OpenCascade (WebAssembly) exception. */
export function ocErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    try {
        const [type, message] = (getOC() as unknown as { getExceptionMessage(e: unknown): [string, string] }).getExceptionMessage(error);
        return `OpenCascade ${type}${message ? `: ${message}` : ''}`;
    } catch {
        return String(error);
    }
}

/** Runs an OpenCascade step that may throw; null when it does. */
function attempt<T>(step: () => T): T | null {
    try {
        return step();
    } catch {
        return null;
    }
}

/** pcurves, seams and tolerances for one solid read from text. */
function fixSolid(solid: TopoShape): TopoShape {
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const fix = r(new oc.ShapeFix_Solid(oc.TopoDS.Solid(solid)));
        fix.SetPrecision(1e-7);
        fix.SetMaxTolerance(1e-2);
        fix.Perform(r(new oc.Message_ProgressRange()));
        const fixed = fix.Solid();
        if (!isValidShape(fixed)) {
            // A pcurve shifted by a period to follow its neighbour can leave its edge flagged as not
            // same-range; re-parameterising every edge settles it.
            attempt(() => {
                oc.BRepLib.SameParameter(fixed, 1e-5, true);
                oc.BRepLib.UpdateTolerances(fixed, false);
            });
        }
        return fixed;
    } finally {
        gc();
    }
}

/** The faces sewn into closed shells and made into solids, then fixed as above. */
function sewSolid(shape: TopoShape, tolerance: number): TopoShape | null {
    const oc = getOC();
    const [r, gc] = localGC();
    try {
        const sewing = r(new oc.BRepBuilderAPI_Sewing(tolerance, true, true, true, false));
        for (const face of listOf(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE)) {
            sewing.Add(face);
        }
        sewing.Perform(r(new oc.Message_ProgressRange()));
        const sewn = sewing.SewedShape();
        const shells = listOf(sewn, oc.TopAbs_ShapeEnum.TopAbs_SHELL);
        if (shells.length === 0) {
            return null;
        }
        const maker = r(new oc.BRepBuilderAPI_MakeSolid());
        for (const shell of shells) {
            maker.Add(oc.TopoDS.Shell(shell));
        }
        if (!maker.IsDone()) {
            return null;
        }
        return fixSolid(maker.Solid());
    } finally {
        gc();
    }
}

export interface SolidResult {
    shape: Shape3D;
    valid: boolean;
    /** How the solid was made valid, when it needed more than adding pcurves. */
    repair?: string;
}

/** Reads B-rep text and turns each solid in it into a valid OpenCascade solid where it can. */
export function solidsFromBrep(text: string): SolidResult {
    const oc = getOC();
    const read = oc.BRepToolsWrapper.Read(text);
    if (read.IsNull()) {
        throw new Error('OpenCascade could not read the converted body');
    }
    const solids = listOf(read, oc.TopAbs_ShapeEnum.TopAbs_SOLID);
    const fixed: TopoShape[] = [];
    let valid = true;
    let repair: string | undefined;
    for (const solid of solids) {
        let s = attempt(() => fixSolid(solid)) ?? solid;
        if (!attempt(() => isValidShape(s) && shapeVolume(s) > 0)) {
            let sewn: TopoShape | null = null;
            for (const tol of [1e-6, 1e-5, 1e-4]) {
                const tried = attempt(() => sewSolid(solid, tol));
                if (tried && attempt(() => isValidShape(tried) && shapeVolume(tried) > 0)) {
                    sewn = tried;
                    repair = `faces sewn at ${tol} mm`;
                    break;
                }
            }
            if (sewn) {
                s = sewn;
            } else {
                valid = false;
            }
        }
        fixed.push(s);
    }
    let result: TopoShape;
    if (fixed.length === 1) {
        result = fixed[0];
    } else {
        const compound = new oc.TopoDS_Compound();
        const b = new oc.TopoDS_Builder();
        b.MakeCompound(compound);
        for (const s of fixed) {
            b.Add(compound, s);
        }
        b.delete();
        result = compound;
    }
    return { shape: cast(result) as Shape3D, valid, repair };
}
