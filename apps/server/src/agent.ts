import { createSdkMcpServer, query, tool, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentStatus, ImageAttachment } from '@jarvis/core';
import { compatibleModels, type Effort } from '@jarvis/core/settings';
import { compatibleSession, compatibleSetup, type CompatibleSetup } from './agentOpenAI.js';
import { buildersText, Delegation, isAgentTool } from './delegation.js';
import { JARVIS_PERSONA as PERSONA } from './jarvisRules.js';
import { PROJECTS_DIR } from './paths.js';
import { serverDefaults, type AiConfig } from './settings.js';
import type { ProjectStore } from './store.js';
import { sessionSkillOptions, skillsPrompt, skillsSignature } from './skills.js';
import { callTool, sceneDigest, type AnyTool } from './tools.js';

export interface JarvisEvents {
    status: (status: AgentStatus, detail?: string) => void;
    sentence: (turn: number, text: string) => void;
    interrupted: (turn: number) => void;
    finished: (turn: number, ok: boolean) => void;
    model: (model: string) => void;
    error: (message: string) => void;
    /** How many part builders (subagents) work on the turn now; 0 when the last is done. */
    delegating?: (turn: number, builders: number) => void;
}

/**
 * fast and best: the two model choices of Options > AI assistant (by default Sonnet at medium effort, and Opus at high
 * effort, slower and heavier on plan limits but much better at design).
 */
export type Quality = 'fast' | 'best';

export type SessionSetup = { model: string; effort: Effort; env?: Record<string, string | undefined> } | CompatibleSetup | { error: string };

/** What Jarvis needs of a running session: Claude Code's, or the OpenAI-compatible loop's (agentOpenAI.ts). */
type Session = { interrupt(): Promise<unknown>; close(): void } & AsyncIterable<SDKMessage>;

/**
 * Model, effort and environment of the Claude Code session for these settings. With an API key the session gets it as
 * ANTHROPIC_API_KEY (and no other Anthropic credential, so the key is what it uses); with the local login the session
 * inherits the server's environment, as it always has.
 */
export function sessionSetup(config: AiConfig, quality: Quality, env: NodeJS.ProcessEnv = process.env): SessionSetup {
    if (config.provider === 'openai-compatible') {
        return compatibleSetup(config, quality);
    }
    const { model, effort } = config[quality];
    if (config.auth !== 'apiKey') {
        return { model, effort };
    }
    if (!config.apiKey) {
        return { error: 'No API key is set. Add one in Options, AI assistant, or choose the Claude Code login there.' };
    }
    const { ANTHROPIC_AUTH_TOKEN: _token, CLAUDE_CODE_OAUTH_TOKEN: _oauth, ANTHROPIC_API_KEY: _key, ...rest } = env;
    return { model, effort, env: { ...rest, ANTHROPIC_API_KEY: config.apiKey } };
}

/** What a running session was started with, to tell whether new settings need a new session. */
function signature(setup: SessionSetup): string {
    return 'error' in setup ? 'error' : 'provider' in setup ? JSON.stringify([setup.preset, setup.baseUrl, setup.model, setup.apiKey])
        : JSON.stringify([setup.model, setup.effort, setup.env?.ANTHROPIC_API_KEY ?? null]);
}

const ENV_CONFIG: AiConfig = { ...serverDefaults().ai, apiKey: '' };

/** Async queue feeding user turns to one long-lived Claude Code session. */
class Inbox implements AsyncIterable<SDKUserMessage> {
    private items: SDKUserMessage[] = [];
    private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;

    push(text: string, images: ImageAttachment[] = []): void {
        const content = images.length === 0 ? text : [
            ...images.map((image) => ({
                type: 'image' as const,
                source: { type: 'base64' as const, media_type: image.mimeType, data: image.data },
            })),
            { type: 'text' as const, text },
        ];
        const message: SDKUserMessage = {
            type: 'user',
            message: { role: 'user', content },
            parent_tool_use_id: null,
        };
        if (this.waiting) {
            this.waiting({ value: message, done: false });
            this.waiting = null;
        } else {
            this.items.push(message);
        }
    }

    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
        return {
            next: () => {
                const item = this.items.shift();
                if (item) {
                    return Promise.resolve({ value: item, done: false });
                }
                return new Promise((resolve) => {
                    this.waiting = resolve;
                });
            },
        };
    }
}

