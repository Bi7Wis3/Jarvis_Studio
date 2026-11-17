// The microphone's samples made into what the speech server takes: 16 kHz mono 16-bit PCM, cut into phrases where the
// speaker pauses, so each phrase is recognised while the next is spoken. Pure, so it is tested without a browser.

export const SAMPLE_RATE = 16000;
/** Analysis frames of 20 ms. */
export const FRAME = 320;

export interface ChunkOptions {
    /** A pause this long ends a phrase. */
    pauseMs: number;
    /** Kept before the first loud frame of a phrase and after its last, so soft word edges are not cut. */
    padMs: number;
    /** Less loud sound than this is not a phrase (a click or a breath). */
    minSpeechMs: number;
    /** A phrase is cut at its quietest point once it grows this long without a pause. */
    maxPhraseMs: number;
    /** Frames this much louder than the background (RMS ratio) are speech... */
    ratio: number;
    /** ...and never quieter than this RMS level (full scale is 1). */
    floor: number;
}

export const CHUNK_DEFAULTS: ChunkOptions = { pauseMs: 350, padMs: 200, minSpeechMs: 150, maxPhraseMs: 20000, ratio: 3, floor: 0.004 };

/** Background level: the quietest frame of the last 1.5 s, which during speech is a gap between words. */
const NOISE_FRAMES = 75;
/**
 * For the first half second there is no background level yet (speech may start at once), so only the floor counts;
 * a phrase begun then is checked again against the background known when it ends.
 */
const WARM_UP_FRAMES = 25;

/** Resamples to 16 kHz from any rate, a block at a time: each output sample is the mean of the input it covers. */
export class Resampler {
    private readonly step: number;
    private carry: number[] = [];
    private pos = 0;

    constructor(readonly inputRate: number, readonly outputRate = SAMPLE_RATE) {
        this.step = inputRate / outputRate;
    }

    push(input: Float32Array): Float32Array {
        if (this.step === 1) {
            return input.slice();
        }
        const data = this.carry.length ? Float32Array.from([...this.carry, ...input]) : input;
        const out: number[] = [];
        if (this.step > 1) {
            // Averaging over the span an output sample covers keeps sound above 8 kHz from folding into the speech.
            while (this.pos + this.step <= data.length) {
                const from = Math.floor(this.pos);
                const to = Math.floor(this.pos + this.step);
                let sum = 0;
                for (let i = from; i < to; i++) {
                    sum += data[i];
                }
                out.push(sum / Math.max(1, to - from));
                this.pos += this.step;
            }
        } else {
            while (this.pos + 1 < data.length) {
                const i = Math.floor(this.pos);
                const t = this.pos - i;
                out.push(data[i] * (1 - t) + data[i + 1] * t);
                this.pos += this.step;
            }
        }
        const used = Math.floor(this.pos);
        this.carry = Array.from(data.subarray(used));
        this.pos -= used;
        return Float32Array.from(out);
    }
}

/** Float samples to 16-bit little-endian PCM. */
export function toPcm16(samples: Float32Array): Int16Array<ArrayBuffer> {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        out[i] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
    }
    return out;
}

const frames = (millis: number) => Math.max(1, Math.round((millis / 1000) * SAMPLE_RATE / FRAME));

/**
 * Cuts 16 kHz samples into phrases at pauses. push() gives back each phrase as soon as the pause after it is long
 * enough; finish() gives what is left when Talk is released.
 */
export class PhraseChunker {
    private readonly o: ChunkOptions;
    /** Samples not yet given out; the first is sample `offset` of the recording. */
    private buffer: number[] = [];
    private offset = 0;
    private partial: number[] = [];
    private frameCount = 0;
    private recent: number[] = [];
    /** First and last loud frame of the phrase being spoken (-1: none), and the levels of its frames. */
    private speechStart = -1;
    private speechEnd = -1;
    private speechFrames = 0;
    private levels: number[] = [];
    /** Phrases given out so far. */
    sent = 0;

    constructor(options: Partial<ChunkOptions> = {}) {
        this.o = { ...CHUNK_DEFAULTS, ...options };
    }

    push(samples: Float32Array): Float32Array[] {
        const phrases: Float32Array[] = [];
        for (let i = 0; i < samples.length; i++) {
            this.buffer.push(samples[i]);
            this.partial.push(samples[i]);
            if (this.partial.length === FRAME) {
                const phrase = this.frame(this.partial);
                this.partial = [];
                if (phrase) {
                    phrases.push(phrase);
                }
            }
        }
        return phrases;
    }

