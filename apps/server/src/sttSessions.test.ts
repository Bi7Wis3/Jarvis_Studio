import { describe, expect, it } from 'vitest';
import { join, SpeechSessions } from './sttSessions.js';
import type { TranscribeOptions, Transcriber } from './stt.js';

/** A recogniser that "hears" the text written into the audio, after a delay, and remembers how it was asked. */
class FakeEars implements Transcriber {
    calls: { text: string; options: TranscribeOptions }[] = [];
    unavailable = false;
    constructor(private delayMs = 5) {}
    async transcribe(audio: Buffer, options: TranscribeOptions = {}): Promise<string | null> {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        const text = audio.toString('utf8');
        this.calls.push({ text, options });
        return this.unavailable ? null : text;
    }
}

const pcm = (text: string) => Buffer.from(text, 'utf8');

describe('SpeechSessions', () => {
    it('recognises phrases in order, each with the words before it, and answers with the words so far', async () => {
        const ears = new FakeEars();
        const sessions = new SpeechSessions(ears);
        const first = sessions.phrase('s1', 0, pcm('make a box'), false);
        const second = sessions.phrase('s1', 1, pcm('forty by twenty'), false);
        expect(await first).toEqual({ text: 'make a box', final: false });
        expect(await second).toEqual({ text: 'make a box forty by twenty', final: false });
        expect(await sessions.phrase('s1', 2, pcm('and fillet it'), true)).toEqual({ text: 'make a box forty by twenty and fillet it', final: true });
        expect(ears.calls.map((c) => c.options)).toEqual([
            { pcm: true, prompt: '' },
            { pcm: true, prompt: 'make a box' },
            { pcm: true, prompt: 'make a box forty by twenty' },
        ]);
        expect(sessions.size).toBe(0);
    });

    it('puts phrases that arrive out of order back in order', async () => {
        const ears = new FakeEars();
        const sessions = new SpeechSessions(ears);
        const last = sessions.phrase('s', 2, pcm('three'), true);
        const middle = sessions.phrase('s', 1, pcm('two'), false);
        const first = sessions.phrase('s', 0, pcm('one'), false);
        expect((await last)?.text).toBe('one two three');
        expect((await middle)?.text).toBe('one two');
        expect((await first)?.text).toBe('one');
        expect(ears.calls.map((c) => c.text)).toEqual(['one', 'two', 'three']);
    });

    it('takes an empty last phrase (nothing more was said) and keeps sessions apart', async () => {
        const sessions = new SpeechSessions(new FakeEars());
        await sessions.phrase('a', 0, pcm('undo'), false);
        await sessions.phrase('b', 0, pcm('redo'), false);
        expect(await sessions.phrase('a', 1, Buffer.alloc(0), true)).toEqual({ text: 'undo', final: true });
        expect(await sessions.phrase('b', 1, pcm('that'), true)).toEqual({ text: 'redo that', final: true });
    });

    it('answers null when recognition is unavailable', async () => {
        const ears = new FakeEars();
        ears.unavailable = true;
        const sessions = new SpeechSessions(ears);
        expect(await sessions.phrase('s', 0, pcm('hello'), true)).toBeNull();
        // Also when the last phrase was empty (nothing more said).
        await sessions.phrase('t', 0, pcm('hello'), false);
        expect(await sessions.phrase('t', 1, Buffer.alloc(0), true)).toBeNull();
    });

    it('skips a phrase whose request never came, after a while', async () => {
        const sessions = new SpeechSessions(new FakeEars(), { gapMs: 30 });
        expect(await sessions.phrase('s', 1, pcm('second'), true)).toEqual({ text: 'second', final: true });
    });

    it('drops sessions left idle and keeps at most a few', async () => {
        let now = 0;
        const sessions = new SpeechSessions(new FakeEars(), { idleMs: 1000, maxSessions: 2, now: () => now });
        await sessions.phrase('a', 0, pcm('x'), false);
        await sessions.phrase('b', 0, pcm('y'), false);
        await sessions.phrase('c', 0, pcm('z'), false);
        expect(sessions.size).toBe(2);
        now = 5000;
        await sessions.phrase('d', 0, pcm('w'), false);
        expect(sessions.size).toBe(1);
    });
});

describe('join', () => {
    it('joins phrases with single spaces and leaves out empty ones', () => {
        expect(join([' Make a box. ', '', 'And fillet it.'])).toBe('Make a box. And fillet it.');
    });
});
