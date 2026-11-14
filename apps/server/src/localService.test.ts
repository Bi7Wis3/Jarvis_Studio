import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalService } from './localService.js';

class FakeProcess extends EventEmitter {
    killed = false;
    kill(): boolean {
        this.killed = true;
        this.emit('exit', 0);
        return true;
    }
}

function setup(state: { up: boolean; startsUp?: boolean }) {
    const started: FakeProcess[] = [];
    const service = new LocalService({
        name: 'test',
        up: async () => state.up,
        spawn: () => {
            const child = new FakeProcess();
            started.push(child);
            if (state.startsUp !== false) {
                state.up = true;
            }
            return child as unknown as ChildProcess;
        },
        attempts: 3,
        failed: 'did not start',
        wait: async () => undefined,
    });
    return { service, started };
}

afterEach(() => vi.restoreAllMocks());

describe('LocalService', () => {
    it('uses a service that is already answering instead of starting a second one', async () => {
        const { service, started } = setup({ up: true });
        expect(await service.call(async () => 'heard')).toBe('heard');
        expect(started).toHaveLength(0);
    });

    it('starts the service when nothing answers, and stops it on close', async () => {
        const { service, started } = setup({ up: false });
        expect(await service.call(async () => 'heard')).toBe('heard');
        expect(started).toHaveLength(1);
        service.close();
        expect(started[0].killed).toBe(true);
    });

    it('gives null when the service does not come up', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { service } = setup({ up: false, startsUp: false });
        expect(await service.call(async () => 'heard')).toBeNull();
        expect(warn).toHaveBeenCalledWith('[test] did not start');
    });

    it('starts a service that went away again and repeats the request', async () => {
        const state = { up: true };
        const { service, started } = setup(state);
        let calls = 0;
        const request = async () => {
            calls++;
            if (!state.up) {
                throw new Error('connection refused');
            }
            return 'heard';
        };
        expect(await service.call(request)).toBe('heard');
        state.up = false;
        expect(await service.call(request)).toBe('heard');
        expect(started).toHaveLength(1);
        expect(calls).toBe(3);
    });

    it('does not restart a running service over a failed request', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { service, started } = setup({ up: true });
        expect(await service.call<string>(async () => {
            throw new Error('bad audio');
        })).toBeNull();
        expect(started).toHaveLength(0);
        expect(error).toHaveBeenCalled();
    });
});
