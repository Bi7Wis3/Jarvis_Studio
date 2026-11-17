import { beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Part, Project, Vec3 } from '@jarvis/core';
import type { AssemblyMates, MateGeom, MateRef } from '@jarvis/core/mates';
import { applyCall, formPlan } from './mateForm';
import { formTypes, itemLabels, pickMateItem, resetMateForm, sameRef, useMateForm, type MateItem } from './mateState';
import { movesComponentsByDragging, useOptions } from '../options';
import { DragSession } from './dragSession';
import { analyseMates } from './mateAnalysis';
import { componentMateEntries, MatesFolderView, PrefixView } from './MatesTree';

const material = { color: '#888888', metalness: 0, roughness: 1 };
const part = (id: string, position: Vec3 = [0, 0, 0]): Part => ({ id, name: id.toUpperCase(), shape: { kind: 'empty' }, position, rotation: [0, 0, 0], material });
const parts = [part('plate'), part('pin', [12, 40, -3]), part('block', [50, 30, 0])];

const face = (p: string, found: MateGeom, x = 0): MateRef => ({ part: p, pick: { kind: 'face', at: [x, 0, 0] }, found });
const item = (ref: MateRef, box: MateItem['box'] = 'entities'): MateItem => ({ ref, box, exact: true });
const plane = (y: number, ny: number): MateGeom => ({ type: 'plane', origin: [0, y, 0], normal: [0, ny, 0] });
const hole: MateGeom = { type: 'cylinder', point: [10, 0, 0], direction: [0, 1, 0], radius: 3, inside: true };
const shank: MateGeom = { type: 'cylinder', point: [0, 0, 0], direction: [0, 1, 0], radius: 2.9 };

beforeEach(() => {
    resetMateForm();
});

