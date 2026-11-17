import { describe, expect, it } from 'vitest';
import { applyPatch, DEFAULT_SETTINGS, normaliseSettings, resetCategory } from './settings';
import { DEFAULT_SPEECH, normaliseSpeech, sameRuntime, speechRuntime } from './speechSettings';

describe('speech settings', () => {
    it('loads a settings file from before speech settings unchanged, with the speech defaults', () => {
        const old = { general: { confirmDelete: false }, display: { bloom: false } };
        const s = normaliseSettings(old);
        expect(s.speech).toEqual(DEFAULT_SPEECH);
        expect(s.general.confirmDelete).toBe(false);
        expect(s.display.bloom).toBe(false);
        expect(DEFAULT_SETTINGS.speech).toEqual(DEFAULT_SPEECH);
    });

    it('keeps valid choices and puts unknown engines, models and devices back to the defaults', () => {
        expect(normaliseSpeech({ engine: 'whisper', whisperModel: 'small.en', moonshineModel: 'tiny', device: 'gpu' }))
            .toEqual({ engine: 'whisper', whisperModel: 'small.en', moonshineModel: 'tiny', device: 'gpu' });
        expect(normaliseSpeech({ engine: 'siri', whisperModel: 'large-v9', moonshineModel: '../../x', device: 'tpu' })).toEqual(DEFAULT_SPEECH);
        // A Moonshine model name is not a Whisper model.
        expect(normaliseSpeech({ whisperModel: 'base' }).whisperModel).toBe(DEFAULT_SPEECH.whisperModel);
        expect(normaliseSpeech('nonsense')).toEqual(DEFAULT_SPEECH);
    });

    it('is saved as a category of its own, patched and reset like the others', () => {
        const patched = applyPatch(DEFAULT_SETTINGS, { speech: { device: 'cpu' } });
        expect(patched.speech).toEqual({ ...DEFAULT_SPEECH, device: 'cpu' });
        expect(patched.ai).toEqual(DEFAULT_SETTINGS.ai);
        expect(resetCategory(patched, 'speech').speech).toEqual(DEFAULT_SPEECH);
    });

    it("gives the runtime of the chosen engine, which changes only with engine, that engine's model or device", () => {
        const a = speechRuntime({ ...DEFAULT_SPEECH, engine: 'moonshine', moonshineModel: 'tiny' });
        expect(a).toEqual({ engine: 'moonshine', model: 'tiny', device: DEFAULT_SPEECH.device });
        expect(sameRuntime(a, speechRuntime({ ...DEFAULT_SPEECH, engine: 'moonshine', moonshineModel: 'tiny', whisperModel: 'small.en' }))).toBe(true);
        expect(sameRuntime(a, speechRuntime({ ...DEFAULT_SPEECH, engine: 'whisper' }))).toBe(false);
        expect(sameRuntime(a, { ...a, device: 'cpu' })).toBe(false);
    });
});
