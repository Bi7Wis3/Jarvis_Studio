// Block instances as rigid bodies in the solver (SolidWorks: a block moves as one unit; relations to its entities
// drive it). Each instance has a frame: its insertion point and a hidden point along the block's x axis at a fixed
// distance, free to move and turn (Lock angle holds the turn). Every point of the instance keeps its distance from the
// insertion point and its angle from the frame's axis; circles keep their radius. After the solve the frame gives the
// instance's new insertion point and angle. No imports from solver.ts (it imports this module).

import type { SketchPrimitive } from '@salusoft89/planegcs';
import type { SketchBlockInsert, SketchGeometry, SketchPoint } from '@jarvis/core';

const pid = (id: string) => `p:${id}`;

/** One instance, ready for the solver. */
export interface RigidBody {
    insert: SketchBlockInsert;
    /** Solver point ids of the insertion point and the frame's axis point. */
    origin: string;
    axis: string;
    /** Whether the insertion point is a point of the sketch (else a hidden solver point). */
    ownOrigin: boolean;
    /** The instance's points with their block coordinates (scaled). */
    points: { id: string; q: [number, number] }[];
    circles: { id: string; radius: number }[];
    /** Length of the frame's axis. */
    length: number;
}

/** The instances that move as rigid bodies (their block is known and they are built from it). */
export function rigidBodies(g: SketchGeometry): RigidBody[] {
    const out: RigidBody[] = [];
    for (const insert of g.inserts ?? []) {
        const block = g.blocks?.find((b) => b.id === insert.block);
        if (!block) {
            continue;
        }
        const b = block.geometry;
        const extra = insert.points.length - b.points.length;
        if ((extra !== 0 && extra !== 1) || insert.curves.length !== b.curves.length) {
            continue;
        }
        const ownOrigin = !!insert.origin && extra === 1 && g.points.some((p) => p.id === insert.origin);
        const s = insert.scale;
        const points = b.points.map((p, i) => ({ id: insert.points[i], q: [p.u * s, p.v * s] as [number, number] }));
        const reach = Math.max(1, ...points.map((p) => Math.hypot(p.q[0], p.q[1])));
        out.push({
            insert,
            origin: ownOrigin ? pid(insert.origin!) : pid(`${insert.id}.frame-at`),
            axis: pid(`${insert.id}.frame-axis`),
            ownOrigin,
            points,
            circles: b.curves.flatMap((c, i) => (c.kind === 'circle' ? [{ id: insert.curves[i], radius: c.radius * s }] : [])),
            length: reach,
        });
    }
    return out;
}

/** Ids of the points the bodies move (built fixed by their item, solved as part of a body). */
export function rigidPointIds(bodies: RigidBody[]): Set<string> {
    return new Set(bodies.flatMap((b) => [...b.points.map((p) => p.id), ...(b.ownOrigin ? [b.insert.origin!] : [])]));
}

/** Points of each body, by point id (a body's points are defined or free together). */
export function rigidGroups(g: SketchGeometry): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const b of rigidBodies(g)) {
        const ids = [...b.points.map((p) => p.id), ...(b.ownOrigin ? [b.insert.origin!] : [])];
        ids.forEach((id) => out.set(id, ids));
    }
    return out;
}

/** The sketch with the bodies' points free for the solver. */
export function unfixBodies(g: SketchGeometry, bodies: RigidBody[]): SketchGeometry {
    const moving = rigidPointIds(bodies);
    return moving.size ? { ...g, points: g.points.map((p): SketchPoint => (moving.has(p.id) && p.fixed ? { ...p, fixed: false } : p)) } : g;
}

/**
 * The bodies' frames and rigid relations. `start` is the sketch as the solver starts from it (held points fixed):
 * a body whose points are all held is left out (it cannot move).
 */
export function rigidPrimitives(start: SketchGeometry, bodies: RigidBody[]): { primitives: SketchPrimitive[]; active: RigidBody[] } {
    const fixed = new Set(start.points.filter((p) => p.fixed).map((p) => p.id));
    const out: SketchPrimitive[] = [];
    const active: RigidBody[] = [];
    for (const body of bodies) {
        const { insert } = body;
        if (body.points.every((p) => fixed.has(p.id)) && (!body.ownOrigin || fixed.has(insert.origin!))) {
            continue;
        }
        active.push(body);
        const at = body.ownOrigin ? start.points.find((p) => p.id === insert.origin)! : { u: insert.at[0], v: insert.at[1] };
        const turn = (insert.angle * Math.PI) / 180;
        const tag = `blk:${insert.id}`;
        if (!body.ownOrigin) {
            out.push({ id: body.origin, type: 'point', x: at.u, y: at.v, fixed: false });
        }
        out.push(
            { id: body.axis, type: 'point', x: at.u + body.length * Math.cos(turn), y: at.v + body.length * Math.sin(turn), fixed: false },
            { id: `${tag}:axis-length`, type: 'p2p_distance', p1_id: body.origin, p2_id: body.axis, distance: body.length },
        );
        if (insert.lockAngle) {
            out.push(
                { id: `${tag}:axis`, type: 'line', p1_id: body.origin, p2_id: body.axis },
                { id: `${tag}:lock`, type: 'l2l_angle_ll', l1_id: 'axis-u', l2_id: `${tag}:axis`, angle: Math.atan2(Math.sin(turn), Math.cos(turn)) },
            );
        }
        for (const p of body.points) {
            const r = Math.hypot(p.q[0], p.q[1]);
            if (r < 1e-9) {
                out.push({ id: `${tag}:at:${p.id}`, type: 'p2p_coincident', p1_id: pid(p.id), p2_id: body.origin });
                continue;
            }
            out.push(
                { id: `${tag}:r:${p.id}`, type: 'p2p_distance', p1_id: body.origin, p2_id: pid(p.id), distance: r },
                {
                    id: `${tag}:a:${p.id}`, type: 'l2l_angle_pppp', l1p1_id: body.origin, l1p2_id: body.axis, l2p1_id: body.origin, l2p2_id: pid(p.id),
                    angle: Math.atan2(p.q[1], p.q[0]),
                },
            );
        }
        for (const c of body.circles) {
            out.push({ id: `${tag}:radius:${c.id}`, type: 'circle_radius', c_id: `c:${c.id}`, radius: c.radius });
        }
    }
    return { primitives: out, active };
}

/**
 * The instances after the solve: insertion point and angle read off each moved frame. `solved` gives solver point
 * positions by solver id.
 */
export function rigidInserts(g: SketchGeometry, active: RigidBody[], solved: (id: string) => { x: number; y: number } | undefined): SketchBlockInsert[] | undefined {
    if (!active.length || !g.inserts) {
        return g.inserts;
    }
    const byId = new Map(active.map((b) => [b.insert.id, b]));
    return g.inserts.map((insert) => {
        const body = byId.get(insert.id);
        const [o, a] = body ? [solved(body.origin), solved(body.axis)] : [undefined, undefined];
        if (!body || !o || !a) {
            return insert;
        }
        const angle = (Math.atan2(a.y - o.y, a.x - o.x) * 180) / Math.PI;
        // The turn the instance had, kept exactly when the solve did not turn it (and whole turns kept).
        const was = insert.angle;
        const delta = ((angle - was) % 360 + 540) % 360 - 180;
        const moved = Math.abs(o.x - insert.at[0]) > 1e-10 || Math.abs(o.y - insert.at[1]) > 1e-10;
        const turned = Math.abs(delta) > 1e-9;
        return moved || turned ? { ...insert, at: [o.x + 0, o.y + 0], angle: turned ? was + delta : was } : insert;
    });
}