describe('the Mate form', () => {
    it('offers only the mates a pair takes, with the help\'s best guess first', () => {
        const pair = (a: MateRef, b: MateRef) => formTypes({ items: [item(a), item(b)], multiple: false }, parts);
        expect(pair(face('plate', plane(10, 1)), face('pin', plane(5, -1)))).toEqual({
            valid: ['coincident', 'parallel', 'perpendicular', 'lock', 'distance', 'angle'], suggested: 'coincident',
        });
        expect(pair(face('plate', hole), face('pin', shank))).toEqual({
            valid: ['parallel', 'perpendicular', 'tangent', 'concentric', 'lock', 'distance', 'angle'], suggested: 'concentric',
        });
        expect(pair(face('plate', plane(0, 1)), face('pin', shank)).suggested).toBe('tangent');
        expect(pair(face('plate', plane(0, 1)), face('plate', plane(5, 1), 3))).toEqual({ valid: [], suggested: null });
        const origin = (p?: string): MateRef => ({ ...(p ? { part: p } : {}), pick: { kind: 'point', point: 'origin' } });
        expect(pair(origin(), origin('pin')).valid).toEqual(['coincident', 'lock', 'distance']);
    });

    it('makes a concentric mate aligned as the parts stand and sends it without the geometry', () => {
        const form = { ...useMateForm.getState(), open: true, items: [item(face('plate', hole, 1)), item(face('pin', shank, 2))] };
        const plan = formPlan(form, parts, undefined);
        expect(plan.type).toBe('concentric');
        expect(plan.lockRotation).toBe(true);
        expect(plan.mates[0]).toMatchObject({ type: 'concentric', alignment: 'aligned', name: 'Concentric1' });
        const call = applyCall(form, plan, undefined)!;
        expect(call.name).toBe('mates_add');
        expect(call.args).toEqual({
            mates: [{ type: 'concentric', alignment: 'aligned', refs: [{ part: 'plate', pick: { kind: 'face', at: [1, 0, 0] } }, { part: 'pin', pick: { kind: 'face', at: [2, 0, 0] } }] }],
        });
        const positioned = applyCall({ ...form, positionOnly: true }, plan, undefined)!;
        expect(positioned.args.positionOnly).toBe(true);
    });

    it('measures a new distance as the parts stand, and edits a stored mate with mates_update', () => {
        const form = { ...useMateForm.getState(), open: true, type: 'distance' as const, items: [item(face('plate', plane(10, 1))), item(face('block', plane(-5, -1)))] };
        const plan = formPlan(form, parts, undefined);
        expect(plan.mates[0].value).toBeCloseTo(15, 9);
        expect(plan.flip).toBe(true);
        const typed = formPlan({ ...form, value: '2.5' }, parts, undefined);
        expect(typed.mates[0].value).toBe(2.5);
        const assembly: AssemblyMates = { mates: [{ ...typed.mates[0], id: 'mate-7', name: 'Distance4' }] };
        const edit = applyCall({ ...form, value: '4', editing: 'mate-7' }, formPlan({ ...form, value: '4', editing: 'mate-7' }, parts, assembly), assembly)!;
        expect(edit.name).toBe('mates_update');
        expect(edit.args).toMatchObject({ updates: [{ id: 'mate-7', type: 'distance', value: 4, name: 'Distance4' }] });
    });

    it('in multiple mate mode mates each component reference to the common one, in a multi-mate folder', () => {
        const form = {
            ...useMateForm.getState(), open: true, multiple: true, multiFolder: true,
            items: [item(face('plate', plane(10, 1)), 'common'), item(face('pin', plane(5, -1)), 'components'), item(face('block', plane(-5, -1)), 'components')],
        };
        const plan = formPlan(form, parts, undefined);
        expect(plan.mates.map((m) => m.refs.map((r) => r.part))).toEqual([['plate', 'pin'], ['plate', 'block']]);
        expect(applyCall(form, plan, undefined)!.args).toMatchObject({ newFolder: 'MultiMate1' });
    });

    it('takes picks into the selection box, a second pick of the same entity takes it out, a third replaces the second', () => {
        useMateForm.setState({ open: true });
        const top: MateRef = { part: 'plate', pick: { kind: 'plane', plane: 'top' } };
        const front: MateRef = { part: 'pin', pick: { kind: 'plane', plane: 'front' } };
        const right: MateRef = { part: 'block', pick: { kind: 'plane', plane: 'right' } };
        pickMateItem(top);
        pickMateItem(front);
        expect(itemLabels(useMateForm.getState().items, parts)).toEqual(['Top plane@PLATE', 'Front plane@PIN']);
        pickMateItem(right);
        expect(useMateForm.getState().items.map((i) => i.ref.part)).toEqual(['plate', 'block']);
        pickMateItem({ ...top });
        expect(useMateForm.getState().items.map((i) => i.ref.part)).toEqual(['block']);
        expect(sameRef(face('pin', shank, 1), face('pin', hole, 1.0000001))).toBe(true);
        expect(sameRef(face('pin', shank, 1), { ...face('pin', shank, 1), copy: 1 })).toBe(false);
    });
});

