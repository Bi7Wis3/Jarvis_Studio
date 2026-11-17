// The mate solver: places the floating components so their mates hold, by least squares on the mates' residuals
// (Levenberg-Marquardt, one rigid motion of six numbers per component, the Jacobian by central differences).
// Components joined by mates through floating ones form a cluster; only the clusters asked for are solved, so a drag
// solves the dragged component's cluster on every frame. Fixed components and the assembly's own planes hold still.
// The analysis reports each mate's state (red errors, yellow warnings), each component's remaining degrees of
// freedom and its tree prefix, as SolidWorks does: a later mate that fights earlier ones is the one left unsolved.

import type { Part, Vec3 } from '../index';
import { choleskySolve, RowBasis, symmetricEigen } from './linalg';
import {
    across, add, applyDir, axisAngle, compose, copyTransform, cross, dist, dot, expRot, IDENTITY_RIGID, logRot, mulMat,
    mulVec, placementOf, rigidOf, scale, sub, transpose, unit, type Rigid,
} from './math';
import { anchorOf, angleSense, directionOf, mateRows, worldGeom, type Side } from './residuals';
import { refGeometry } from './resolve';
import type { AssemblyMates, ComponentState, Mate, MateGeom, MateRef, MateStatus, Placement } from './types';
import { entityClass, MATE_LABELS, validMateTypes } from './valid';

/** A mate holds when every residual is below this (mm). */
export const HOLDS = 1e-6;
/** The solver aims well below that. */
const AIM = 1e-10;
/** Weight of a drag's pull against the mates. */
const PULL = 0.02;

interface Body {
    id: string;
    T: Rigid;
    fixed: boolean;
    repeat?: Part['repeat'];
    /** Where the body turns about while solving (the middle of its mated entities), world. */
    pivot: Vec3;
}

interface SideRef {
    /** Index into bodies; -1 for the assembly itself. */
    body: number;
    copy: Rigid;
    geom: MateGeom;
}

interface Link {
    mate: Mate;
    sides: [SideRef, SideRef];
}

export interface SolveOptions {
    /** Solve only the clusters that hold these parts (all when absent). */
    only?: readonly string[];
    /** Work out each mate's state and each component's freedom (slower: conflicts are traced mate by mate). */
    analyse?: boolean;
}

export interface AssemblyResult {
    /** New placements of the parts the solve moved. */
    placements: Record<string, Placement>;
    /** Per mate id (with `analyse`, else only mates that could not be set up). */
    mates: Record<string, MateStatus>;
    /** Per part id (with `analyse`). */
    components: Record<string, ComponentState>;
    /** Remaining degrees of freedom per part (with `analyse`; fixed parts 0). */
    dof: Record<string, number>;
    /** Whether every solved mate holds. */
    converged: boolean;
}

/** A pull on a component while it is dragged: a point of it towards the pointer's ray, or its whole placement. */
export type DragTarget =
    | { part: string; copy?: number; grab: Vec3; ray: { origin: Vec3; direction: Vec3 } }
    | { part: string; placement: Placement };

/** The parts fixed in place: those listed, else the first part (SolidWorks fixes the first component). */
export function fixedParts(parts: readonly Pick<Part, 'id'>[], assembly: Pick<AssemblyMates, 'fixed'> | undefined): Set<string> {
    if (assembly?.fixed) {
        return new Set(assembly.fixed);
    }
    return new Set(parts.length ? [parts[0].id] : []);
}

const MESSAGES = {
    missing: 'One of the entities of this mate is suppressed, invalid, or no longer present.',
    conflict: 'This mate is over defining the assembly. Consider deleting some of the over defining mates.',
    unsolved: 'This mate cannot be solved. Consider deleting this mate, dragging the components closer to where the mate '
        + 'puts them, adding mates to define the assembly further, or changing the mating scheme.',
    redundant: 'This mate is over defining the assembly: other mates already set its value. Consider deleting some of the '
        + 'over defining mates.',
};

/**
 * The mates of an assembly set up for solving: its components as rigid bodies and its active mates with their
 * geometry. Placements change as it solves (a drag keeps one and solves on every frame).
 */
export class MateSystem {
    readonly bodies: Body[] = [];
    private readonly index = new Map<string, number>();
    private readonly links: Link[] = [];
    /** Mates that could not be set up (lost references, pairs that cannot take the mate). */
    private readonly broken = new Map<string, MateStatus>();
    private readonly suppressed = new Set<string>();
    /** The size of the assembly: scales direction errors into lengths. */
    readonly L: number;
    private readonly start: Map<number, Rigid>;

