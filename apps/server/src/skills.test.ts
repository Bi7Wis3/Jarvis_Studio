import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// Nothing here may touch the real data folder, and nothing reaches a model: sessions are stand-ins.
const dir = await vi.hoisted(async () => {
    const { mkdtempSync: temp } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const d = temp(path.join(os.tmpdir(), 'jarvis-skills-data-'));
    process.env.JARVIS_PROJECTS_DIR = d;
    process.env.JARVIS_SETTINGS_FILE = path.join(d, '.studio', 'settings.json');
    return d;
});

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_SETTINGS } from '@jarvis/core/settings';
import { Jarvis } from './agent.js';
import { buildersText, Delegation } from './delegation.js';
import { JARVIS_PERSONA, MODELLING_RULES, PART_BUILDER_PROMPT } from './jarvisRules.js';
import type { AiConfig } from './settings.js';
import {
    DEFAULT_PLUGIN_DIR, listSkills, NOT_FOR_BUILDERS, OWN_PLUGIN_DIR, ownPluginReady, parseSkill, PART_BUILDER_MAX_TURNS, registerSkillRoutes,
    sessionSkillOptions, skillsPrompt, type SkillDirs,
} from './skills.js';
import { ProjectStore } from './store.js';
import { createTools } from './tools.js';

const root = mkdtempSync(join(tmpdir(), 'jarvis-skills-test-'));
afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
});
afterEach(() => vi.unstubAllGlobals());

const config = (patch: Partial<AiConfig> = {}): AiConfig => ({ ...DEFAULT_SETTINGS.ai, apiKey: '', ...patch });

/** A made-up own skill in a folder of its own. */
function ownDirs(skills: Record<string, string>): SkillDirs {
    const own = mkdtempSync(join(root, 'own-'));
    for (const [name, text] of Object.entries(skills)) {
        mkdirSync(join(own, 'skills', name), { recursive: true });
        writeFileSync(join(own, 'skills', name, 'SKILL.md'), text);
    }
    return { default: DEFAULT_PLUGIN_DIR, own };
}

const GEARS = '---\nname: gears\ndescription: "Spur gears to a module and tooth count."\n---\nModel the involute with a script shape.\n';

