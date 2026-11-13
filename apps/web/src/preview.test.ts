import { describe, expect, it } from 'vitest';
import { CAPTURED, captureCall, captureToolCalls, LatestOnly, toPreview } from './preview';

/** A stand-in for runTool: records what it really sent. */
function makeRunTool(sent: string[]) {
    return (name: string, args: Record<string, unknown> = {}) => {
        if (captureCall(name, args)) {
            return Promise.resolve({ ...CAPTURED });
        }
        sent.push(name);
        return Promise.resolve({ text: 'ok', isError: false });
    };
}

describe('captureToolCalls', () => {
    it('captures the synchronous calls with an error result and sends nothing', async () => {
        const sent: string[] = [];
        const runTool = makeRunTool(sent);
        const { result, calls } = captureToolCalls(() => runTool('parts_update', { updates: [{ id: 'a' }] }));
        expect(calls).toEqual([{ name: 'parts_update', args: { updates: [{ id: 'a' }] } }]);
        expect(await result).toEqual({ text: 'preview', isError: true });
        expect(sent).toEqual([]);
    });

    it('captures calls made before the first await of an async apply, and sends those made after', async () => {
        const sent: string[] = [];
        const runTool = makeRunTool(sent);
        const apply = async () => {
            const first = await runTool('features_add');
            return first.isError ? first : runTool('never');
        };
        const later = async () => {
            await Promise.resolve();
            return runTool('later');
        };
        const { calls, result } = captureToolCalls(() => Promise.all([apply(), later()]));
        expect(calls.map((c) => c.name)).toEqual(['features_add']);
        await result;
        expect(sent).toEqual(['later']);
    });

    it('stops capturing when the function throws', () => {
        const sent: string[] = [];
        const runTool = makeRunTool(sent);
        expect(() => captureToolCalls(() => {
            throw new Error('bad');
        })).toThrow('bad');
        void runTool('parts_add');
        expect(sent).toEqual(['parts_add']);
    });
});

describe('LatestOnly', () => {
    function setup() {
        const requests: { input: number; resolve: (r: string) => void }[] = [];
        const done: [string, number][] = [];
        const queue = new LatestOnly<number, string>(
            (input) => new Promise((resolve) => requests.push({ input, resolve })),
            (result, input) => done.push([result, input]),
        );
        return { requests, done, queue };
    }
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('keeps one request in flight and sends only the newest input after it', async () => {
        const { requests, done, queue } = setup();
        queue.push(1);
        queue.push(2);
        queue.push(3);
        expect(requests.map((r) => r.input)).toEqual([1]);
        requests[0].resolve('one');
        await tick();
        // The answer for 1 is stale: 3 is newer.
        expect(done).toEqual([]);
        expect(requests.map((r) => r.input)).toEqual([1, 3]);
        requests[1].resolve('three');
        await tick();
        expect(done).toEqual([['three', 3]]);
    });

    it('drops the answer in flight on cancel, and everything after close', async () => {
        const { requests, done, queue } = setup();
        queue.push(1);
        queue.cancel();
        requests[0].resolve('one');
        await tick();
        expect(done).toEqual([]);
        queue.push(2);
        queue.close();
        queue.push(3);
        requests[1].resolve('two');
        await tick();
        expect(done).toEqual([]);
        expect(requests.map((r) => r.input)).toEqual([1, 2]);
    });
});

describe('toPreview', () => {
    it('leaves out parts that failed to build', () => {
        const part = (id: string) => ({ id, name: id, shape: { kind: 'box', size: [1, 1, 1] }, position: [0, 0, 0], rotation: [0, 0, 0],
            material: { color: '#fff', metalness: 0, roughness: 1 } }) as never;
        const preview = toPreview({ parts: [part('a'), part('b')], keys: { a: 'ka', b: 'kb' }, errors: { b: 'fillet failed' } });
        expect(Object.keys(preview.parts)).toEqual(['a']);
        expect(preview.keys).toEqual({ a: 'ka' });
        expect(preview.errors).toEqual({ b: 'fillet failed' });
        expect(preview.error).toBeNull();
    });
});
