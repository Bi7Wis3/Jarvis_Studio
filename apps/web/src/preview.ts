// Live previews of tool forms: capturing the tool calls a form would make, and sending them latest-wins.

import type { Part } from '@jarvis/core';

export interface ToolCall {
    name: string;
    args: Record<string, unknown>;
}

/** What the server would make of a form's calls: changed and new parts, their mesh keys and build errors. */
export interface Preview {
    parts: Record<string, Part>;
    keys: Record<string, string>;
    errors: Record<string, string>;
    error: string | null;
}

/** The answer of POST /api/preview. */
export interface PreviewResponse {
    parts: Part[];
    keys: Record<string, string>;
    errors: Record<string, string>;
    /** What the build says about a part's steps, by part (a thread cut to the length of its hole). */
    notes?: Record<string, string[]>;
    error?: string;
}

/** Result runTool gives a captured call: an error, so code that acts "on success" (closing, selecting) does not. */
export const CAPTURED = { text: 'preview', isError: true } as const;

let capturing: ToolCall[] | null = null;

/** While `fn` runs synchronously, tool calls are recorded instead of sent; calls made after it returns are sent. */
export function captureToolCalls<T>(fn: () => T): { result: T; calls: ToolCall[] } {
    const calls: ToolCall[] = [];
    const outer = capturing;
    capturing = calls;
    try {
        return { result: fn(), calls };
    } finally {
        capturing = outer;
    }
}

/** Records a call when capturing; false when it should really be sent. */
export function captureCall(name: string, args: Record<string, unknown>): boolean {
    if (!capturing) {
        return false;
    }
    capturing.push({ name, args });
    return true;
}

/** The preview to show: a part that failed to build keeps its committed look (a new one is left out). */
export function toPreview(response: PreviewResponse): Preview {
    const ok = response.parts.filter((p) => !response.errors[p.id]);
    return {
        parts: Object.fromEntries(ok.map((p) => [p.id, p])),
        keys: Object.fromEntries(ok.flatMap((p) => (response.keys[p.id] ? [[p.id, response.keys[p.id]]] : []))),
        errors: response.errors,
        error: response.error ?? null,
    };
}

/**
 * Sends inputs one at a time and only reports the answer to the newest: at most one request is in flight; while
 * it runs, only the newest input is kept and sent when it returns. `cancel` drops the pending input and the
 * answer in flight; `close` stops for good.
 */
export class LatestOnly<I, R> {
    private seq = 0;
    private running = false;
    private pending: { input: I } | null = null;
    private closed = false;

    constructor(private send: (input: I) => Promise<R>, private done: (result: R, input: I) => void,
        private failed: (error: unknown) => void = () => undefined) {}

    push(input: I): void {
        if (this.closed) {
            return;
        }
        this.seq++;
        if (this.running) {
            this.pending = { input };
        } else {
            this.start(input);
        }
    }

    cancel(): void {
        this.seq++;
        this.pending = null;
    }

    close(): void {
        this.cancel();
        this.closed = true;
    }

    get busy(): boolean {
        return this.running;
    }

    private start(input: I): void {
        const seq = this.seq;
        this.running = true;
        const finish = () => {
            this.running = false;
            const next = this.pending;
            this.pending = null;
            if (next && !this.closed) {
                this.start(next.input);
            }
        };
        let request: Promise<R>;
        try {
            request = this.send(input);
        } catch (error) {
            request = Promise.reject(error);
        }
        request.then(
            (result) => {
                if (seq === this.seq && !this.closed) {
                    this.done(result, input);
                }
                finish();
            },
            (error: unknown) => {
                if (seq === this.seq && !this.closed) {
                    this.failed(error);
                }
                finish();
            },
        );
    }
}

/** Asks the server what the calls would do. */
export async function fetchPreview(calls: ToolCall[]): Promise<PreviewResponse> {
    const response = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ calls }),
    });
    const body = await response.json() as PreviewResponse & { error?: string };
    if (!response.ok) {
        throw new Error(body.error ?? `Preview failed (${response.status}).`);
    }
    return body;
}
