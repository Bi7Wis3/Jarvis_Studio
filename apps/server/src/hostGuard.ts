// Every request must be addressed to this machine. The server listens on 127.0.0.1 only, but a web page elsewhere could
// still reach it through DNS rebinding (its own name made to point at 127.0.0.1) and use the studio's API and MCP
// tools: so the Host header must name localhost, and a browser's Origin, when sent, must be a local page too.

import type { FastifyInstance } from 'fastify';

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '::1']);

/** Whether a host name is this machine: localhost, a name under .localhost, 127.0.0.1 or ::1. */
export function isLocalName(hostname: string): boolean {
    const name = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    return LOCAL_NAMES.has(name) || name.endsWith('.localhost');
}

/** The host name of a Host header ("localhost:4719", "[::1]:4720"), or null when it cannot be read. */
export function hostOfHeader(header: string | undefined): string | null {
    if (!header) {
        return null;
    }
    try {
        return new URL(`http://${header}`).hostname;
    } catch {
        return null;
    }
}

/** Whether a request with these headers may be answered. */
export function allowedRequest(host: string | undefined, origin: string | undefined): boolean {
    const name = hostOfHeader(host);
    if (!name || !isLocalName(name)) {
        return false;
    }
    if (origin === undefined) {
        return true; // not from a browser page: an MCP client, a script, the server itself
    }
    try {
        const url = new URL(origin);
        return (url.protocol === 'http:' || url.protocol === 'https:') && isLocalName(url.hostname);
    } catch {
        return false; // "null" (a sandboxed page or a file) and anything unreadable
    }
}

/** Refuses every request not addressed to this machine, before any route sees it. */
export function guardHost(app: FastifyInstance): void {
    app.addHook('onRequest', async (request, reply) => {
        if (!allowedRequest(request.headers.host, request.headers.origin)) {
            await reply.code(403).send({ error: 'Jarvis Studio only answers requests addressed to this computer (localhost).' });
        }
    });
}
