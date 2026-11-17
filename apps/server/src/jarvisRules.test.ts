import { describe, expect, it } from 'vitest';
import { JARVIS_PERSONA, MCP_INSTRUCTIONS, MODELLING_RULES, UNITS } from './jarvisRules.js';

describe('MCP instructions', () => {
    it('give outside clients the units and the modelling rules Jarvis has, without its spoken manner', () => {
        expect(MCP_INSTRUCTIONS).toContain(UNITS);
        expect(MCP_INSTRUCTIONS).toContain(MODELLING_RULES);
        expect(MCP_INSTRUCTIONS).toMatch(/cad_check/);
        expect(JARVIS_PERSONA).toMatch(/sir/);
        expect(MCP_INSTRUCTIONS).not.toMatch(/\bsir\b|spoken aloud|scene digest/);
    });
});
