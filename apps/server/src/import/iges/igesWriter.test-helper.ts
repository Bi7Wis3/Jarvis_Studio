// Test helper: writes small IGES files (fixed-column ASCII) from entities given by type and parameters, with
// builders for the entities the tests use. Entities refer to each other by DE pointer (the value add() returns).

export type V3 = [number, number, number];

export interface TestEntity {
    type: number;
    params: (number | string)[];
    form?: number;
    /** DE pointer of a transformation matrix (124). */
    xform?: number;
    /** Colour number, or minus the DE pointer of a colour definition (314). */
    color?: number;
    /** Status digits: blank, subordinate, use, hierarchy (default '00000000'). */
    status?: string;
}

const num = (v: number): string => (Number.isInteger(v) ? `${v}.` : String(v));
const param = (v: number | string): string => (typeof v === 'string' ? `${v.length}H${v}` : Number.isInteger(v) && Math.abs(v) < 1e9 ? String(v) : num(v));
const col = (v: string | number, width = 8): string => String(v).padStart(width, ' ');
const seq = (section: string, n: number): string => `${section}${String(n).padStart(7, ' ')}`;

export interface GlobalOptions {
    /** Unit flag (2 mm, 1 inch, ...) and name. */
    unit?: [number, string];
    scale?: number;
    resolution?: number;
    system?: string;
}

export class IgesBuilder {
    readonly entities: TestEntity[] = [];

    /** Adds an entity; returns its DE pointer. */
    add(e: TestEntity): number {
        this.entities.push(e);
        return 2 * this.entities.length - 1;
    }

    point(p: V3): number {
        return this.add({ type: 116, params: [...p, 0] });
    }

    direction(v: V3): number {
        return this.add({ type: 123, params: [...v] });
    }

    line(a: V3, b: V3, xform?: number): number {
        return this.add({ type: 110, params: [...a, ...b], xform });
    }

    /** A circular arc in the plane z = zt, anticlockwise from start to end (equal points: a full circle). */
    arc(zt: number, c: [number, number], s: [number, number], e: [number, number], xform?: number): number {
        return this.add({ type: 100, params: [zt, ...c, ...s, ...e], xform });
    }

    composite(curves: number[]): number {
        return this.add({ type: 102, params: [curves.length, ...curves] });
    }

    /** A 3D polyline (copious data, form 12). */
    polyline(points: V3[]): number {
        return this.add({ type: 106, form: 12, params: [2, points.length, ...points.flat()] });
    }

    /** Ax + By + Cz = D. */
    plane(n: V3, d: number): number {
        return this.add({ type: 108, params: [...n, d, 0, 0, 0, 0, 0] });
    }

    /** A rotation (row-major 3 x 3) and translation. */
    matrix(r: number[], t: V3, form = 0): number {
        return this.add({ type: 124, form, params: [r[0], r[1], r[2], t[0], r[3], r[4], r[5], t[1], r[6], r[7], r[8], t[2]] });
    }

    /** A degree-1 B-spline curve between two points (z = 0 for a parameter-space curve). */
    bline(a: V3, b: V3): number {
        return this.add({ type: 126, params: [1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1, ...a, ...b, 0, 1, 0, 0, 1] });
    }

    /** A bilinear B-spline surface through four corners (u along p00 -> p10, v along p00 -> p01). */
    bilinear(p00: V3, p10: V3, p01: V3, p11: V3): number {
        return this.add({
            type: 128,
            params: [1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, ...p00, ...p10, ...p01, ...p11, 0, 1, 0, 1],
        });
    }

    curveOnSurface(surface: number, model: number, param = 0): number {
        return this.add({ type: 142, params: [0, surface, param, model, model ? 2 : 1], status: '00010500' });
    }

    trimmed(surface: number, outer: number, inner: number[] = [], color?: number): number {
        return this.add({ type: 144, params: [surface, 1, inner.length, outer, ...inner], color });
    }

    /** A planar face bounded by a closed polygon of lines (a trimmed plane). */
    planarFace(corners: V3[], color?: number): number {
        const [a, b, c] = corners;
        const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const plane = this.plane(n, n[0] * a[0] + n[1] * a[1] + n[2] * a[2]);
        const lines = corners.map((p, i) => this.line(p, corners[(i + 1) % corners.length]));
        return this.trimmed(plane, this.curveOnSurface(plane, this.composite(lines)), [], color);
    }

    toBytes(options: GlobalOptions = {}): Uint8Array {
        const [unitFlag, unitName] = options.unit ?? [2, 'MM'];
        const global = [',', ';', 'test', 'test.igs', options.system ?? 'Jarvis test', 'writer 1', 32, 308, 15, 308, 15, 'test',
            options.scale ?? 1, unitFlag, unitName, 1, 0.01, '20261116.000000', options.resolution ?? 1e-7, 1000, 'tester', '', 11, 0,
            '20261116.000000'];
        const gText = `${global.map((v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(v)) : `${v.length}H${v}`)).join(',')};`;
        const lines: string[] = [`${'IGES written by the reader tests'.padEnd(72)}${seq('S', 1)}`];
        for (let i = 0; i * 72 < gText.length; i++) {
            lines.push(`${gText.slice(i * 72, i * 72 + 72).padEnd(72)}${seq('G', i + 1)}`);
        }
        const gCount = Math.ceil(gText.length / 72);
        const dLines: string[] = [];
        const pLines: string[] = [];
        this.entities.forEach((e, k) => {
            const de = 2 * k + 1;
            const text = `${[e.type, ...e.params].map(param).join(',')};`;
            const start = pLines.length + 1;
            for (let i = 0; i * 64 < text.length; i++) {
                pLines.push(`${text.slice(i * 64, i * 64 + 64).padEnd(64)} ${col(de, 7)}${seq('P', pLines.length + 1)}`);
            }
            const count = pLines.length + 1 - start;
            dLines.push(`${col(e.type)}${col(start)}${col(0)}${col(0)}${col(0)}${col(0)}${col(e.xform ?? 0)}${col(0)}${(e.status ?? '00000000').padStart(8, '0')}${seq('D', de)}`);
            dLines.push(`${col(e.type)}${col(0)}${col(e.color ?? 0)}${col(count)}${col(e.form ?? 0)}${col('')}${col('')}${col('')}${col(0)}${seq('D', de + 1)}`);
        });
        lines.push(...dLines, ...pLines);
        lines.push(`${seq('S', 1)}${seq('G', gCount)}${seq('D', dLines.length)}${seq('P', pLines.length)}`.padEnd(72) + seq('T', 1));
        return new TextEncoder().encode(`${lines.join('\n')}\n`);
    }
}

/** The six faces of a box from the origin, as polygons (anticlockwise seen from outside). */
export function boxFaces(w: number, d: number, h: number, at: V3 = [0, 0, 0]): V3[][] {
    const p = (x: number, y: number, z: number): V3 => [at[0] + x * w, at[1] + y * d, at[2] + z * h];
    return [
        [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)],
        [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)],
        [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)],
        [p(1, 1, 0), p(0, 1, 0), p(0, 1, 1), p(1, 1, 1)],
        [p(0, 1, 0), p(0, 0, 0), p(0, 0, 1), p(0, 1, 1)],
        [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)],
    ];
}
