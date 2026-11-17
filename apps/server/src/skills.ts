// Jarvis's skills: the default ones in the repo (jarvis-plugin, a Claude Code plugin) and the owner's own in the data
// folder (projects/.studio/skills/<name>/SKILL.md), loaded into Jarvis's Claude Code sessions as local plugins and
// filtered by Options > AI assistant > Skills; the part-builder subagent the manage skill hands work to; the list for
// the page (GET /api/ai/skills). No user or project settings are read from disk: the plugins are named explicitly.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentDefinition, SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import type { FastifyInstance } from 'fastify';
import { enabledSkillIds } from '@jarvis/core/settings';
import { PART_BUILDER_PROMPT, skillsGuidance } from './jarvisRules.js';
import { PROJECTS_DIR } from './paths.js';
import type { AiConfig } from './settings.js';
import type { AnyTool } from './tools.js';

/** The default skills, kept in the repo. */
export const DEFAULT_PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'jarvis-plugin');
/** The owner's own skills: the data folder's .studio is their plugin folder, its skills under skills/. */
export const OWN_PLUGIN_DIR = join(PROJECTS_DIR, '.studio');
export const OWN_PLUGIN = 'own';

export const PART_BUILDER = 'part-builder';
/** The skill that delegates to part builders: the Agent tool and the part-builder subagent come with it. */
export const MANAGE_SKILL = 'jarvis:manage';
/** The most rounds a part builder may take on one brief. */
export const PART_BUILDER_MAX_TURNS = 60;

export interface Skill {
    /** plugin:name, as the settings and Claude Code name it. */
    id: string;
    name: string;
    plugin: string;
    description: string;
    /** The instructions after the front matter. */
    body: string;
    source: 'default' | 'own';
}

export interface SkillDirs {
    default: string;
    own: string;
}

const DIRS: SkillDirs = { default: DEFAULT_PLUGIN_DIR, own: OWN_PLUGIN_DIR };

const unquote = (v: string): string => (/^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v);

/** A SKILL.md: its front matter's name and description, and the instructions after it. Null when it has none. */
export function parseSkill(text: string): { name: string; description: string; body: string } | null {
    const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
    if (!match) {
        return null;
    }
    const fields: Record<string, string> = {};
    const lines = match[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const field = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
        if (!field) {
            continue;
        }
        let value = field[2].trim();
        // A folded or literal block (description: >): the indented lines that follow.
        if (/^[>|][+-]?$/.test(value)) {
            const block: string[] = [];
            while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
                block.push(lines[++i].trim());
            }
            value = block.filter(Boolean).join(' ');
        }
        fields[field[1]] = unquote(value);
    }
    const name = fields.name ?? '';
    const description = (fields.description ?? '').trim();
    return { name, description, body: match[2] };
}

const SKILL_NAME = /^[A-Za-z0-9][\w-]{0,63}$/;

/** The name a plugin folder gives itself in .claude-plugin/plugin.json. */
function pluginName(dir: string): string | null {
    try {
        const manifest = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')) as { name?: unknown };
        return typeof manifest.name === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(manifest.name) ? manifest.name : null;
    } catch {
        return null;
    }
}

/** The skills in one plugin folder's skills/<name>/SKILL.md; one without a name or description is left out. */
function skillsIn(dir: string, plugin: string, source: Skill['source']): Skill[] {
    const root = join(dir, 'skills');
    if (!existsSync(root)) {
        return [];
    }
    const out: Skill[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = join(root, entry.name, 'SKILL.md');
        if (!entry.isDirectory() || !existsSync(file)) {
            continue;
        }
        let parsed: ReturnType<typeof parseSkill> = null;
        try {
            parsed = parseSkill(readFileSync(file, 'utf8'));
        } catch {
            continue;
        }
        const name = parsed?.name || entry.name;
        if (!parsed || !SKILL_NAME.test(name) || !parsed.description) {
            console.warn(`[skills] ${source} skill ${entry.name.slice(0, 64)} has no name or description; left out`);
            continue;
        }
        out.push({ id: `${plugin}:${name}`, name, plugin, description: parsed.description.slice(0, 1024), body: parsed.body.slice(0, 40_000), source });
    }
    return out;
}

/** Every skill found: the default ones, then the owner's own. */
export function listSkills(dirs: SkillDirs = DIRS): Skill[] {
    const plugin = pluginName(dirs.default) ?? 'jarvis';
    return [...skillsIn(dirs.default, plugin, 'default'), ...skillsIn(dirs.own, OWN_PLUGIN, 'own')];
}

/**
 * Makes the owner's folder a plugin Claude Code can load (its manifest, named "own"), once it holds a skill. Returns
 * whether it can be loaded.
 */
