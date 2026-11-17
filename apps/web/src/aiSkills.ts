// Jarvis's skills for Options > AI assistant > Skills: the list the server finds (GET /api/ai/skills), default and own,
// and turning one on or off in the settings (ai.skills; absent: every skill found is on).

import { enabledSkillIds } from '@jarvis/core/settings';

export interface SkillEntry {
    /** plugin:name, as jarvis:manage or own:my-skill. */
    id: string;
    name: string;
    description: string;
    source: 'default' | 'own';
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const http: Fetch = (url) => globalThis.fetch(url);

/** The skills the server finds, or why there are none to show. */
export async function fetchSkills(fetcher: Fetch = http): Promise<{ skills: SkillEntry[] } | { error: string }> {
    try {
        const response = await fetcher('/api/ai/skills');
        const answer = await response.json() as { skills?: unknown };
        if (!response.ok || !Array.isArray(answer?.skills)) {
            return { error: `The server could not list the skills (${response.status}).` };
        }
        return { skills: answer.skills as SkillEntry[] };
    } catch {
        return { error: 'The server is not answering.' };
    }
}

/**
 * The setting after turning one skill on or off: the list of every skill that stays on (from then on, a skill added
 * later starts off until it is turned on here).
 */
export function toggleSkill(setting: string[] | undefined, found: SkillEntry[], id: string, on: boolean): string[] {
    const enabled = enabledSkillIds(found, setting).filter((s) => s !== id);
    // Ids the settings keep for skills not found now (a folder moved away) stay as they were.
    const missing = (setting ?? []).filter((s) => !found.some((f) => f.id === s));
    return [...enabled, ...(on ? [id] : []), ...missing];
}