    /**
     * `geometry` finds a reference's geometry (part frame); by default refGeometry (found faces, edges and vertices,
     * and the part's planes, axes and origin). `extra`: mates to solve that are not stored (a form's preview).
     * `exclude`: mates left out (known errors, during a drag).
     */
    constructor(parts: readonly Part[], assembly: AssemblyMates | undefined, options: {
        geometry?: (ref: MateRef) => MateGeom | null;
        extra?: readonly Mate[];
        exclude?: ReadonlySet<string>;
        fixed?: ReadonlySet<string>;
    } = {}) {
        const fixed = options.fixed ?? fixedParts(parts, assembly);
        for (const part of parts) {
            this.index.set(part.id, this.bodies.length);
            this.bodies.push({ id: part.id, T: rigidOf(part), fixed: fixed.has(part.id), repeat: part.repeat, pivot: [...part.position] as Vec3 });
        }
        const geometry = options.geometry ?? ((ref: MateRef) => refGeometry(ref, parts));
        const anchors = new Map<number, Vec3[]>();
        const all: Vec3[] = [];
        for (const mate of [...(assembly?.mates ?? []), ...(options.extra ?? [])]) {
            if (mate.suppressed) {
                this.suppressed.add(mate.id);
                continue;
            }
            if (options.exclude?.has(mate.id)) {
                continue;
            }
            const sides: SideRef[] = [];
            let lost = false;
            for (const ref of mate.refs.slice(0, 2)) {
                const body = ref.part ? this.index.get(ref.part) ?? -2 : -1;
                const geom = mate.type === 'lock' ? ({ type: 'point', point: [0, 0, 0] } as MateGeom) : geometry(ref);
                if (body === -2 || !geom) {
                    lost = true;
                    break;
                }
                const copy = body >= 0 ? copyTransform(this.bodies[body].repeat, ref.copy ?? 0) : IDENTITY_RIGID;
                sides.push({ body, copy, geom });
            }
            if (lost || sides.length < 2) {
                this.broken.set(mate.id, { state: 'error', reason: 'missing', message: MESSAGES.missing });
                continue;
            }
            const [a, b] = sides;
            const same = a.body === b.body;
            if (same || (mate.type !== 'lock' && !validMateTypes(a.geom, b.geom).includes(mate.type))) {
                this.broken.set(mate.id, {
                    state: 'error', reason: 'invalid',
                    message: same ? 'Both entities are on the same component: a mate joins two components.'
                        : `A ${MATE_LABELS[mate.type].toLowerCase()} mate cannot join a ${entityClass(a.geom)} and a ${entityClass(b.geom)}.`,
                });
                continue;
            }
            this.links.push({ mate, sides: [a, b] });
            for (const s of sides) {
                const anchor = anchorOf(s.geom);
                if (anchor) {
                    const w = this.world(s).geom;
                    const p = anchorOf(w)!;
                    all.push(p);
                    if (s.body >= 0) {
                        anchors.set(s.body, [...(anchors.get(s.body) ?? []), p]);
                    }
                }
            }
        }
        for (const [i, points] of anchors) {
            this.bodies[i].pivot = scale(points.reduce(add, [0, 0, 0] as Vec3), 1 / points.length);
        }
        const centre = all.length ? scale(all.reduce(add, [0, 0, 0] as Vec3), 1 / all.length) : [0, 0, 0] as Vec3;
        const spread = all.length ? Math.sqrt(all.reduce((s, p) => s + dist(p, centre) ** 2, 0) / all.length) : 0;
        this.L = Math.max(10, 2 * spread);
        this.start = new Map(this.bodies.map((b, i) => [i, b.T]));
    }

    /** The world geometry and transform of one side. */
    private world(s: SideRef): Side {
        const T = s.body >= 0 ? compose(s.copy, this.bodies[s.body].T) : IDENTITY_RIGID;
        return { T, geom: worldGeom(s.geom, T) };
    }

    private rowsOf(link: Link): number[] {
        return mateRows(link.mate, this.world(link.sides[0]), this.world(link.sides[1]), this.L, true)?.rows ?? [];
    }

