import { rmSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Nothing here may touch the real data folder, and nothing reaches a real service: every request goes to a stub.
const dir = await vi.hoisted(async () => {
    const { mkdtempSync } = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const d = mkdtempSync(path.join(os.tmpdir(), 'jarvis-openai-test-'));
    process.env.JARVIS_PROJECTS_DIR = d;
    process.env.JARVIS_SETTINGS_FILE = path.join(d, '.studio', 'settings.json');
    return d;
});

import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { DEFAULT_SETTINGS } from '@jarvis/core/settings';
import { Jarvis, sessionSetup } from './agent.js';
import {
    compatibleModelList, compatibleSession, compatibleSetup, errorDetail, plainError, portableSchema, toolDefinitions, type ChatMessage,
    type CompatibleSetup, type Fetcher,
} from './agentOpenAI.js';
import { compatibleTarget, ModelLists } from './aiModels.js';
import { testAi } from './aiTest.js';
import { createHostTools } from './hostTools.js';
import { jarvisFileTools } from './jarvisFileRoutes.js';
import { mateTools } from './mates.js';
import type { AiConfig } from './settings.js';
import { ProjectStore } from './store.js';
import { createTools, type AnyTool, type HostTool } from './tools.js';

afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

// Obvious fakes, never real keys.
const KEY = 'sk-FAKE-openai-compatible-test-key-0000';

const SETUP: CompatibleSetup = {
    provider: 'openai-compatible', preset: 'openai', name: 'OpenAI', baseUrl: 'https://api.example.test/v1', apiKey: KEY, model: 'gpt-test', local: false,
};

const config = (patch: Partial<AiConfig> = {}): AiConfig => ({
    ...DEFAULT_SETTINGS.ai,
    provider: 'openai-compatible',
    compatible: { preset: 'openai', baseUrl: '', models: { openai: { fast: 'gpt-fast', best: 'gpt-best' } } },
    apiKey: '',
    compatibleKeys: { openai: KEY },
    ...patch,
});

const encoder = new TextEncoder();

/** A streamed Chat Completions answer: one data line per chunk, then [DONE]. */
function sse(chunks: unknown[], split = false): Response {
    const lines = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'];
    // Split mid-line too, as a network does.
    const pieces = split ? lines.join('').match(/[\s\S]{1,17}/g) ?? [] : lines;
    return new Response(new ReadableStream({
        start(controller) {
            for (const piece of pieces) {
                controller.enqueue(encoder.encode(piece));
            }
            controller.close();
        },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const text = (content: string) => ({ choices: [{ index: 0, delta: { content } }] });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Sent {
    url: string;
    headers: Record<string, string>;
    body: { model: string; messages: ChatMessage[]; tools?: { function: { name: string; parameters: Record<string, unknown> } }[]; stream?: boolean };
}

/** A stub service: answers each request with the next of `answers`, and records what it was sent. */
function stub(answers: ((sent: Sent) => Response | Promise<Response>)[]) {
    const sent: Sent[] = [];
    const fetcher: Fetcher = async (url, init) => {
        const request: Sent = { url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
        sent.push(request);
        const answer = answers.shift();
        if (!answer) {
            throw new Error('No more answers');
        }
        return answer(request);
    };
    return { fetcher, sent };
}

/** User turns fed one by one, like agent.ts's inbox. */
function inbox() {
    const queue: SDKUserMessage[] = [];
    let wake: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
    return {
        push(text: string, images: { data: string; mimeType: string }[] = []) {
            const content = images.length === 0 ? text : [
                ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } })),
                { type: 'text', text },
            ];
            const message = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } as SDKUserMessage;
            if (wake) {
                wake({ value: message, done: false });
                wake = null;
            } else {
                queue.push(message);
            }
        },
        stream: {
            [Symbol.asyncIterator]: () => ({
                next: () => (queue.length ? Promise.resolve({ value: queue.shift()!, done: false as const })
                    : new Promise<IteratorResult<SDKUserMessage>>((resolve) => void (wake = resolve))),
            }),
        },
    };
}

type Seen = { type: string; subtype?: string; is_error?: boolean; result?: string; errors?: string[]; model?: string; event?: Record<string, any> };

/** Reads a session's messages up to and including the next result. */
async function untilResult(iterator: AsyncIterator<SDKMessage>): Promise<Seen[]> {
    const out: Seen[] = [];
    for (;;) {
        const next = await iterator.next();
        if (next.done) {
            return out;
        }
        out.push(next.value as unknown as Seen);
        if ((next.value as { type: string }).type === 'result') {
            return out;
        }
    }
}

const said = (messages: Seen[]) => messages.filter((m) => m.event?.delta?.type === 'text_delta').map((m) => m.event!.delta.text).join('');

const steel = { color: '#c9d1d9', metalness: 1, roughness: 0.3 };
const BLOCK = { parts: [{ name: 'Test block', shape: { kind: 'box', size: [10, 10, 10] }, position: [0, 0, 0], material: steel }] };

/** A host tool that answers with a picture, like view_screenshot. */
const camera: HostTool = {
    name: 'view_screenshot',
    description: 'A picture of the view',
    schema: {},
    run: async () => ({ text: 'Current viewport:', image: { data: 'QUJD', mimeType: 'image/jpeg' } }),
};

describe('the studio tools as functions', () => {
    it('turns every tool schema into portable JSON Schema', () => {
        const store = new ProjectStore();
        const tools: AnyTool[] = [
            ...createTools(store),
            ...createHostTools(store, { capture: async () => Buffer.alloc(0), download: () => {}, meshes: {} as never, kernel: {} as never }),
            ...mateTools(store, {} as never),
            ...jarvisFileTools(store, {}),
        ];
        const definitions = toolDefinitions(tools);
        expect(definitions.length).toBe(tools.length);
        for (const d of definitions) {
            expect(d.function.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
            expect(d.function.parameters.type).toBe('object');
            const text = JSON.stringify(d.function.parameters);
            expect(text).not.toContain('$schema');
            expect(text).not.toContain('prefixItems');
            expect(text).not.toContain('"const"');
            // No tuple form left: items is always one schema.
            const walk = (v: unknown): void => {
                if (Array.isArray(v)) {
                    v.forEach(walk);
                } else if (v && typeof v === 'object') {
                    const o = v as Record<string, unknown>;
                    expect(Array.isArray(o.items)).toBe(false);
                    Object.values(o).forEach(walk);
                }
            };
            walk(d.function.parameters);
        }
        const parts = definitions.find((d) => d.function.name === 'parts_add')!.function.parameters;
        expect(parts.required).toContain('parts');
    });

    it('makes tuples plain arrays with a length, and const a one-value enum', () => {
        const schema = z.toJSONSchema(z.object({ at: z.tuple([z.number(), z.number(), z.number()]), kind: z.literal('box') }), { target: 'draft-07' });
        expect(portableSchema(schema)).toMatchObject({
            properties: { at: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }, kind: { enum: ['box'] } },
        });
    });
});

describe('the loop', () => {
    it('runs the real tool handler, sends its result back and streams the final text', async () => {
        const store = new ProjectStore();
        const tools = createTools(store);
        const { fetcher, sent } = stub([
            () => sse([
                text('Right away, sir. '),
                { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'parts_add', arguments: '{"parts":' } }] } }] },
                { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(BLOCK.parts) + '}' } }] } }] },
                { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            ], true),
            () => sse([text('The block is in place.'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]),
        ]);
        const input = inbox();
        const session = compatibleSession({ prompt: input.stream, setup: SETUP, systemPrompt: 'You are Jarvis.', tools, fetch: fetcher });
        const iterator = session[Symbol.asyncIterator]();
        input.push('Add a block.');
        const messages = await untilResult(iterator);
        expect(messages[0]).toMatchObject({ type: 'system', subtype: 'init', model: 'gpt-test' });
        expect(said(messages)).toBe('Right away, sir. The block is in place.');
        expect(messages.some((m) => m.event?.type === 'content_block_start' && m.event.content_block.name === 'parts_add')).toBe(true);
        expect(messages[messages.length - 1]).toMatchObject({ type: 'result', subtype: 'success', result: 'The block is in place.' });
        // The handler really ran.
        expect(store.get().parts.map((p) => p.name)).toContain('Test block');
        // The request: the key as a bearer token, streamed, the same tools; then the tool's answer sent back.
        expect(sent[0].url).toBe('https://api.example.test/v1/chat/completions');
        expect(sent[0].headers.authorization).toBe(`Bearer ${KEY}`);
        expect(sent[0].body).toMatchObject({ model: 'gpt-test', stream: true });
        expect(sent[0].body.messages[0]).toEqual({ role: 'system', content: 'You are Jarvis.' });
        expect(sent[0].body.tools?.map((t) => t.function.name)).toEqual(tools.map((t) => t.name));
        const second = sent[1].body.messages;
        expect(second[2]).toMatchObject({ role: 'assistant', content: 'Right away, sir. ', tool_calls: [{ id: 'call_1', function: { name: 'parts_add' } }] });
        expect(second[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
        expect((second[3] as { content: string }).content).not.toMatch(/^Failed/);
        session.close();
    });

    it('keeps the conversation for the next turn', async () => {
        const { fetcher, sent } = stub([() => sse([text('One.')]), () => sse([text('Two.')])]);
        const input = inbox();
        const session = compatibleSession({ prompt: input.stream, setup: SETUP, systemPrompt: 'S', tools: [], fetch: fetcher });
        const iterator = session[Symbol.asyncIterator]();
        input.push('First');
        await untilResult(iterator);
        input.push('Second');
        await untilResult(iterator);
        expect(sent[1].body.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
        expect(sent[1].body.tools).toBeUndefined();
        session.close();
    });

    it('tells the model when its arguments do not fit, and names an unknown tool', async () => {
        const store = new ProjectStore();
        const { fetcher, sent } = stub([
            () => sse([{ choices: [{ index: 0, delta: { tool_calls: [
                { index: 0, id: 'a', function: { name: 'parts_add', arguments: '{"parts": 3}' } },
                { index: 1, id: 'b', function: { name: 'no_such_tool', arguments: '{}' } },
                { index: 2, id: 'c', function: { name: 'parts_add', arguments: '{not json' } },
            ] } }] }]),
            () => sse([text('Sorry.')]),
        ]);
        const input = inbox();
        const session = compatibleSession({ prompt: input.stream, setup: SETUP, systemPrompt: 'S', tools: createTools(store), fetch: fetcher });
        const iterator = session[Symbol.asyncIterator]();
        input.push('Go');
        await untilResult(iterator);
        const answers = sent[1].body.messages.filter((m) => m.role === 'tool') as { content: string }[];
        expect(answers[0].content).toMatch(/do not fit the tool/);
        expect(answers[1].content).toMatch(/no tool called no_such_tool/);
        expect(answers[2].content).toMatch(/not valid JSON/);
        session.close();
    });

    it('sends a tool picture as a user message right after the tool answer', async () => {
        const { fetcher, sent } = stub([
            () => sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'shot', function: { name: 'view_screenshot', arguments: '' } }] } }] }]),
            () => sse([text('Looks right.')]),
        ]);
        const input = inbox();
        const session = compatibleSession({ prompt: input.stream, setup: SETUP, systemPrompt: 'S', tools: [camera], fetch: fetcher });
        const iterator = session[Symbol.asyncIterator]();
        input.push('Look');
        await untilResult(iterator);
        const messages = sent[1].body.messages;
        expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'shot', content: 'Current viewport:' });
        expect(messages[4]).toMatchObject({
            role: 'user',
            content: [{ type: 'text' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }],
        });
        session.close();
    });

    it('leaves pictures out, with a note, for a model that refuses them', async () => {
        const refuses = (sent: Sent) => (JSON.stringify(sent.body).includes('image_url')
            ? json(400, { error: { message: 'Image input is not supported for this model' } }) : null);
        const notices: string[] = [];
        const { fetcher, sent } = stub([
            () => sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'shot', function: { name: 'view_screenshot', arguments: '{}' } }] } }] }]),
            (s) => refuses(s) ?? sse([text('x')]),
            (s) => refuses(s) ?? sse([text('Done without it.')]),
            (s) => refuses(s) ?? sse([text('Still fine.')]),
        ]);
        const input = inbox();
        const session = compatibleSession({
            prompt: input.stream, setup: SETUP, systemPrompt: 'S', tools: [camera], fetch: fetcher, notice: (t) => void notices.push(t),
        });
        const iterator = session[Symbol.asyncIterator]();
        input.push('Look');
        const first = await untilResult(iterator);
        expect(first[first.length - 1]).toMatchObject({ subtype: 'success', result: 'Done without it.' });
        expect(notices).toEqual([expect.stringMatching(/does not take pictures/)]);
        expect(JSON.stringify(sent[2].body)).not.toContain('image_url');
        expect(JSON.stringify(sent[2].body)).toContain('does not take pictures');
        // An attached picture later is left out at once.
        input.push('And this one', [{ data: 'WFla', mimeType: 'image/png' }]);
        const second = await untilResult(iterator);
        expect(second[second.length - 1]).toMatchObject({ subtype: 'success' });
        expect(JSON.stringify(sent[3].body)).not.toContain('image_url');
        expect(sent).toHaveLength(4);
        session.close();
    });

    it('stops at once when interrupted, and takes the next turn', async () => {
        let started: () => void = () => {};
        const waiting = new Promise<void>((resolve) => void (started = resolve));
        const { fetcher } = stub([
            (sent) => {
                started();
                return new Response(new ReadableStream({
                    start(controller) {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(text('Thinking about it'))}\n\n`));
                        // Then nothing more: the user presses Esc.
                    },
                }), { headers: { 'content-type': 'text/event-stream' } });
            },
            () => sse([text('Next.')]),
        ]);
        const input = inbox();
        const session = compatibleSession({ prompt: input.stream, setup: SETUP, systemPrompt: 'S', tools: [], fetch: fetcher });
        const iterator = session[Symbol.asyncIterator]();
        input.push('Long job');
        const reading = untilResult(iterator);
        await waiting;
        await new Promise((resolve) => setTimeout(resolve, 10));
        await session.interrupt();
        const stopped = await reading;
        expect(stopped[stopped.length - 1]).toMatchObject({ type: 'result', subtype: 'error_during_execution', errors: ['interrupted'] });
        input.push('Again');
        const next = await untilResult(iterator);
        expect(next[next.length - 1]).toMatchObject({ subtype: 'success', result: 'Next.' });
        session.close();
    });

    it('stops after the round limit', async () => {
        const call = () => sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'view_screenshot', arguments: '{}' } }] } }] }]);
        const { fetcher } = stub([call, call, call]);
        const input = inbox();
        const session = compatibleSession({ prompt: input.stream, setup: SETUP, systemPrompt: 'S', tools: [camera], fetch: fetcher, maxRounds: 2 });
        const iterator = session[Symbol.asyncIterator]();
        input.push('Loop forever');
        const messages = await untilResult(iterator);
        expect(messages[messages.length - 1]).toMatchObject({ type: 'result', subtype: 'error_max_turns', errors: [expect.stringMatching(/2 rounds/)] });
        session.close();
    });

    it('takes an answer that comes whole instead of streamed', async () => {
        const { fetcher } = stub([
            () => json(200, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'view_screenshot', arguments: '{}' } }] } }] }),
            () => json(200, { choices: [{ message: { role: 'assistant', content: 'All done.' } }] }),
        ]);
        const input = inbox();
        const session = compatibleSession({ prompt: input.stream, setup: SETUP, systemPrompt: 'S', tools: [camera], fetch: fetcher });
        const iterator = session[Symbol.asyncIterator]();
        input.push('Go');
        const messages = await untilResult(iterator);
        expect(said(messages)).toBe('All done.');
        session.close();
    });
});

describe('errors in plain words', () => {
    const run = async (answer: () => Response | Promise<Response>, setup: CompatibleSetup = SETUP) => {
        const { fetcher } = stub([answer]);
        const input = inbox();
        const session = compatibleSession({ prompt: input.stream, setup, systemPrompt: 'S', tools: [camera], fetch: fetcher });
        const iterator = session[Symbol.asyncIterator]();
        input.push('Hi');
        const messages = await untilResult(iterator);
        session.close();
        return messages[messages.length - 1].errors?.join(' ') ?? '';
    };

    it('says what went wrong and what to do, never with the key', async () => {
        expect(await run(() => json(401, { error: { message: `Incorrect API key provided: ${KEY}` } }))).toMatch(/OpenAI refused the API key \(401\)/);
        expect(await run(() => json(401, { error: { message: `Incorrect API key provided: ${KEY}` } }))).not.toContain(KEY);
        expect(await run(() => json(429, { error: { message: 'Rate limit reached' } }))).toMatch(/limiting requests.*\(429\)/);
        expect(await run(() => json(503, { error: { message: 'overloaded' } }))).toMatch(/problem of its own \(503\)/);
        expect(await run(() => json(404, { error: { message: 'The model `gpt-test` does not exist' } }))).toMatch(/does not offer the model gpt-test/);
        expect(await run(() => json(400, { error: 'registry.ollama.ai/library/gemma:2b does not support tools' })))
            .toMatch(/does not support tool calling/);
        expect(await run(() => json(404, { error: { message: 'No endpoints found that support tool use.' } }))).toMatch(/does not support tool calling/);
    });

    it('says a local service is not running', async () => {
        const local: CompatibleSetup = { ...SETUP, preset: 'ollama', name: 'Ollama (on this computer)', baseUrl: 'http://localhost:11434/v1', apiKey: '', local: true };
        const refused = Object.assign(new TypeError('fetch failed'), { cause: new Error('connect ECONNREFUSED 127.0.0.1:11434') });
        expect(await run(() => Promise.reject(refused), local)).toMatch(/Could not reach Ollama.*is it running\? \(connect ECONNREFUSED/);
    });

    it('reads the reason from the usual error bodies', () => {
        expect(errorDetail('{"error":{"message":"bad things"}}')).toBe('bad things');
        expect(errorDetail('[{"error":{"code":400,"message":"gemini says no"}}]')).toBe('gemini says no');
        expect(errorDetail('{"detail":"nope"}')).toBe('nope');
        expect(errorDetail('Bad Gateway')).toBe('Bad Gateway');
        expect(plainError(SETUP, 418, '').message).toBe('OpenAI refused the request (418).');
    });
});

describe('the settings for another provider', () => {
    it('needs a model, and a key unless the service runs here', () => {
        expect(compatibleSetup(config(), 'best')).toMatchObject({ model: 'gpt-best', apiKey: KEY, baseUrl: 'https://api.openai.com/v1' });
        expect(compatibleSetup(config({ compatibleKeys: {} }), 'fast')).toMatchObject({ error: expect.stringMatching(/No API key is kept for OpenAI/) });
        expect(compatibleSetup(config({ compatible: { preset: 'groq', baseUrl: '', models: {} } }), 'fast'))
            .toMatchObject({ error: expect.stringMatching(/No Fast model is chosen for Groq/) });
        const ollama = config({ compatible: { preset: 'ollama', baseUrl: '', models: { ollama: { fast: 'qwen3:8b', best: '' } } }, compatibleKeys: {} });
        expect(compatibleSetup(ollama, 'fast')).toMatchObject({ baseUrl: 'http://localhost:11434/v1', apiKey: '', local: true });
        expect(compatibleSetup(config({ compatible: { preset: 'custom', baseUrl: '', models: { custom: { fast: 'm', best: 'm' } } } }), 'fast'))
            .toMatchObject({ error: expect.stringMatching(/No base URL/) });
        // agent.ts picks this loop for the provider; Claude's own setup is untouched.
        expect(sessionSetup(config(), 'fast')).toMatchObject({ provider: 'openai-compatible', model: 'gpt-fast' });
        expect(sessionSetup(config({ provider: 'claude' }), 'fast', {})).toEqual({ model: 'sonnet', effort: 'medium' });
    });

    it('sends a kept key only to the base URL it was kept for', () => {
        const custom = config({ compatible: { preset: 'custom', baseUrl: 'http://10.0.0.5:8000/v1', models: {} }, compatibleKeys: { custom: KEY } });
        expect(compatibleTarget(custom, 'custom')).toMatchObject({ baseUrl: 'http://10.0.0.5:8000/v1', apiKey: KEY });
        expect(compatibleTarget(custom, 'custom', 'https://elsewhere.example/v1')).toMatchObject({ baseUrl: 'https://elsewhere.example/v1', apiKey: '' });
        expect(compatibleTarget(custom, 'custom', 'https://elsewhere.example/v1', 'typed-key-1234')).toMatchObject({ apiKey: 'typed-key-1234' });
        // A preset's base URL cannot be changed by a request.
        expect(compatibleTarget(custom, 'openai', 'https://elsewhere.example/v1').baseUrl).toBe('https://api.openai.com/v1');
    });

    it('runs Jarvis on the loop: the same events as with Claude', async () => {
        const store = new ProjectStore();
        const { fetcher, sent } = stub([
            () => sse([text('Very good, sir. '), { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'v', function: { name: 'view_set', arguments: '{"azimuth":45}' } }] } }] }]),
            () => sse([text('The view is turned.')]),
        ]);
        vi.stubGlobal('fetch', fetcher);
        const events: string[] = [];
        const done = new Promise<void>((resolve) => {
            const jarvis = new Jarvis(store, createTools(store), {
                status: (status, detail) => void events.push(`status ${status}${detail ? ` ${detail}` : ''}`),
                sentence: (_turn, t) => void events.push(`say ${t}`),
                interrupted: () => void events.push('interrupted'),
                finished: (turn, ok) => {
                    events.push(`finished ${turn} ${ok}`);
                    resolve();
                },
                model: (m) => void events.push(`model ${m}`),
                error: (m) => void events.push(`error ${m}`),
            }, () => config());
            expect(jarvis.getModel()).toBe('gpt-fast');
            jarvis.prompt('Turn the view.');
        });
        await done;
        expect(events).toEqual([
            'status thinking', 'model gpt-fast', 'say Very good, sir.', 'status working view_set', 'say The view is turned.', 'finished 1 true', 'status idle',
        ]);
        expect(sent[0].body.messages[1]).toMatchObject({ role: 'user', content: expect.stringContaining('Turn the view.') });
        // No skills or subagents there: the skills that are on come as guidance in the system prompt.
        const system = sent[0].body.messages[0] as { content: string };
        expect(system.content).toContain('You are Jarvis');
        expect(system.content).toContain('Skill "manage"');
        expect(system.content).toContain('cannot hand work to part builders');
    });

    it('shows a failed request in the chat in plain words', async () => {
        const { fetcher } = stub([() => json(401, { error: { message: 'bad key' } })]);
        vi.stubGlobal('fetch', fetcher);
        const errors: string[] = [];
        await new Promise<void>((resolve) => {
            const jarvis = new Jarvis(new ProjectStore(), [], {
                status: () => {}, sentence: () => {}, interrupted: () => {}, model: () => {},
                finished: (_turn, ok) => {
                    expect(ok).toBe(false);
                    resolve();
                },
                error: (m) => void errors.push(m),
            }, () => config());
            jarvis.prompt('Hello');
        });
        expect(errors).toEqual(['Jarvis stopped: OpenAI refused the API key (401): check the key in Options, AI assistant (bad key).']);
    });
});

describe('the model list of a service', () => {
    it('lists chat models with what the service says they can do', async () => {
        const { fetcher, sent } = stub([() => json(200, {
            data: [
                { id: 'openai/gpt-5', name: 'OpenAI: GPT-5', supported_parameters: ['tools', 'temperature'], architecture: { input_modalities: ['text', 'image'] } },
                { id: 'meta/tiny', supported_parameters: ['temperature'], architecture: { input_modalities: ['text'] } },
                { id: 'mistral-large-latest', capabilities: { completion_chat: true, function_calling: true, vision: false } },
                { id: 'mistral-embed', capabilities: { completion_chat: false } },
                { id: 'text-embedding-3-small' },
                { id: 'whisper-1' },
                { id: 'gpt-4.1' },
            ],
        })]);
        const models = await compatibleModelList({ ...SETUP }, fetcher);
        expect(sent[0]).toMatchObject({ url: 'https://api.example.test/v1/models', headers: { authorization: `Bearer ${KEY}` } });
        expect(models).toEqual([
            { value: 'gpt-4.1', name: 'gpt-4.1' },
            { value: 'meta/tiny', name: 'meta/tiny', tools: false, images: false },
            { value: 'mistral-large-latest', name: 'mistral-large-latest', tools: true, images: false },
            { value: 'openai/gpt-5', name: 'OpenAI: GPT-5 (openai/gpt-5)', tools: true, images: true },
        ]);
    });

    it('comes through /api/ai/models with the kept key, and without one for a local service', async () => {
        const { fetcher, sent } = stub([() => json(200, { data: [{ id: 'gpt-4.1' }] }), () => json(200, { data: [{ id: 'qwen3:8b' }] })]);
        const lists = new ModelLists(undefined, 1000, fetcher);
        const list = await lists.list(config(), {});
        expect(list).toMatchObject({ ok: true, source: 'OpenAI', models: [{ value: 'gpt-4.1' }] });
        expect(JSON.stringify(list)).not.toContain(KEY);
        await lists.list(config(), { preset: 'ollama' });
        expect(sent[1].url).toBe('http://localhost:11434/v1/models');
        expect(sent[1].headers.authorization).toBeUndefined();
        // No key kept for Groq: nothing is asked.
        expect(await lists.list(config(), { preset: 'groq' })).toMatchObject({ ok: false, error: expect.stringMatching(/No API key is kept for Groq/) });
        expect(sent).toHaveLength(2);
    });
});

describe('Test connection with another provider', () => {
    it('sends one short request through the same loop, without tools', async () => {
        const { fetcher, sent } = stub([() => sse([text('OK')])]);
        const result = await testAi(config(), { provider: 'openai-compatible', model: 'gpt-typed' }, undefined, fetcher);
        expect(result).toMatchObject({ ok: true, model: 'gpt-typed', reply: 'OK', credential: 'the OpenAI API key' });
        expect(sent[0].body.tools).toBeUndefined();
        expect(sent[0].body.model).toBe('gpt-typed');
    });

    it('tests a key typed in the form, and reports a refusal without the key', async () => {
        const typed = 'sk-FAKE-typed-in-the-form-9999';
        const { fetcher, sent } = stub([() => json(401, { error: { message: `bad key ${typed}` } })]);
        const result = await testAi(config({ compatibleKeys: {} }), { provider: 'openai-compatible', apiKey: typed }, undefined, fetcher);
        expect(sent[0].headers.authorization).toBe(`Bearer ${typed}`);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/refused the API key/);
        expect(result.error).not.toContain(typed);
    });
});
