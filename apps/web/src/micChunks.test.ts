import { describe, expect, it } from 'vitest';
import { FRAME, PhraseChunker, Resampler, SAMPLE_RATE, toPcm16 } from './micChunks';

const rate = SAMPLE_RATE;
const silence = (ms: number, level = 0.0005) => Float32Array.from({ length: Math.round((ms / 1000) * rate) }, (_, i) => level * Math.sin(i * 1.7));
const tone = (ms: number, amp = 0.2) => Float32Array.from({ length: Math.round((ms / 1000) * rate) }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / rate));
const concat = (...parts: Float32Array[]) => {
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
};
const loudSamples = (x: Float32Array) => x.filter((s) => Math.abs(s) > 0.05).length;

/** Feeds the recording in blocks, as the worklet posts it. */
function feed(chunker: PhraseChunker, audio: Float32Array, block = 1024): Float32Array[] {
    const out: Float32Array[] = [];
    for (let at = 0; at < audio.length; at += block) {
        out.push(...chunker.push(audio.subarray(at, at + block)));
    }
    return out;
}

describe('PhraseChunker', () => {
    it('gives out a phrase as soon as a pause follows it, with padding, and the last one on release', () => {
        const chunker = new PhraseChunker();
        const first = feed(chunker, concat(silence(500), tone(800), silence(450)));
        expect(first).toHaveLength(1);
        // All the speech, a little before and after it, and not the whole leading silence.
        expect(loudSamples(first[0])).toBe(loudSamples(tone(800)));
        expect(first[0].length / rate).toBeGreaterThan(0.95);
        expect(first[0].length / rate).toBeLessThan(1.3);

        expect(feed(chunker, concat(tone(600), silence(100)))).toHaveLength(0);
        const last = chunker.finish();
        expect(last).not.toBeNull();
        expect(loudSamples(last as Float32Array)).toBe(loudSamples(tone(600)));
        expect(chunker.sent).toBe(2);
    });

    it('keeps a short pause between words inside one phrase', () => {
        const chunker = new PhraseChunker();
        expect(feed(chunker, concat(tone(400), silence(200), tone(400), silence(150)))).toHaveLength(0);
        const all = chunker.finish() as Float32Array;
        expect(loudSamples(all)).toBe(2 * loudSamples(tone(400)));
    });

    it('cuts three phrases spoken with pauses, in order, and loses no speech', () => {
        const chunker = new PhraseChunker();
        const parts = [tone(700, 0.1), tone(500, 0.3), tone(900, 0.2)];
        const phrases = feed(chunker, concat(silence(300), parts[0], silence(600), parts[1], silence(600), parts[2], silence(200)));
        const last = chunker.finish();
        const all = [...phrases, last as Float32Array];
        expect(all).toHaveLength(3);
        all.forEach((phrase, i) => expect(loudSamples(phrase)).toBe(loudSamples(parts[i])));
    });

    it('ignores clicks and gives nothing more after the last phrase when only silence follows', () => {
        const chunker = new PhraseChunker();
        expect(feed(chunker, concat(silence(300), tone(40), silence(600)))).toHaveLength(0);
        expect(feed(chunker, concat(tone(500), silence(600)))).toHaveLength(1);
        expect(feed(chunker, silence(800))).toHaveLength(0);
        expect(chunker.finish()).toBeNull();
    });

    it('sends the whole recording when it never heard speech, so the recogniser decides', () => {
        const chunker = new PhraseChunker();
        feed(chunker, silence(700));
        const all = chunker.finish() as Float32Array;
        // Only the padding is kept while nothing is said, so that is what goes.
        expect(all.length).toBeGreaterThan(0);
        expect(all.length).toBeLessThanOrEqual(0.2 * rate + FRAME);
    });

    it('follows a louder background instead of taking it for speech', () => {
        const noisy = (ms: number) => silence(ms, 0.01);
        const chunker = new PhraseChunker();
        const phrases = feed(chunker, concat(noisy(1500), tone(600, 0.3), noisy(600), tone(600, 0.3), noisy(100)));
        expect(phrases).toHaveLength(1);
        expect(chunker.finish()).not.toBeNull();
    });

    it('cuts a phrase that goes on without a pause at its quietest point', () => {
        const chunker = new PhraseChunker({ maxPhraseMs: 3000 });
        // Speech with dips (quieter, not silent) every 700 ms: never a pause.
        const speech = concat(...Array.from({ length: 8 }, () => concat(tone(600, 0.3), tone(100, 0.03))));
        const phrases = feed(chunker, speech);
        expect(phrases.length).toBeGreaterThanOrEqual(1);
        for (const phrase of phrases) {
            expect(phrase.length / rate).toBeLessThanOrEqual(3.3);
        }
        const rest = chunker.finish() as Float32Array;
        const total = [...phrases, rest].reduce((n, p) => n + p.length, 0);
        expect(total).toBe(speech.length);
    });
});

describe('Resampler', () => {
    it('makes 48 kHz into 16 kHz block by block without losing or adding samples', () => {
        const r = new Resampler(48000);
        const input = Float32Array.from({ length: 48000 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 48000));
        let n = 0;
        for (let at = 0; at < input.length; at += 128) {
            n += r.push(input.subarray(at, at + 128)).length;
        }
        expect(n).toBe(16000);
    });

    it('handles rates that are not a whole multiple (44.1 kHz) and keeps a tone\'s level', () => {
        const r = new Resampler(44100);
        const input = Float32Array.from({ length: 44100 }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 300 * i) / 44100));
        const out: number[] = [];
        for (let at = 0; at < input.length; at += 1000) {
            out.push(...r.push(input.subarray(at, at + 1000)));
        }
        expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(1);
        const rms = Math.sqrt(out.reduce((s, x) => s + x * x, 0) / out.length);
        expect(rms).toBeCloseTo(0.5 / Math.SQRT2, 1);
    });

    it('passes 16 kHz through and raises lower rates', () => {
        expect(new Resampler(16000).push(Float32Array.of(0.1, 0.2))).toEqual(Float32Array.of(0.1, 0.2));
        const up = new Resampler(8000).push(Float32Array.from({ length: 800 }, () => 0.25));
        expect(up.length).toBeGreaterThanOrEqual(1597);
        expect(up.every((x) => Math.abs(x - 0.25) < 1e-6)).toBe(true);
    });
});

describe('toPcm16', () => {
    it('scales to 16-bit and clips', () => {
        expect(Array.from(toPcm16(Float32Array.of(0, 1, -1, 2, -2, 0.5)))).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
    });
});