/** The assistant: local Claude Code driven through the Agent SDK, limited to the studio tools. */
export class Jarvis {
    private session: Session | null = null;
    private inbox = new Inbox();
    private nextTurn = 1;
    private pending: number[] = [];
    private cancelled = new Set<number>();
    private buffer = '';
    private quality: Quality = process.env.JARVIS_QUALITY === 'best' ? 'best' : 'fast';
    private delegation = new Delegation();

    /** The settings the running session was started with, and whether they have changed since. */
    private started = '';
    private stale = false;

    constructor(
        private store: ProjectStore,
        private tools: AnyTool[],
        private events: JarvisEvents,
        /** Options > AI assistant, read afresh for every new session. */
        private config: () => AiConfig = () => ENV_CONFIG,
        /** The Agent SDK's query (a stand-in in tests). */
        private run: typeof query = query,
    ) {}

    /** What the session for the current settings is made with: model, effort, credentials and the skills that are on. */
    private sign(): string {
        const config = this.config();
        return `${signature(sessionSetup(config, this.quality))}|${skillsSignature(config)}`;
    }

    getQuality(): Quality {
        return this.quality;
    }

    /** The model the next request goes to. */
    getModel(): string {
        const config = this.config();
        return config.provider === 'openai-compatible' ? compatibleModels(config.compatible)[this.quality] : config[this.quality].model;
    }

    /**
     * The AI settings changed: a running session made with other settings is closed (the conversation starts afresh at
     * the next request, the project is unaffected), so the new model, effort or credentials apply without a restart.
     */
    reconfigure(): void {
        if (this.session && this.sign() !== this.started) {
            // A turn in progress is left to finish; the next request starts the new session.
            if (this.pending.length === 0) {
                this.restart();
            } else {
                this.stale = true;
            }
        }
        this.events.model(this.getModel());
    }

    /** Switches model and effort. The conversation starts afresh; the project is unaffected. */
    setQuality(quality: Quality): void {
        if (quality === this.quality) {
            return;
        }
        this.quality = quality;
        this.restart();
        this.events.model(this.getModel());
    }

    private restart(): void {
        this.stale = false;
        this.stop();
        const session = this.session;
        this.session = null;
        this.pending = [];
        session?.close();
    }

    isCancelled(turn: number): boolean {
        return this.cancelled.has(turn);
    }

    /** Sends a request to Jarvis and returns its turn number. */
    prompt(text: string, images: ImageAttachment[] = []): number {
        this.stop();
        if (this.stale) {
            this.restart();
        }
        const turn = this.nextTurn++;
        if (!this.session) {
            const setup = sessionSetup(this.config(), this.quality);
            if ('error' in setup) {
                // After the caller has logged the turn, so the activity list shows it as failed.
                queueMicrotask(() => {
                    this.events.error(setup.error);
                    this.events.finished(turn, false);
                });
                return turn;
            }
            this.start(setup);
        }
        this.pending.push(turn);
        const note = images.length ? `\n(The user attached ${images.length} picture(s) above: use them as the reference.)` : '';
        this.inbox.push(`[${sceneDigest(this.store.get())}]\n${text}${note}`, images);
        this.events.status('thinking');
        return turn;
    }

    /** Cancels the turn in progress, if any. */
    stop(): void {
        if (this.pending.length === 0) {
            return;
        }
        for (const turn of this.pending) {
            this.cancelled.add(turn);
            this.events.interrupted(turn);
        }
        this.buffer = '';
        this.session?.interrupt().catch(() => undefined);
        this.events.status('idle');
    }

