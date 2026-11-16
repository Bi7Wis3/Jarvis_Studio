// OpenCascade B-rep text (the BRepTools format) for IGES faces and solids: as the SolidWorks reader writes it
// (sldprt/brep.ts), plus edges that carry only a curve in a face's parameter space (IGES parameter-space curves),
// whose 3D curves OpenCascade builds after reading.

import type { V3 } from '../sldprt/nurbs.js';

const fmt = (x: number): string => (x === 0 ? '0' : String(x));
const v3 = (v: V3): string => `${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`;

interface ShapeRec {
    head: string;
    flags: string;
    subs: [string, number][];
}

/** The sections of one B-rep text; shapes are numbered in write order, sub-shapes first. */
export class BrepWriter {
    private readonly curves: string[] = [];
    private readonly curves2d: string[] = [];
    private readonly surfaces: string[] = [];
    private readonly shapes: ShapeRec[] = [];

    curve(rec: string): number {
        this.curves.push(rec);
        return this.curves.length;
    }

    curve2d(rec: string): number {
        this.curves2d.push(rec);
        return this.curves2d.length;
    }

    surface(rec: string): number {
        this.surfaces.push(rec);
        return this.surfaces.length;
    }

    shape(head: string, flags: string, subs: [string, number][] = []): number {
        this.shapes.push({ head, flags, subs });
        return this.shapes.length - 1;
    }

    vertex(p: V3, tol: number): number {
        return this.shape(`Ve\n${fmt(tol)}\n${v3(p)}\n0 0\n`, '0101101');
    }

    /** An edge on a 3D curve between parameters, from vertex v1 (at first) to v2 (at last). */
    edge3d(curve: number, first: number, last: number, v1: number, v2: number, tol: number): number {
        return this.shape(`Ed\n ${fmt(tol)} 1 1 0\n1  ${curve} 0 ${fmt(first)} ${fmt(last)}\n0\n`, '0101000', [['+', v1], ['-', v2]]);
    }

    /** An edge known only by its curve in a surface's parameter space. */
    edge2d(pcurve: number, surface: number, first: number, last: number, v1: number, v2: number, tol: number): number {
        return this.shape(`Ed\n ${fmt(tol)} 1 1 0\n2  ${pcurve} ${surface} 0 ${fmt(first)} ${fmt(last)}\n0\n`, '0101000', [['+', v1], ['-', v2]]);
    }

    wire(edges: [string, number][]): number {
        return this.shape('Wi\n', '0101100', edges);
    }

    face(surface: number, tol: number, wires: [string, number][]): number {
        return this.shape(`Fa\n0  ${fmt(tol)} ${surface} 0\n`, '0101000', wires);
    }

    toString(root: number, orientation = '+'): string {
        const n = this.shapes.length;
        const ref = (pos: number): number => n - pos;
        const out: string[] = ['DBRep_DrawableShape', '', 'CASCADE Topology V3, (c) Open Cascade', 'Locations 0'];
        out.push(`Curve2ds ${this.curves2d.length}`, ...this.curves2d);
        out.push(`Curves ${this.curves.length}`, ...this.curves);
        out.push('Polygon3D 0', 'PolygonOnTriangulations 0');
        out.push(`Surfaces ${this.surfaces.length}`, ...this.surfaces);
        out.push('Triangulations 0', '', `TShapes ${n}`);
        for (const s of this.shapes) {
            const subs = s.subs.map(([o, p]) => `${o}${ref(p)} 0`).join(' ');
            out.push(`${s.head}\n${s.flags}\n${subs ? `${subs} *` : '*'}`);
        }
        out.push('', `${orientation}${ref(root)} 0`, '');
        return out.join('\n');
    }
}
