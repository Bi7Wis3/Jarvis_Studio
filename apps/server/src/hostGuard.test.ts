import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { allowedRequest, guardHost, isLocalName } from './hostGuard.js';

describe('host guard', () => {
    it('knows the names of this machine', () => {
        for (const name of ['localhost', 'LOCALHOST', '127.0.0.1', '[::1]', '::1', 'studio.localhost', 'localhost.']) {
            expect(isLocalName(name), name).toBe(true);
        }
        for (const name of ['evil.example', 'localhost.evil.example', '127.0.0.2.nip.io', '192.168.1.5', '0.0.0.0']) {
            expect(isLocalName(name), name).toBe(false);
        }
    });

    it('answers requests addressed to localhost, from local pages or from no page at all', () => {
        expect(allowedRequest('localhost:4719', 'http://localhost:4719')).toBe(true);
        expect(allowedRequest('127.0.0.1:4720', undefined)).toBe(true);
        expect(allowedRequest('[::1]:4720', 'http://[::1]:4720')).toBe(true);
        expect(allowedRequest('localhost:4720', 'http://127.0.0.1:4719')).toBe(true);
    });

    it('refuses a rebound name, a foreign page, a sandboxed page and a missing Host', () => {
        expect(allowedRequest('evil.example:4720', undefined)).toBe(false);
        expect(allowedRequest('localhost:4720', 'http://evil.example')).toBe(false);
        expect(allowedRequest('localhost:4720', 'null')).toBe(false);
        expect(allowedRequest('localhost:4720', 'file:///home/me/page.html')).toBe(false);
        expect(allowedRequest(undefined, undefined)).toBe(false);
        expect(allowedRequest('', undefined)).toBe(false);
    });

    it('stops refused requests before any route, the MCP endpoint included', async () => {
        const app = Fastify();
        guardHost(app);
        let reached = 0;
        app.post('/mcp', async () => {
            reached++;
            return { ok: true };
        });
        app.get('/api/settings', async () => {
            reached++;
            return { ok: true };
        });
        const local = await app.inject({ method: 'POST', url: '/mcp', headers: { host: 'localhost:4720' }, payload: {} });
        expect(local.statusCode).toBe(200);
        const rebound = await app.inject({ method: 'POST', url: '/mcp', headers: { host: 'attacker.example:4720' }, payload: {} });
        expect(rebound.statusCode).toBe(403);
        const foreign = await app.inject({ method: 'GET', url: '/api/settings', headers: { host: 'localhost:4719', origin: 'https://attacker.example' } });
        expect(foreign.statusCode).toBe(403);
        expect(reached).toBe(1);
        await app.close();
    });
});