    private start(setup: Exclude<SessionSetup, { error: string }>): void {
        this.started = this.sign();
        this.inbox = new Inbox();
        this.delegation = new Delegation();
        if ('provider' in setup) {
            // No skills or subagents there: the skills that are on come as guidance in the system prompt.
            const systemPrompt = [PERSONA, skillsPrompt(this.config())].filter(Boolean).join('\n\n');
            const session = compatibleSession({
                prompt: this.inbox, setup, systemPrompt, tools: this.tools, notice: (text) => this.events.error(text),
            });
            this.session = session;
            void this.consume(session);
            return;
        }
        const server = createSdkMcpServer({
            name: 'studio',
            version: '0.1.0',
            tools: this.tools.map((t) => tool(t.name, t.description, t.schema, (args) => callTool(t, args), {
                alwaysLoad: true,
            })),
        });
        const session = this.run({
            prompt: this.inbox,
            options: {
                systemPrompt: PERSONA,
                model: setup.model,
                effort: setup.effort,
                ...(setup.env ? { env: setup.env } : {}),
                mcpServers: { studio: server },
                // The skills that are on (plugins named here, nothing read from user or project settings), and with
                // manage the part-builder subagent.
                ...sessionSkillOptions(this.config(), this.tools),
                permissionMode: 'dontAsk',
                settingSources: [],
                persistSession: false,
                includePartialMessages: true,
                cwd: PROJECTS_DIR,
            },
        });
        this.session = session;
        void this.consume(session);
    }

    private async consume(session: Session): Promise<void> {
        try {
            for await (const message of session) {
                const builders = this.delegation.see(message);
                if (builders !== null && message.type !== 'result') {
                    this.events.status(builders ? 'working' : 'thinking', builders ? buildersText(builders) : undefined);
                    if (this.pending[0] !== undefined) {
                        this.events.delegating?.(this.pending[0], builders);
                    }
                }
                if (message.type === 'system' && message.subtype === 'init') {
                    this.events.model(message.model);
                } else if (message.type === 'stream_event' && !message.parent_tool_use_id) {
                    this.onStreamEvent(message.event);
                } else if (message.type === 'result') {
                    this.flush();
                    const turn = this.pending.shift();
                    if (message.subtype !== 'success' && turn !== undefined && !this.cancelled.has(turn)) {
                        this.events.error(`Jarvis stopped: ${message.errors?.length ? message.errors.join('; ') : message.subtype}`);
                    }
                    if (turn !== undefined && !this.cancelled.has(turn)) {
                        this.events.finished(turn, message.subtype === 'success');
                    }
                    if (this.pending.length === 0) {
                        this.events.status('idle');
                    }
                }
            }
        } catch (e) {
            this.events.error(`Jarvis session failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (this.session === session) {
            this.session = null;
            this.pending = [];
            this.events.status('idle');
        }
    }

    private onStreamEvent(event: any): void {
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            this.flush();
            // A part builder's start is shown by the delegation count instead.
            if (!isAgentTool(event.content_block.name)) {
                this.events.status('working', String(event.content_block.name).replace('mcp__studio__', ''));
            }
        } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            this.buffer += event.delta.text;
            this.emitSentences();
        } else if (event.type === 'content_block_stop') {
            this.flush();
        }
    }

    private emitSentences(): void {
        for (;;) {
            const match = /[.!?]["')\]]?\s+/.exec(this.buffer);
            if (!match) {
                return;
            }
            const end = match.index + match[0].length;
            this.say(this.buffer.slice(0, end));
            this.buffer = this.buffer.slice(end);
        }
    }

    private flush(): void {
        this.say(this.buffer);
        this.buffer = '';
    }

    private say(raw: string): void {
        const text = raw.replace(/[*_`#]/g, '').trim();
        const turn = this.pending[0];
        if (text && turn !== undefined && !this.cancelled.has(turn)) {
            this.events.sentence(turn, text);
        }
    }
}
