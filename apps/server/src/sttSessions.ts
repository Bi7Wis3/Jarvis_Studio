// Speech recognised while Talk is held: the browser sends each finished phrase (raw 16 kHz PCM) as soon as the speaker
// pauses, numbered from 0, and the last one when Talk is released. Phrases are recognised in order, each with the words
// before it as context, and joined; every answer carries the words so far, which the prompt bar shows as they arrive.

import type { Transcriber } from './stt.js';

export interface PhraseAnswer {
    /** The phrases heard so far, joined in order. */
    text: string;
    /** This was the last phrase; the session is over. */
    final: boolean;
}

interface Session {
    /** Phrases received and not yet recognised, by number. */
    waiting: Map<number, Buffer>;
    texts: string[];
    /** Number of the next phrase to recognise. */
    next: number;
    /** Number of the last phrase, once it has arrived. */
    last: number | null;
    busy: boolean;
    /** Phrases with audio sent for recognition, and those it answered null for (unavailable). */
    attempted: number;
    unavailable: number;
    /** Callers waiting for their phrase, by number. */
    done: Map<number, Array<() => void>>;
    gapTimer: ReturnType<typeof setTimeout> | null;
    touched: number;
}

export interface SessionOptions {
    /** A session nobody has sent to for this long is dropped. */
    idleMs?: number;
    /** A phrase missing this long while later ones wait is skipped (its request was lost). */
    gapMs?: number;
    /** Most sessions kept at once (one person talks; a few are left over by reloads). */
    maxSessions?: number;
    now?: () => number;
}

export const MAX_PHRASES = 1000;
const PROMPT_CHARS = 300;

export const validSessionId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);

export class SpeechSessions {
    private sessions = new Map<string, Session>();
    private readonly idleMs: number;
    private readonly gapMs: number;
    private readonly maxSessions: number;
    private readonly now: () => number;

    constructor(private readonly ears: Transcriber, options: SessionOptions = {}) {
        this.idleMs = options.idleMs ?? 120_000;
        this.gapMs = options.gapMs ?? 5000;
        this.maxSessions = options.maxSessions ?? 8;
        this.now = options.now ?? Date.now;
    }

    /**
     * Adds phrase `seq` of a session (an empty buffer: nothing more was said) and answers once it has been recognised,
     * with the words so far. Null when recognition was unavailable for every phrase.
     */
    async phrase(id: string, seq: number, audio: Buffer, final: boolean): Promise<PhraseAnswer | null> {
        this.sweep();
        const session = this.session(id);
        session.touched = this.now();
        if (final) {
            session.last = seq;
        }
        if (seq >= session.next && !session.waiting.has(seq)) {
            session.waiting.set(seq, audio);
        }
        const heard = seq < session.next ? Promise.resolve() : new Promise<void>((resolve) => {
            session.done.set(seq, [...(session.done.get(seq) ?? []), resolve]);
        });
        void this.pump(session);
        await heard;
        const isLast = session.last !== null && seq >= session.last;
        if (isLast) {
            this.end(id, session);
        }
        if (session.attempted > 0 && session.unavailable === session.attempted) {
            return null;
        }
        return { text: join(session.texts), final: isLast };
    }

    /** Sessions open now (for tests and the status). */
    get size(): number {
        return this.sessions.size;
    }

    private session(id: string): Session {
        let session = this.sessions.get(id);
        if (!session) {
            if (this.sessions.size >= this.maxSessions) {
                const oldest = [...this.sessions.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
                this.end(oldest[0], oldest[1]);
            }
            session = {
                waiting: new Map(), texts: [], next: 0, last: null, busy: false, attempted: 0, unavailable: 0, done: new Map(), gapTimer: null,
                touched: this.now(),
            };
            this.sessions.set(id, session);
        }
        return session;
    }

    private async pump(session: Session): Promise<void> {
        if (session.busy) {
            return;
        }
        session.busy = true;
        try {
            while (session.waiting.has(session.next)) {
                const audio = session.waiting.get(session.next) as Buffer;
                session.waiting.delete(session.next);
                let text: string | null = '';
                if (audio.length >= 2) {
                    session.attempted++;
                    try {
                        text = await this.ears.transcribe(audio, { pcm: true, prompt: join(session.texts).slice(-PROMPT_CHARS) });
                    } catch (error) {
                        console.error('[ears] a phrase could not be recognised', error);
                        text = '';
                    }
                }
                if (text === null) {
                    session.unavailable++;
                }
                this.settle(session, text ?? '');
            }
        } finally {
            session.busy = false;
        }
        // A phrase is missing while later ones wait: its request was lost, so it is skipped after a while.
        if (session.waiting.size > 0 && !session.gapTimer) {
            session.gapTimer = setTimeout(() => {
                session.gapTimer = null;
                if (!session.waiting.has(session.next) && session.waiting.size > 0) {
                    this.settle(session, '');
                    void this.pump(session);
                }
            }, this.gapMs);
        }
    }

    /** Phrase `next` is done: its text is kept and whoever waits for it is answered. */
    private settle(session: Session, text: string): void {
        session.texts.push(text);
        const seq = session.next++;
        for (const resolve of session.done.get(seq) ?? []) {
            resolve();
        }
        session.done.delete(seq);
    }

    private end(id: string, session: Session): void {
        if (session.gapTimer) {
            clearTimeout(session.gapTimer);
            session.gapTimer = null;
        }
        // Anyone still waiting is answered with what there is.
        for (const waiters of session.done.values()) {
            waiters.forEach((resolve) => resolve());
        }
        session.done.clear();
        if (this.sessions.get(id) === session) {
            this.sessions.delete(id);
        }
    }

    private sweep(): void {
        const now = this.now();
        for (const [id, session] of this.sessions) {
            if (!session.busy && now - session.touched > this.idleMs) {
                this.end(id, session);
            }
        }
    }
}

/** Phrases joined with single spaces, empty ones left out. */
export function join(texts: string[]): string {
    return texts.map((t) => t.trim()).filter(Boolean).join(' ');
}