export function ownPluginReady(dir: string = OWN_PLUGIN_DIR): boolean {
    if (pluginName(dir) === OWN_PLUGIN) {
        return true;
    }
    try {
        mkdirSync(join(dir, '.claude-plugin'), { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, '.claude-plugin', 'plugin.json'),
            `${JSON.stringify({ name: OWN_PLUGIN, description: "The owner's own skills for Jarvis", version: '1.0.0' }, null, 4)}\n`);
        return true;
    } catch {
        console.warn('[skills] the own skills folder could not be made a plugin; its skills are left out');
        return false;
    }
}

/**
 * Tools part builders do not get: whole-project ones (open, save, new, export, import, settings, undo and redo, which
 * would undo another builder's work), the view the user is looking at, and joining or organising parts, which Jarvis
 * keeps for itself.
 */
export const NOT_FOR_BUILDERS = new Set([
    'project_new', 'project_open', 'project_list', 'project_save', 'project_save_as', 'print_settings', 'undo', 'redo',
    'export_stl', 'export_step', 'export_freecad', 'import_file', 'view_set', 'view_screenshot', 'assembly_explode',
    'parts_remove', 'parts_reorder', 'mates_add', 'mates_update', 'mates_remove', 'mates_get', 'mate_folders', 'components_fix',
    'components_move', 'component_folders_add', 'component_folders_rename', 'component_folders_remove', 'component_folders_get',
]);

/** The part-builder subagent: the shared modelling rules, the studio's part tools, the session's Fast model. */
export function partBuilder(config: AiConfig, tools: AnyTool[]): AgentDefinition {
    return {
        description: 'Builds or fixes the parts named in its brief in the open project, with the studio tools, and reports what it made '
            + 'and checked. For the manage skill: one builder per independent piece of a larger job.',
        prompt: PART_BUILDER_PROMPT,
        tools: tools.filter((t) => !NOT_FOR_BUILDERS.has(t.name)).map((t) => `mcp__studio__${t.name}`),
        model: config.fast.model,
        effort: config.fast.effort,
        maxTurns: PART_BUILDER_MAX_TURNS,
    };
}

/** The query options a Claude session takes for the skills that are on (none: exactly as without skills). */
export interface SkillOptions {
    tools: string[];
    allowedTools: string[];
    plugins?: SdkPluginConfig[];
    skills?: string[];
    agents?: Record<string, AgentDefinition>;
}

export function sessionSkillOptions(config: AiConfig, tools: AnyTool[], found: Skill[] = listSkills(), dirs: SkillDirs = DIRS): SkillOptions {
    const on = new Set(enabledSkillIds(found, config.skills));
    const enabled = found.filter((s) => on.has(s.id));
    const own = enabled.some((s) => s.source === 'own') && ownPluginReady(dirs.own);
    const loaded = enabled.filter((s) => s.source === 'default' || own);
    if (loaded.length === 0) {
        return { tools: [], allowedTools: ['mcp__studio'] };
    }
    const manage = loaded.some((s) => s.id === MANAGE_SKILL);
    return {
        tools: ['Skill', ...(manage ? ['Agent'] : [])],
        allowedTools: ['mcp__studio', ...(manage ? ['Agent'] : [])],
        plugins: [
            ...(loaded.some((s) => s.source === 'default') ? [{ type: 'local' as const, path: dirs.default, skipMcpDiscovery: true }] : []),
            ...(own ? [{ type: 'local' as const, path: dirs.own, skipMcpDiscovery: true }] : []),
        ],
        skills: loaded.map((s) => s.id),
        ...(manage ? { agents: { [PART_BUILDER]: partBuilder(config, tools) } } : {}),
    };
}

/** What identifies the skills that are on, to tell whether a running session must start again. */
export function skillsSignature(config: AiConfig, found: Skill[] = listSkills()): string {
    return JSON.stringify(enabledSkillIds(found, config.skills));
}

/** The skills that are on, as guidance in the system prompt of a provider without skills or subagents. */
export function skillsPrompt(config: AiConfig, found: Skill[] = listSkills()): string {
    const on = new Set(enabledSkillIds(found, config.skills));
    return skillsGuidance(found.filter((s) => on.has(s.id)));
}

export interface SkillEntry {
    id: string;
    name: string;
    description: string;
    source: Skill['source'];
}

/** GET /api/ai/skills: every skill found, default and own, for Options > AI assistant. */
export function registerSkillRoutes(app: FastifyInstance, find: () => Skill[] = () => listSkills()): void {
    app.get('/api/ai/skills', async (): Promise<{ skills: SkillEntry[] }> => ({
        skills: find().map(({ id, name, description, source }) => ({ id, name, description, source })),
    }));
}