    private free(i: number): boolean {
        return i >= 0 && !this.bodies[i].fixed;
    }

    /** Clusters of floating bodies joined by mates (a fixed body or the assembly joins nothing). */
    private clusters(links: Link[]): number[][] {
        const parent = this.bodies.map((_, i) => i);
        const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
        for (const { sides: [a, b] } of links) {
            if (this.free(a.body) && this.free(b.body)) {
                parent[find(a.body)] = find(b.body);
            }
        }
        const groups = new Map<number, number[]>();
        this.bodies.forEach((body, i) => {
            if (!body.fixed && links.some((l) => l.sides.some((s) => s.body === i))) {
                const root = find(i);
                groups.set(root, [...(groups.get(root) ?? []), i]);
            }
        });
        return [...groups.values()];
    }

    private save(cluster: number[]): Rigid[] {
        return cluster.map((i) => this.bodies[i].T);
    }

    private restore(cluster: number[], saved: Rigid[]): void {
        cluster.forEach((i, k) => {
            this.bodies[i].T = saved[k];
        });
    }

    /** Moves body i by a small rigid motion: x = [dx, dy, dz, L wx, L wy, L wz], turning about its pivot. */
    private nudge(i: number, x: ArrayLike<number>, at = 0): void {
        const body = this.bodies[i];
        const w: Vec3 = [x[at + 3] / this.L, x[at + 4] / this.L, x[at + 5] / this.L];
        const R = expRot(w);
        const c = body.pivot;
        body.T = { R: mulMat(R, body.T.R), t: add(add(mulVec(R, sub(body.T.t, c)), c), [x[at], x[at + 1], x[at + 2]]) };
    }

    /** Pulls of a drag as residual rows (already weighted). */
    private pullRows(target: DragTarget, weight: number): number[] {
        const i = this.index.get(target.part)!;
        const body = this.bodies[i];
        if ('grab' in target) {
            const T = compose(copyTransform(body.repeat, target.copy ?? 0), body.T);
            const p = add(mulVec(T.R, target.grab), T.t);
            const d = unit(target.ray.direction);
            const rel = sub(p, target.ray.origin);
            const off = sub(rel, scale(d, dot(rel, d)));
            return off.map((v) => v * weight);
        }
        const want = rigidOf(target.placement);
        return [...sub(body.T.t, want.t), ...scale(logRot(mulMat(want.R, transpose(body.T.R))), this.L)].map((v) => v * weight);
    }