describe('the skill files', () => {
    it('ship a plugin named jarvis with the manage skill, its name and description in place', () => {
        const manifest = JSON.parse(readFileSync(join(DEFAULT_PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8'));
        expect(manifest.name).toBe('jarvis');
        const skills = listSkills({ default: DEFAULT_PLUGIN_DIR, own: join(root, 'none') });
        const manage = skills.find((s) => s.id === 'jarvis:manage');
        expect(manage).toMatchObject({ name: 'manage', plugin: 'jarvis', source: 'default' });
        // When to use it, and when not.
        expect(manage!.description).toMatch(/several independent pieces/);
        expect(manage!.description).toMatch(/Do not use for one part, one feature, a question, a small edit/);
        expect(manage!.body).toMatch(/part-builder/);
        expect(manage!.body).toMatch(/costs more tokens and more time/);
        // Every default skill parses.
        for (const s of skills) {
            expect(s.name).toMatch(/^[\w-]+$/);
            expect(s.description.length).toBeGreaterThan(20);
        }
    });

    it('reads front matter: quoted, folded, or missing', () => {
        expect(parseSkill(GEARS)).toEqual({ name: 'gears', description: 'Spur gears to a module and tooth count.', body: 'Model the involute with a script shape.\n' });
        expect(parseSkill('---\nname: x\ndescription: >\n  first line\n  second line\n---\nBody')).toMatchObject({ description: 'first line second line', body: 'Body' });
        expect(parseSkill('No front matter here.')).toBeNull();
    });

    it("finds the owner's own skills too, and leaves out one without a description", () => {
        const dirs = ownDirs({ gears: GEARS, broken: '---\nname: broken\n---\nNo description.' });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const skills = listSkills(dirs);
        warn.mockRestore();
        expect(skills.map((s) => s.id)).toEqual(['jarvis:manage', 'own:gears']);
        expect(skills[1]).toMatchObject({ source: 'own', description: 'Spur gears to a module and tooth count.' });
    });

    it("makes the owner's folder a plugin named own once it is used", () => {
        const dirs = ownDirs({ gears: GEARS });
        expect(existsSync(join(dirs.own, '.claude-plugin', 'plugin.json'))).toBe(false);
        expect(ownPluginReady(dirs.own)).toBe(true);
        expect(JSON.parse(readFileSync(join(dirs.own, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('own');
        // The owner's folder is the data folder's .studio, outside the repository.
        expect(OWN_PLUGIN_DIR).toBe(join(dir, '.studio'));
    });
});

describe('the session options', () => {
    const tools = createTools(new ProjectStore());

    it('load the skills that are on as plugins, with the part builder for manage', () => {
        const dirs = ownDirs({ gears: GEARS });
        const options = sessionSkillOptions(config({ fast: { model: 'haiku', effort: 'low' } }), tools, listSkills(dirs), dirs);
        expect(options).toMatchObject({
            tools: ['Skill', 'Agent'],
            allowedTools: ['mcp__studio', 'Agent'],
            plugins: [{ type: 'local', path: DEFAULT_PLUGIN_DIR, skipMcpDiscovery: true }, { type: 'local', path: dirs.own, skipMcpDiscovery: true }],
            skills: ['jarvis:manage', 'own:gears'],
        });
        const builder = options.agents!['part-builder'];
        expect(builder).toMatchObject({ model: 'haiku', effort: 'low', maxTurns: PART_BUILDER_MAX_TURNS, prompt: PART_BUILDER_PROMPT });
        expect(builder.tools).toContain('mcp__studio__parts_add');
        expect(builder.tools).toContain('mcp__studio__features_add');
        for (const name of ['project_new', 'project_open', 'undo', 'print_settings', 'view_set', 'parts_remove']) {
            expect(NOT_FOR_BUILDERS.has(name)).toBe(true);
            expect(builder.tools).not.toContain(`mcp__studio__${name}`);
        }
    });

    it('are as before when no skill is on, and leave out the part builder without manage', () => {
        const dirs = ownDirs({ gears: GEARS });
        const found = listSkills(dirs);
        expect(sessionSkillOptions(config({ skills: [] }), tools, found, dirs)).toEqual({ tools: [], allowedTools: ['mcp__studio'] });
        const own = sessionSkillOptions(config({ skills: ['own:gears'] }), tools, found, dirs);
        expect(own).toMatchObject({ tools: ['Skill'], allowedTools: ['mcp__studio'], skills: ['own:gears'], plugins: [{ path: dirs.own }] });
        expect(own.agents).toBeUndefined();
    });

    it('give a provider without skills their text as guidance', () => {
        const text = skillsPrompt(config(), listSkills({ default: DEFAULT_PLUGIN_DIR, own: join(root, 'none') }));
        expect(text).toMatch(/cannot hand work to part builders/);
        expect(text).toMatch(/Skill "manage"/);
        expect(skillsPrompt(config({ skills: [] }))).toBe('');
    });

    it('share the modelling rules between Jarvis and the part builder', () => {
        expect(JARVIS_PERSONA).toContain(MODELLING_RULES);
        expect(PART_BUILDER_PROMPT).toContain(MODELLING_RULES);
        expect(PART_BUILDER_PROMPT).not.toMatch(/Address the user as "sir"/);
    });
});

/** A stand-in for the Agent SDK's query: records its options and answers with these messages once a prompt comes. */
function fakeQuery(seen: Record<string, any>[], messages: unknown[]) {
    return ((params: { prompt: AsyncIterable<unknown>; options: Record<string, any> }) => {
        seen.push(params.options);
        return {
            async *[Symbol.asyncIterator]() {
                for await (const _ of params.prompt) {
                    yield* messages as SDKMessage[];
                    return;
                }
            },
            interrupt: async () => undefined,
            close: () => {},
        };
    }) as never;
}

const start = (id: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', content_block: { type: 'tool_use', id, name: 'Agent' } } });
const inside = (id: string) => ({ type: 'assistant', parent_tool_use_id: id, message: { content: [{ type: 'text', text: 'Building.' }] } });
const back = (...ids: string[]) => ({ type: 'user', parent_tool_use_id: null, message: { content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id })) } });

describe('Jarvis with skills', () => {
    it('starts Claude Code with the plugins, the skills and the part builder, and shows the builders at work', async () => {
        const seen: Record<string, any>[] = [];
        const events: string[] = [];
        const store = new ProjectStore();
        await new Promise<void>((resolve) => {
            const jarvis = new Jarvis(store, createTools(store), {
                status: (status, detail) => void events.push(`status ${status}${detail ? ` ${detail}` : ''}`),
                sentence: () => {}, interrupted: () => {}, model: () => {}, error: (m) => void events.push(`error ${m}`),
                delegating: (turn, n) => void events.push(`delegating ${turn} ${n}`),
                finished: () => resolve(),
            }, () => config(), fakeQuery(seen, [
                start('a'), start('b'), start('c'), inside('a'), inside('b'), back('a'), back('b', 'c'),
                { type: 'result', subtype: 'success', is_error: false, result: 'Done.' },
            ]));
            jarvis.prompt('Build a drone: frame, four arms, a canopy.');
        });
        expect(seen[0]).toMatchObject({
            settingSources: [],
            tools: ['Skill', 'Agent'],
            allowedTools: ['mcp__studio', 'Agent'],
            skills: expect.arrayContaining(['jarvis:manage']),
            plugins: expect.arrayContaining([{ type: 'local', path: DEFAULT_PLUGIN_DIR, skipMcpDiscovery: true }]),
            agents: { 'part-builder': { model: 'sonnet', maxTurns: PART_BUILDER_MAX_TURNS } },
        });
        expect(seen[0].systemPrompt).toBe(JARVIS_PERSONA);
        expect(events.filter((e) => e !== 'status idle')).toEqual([
            'status thinking',
            `status working ${buildersText(1)}`, 'delegating 1 1',
            `status working ${buildersText(2)}`, 'delegating 1 2',
            'status working working with 3 part builders', 'delegating 1 3',
            `status working ${buildersText(2)}`, 'delegating 1 2',
            'status thinking', 'delegating 1 0',
        ]);
    });

    it('counts builders from their own messages when their start was not seen', () => {
        const d = new Delegation();
        expect(d.see(inside('x') as never)).toBe(1);
        expect(d.see(inside('x') as never)).toBeNull();
        expect(d.see({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'y', name: 'Task' }] } } as never)).toBe(2);
        expect(d.see({ type: 'result' } as never)).toBe(0);
    });
});

describe('GET /api/ai/skills', () => {
    it('lists every skill without its instructions', async () => {
        const dirs = ownDirs({ gears: GEARS });
        const app = Fastify();
        registerSkillRoutes(app, () => listSkills(dirs));
        const got = await app.inject({ method: 'GET', url: '/api/ai/skills' });
        expect(got.json()).toEqual({
            skills: [
                { id: 'jarvis:manage', name: 'manage', description: expect.stringMatching(/part builder/), source: 'default' },
                { id: 'own:gears', name: 'gears', description: 'Spur gears to a module and tooth count.', source: 'own' },
            ],
        });
        await app.close();
    });
});
