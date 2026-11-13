import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINT, THREAD_SIZES } from './index';
import type { FastenerType, HoleSpec, PrintSettings } from './index';
import {
    STANDARD_LENGTHS,
    heatsetData,
    holeDimensions,
    nutData,
    screwHead,
    threadData,
    washerData,
} from './fasteners';

const SCREWS: FastenerType[] = ['socketCap', 'buttonHead', 'countersunk', 'hexBolt'];
const NUTS: FastenerType[] = ['hexNut', 'nylocNut', 'squareNut'];
const KINDS: HoleSpec['kind'][] = ['clearance', 'tap', 'heatset', 'counterbore', 'countersink', 'nutTrap'];
const NO_TOL: PrintSettings = { ...DEFAULT_PRINT, holeTolerance: 0 };

describe('fastener tables', () => {
    it('cover every size for every function', () => {
        for (const size of THREAD_SIZES) {
            expect(threadData(size).size).toBe(size);
            for (const type of SCREWS) expect(screwHead(type, size).diameter).toBeGreaterThan(0);
            for (const type of NUTS) expect(nutData(type, size).thickness).toBeGreaterThan(0);
            expect(washerData(size).outer).toBeGreaterThan(0);
            expect(heatsetData(size).length).toBeGreaterThan(0);
            for (const kind of KINDS) expect(holeDimensions({ kind, size }, DEFAULT_PRINT).diameter).toBeGreaterThan(0);
        }
    });

    it('keeps thread dimensions in order', () => {
        for (const size of THREAD_SIZES) {
            const t = threadData(size);
            expect(t.minor).toBeLessThan(t.major);
            expect(t.tapDrill).toBeLessThan(t.major);
            expect(t.major).toBeLessThan(t.clearanceClose);
            expect(t.clearanceClose).toBeLessThan(t.clearanceNormal);
            expect(t.tapDrill).toBeGreaterThanOrEqual(t.minor);
        }
    });

    it('sizes hardware sensibly against the thread', () => {
        for (const size of THREAD_SIZES) {
            const major = threadData(size).major;
            for (const type of NUTS) expect(nutData(type, size).acrossFlats).toBeGreaterThan(major);
            for (const type of SCREWS) expect(screwHead(type, size).diameter).toBeGreaterThan(major);
            expect(washerData(size).inner).toBeGreaterThan(major);
            expect(washerData(size).outer).toBeGreaterThan(washerData(size).inner);
            expect(nutData('nylocNut', size).thickness).toBeGreaterThan(nutData('hexNut', size).thickness);
            const insert = heatsetData(size);
            expect(insert.hole).toBeLessThanOrEqual(insert.outer);
            expect(insert.hole).toBeGreaterThan(major);
        }
    });

    it('matches the standards for M3', () => {
        expect(threadData('M3')).toMatchObject({ pitch: 0.5, major: 3, tapDrill: 2.5, clearanceNormal: 3.4 });
        expect(screwHead('socketCap', 'M3')).toMatchObject({ diameter: 5.5, height: 3, socket: { size: 2.5 } });
        expect(screwHead('countersunk', 'M3').countersinkAngle).toBe(90);
        expect(screwHead('hexBolt', 'M3').acrossFlats).toBe(5.5);
        expect(nutData('hexNut', 'M3')).toEqual({ acrossFlats: 5.5, thickness: 2.4 });
        expect(washerData('M3')).toEqual({ inner: 3.2, outer: 7, thickness: 0.5 });
        expect(heatsetData('M3')).toMatchObject({ outer: 4.6, length: 5.7, hole: 4 });
    });

    it('lists standard lengths in ascending order', () => {
        expect(STANDARD_LENGTHS[0]).toBe(3);
        expect(STANDARD_LENGTHS).toContain(25);
        expect([...STANDARD_LENGTHS].sort((a, b) => a - b)).toEqual(STANDARD_LENGTHS);
    });

    it('throws for the wrong fastener type', () => {
        expect(() => screwHead('hexNut', 'M3')).toThrow(/not a screw/);
        expect(() => screwHead('washer', 'M3')).toThrow();
        expect(() => screwHead('heatsetInsert', 'M3')).toThrow();
        expect(() => nutData('socketCap', 'M3')).toThrow(/not a nut/);
        expect(() => nutData('washer', 'M3')).toThrow();
    });
});

describe('holeDimensions', () => {
    it('applies tolerance to clearance holes and honours fit', () => {
        expect(holeDimensions({ kind: 'clearance', size: 'M3' }, NO_TOL).diameter).toBe(3.4);
        expect(holeDimensions({ kind: 'clearance', size: 'M3' }, DEFAULT_PRINT).diameter).toBe(3.6);
        expect(holeDimensions({ kind: 'clearance', size: 'M3', fit: 'close' }, NO_TOL).diameter).toBe(3.2);
    });

    it('sizes tap and heatset holes', () => {
        expect(holeDimensions({ kind: 'tap', size: 'M3' }, DEFAULT_PRINT).diameter).toBe(2.7);
        expect(holeDimensions({ kind: 'heatset', size: 'M3' }, DEFAULT_PRINT)).toEqual({ diameter: 4.2, depth: 6.2 });
    });

    it('adds a counterbore larger than the socket cap head', () => {
        for (const size of THREAD_SIZES) {
            const cb = holeDimensions({ kind: 'counterbore', size }, NO_TOL).counterbore!;
            const head = screwHead('socketCap', size);
            expect(cb.diameter).toBeGreaterThan(head.diameter);
            expect(cb.depth).toBeGreaterThan(head.height);
        }
        const cb = holeDimensions({ kind: 'counterbore', size: 'M3' }, DEFAULT_PRINT).counterbore!;
        expect(cb.diameter).toBeCloseTo(6.3);
        expect(cb.depth).toBeCloseTo(3.4);
    });

    it('adds a 90 degree countersink and a hex nut trap', () => {
        const cs = holeDimensions({ kind: 'countersink', size: 'M3' }, DEFAULT_PRINT).countersink!;
        expect(cs.angle).toBe(90);
        expect(cs.diameter).toBeCloseTo(6.92);
        const trap = holeDimensions({ kind: 'nutTrap', size: 'M3' }, DEFAULT_PRINT).nutTrap!;
        expect(trap.acrossFlats).toBeCloseTo(5.7);
        expect(trap.depth).toBeCloseTo(2.7);
    });

    it('handles plain holes', () => {
        expect(holeDimensions({ kind: 'plain', diameter: 10 }, DEFAULT_PRINT).diameter).toBe(10.2);
        expect(() => holeDimensions({ kind: 'plain' }, DEFAULT_PRINT)).toThrow(/diameter/);
    });

    it('requires a size for everything except plain', () => {
        for (const kind of KINDS) expect(() => holeDimensions({ kind }, DEFAULT_PRINT)).toThrow(/thread size/);
    });
});