    /**
     * Levenberg-Marquardt over the bodies of `cluster` for the `links` (and a drag's pull). Returns the largest mate
     * residual at the end. A row depends on at most two bodies, so the normal equations take only their columns.
     */
    private lm(cluster: number[], links: Link[], maxIter: number, pull?: { target: DragTarget; weight: number }): number {
        const n = cluster.length * 6;
        const slot = new Map(cluster.map((b, k) => [b, k]));
        const touches = cluster.map((b) => links.map((l, li) => (l.sides.some((s) => s.body === b) ? li : -1)).filter((li) => li >= 0));
        const pulled = pull ? slot.get(this.index.get(pull.target.part)!) : undefined;
        const colsOf = (slots: number[]) => slots.flatMap((k) => [0, 1, 2, 3, 4, 5].map((v) => k * 6 + v));
        const linkCols = links.map((l) => colsOf([...new Set(l.sides.map((s) => slot.get(s.body)).filter((k): k is number => k !== undefined))]));
        const pullCols = pulled !== undefined ? colsOf([pulled]) : [];
        interface State { r: number[]; offsets: number[]; counts: number[]; hard: number }
        const evaluate = (): State => {
            const r: number[] = [];
            const offsets: number[] = [];
            const counts: number[] = [];
            let hard = 0;
            for (const l of links) {
                const rows = this.rowsOf(l);
                offsets.push(r.length);
                counts.push(rows.length);
                for (const v of rows) {
                    r.push(v);
                    hard = Math.max(hard, Math.abs(v));
                }
            }
            if (pull) {
                r.push(...this.pullRows(pull.target, pull.weight));
            }
            return { r, offsets, counts, hard };
        };
        let current = evaluate();
        if (n === 0) {
            return current.hard;
        }
        let cost = current.r.reduce((s, v) => s + v * v, 0);
        let lambda = 1e-3;
        const h = 1e-6;
        const step = new Float64Array(6);
        for (let iter = 0; iter < maxIter; iter++) {
            if (!pull && current.hard < AIM) {
                break;
            }
            const m = current.r.length;
            const pullAt = current.offsets.length ? current.offsets[current.offsets.length - 1] + current.counts[current.counts.length - 1] : 0;
            const J = new Float64Array(m * n);
            for (let k = 0; k < cluster.length; k++) {
                const i = cluster[k];
                const saved = this.bodies[i].T;
                for (let v = 0; v < 6; v++) {
                    step.fill(0);
                    step[v] = h;
                    this.nudge(i, step);
                    const plus = touches[k].map((li) => this.rowsOf(links[li]));
                    const pullPlus = pull && pulled === k ? this.pullRows(pull.target, pull.weight) : null;
                    this.bodies[i].T = saved;
                    step[v] = -h;
                    this.nudge(i, step);
                    const minus = touches[k].map((li) => this.rowsOf(links[li]));
                    const pullMinus = pull && pulled === k ? this.pullRows(pull.target, pull.weight) : null;
                    this.bodies[i].T = saved;
                    touches[k].forEach((li, j) => {
                        const at = current.offsets[li];
                        const p = plus[j];
                        const q = minus[j];
                        for (let row = 0; row < p.length; row++) {
                            J[(at + row) * n + k * 6 + v] = (p[row] - q[row]) / (2 * h);
                        }
                    });
                    if (pullPlus && pullMinus) {
                        for (let row = 0; row < pullPlus.length; row++) {
                            J[(pullAt + row) * n + k * 6 + v] = (pullPlus[row] - pullMinus[row]) / (2 * h);
                        }
                    }
                }
            }
            const A = new Float64Array(n * n);
            const g = new Float64Array(n);
            const accumulate = (row: number, cols: number[]) => {
                const base = row * n;
                const rv = current.r[row];
                for (const a of cols) {
                    const ja = J[base + a];
                    if (ja === 0) {
                        continue;
                    }
                    g[a] += ja * rv;
                    for (const b of cols) {
                        A[a * n + b] += ja * J[base + b];
                    }
                }
            };
            links.forEach((_, li) => {
                for (let row = 0; row < current.counts[li]; row++) {
                    accumulate(current.offsets[li] + row, linkCols[li]);
                }
            });
            for (let row = pullAt; row < m; row++) {
                accumulate(row, pullCols);
            }
            let accepted = false;
            let settled = false;
            for (let tries = 0; tries < 12; tries++) {
                const M = Float64Array.from(A);
                for (let a = 0; a < n; a++) {
                    M[a * n + a] += lambda * (A[a * n + a] + 1e-6);
                }
                const delta = choleskySolve(M, g.map((v) => -v), n);
                if (!delta) {
                    lambda *= 10;
                    continue;
                }
                const saved = this.save(cluster);
                cluster.forEach((i, k) => this.nudge(i, delta, k * 6));
                const next = evaluate();
                const nextCost = next.r.reduce((s, v) => s + v * v, 0);
                if (nextCost < cost || nextCost < 1e-30) {
                    const moved = Math.sqrt(delta.reduce((s, v) => s + v * v, 0));
                    // Nothing left to gain: the step or (with a pull, which never reaches zero) the improvement is negligible.
                    settled = moved < 1e-12 || (pull !== undefined && cost - nextCost < 1e-10 * Math.max(1, cost));
                    current = next;
                    cost = nextCost;
                    lambda = Math.max(1e-12, lambda / 4);
                    accepted = true;
                    break;
                }
                this.restore(cluster, saved);
                lambda *= 8;
            }
            if (!accepted || settled) {
                break;
            }
        }
        return current.hard;
    }