    /**
     * What is left when Talk is released: the phrase being spoken, or null when nothing more was said. When no phrase
     * was found at all the whole recording is given (a quiet microphone), so the recogniser decides.
     */
    finish(): Float32Array | null {
        if (this.speechStart >= 0 && this.speechFrames >= frames(this.o.minSpeechMs) && this.strongEnough()) {
            return this.take(this.phraseFrom(), this.offset + this.buffer.length);
        }
        if (this.sent === 0 && this.buffer.length > 0) {
            return this.take(this.offset, this.offset + this.buffer.length);
        }
        return null;
    }

    private frame(frame: number[]): Float32Array | null {
        let sum = 0;
        for (const s of frame) {
            sum += s * s;
        }
        const level = Math.sqrt(sum / frame.length);
        const index = this.frameCount++;
        this.recent.push(level);
        if (this.recent.length > NOISE_FRAMES) {
            this.recent.shift();
        }
        const loud = level > this.threshold();
        if (loud && this.speechStart < 0) {
            this.speechStart = index;
            this.speechFrames = 0;
            this.levels = [];
        }
        if (this.speechStart < 0) {
            // Nothing is being said: only the padding before a phrase needs keeping.
            this.trim((index + 1 - frames(this.o.padMs)) * FRAME);
            return null;
        }
        this.levels.push(level);
        if (loud) {
            this.speechEnd = index;
            this.speechFrames++;
        }
        if (index - this.speechEnd >= frames(this.o.pauseMs)) {
            if (this.speechFrames < frames(this.o.minSpeechMs) || !this.strongEnough()) {
                // Too short to be speech, or only background: forgotten.
                this.speechStart = -1;
                this.trim((index + 1 - frames(this.o.padMs)) * FRAME);
                return null;
            }
            return this.cut((this.speechEnd + 1 + frames(this.o.padMs)) * FRAME);
        }
        if (this.levels.length >= frames(this.o.maxPhraseMs)) {
            return this.forcedCut();
        }
        return null;
    }

    private threshold(): number {
        return this.recent.length < WARM_UP_FRAMES ? this.o.floor : Math.max(this.o.floor, Math.min(...this.recent) * this.o.ratio);
    }

    /** The phrase is louder than the background as it is known now for long enough to be speech. */
    private strongEnough(): boolean {
        const threshold = this.threshold();
        return this.levels.filter((level) => level > threshold).length >= frames(this.o.minSpeechMs);
    }

    /**
     * A phrase gone on too long without a pause is cut after the quietest frame of its last third; what follows is the
     * start of the next phrase.
     */
    private forcedCut(): Float32Array {
        const span = Math.max(1, Math.floor(this.levels.length / 3));
        let best = this.levels.length - 1;
        for (let f = this.levels.length - span; f < this.levels.length; f++) {
            if (this.levels[f] < this.levels[best]) {
                best = f;
            }
        }
        const phrase = this.take(this.phraseFrom(), (this.speechStart + best + 1) * FRAME);
        const threshold = this.threshold();
        this.levels = this.levels.slice(best + 1);
        this.speechStart += best + 1;
        this.speechFrames = this.levels.filter((level) => level > threshold).length;
        return phrase;
    }

    private phraseFrom(): number {
        return Math.max(this.offset, (this.speechStart - frames(this.o.padMs)) * FRAME);
    }

    /** Gives out the phrase from its padding to `end`; what follows stays for the next one. */
    private cut(end: number): Float32Array {
        const phrase = this.take(this.phraseFrom(), Math.min(end, this.offset + this.buffer.length));
        this.speechStart = -1;
        this.speechEnd = -1;
        this.speechFrames = 0;
        this.levels = [];
        return phrase;
    }

    private take(from: number, to: number): Float32Array {
        const phrase = Float32Array.from(this.buffer.slice(from - this.offset, to - this.offset));
        this.trim(to);
        this.sent++;
        return phrase;
    }

    /** Drops the samples before sample `at` of the recording. */
    private trim(at: number): void {
        const drop = Math.min(this.buffer.length, at - this.offset);
        if (drop > 0) {
            this.buffer.splice(0, drop);
            this.offset += drop;
        }
    }
}