describe('the assembly tree', () => {
    it('shows the Mates folder with each mate, red and yellow marks, and the components\' prefixes', () => {
        const mates: AssemblyMates = {
            fixed: ['plate'],
            mates: [
                { id: 'm1', name: 'Concentric1', type: 'concentric', alignment: 'aligned', refs: [face('plate', hole), face('pin', shank)] },
                { id: 'm2', name: 'Coincident1', type: 'coincident', alignment: 'antiAligned', refs: [face('plate', plane(10, 1)), face('block', plane(-5, -1))] },
                { id: 'm3', name: 'Coincident2', type: 'coincident', alignment: 'antiAligned', refs: [face('plate', plane(0, 1)), face('block', plane(-5, -1))] },
                { id: 'm4', name: 'Distance1', type: 'distance', value: 3, refs: [{ part: 'pin', pick: { kind: 'face', at: [0, 0, 0] } }, face('block', plane(0, 1))] },
            ],
            folders: [{ id: 'f1', name: 'Pins', mates: ['m1'] }],
        };
        const analysis = analyseMates(parts, mates);
        const html = renderToStaticMarkup(createElement(MatesFolderView, { parts, assembly: mates, analysis }));
        expect(html).toContain('Mates');
        expect(html).toContain('Pins');
        expect(html).toContain('Coincident1');
        expect(html).toContain('(PLATE, BLOCK)');
        // The second coincident fights the first: red, and the first yellow; the distance has lost its face.
        expect(html).toMatch(/mt-row[^"]* error"[^>]*>.*?Coincident2/);
        expect(html).toMatch(/mt-row[^"]* warning"[^>]*>.*?Coincident1/);
        expect(html).toContain('(?) Distance1');
        const prefix = (id: string) => renderToStaticMarkup(createElement(PrefixView, { state: { state: analysis.components[id], dof: analysis.dof[id] } }));
        expect(prefix('plate')).toContain('(f)');
        expect(prefix('pin')).toContain('(-)');
        expect(prefix('block')).toContain('(+)');
        const menu = componentMateEntries(parts[1], false, true, () => undefined);
        expect(menu.map((m) => (typeof m === 'object' && 'label' in m ? m.label : m))).toEqual(['Fix', 'Mate', 'View mates']);
    });
});

describe('dragging a component', () => {
    const view = { explode: 0, explodeSpacing: null, labels: false, focus: null, autoRotate: false, azimuth: null, elevation: null };
    const assembly: AssemblyMates = {
        mates: [{ id: 'm1', name: 'Concentric1', type: 'concentric', alignment: 'aligned', refs: [face('plate', hole), face('pin', shank)] }],
    };
    const placed = [part('plate'), part('pin', [10, 20, 0]), part('block', [50, 30, 0])];
    const history: Project = { name: 'Drag', parts: placed, view, assembly };

    it('moves only floating components; Esc puts back everything it moved', () => {
        expect(DragSession.start(history, 'plate', 0, [0, 0, 0])).toBeNull();
        const drag = DragSession.start(history, 'pin', 0, [2.9, 0, 0])!;
        drag.pull({ origin: [40, 35, 30], direction: [0, 0, -1] });
        const moved = drag.pull({ origin: [45, 30, 30], direction: [0, 0, -1] });
        expect(Object.keys(moved)).toEqual(['pin']);
        const shown = drag.shown(history);
        const pin = shown.parts.find((p) => p.id === 'pin')!;
        expect(pin.position[0]).toBeCloseTo(10, 6);
        expect(pin.position[2]).toBeCloseTo(0, 6);
        expect(Math.abs(pin.position[1] - 20)).toBeGreaterThan(1);
        expect(drag.restored(shown, history).parts).toEqual(history.parts);
        expect(drag.updates()).toEqual([{ id: 'pin', position: moved.pin.position, rotation: moved.pin.rotation }]);
    });

    it('drags an unmated part freely; nothing moved is nothing to save; a locked part stays; the option turns dragging off', () => {
        const free = DragSession.start(history, 'block', 0, [0, 0, 0])!;
        expect(free.updates()).toBeNull();
        free.pull({ origin: [60, 40, 100], direction: [0, 0, -1] });
        const block = free.shown(history).parts.find((p) => p.id === 'block')!;
        expect(block.position[0]).toBeCloseTo(60, 6);
        expect(block.position[1]).toBeCloseTo(40, 6);
        const locked: Project = {
            ...history,
            assembly: {
                mates: [{
                    id: 'l', name: 'Lock1', type: 'lock', refs: [{ part: 'plate', pick: { kind: 'component' } }, { part: 'block', pick: { kind: 'component' } }],
                    hold: { relative: { position: [50, 30, 0], rotation: [0, 0, 0] } },
                }],
            },
        };
        expect(DragSession.start(locked, 'block', 0, [0, 0, 0])).toBeNull();
        expect(movesComponentsByDragging()).toBe(true);
        const settings = useOptions.getState().settings;
        useOptions.setState({ settings: { ...settings, general: { ...settings.general, moveComponentsByDragging: false } } });
        expect(movesComponentsByDragging()).toBe(false);
        useOptions.setState({ settings });
    });
});