    /** Turns a component to the side its mates ask for before solving, where the solver could not get there itself. */
    private setSides(cluster: number[], links: Link[]): void {
        const inCluster = new Set(cluster);
        for (const link of links) {
            const [sa, sb] = link.sides;
            const turnable = inCluster.has(sb.body) ? sb : inCluster.has(sa.body) ? sa : null;
            if (!turnable) {
                continue;
            }
            const a = this.world(sa);
            const b = this.world(sb);
            const da = directionOf(a.geom);
            const db = directionOf(b.geom);
            if (!da || !db) {
                continue;
            }
            const body = this.bodies[turnable.body];
            const mate = link.mate;
            if (mate.type === 'angle') {
                const want = mate.flip ? -1 : 1;
                const sense = angleSense(mate, a, b);
                if (sense && sense !== want && mate.hold?.about) {
                    const k = unit(applyDir(a.T, mate.hold.about));
                    const flat = (d: Vec3) => sub(d, scale(k, dot(d, k)));
                    const dbs = mate.alignment === 'antiAligned' ? scale(db, -1) : db;
                    const phi = Math.atan2(dot(cross(flat(da), flat(dbs)), k), dot(flat(da), flat(dbs)));
                    this.turn(body, k, turnable === sb ? -2 * phi : 2 * phi);
                }
                continue;
            }
            const mixed = (entityClass(a.geom) === 'plane') !== (entityClass(b.geom) === 'plane');
            const directed = (mate.type === 'perpendicular' && mixed)
                || ((mate.type === 'coincident' || mate.type === 'concentric' || mate.type === 'parallel' || mate.type === 'distance') && !mixed);
            if (!directed || !mate.alignment) {
                continue;
            }
            const s = mate.alignment === 'aligned' ? 1 : -1;
            if (dot(da, db) * s < -0.5) {
                this.turn(body, across(turnable === sb ? db : da), Math.PI);
            }
        }
    }

    private turn(body: Body, axis: Vec3, angle: number): void {
        const R = axisAngle(unit(axis), angle);
        const c = body.pivot;
        body.T = { R: mulMat(R, body.T.R), t: add(mulVec(R, sub(body.T.t, c)), c) };
    }

    /** Places the clusters asked for so their mates hold; with `analyse`, the states and freedoms too. */
    solve(options: SolveOptions = {}): AssemblyResult {
        const result: AssemblyResult = { placements: {}, mates: {}, components: {}, dof: {}, converged: true };
        for (const [id, status] of this.broken) {
            result.mates[id] = status;
        }
        for (const id of this.suppressed) {
            result.mates[id] = { state: 'suppressed' };
        }
        const only = options.only ? new Set(options.only.map((id) => this.index.get(id)).filter((i): i is number => i !== undefined)) : null;
        const red = new Map<Link, MateStatus>();
        const solved = new Set<number>();
        for (const cluster of this.clusters(this.links)) {
            if (only && !cluster.some((i) => only.has(i))) {
                continue;
            }
            cluster.forEach((i) => solved.add(i));
            const links = this.links.filter((l) => l.sides.some((s) => cluster.includes(s.body)));
            const before = this.save(cluster);
            this.setSides(cluster, links);
            let accepted = links;
            if (this.lm(cluster, links, 80) > HOLDS) {
                // Something fights: take the mates in order, leaving out each one that cannot join the rest.
                this.restore(cluster, before);
                this.setSides(cluster, links);
                accepted = [];
                for (const link of links) {
                    const saved = this.save(cluster);
                    if (this.lm(cluster, [...accepted, link], 60) <= HOLDS) {
                        accepted.push(link);
                    } else {
                        this.restore(cluster, saved);
                        red.set(link, { state: 'error', reason: 'unsolved', message: MESSAGES.unsolved });
                    }
                }
                result.converged = false;
            }
            if (options.analyse) {
                this.analyse(cluster, accepted, [...red.keys()].filter((l) => links.includes(l)), red, result);
            }
        }
        // Mates between components that never move: they hold or they do not.
        for (const link of this.links) {
            if (link.sides.some((s) => this.free(s.body))) {
                continue;
            }
            const off = this.rowsOf(link).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
            if (off > HOLDS) {
                red.set(link, { state: 'error', reason: 'conflict', message: `${MESSAGES.conflict} Both of its components are fixed.` });
                result.converged = false;
            } else if (options.analyse && (link.mate.type === 'distance' || link.mate.type === 'angle')) {
                result.mates[link.mate.id] = { state: 'warning', reason: 'redundant', message: MESSAGES.redundant };
            }
        }
        for (const [link, status] of red) {
            result.mates[link.mate.id] = status;
        }
        if (options.analyse) {
            for (const link of this.links) {
                result.mates[link.mate.id] ??= { state: 'ok' };
            }
            this.componentStates(result);
        }
        for (const i of solved) {
            const body = this.bodies[i];
            const was = this.start.get(i)!;
            const moved = dist(body.T.t, was.t) > 1e-12 || body.T.R.some((v, k) => Math.abs(v - was.R[k]) > 1e-13);
            if (moved) {
                result.placements[body.id] = placementOf(body.T);
            }
        }
        return result;
    }

