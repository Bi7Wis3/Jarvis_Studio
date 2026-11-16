// Bodies brought in from other CAD files (STEP, STL; SolidWorks parts later): the Imported step of a part's history
// and the options of the Import form. See docs/SOLIDWORKS_REFERENCE.md, Import. The server reads the file
// (apps/server/src/import) and stores what it read as asset files next to the projects, by content hash.

/** Units a mesh file's numbers can be read in (Mesh files import options, Unit), as millimetres per unit. */
export const IMPORT_UNITS = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 } as const;

export type ImportUnit = keyof typeof IMPORT_UNITS;

export const IMPORT_UNIT_NAMES: Record<ImportUnit, string> = {
    mm: 'Millimetres', cm: 'Centimetres', m: 'Metres', in: 'Inches', ft: 'Feet',
};

/** How a mesh file comes in (Import as): shown only (graphics), or one face per facet, closed meshes as solids. */
export type MeshImportAs = 'graphics' | 'solid';

export interface ImportOptions {
    /** Mesh files: Graphics body (default) or Solid body. */
    meshAs?: MeshImportAs;
    /** Mesh files: the unit the file's numbers are taken in (default mm). STEP files carry their own unit. */
    unit?: ImportUnit;
    /** Mesh files as solid bodies: coplanar facets next to each other become one face (Group facets into faces). */
    groupFacets?: boolean;
    /** Checks every body and repairs what fails the check (Perform full entity check and repair errors). */
    repair?: boolean;
    /** Surfaces in the file are knitted, and closed ones made into solids (Knit surface(s)); default on. */
    knit?: boolean;
    /** Tolerance in mm for reading curves and knitting (Customize curve tolerance); unset: the file's own. */
    tolerance?: number;
    /**
     * The file's up axis. 'z' (default: the studio's own exports, 3D printing and most CAD) is turned to the studio's
     * Y up; 'y' (SolidWorks) is kept as it is.
     */
    up?: 'y' | 'z';
    /** A new part per body instead of one part with several bodies (Import multiple bodies as parts). */
    bodiesAsParts?: boolean;
}

export const DEFAULT_IMPORT_OPTIONS: Required<Omit<ImportOptions, 'tolerance'>> = {
    meshAs: 'graphics', unit: 'mm', groupFacets: true, repair: false, knit: true, up: 'z', bodiesAsParts: false,
};

/** A body as the file names and colours it, when it does. */
export interface ImportedBodyInfo {
    name?: string;
    color?: string;
}

/**
 * The Imported step (SolidWorks: Imported1, or STL Graphics1 for a graphics body): bodies read from a file, added to
 * the part as separate bodies, in mm in the part's own frame (Y up). Later steps (fillets, cuts) work on its solids.
 */
export interface ImportStep {
    op: 'import';
    /** The file as it was picked: its name, format, and the asset id of its original bytes. */
    file: { name: string; format: string; asset: string; thumbnail?: string };
    /** Solid bodies: asset id of the OpenCascade BREP that holds them (a compound of solids). */
    brep?: string;
    /** Graphics body: asset id of its triangles as a binary STL (mm, part frame). Shown, not used by other steps. */
    mesh?: string;
    /** Per solid of the BREP, in order (or the one graphics body). */
    bodies?: ImportedBodyInfo[];
    /** The options it was read with. */
    options?: ImportOptions;
}

/** Asset ids of import files: 24 hex digits of the content's SHA-256 and the file's own extension. */
export const IMPORT_ASSET = /^[a-f0-9]{24}\.[a-z0-9]{1,8}$/;
