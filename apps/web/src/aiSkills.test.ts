import { describe, expect, it } from 'vitest';
import { fetchSkills, toggleSkill, type SkillEntry } from './aiSkills';

const found: SkillEntry[] = [
    { id: 'jarvis:manage', name: 'manage', description: 'Split a large job', source: 'default' },
    { id: 'own:gears', name: 'gears', description: 'Spur gears', source: 'own' },
];

describe('turning skills on and off', () => {
    it('starts from every skill on, then keeps the list of those left on', () => {
        expect(toggleSkill(undefined, found, 'jarvis:manage', false)).toEqual(['own:gears']);
        expect(toggleSkill(['own:gears'], found, 'jarvis:manage', true)).toEqual(['own:gears', 'jarvis:manage']);
        expect(toggleSkill([], found, 'own:gears', true)).toEqual(['own:gears']);
        // A skill the settings name but that is not found now stays named.
        expect(toggleSkill(['own:gone', 'own:gears'], found, 'own:gears', false)).toEqual(['own:gone']);
    });

    it('lists the skills from the server, or says why not', async () => {
        expect(await fetchSkills(async () => ({ ok: true, status: 200, json: async () => ({ skills: found }) }))).toEqual({ skills: found });
        expect(await fetchSkills(async () => ({ ok: false, status: 500, json: async () => ({}) }))).toEqual({ error: 'The server could not list the skills (500).' });
        expect(await fetchSkills(async () => {
            throw new Error('offline');
        })).toEqual({ error: 'The server is not answering.' });
    });
});