    /** Freedom, redundant dimensions and the mates a red one fights, at the solution of `accepted`. */
    private analyse(cluster: number[], accepted: Link[], reds: Link[], red: Map<Link, MateStatus>, result: AssemblyResult): void {
        const n = cluster.length * 6;
        const rowsOf = (links: Link[]) => this.jacobian(cluster, links);
        const { J, rows, owner, dims } = rowsOf(accepted);
        // Freedom: the null space of J, seen from each body.
        const A = new Float64Array(n * n);
        for (let r = 0; r < rows; r++) {
            for (let a = 0; a < n; a++) {
                const ja = J[r * n + a];
                if (ja === 0) {
                    continue;
                }
                for (let b = 0; b < n; b++) {
                    A[a * n + b] += ja * J[r * n + b];
                }
            }
        }
        const { values, vectors } = symmetricEigen(A, n);
        const top = Math.max(1, ...values);
        const nullCols: number[] = [];
        values.forEach((v, k) => {
            if (v < 1e-9 * top) {
                nullCols.push(k);
            }
        });
        cluster.forEach((i, k) => {
            const P = new Float64Array(36);
            for (const col of nullCols) {
                for (let a = 0; a < 6; a++) {
                    for (let b = 0; b < 6; b++) {
                        P[a * 6 + b] += vectors[(k * 6 + a) * n + col] * vectors[(k * 6 + b) * n + col];
                    }
                }
            }
            const own = symmetricEigen(P, 6).values;
            result.dof[this.bodies[i].id] = own.filter((v) => v > 1e-6).length;
        });
        // Redundant values: a distance or angle whose value other mates already set.
        const basis = new RowBasis(1e-6);
        const row = (r: number) => J.subarray(r * n, r * n + n);
        for (let r = 0; r < rows; r++) {
            if (!dims[r]) {
                basis.add(row(r));
            }
        }
        for (const link of accepted) {
            const own = [...Array(rows).keys()].filter((r) => owner[r] === link && dims[r]);
            if (own.length === 0) {
                continue;
            }
            if (own.some((r) => !basis.add(row(r)))) {
                result.mates[link.mate.id] = { state: 'warning', reason: 'redundant', message: MESSAGES.redundant };
            }
        }
        // A red mate: over defining when its equations repeat the others', else unsolved; the mates it pulls on.
        const all = new RowBasis(1e-6);
        for (let r = 0; r < rows; r++) {
            all.add(row(r));
        }
        for (const link of reds) {
            const own = this.jacobian(cluster, [link]);
            const repeats = [...Array(own.rows).keys()].some((r) => !all.add(own.J.subarray(r * n, r * n + n), true));
            const saved = this.save(cluster);
            this.lm(cluster, [...accepted, link], 40);
            const fought = accepted.filter((l) => this.rowsOf(l).some((v) => Math.abs(v) > HOLDS));
            this.restore(cluster, saved);
            const names = fought.map((l) => l.mate.name);
            const missed = this.rowsOf(link).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
            const detail = names.length ? ` It conflicts with ${names.join(', ')}.` : '';
            const by = missed > HOLDS ? ` It is not satisfied by ${formatMm(missed)}.` : '';
            red.set(link, repeats || names.length
                ? { state: 'error', reason: 'conflict', message: `${MESSAGES.conflict}${detail}${by}` }
                : { state: 'error', reason: 'unsolved', message: `${MESSAGES.unsolved}${by}` });
            for (const l of fought) {
                if (!result.mates[l.mate.id] || result.mates[l.mate.id].state === 'ok') {
                    result.mates[l.mate.id] = {
                        state: 'warning', reason: 'conflict',
                        message: `Satisfied, but ${link.mate.name} is trying to move the components in a way that would violate this mate.`,
                    };
                }
            }
        }
    }

    /** The Jacobian of some links over the cluster's bodies, with each row's link and whether it carries a value. */
    private jacobian(cluster: number[], links: Link[]): { J: Float64Array; rows: number; owner: Link[]; dims: boolean[] } {
        const n = cluster.length * 6;
        const owner: Link[] = [];
        const dims: boolean[] = [];
        for (const link of links) {
            const out = mateRows(link.mate, this.world(link.sides[0]), this.world(link.sides[1]), this.L);
            const count = out?.rows.length ?? 0;
            for (let r = 0; r < count; r++) {
                owner.push(link);
                dims.push(r >= count - (out?.dims ?? 0));
            }
        }
        const rows = owner.length;
        const J = new Float64Array(rows * n);
        const h = 1e-6;
        const step = new Float64Array(6);
        cluster.forEach((i, k) => {
            const saved = this.bodies[i].T;
            for (let v = 0; v < 6; v++) {
                step.fill(0);
                step[v] = h;
                this.nudge(i, step);
                const plus = links.flatMap((l) => this.rowsOf(l));
                this.bodies[i].T = saved;
                step[v] = -h;
                this.nudge(i, step);
                const minus = links.flatMap((l) => this.rowsOf(l));
                this.bodies[i].T = saved;
                for (let r = 0; r < rows; r++) {
                    J[r * n + k * 6 + v] = (plus[r] - minus[r]) / (2 * h);
                }
            }
        });
        return { J, rows, owner, dims };
    }

    /** Each component's prefix: fixed, not solved, over defined, under defined, or fully defined. */
    private componentStates(result: AssemblyResult): void {
        const states = new Map<number, ComponentState>();
        for (const link of this.links) {
            const status = result.mates[link.mate.id];
            if (!status || status.state === 'ok') {
                continue;
            }
            const state: ComponentState = status.reason === 'unsolved' ? 'unsolved' : 'over';
            for (const s of link.sides) {
                if (s.body >= 0 && states.get(s.body) !== 'unsolved') {
                    states.set(s.body, state);
                }
            }
        }
        this.bodies.forEach((body, i) => {
            if (body.fixed) {
                result.components[body.id] = 'fixed';
                result.dof[body.id] = 0;
                return;
            }
            const marked = states.get(i);
            if (marked) {
                result.components[body.id] = marked;
                return;
            }
            const dof = result.dof[body.id] ?? 6;
            result.dof[body.id] = dof;
            result.components[body.id] = dof > 0 ? 'under' : 'defined';
        });
    }

    /**
     * Moves a component towards a drag's pull within the freedom its mates leave (its cluster follows), keeping the
     * mates. Fixed components do not move. Returns the parts moved, as placements.
     */
    drag(target: DragTarget): Record<string, Placement> {
        const i = this.index.get(target.part);
        if (i === undefined || this.bodies[i].fixed) {
            return {};
        }
        const cluster = this.clusters(this.links).find((c) => c.includes(i)) ?? [i];
        const links = this.links.filter((l) => l.sides.some((s) => cluster.includes(s.body)));
        this.lm(cluster, links, 14, { target, weight: links.length ? PULL : 1 });
        if (links.length) {
            this.lm(cluster, links, 10);
        }
        const out: Record<string, Placement> = {};
        for (const k of cluster) {
            out[this.bodies[k].id] = placementOf(this.bodies[k].T);
        }
        return out;
    }

    /** A part's current placement in the system. */
    placement(part: string): Placement | null {
        const i = this.index.get(part);
        return i === undefined ? null : placementOf(this.bodies[i].T);
    }

    /** Whether a part takes part in any mate the system holds. */
    mated(part: string): boolean {
        const i = this.index.get(part);
        return i !== undefined && this.links.some((l) => l.sides.some((s) => s.body === i));
    }

    /** The largest residual of a mate as the components stand now (mm), or null when it is not set up. */
    offBy(mateId: string): number | null {
        const link = this.links.find((l) => l.mate.id === mateId);
        return link ? this.rowsOf(link).reduce((m, v) => Math.max(m, Math.abs(v)), 0) : null;
    }

    /** One side of a mate in the world as the components stand now. */
    sideOf(mateId: string, k: 0 | 1): Side | null {
        const link = this.links.find((l) => l.mate.id === mateId);
        return link ? this.world(link.sides[k]) : null;
    }
}

const formatMm = (v: number): string => `${Number(v.toPrecision(4))} mm`;

/** Solves an assembly's mates and reports their states: the parts to move and how each mate and component stands. */
export function solveAssembly(parts: readonly Part[], assembly: AssemblyMates | undefined, options: SolveOptions & {
    geometry?: (ref: MateRef) => MateGeom | null;
    extra?: readonly Mate[];
} = {}): AssemblyResult {
    return new MateSystem(parts, assembly, options).solve(options);
}
