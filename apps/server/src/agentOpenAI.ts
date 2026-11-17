// Jarvis on an OpenAI-compatible service (OpenAI, Gemini, Mistral, Groq, DeepSeek, xAI, OpenRouter, Ollama, LM Studio
// or any other that speaks the Chat Completions API with tool calling), through plain fetch. It behaves towards
// agent.ts as a Claude Code session does: it reads the same user turns and answers with the same kind of messages
// (streamed text, tool starts, one result per turn), so Jarvis's events, the chat and the status chip work unchanged.
// The studio tools are the same ones, their zod schemas turned into JSON Schema, run by the same handlers.

import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { z, type ZodRawShape } from 'zod';
import {
    compatibleBaseUrl, compatibleModels, compatiblePreset, type CompatiblePreset,
} from '@jarvis/core/settings';
import type { Quality } from './agent.js';
import type { AiConfig } from './settings.js';
import { callTool, type AnyTool } from './tools.js';

export interface CompatibleSetup {
    provider: 'openai-compatible';
    preset: CompatiblePreset;
    /** The service's name, for messages. */
    name: string;
    baseUrl: string;
    /** '' when the service takes no key. */
    apiKey: string;
    model: string;
    local: boolean;
}

/** The service, model and key Jarvis uses for these settings, or why it cannot run. */
export function compatibleSetup(config: AiConfig, quality: Quality): CompatibleSetup | { error: string } {
    const c = config.compatible;
    const preset = compatiblePreset(c.preset);
    const baseUrl = compatibleBaseUrl(c);
    const model = compatibleModels(c)[quality];
    const apiKey = config.compatibleKeys?.[c.preset] ?? '';
    if (!baseUrl) {
        return { error: 'No base URL is set for the custom service. Add one in Options, AI assistant.' };
    }
    if (!model) {
        return { error: `No ${quality === 'fast' ? 'Fast' : 'Best'} model is chosen for ${preset.name}. Choose one in Options, AI assistant.` };
    }
    if (!apiKey && !preset.local && c.preset !== 'custom') {
        return { error: `No API key is kept for ${preset.name}. Add one in Options, AI assistant.` };
    }
    return { provider: 'openai-compatible', preset: c.preset, name: preset.name, baseUrl, apiKey, model, local: preset.local };
}

// ---- Tool definitions --------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

const isPlain = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * A JSON Schema made portable across the services: no $schema, tuples as plain arrays with a length (Gemini and others
 * take no tuple form), const as a one-value enum, oneOf as anyOf.
 */
export function portableSchema(schema: unknown): unknown {
    if (Array.isArray(schema)) {
        return schema.map(portableSchema);
    }
    if (!isPlain(schema)) {
        return schema;
    }
    const out: Json = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === '$schema' || key === '$id' || key === 'additionalItems' || key === 'prefixItems') {
            continue;
        }
        if (key === 'const') {
            out.enum = [value];
        } else if (key === 'oneOf') {
            out.anyOf = portableSchema(value);
        } else if (key === 'properties' && isPlain(value)) {
            out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, portableSchema(v)]));
        } else if (key === 'items' && Array.isArray(value)) {
            continue;
        } else {
            out[key] = portableSchema(value);
        }
    }
    const tuple = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : null;
    if (tuple) {
        const items = tuple.map(portableSchema);
        const unique = items.filter((item, i) => items.findIndex((x) => JSON.stringify(x) === JSON.stringify(item)) === i);
        out.items = unique.length === 1 ? unique[0] : { anyOf: unique };
        out.minItems ??= items.length;
        if (schema.items === false || schema.additionalItems === false || Array.isArray(schema.items)) {
            out.maxItems ??= items.length;
        }
    }
    return out;
}

/** A tool's arguments as JSON Schema (an object, even for a tool that takes none). */
export function toolParameters(shape: ZodRawShape): Json {
    try {
        const schema = z.toJSONSchema(z.object(shape), { target: 'draft-07', unrepresentable: 'any', io: 'input', reused: 'inline' });
        const out = portableSchema(schema) as Json;
        return { ...out, type: 'object', properties: out.properties ?? {} };
    } catch {
        return { type: 'object', properties: {} };
    }
}

interface FunctionTool {
    type: 'function';
    function: { name: string; description: string; parameters: Json };
}

export function toolDefinitions(tools: AnyTool[]): FunctionTool[] {
    return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: toolParameters(t.schema) } }));
}

// ---- Messages ----------------------------------------------------------------------------------------------------

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export type ChatMessage =
    | { role: 'system'; content: string }
    | { role: 'user'; content: string | Part[] }
    | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
    | { role: 'tool'; tool_call_id: string; content: string };

/** A user turn as agent.ts queues it (text, pictures first) in the Chat Completions form. */
function userMessage(message: SDKUserMessage): ChatMessage {
    const content = message.message.content;
    if (typeof content === 'string') {
        return { role: 'user', content };
    }
    const parts: Part[] = [];
    for (const block of content as unknown[]) {
        const b = block as { type?: string; text?: string; source?: { type?: string; media_type?: string; data?: string } };
        if (b.type === 'text' && typeof b.text === 'string') {
            parts.push({ type: 'text', text: b.text });
        } else if (b.type === 'image' && b.source?.type === 'base64') {
            parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
        }
    }
    return { role: 'user', content: parts };
}

const NO_PICTURE = '[A picture was here, but this model does not take pictures.]';
const OLD_PICTURE = '[An earlier picture was here; it was left out to keep the conversation small.]';

/** Pictures kept in the conversation; older ones become a short note (each is sent again with every request). */
const KEPT_PICTURES = 4;

function replacePictures(messages: ChatMessage[], keep: number, note: string): ChatMessage[] {
    let seen = 0;
    const out = [...messages];
    for (let i = out.length - 1; i >= 0; i--) {
        const m = out[i];
        if (m.role !== 'user' || typeof m.content === 'string') {
            continue;
        }
        const parts = m.content.map((part) => {
            if (part.type !== 'image_url') {
                return part;
            }
            seen++;
            return seen > keep ? { type: 'text' as const, text: note } : part;
        });
        out[i] = { ...m, content: parts };
    }
    return out;
}

const hasPictures = (messages: ChatMessage[]): boolean =>
    messages.some((m) => m.role === 'user' && typeof m.content !== 'string' && m.content.some((p) => p.type === 'image_url'));

// ---- Errors ------------------------------------------------------------------------------------------------------

export class ProviderError extends Error {
    constructor(message: string, readonly status = 0, readonly detail = '') {
        super(message);
    }
}

/** The provider's own reason from an error body, in a line. */
export function errorDetail(body: string): string {
    let text = body;
    try {
        const json = JSON.parse(body) as unknown;
        const first = Array.isArray(json) ? json[0] : json;
        const e: Json = isPlain(first) ? first : {};
        const err = e.error;
        const candidates = [
            isPlain(err) ? err.message : undefined, typeof err === 'string' ? err : undefined, e.message,
            typeof e.detail === 'string' ? e.detail : Array.isArray(e.detail) ? JSON.stringify(e.detail) : undefined,
        ];
        text = candidates.find((c): c is string => typeof c === 'string' && c.trim() !== '') ?? body;
    } catch {
        // Not JSON: the text as it is.
    }
    const line = text.replace(/\s+/g, ' ').trim();
    return line.length > 240 ? `${line.slice(0, 240)}…` : line;
}

const TOOLS_REFUSED = /(does ?n[o']t|not) support(s|ed)? (tools|tool[ _-]?(use|calling|calls)|function[ _-]?calling)|tool[ _-]?(use|calling|choice)\W+(is )?not (supported|available|enabled)|no endpoints found that support tool/i;

/** A plain message for a failed request: what went wrong, and what to do. */
export function plainError(setup: Pick<CompatibleSetup, 'name' | 'model' | 'baseUrl'>, status: number, body: string): ProviderError {
    const detail = errorDetail(body);
    const why = detail ? ` (${detail})` : '';
    const { name, model } = setup;
    let message: string;
    if (TOOLS_REFUSED.test(detail)) {
        message = `The model ${model} does not support tool calling, which Jarvis needs to work in the studio: choose another model${why}.`;
    } else if (status === 401 || status === 403) {
        message = `${name} refused the API key (${status}): check the key in Options, AI assistant${why}.`;
    } else if (status === 404) {
        message = /model/i.test(detail)
            ? `${name} does not offer the model ${model} (404): choose one from the list${why}.`
            : `Nothing answers at ${setup.baseUrl} (404): check the base URL and the model${why}.`;
    } else if (status === 429) {
        message = `${name} is limiting requests or the account is out of credit (429): wait a moment, or check the account${why}.`;
    } else if (status >= 500) {
        message = `${name} had a problem of its own (${status}): try again in a moment${why}.`;
    } else {
        message = `${name} refused the request (${status})${why}.`;
    }
    return new ProviderError(message, status, detail);
}

/** A request that never reached the service (nothing listening, no network, a wrong host name). */
function unreachable(setup: Pick<CompatibleSetup, 'name' | 'baseUrl' | 'local'>, error: unknown): ProviderError {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : error instanceof Error ? error.message : String(error);
    return new ProviderError(setup.local
        ? `Could not reach ${setup.name} at ${setup.baseUrl}: is it running? (${cause})`
        : `Could not reach ${setup.baseUrl}: ${cause}.`);
}

/** Removes the key from a text that will be shown. */
const scrub = (text: string, key: string): string => (key.length >= 4 ? text.split(key).join('••••') : text);

// ---- Requests ----------------------------------------------------------------------------------------------------

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

/** The headers of every request to the service: the key as a bearer token when there is one. */
export function requestHeaders(apiKey: string, json = true): Record<string, string> {
    return {
        ...(json ? { 'content-type': 'application/json' } : {}),
        accept: json ? 'application/json, text/event-stream' : 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    };
}

interface Reply {
    text: string;
    reasoning: string;
    calls: ToolCall[];
}

interface CallSlot {
    id: string;
    name: string;
    arguments: string;
}

const NO_REPLY_MS = 180_000;
const MAX_ROUNDS = 40;

/** A message agent.ts reads as it reads Claude Code's (only the fields it uses). */
const message = (m: Record<string, unknown>): SDKMessage => ({ parent_tool_use_id: null, ...m }) as unknown as SDKMessage;
const textDelta = (text: string) => message({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
const blockStop = () => message({ type: 'stream_event', event: { type: 'content_block_stop' } });
const toolStart = (name: string) => message({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name } } });

export interface CompatibleSessionOptions {
    prompt: AsyncIterable<SDKUserMessage>;
    setup: CompatibleSetup;
    systemPrompt: string;
    tools: AnyTool[];
    /** Told to the user once, for something they should know that is not a failure. */
    notice?: (text: string) => void;
    fetch?: Fetcher;
    maxRounds?: number;
    /** Longest wait for the next piece of an answer. */
    noReplyMs?: number;
}

/** What agent.ts needs of a session. */
export interface CompatibleSession extends AsyncIterable<SDKMessage> {
    interrupt(): Promise<void>;
    close(): void;
}

class Loop {
    private messages: ChatMessage[];
    private readonly definitions: FunctionTool[];
    private readonly byName: Map<string, AnyTool>;
    private turnAbort: AbortController | null = null;
    private closed = false;
    private onClose: () => void = () => {};
    private readonly closing = new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.onClose = () => resolve({ value: undefined, done: true });
    });
    /** The model refused pictures once: they are left out from then on. */
    private noPictures = false;
    private callCount = 0;

    constructor(private readonly o: CompatibleSessionOptions) {
        this.messages = [{ role: 'system', content: o.systemPrompt }];
        this.definitions = toolDefinitions(o.tools);
        this.byName = new Map(o.tools.map((t) => [t.name, t]));
    }

    interrupt(): void {
        this.turnAbort?.abort();
    }

    close(): void {
        this.closed = true;
        this.turnAbort?.abort();
        this.onClose();
    }

    async *run(): AsyncGenerator<SDKMessage> {
        yield message({ type: 'system', subtype: 'init', model: this.o.setup.model });
        const inbox = this.o.prompt[Symbol.asyncIterator]();
        while (!this.closed) {
            const next = await Promise.race([inbox.next(), this.closing]);
            if (this.closed || next.done) {
                return;
            }
            yield* this.turn(next.value);
        }
    }

    private async *turn(user: SDKUserMessage): AsyncGenerator<SDKMessage> {
        const abort = new AbortController();
        this.turnAbort = abort;
        this.messages.push(userMessage(user));
        if (this.noPictures) {
            this.messages = replacePictures(this.messages, 0, NO_PICTURE);
        }
        const maxRounds = this.o.maxRounds ?? MAX_ROUNDS;
        try {
            for (let round = 0; ; round++) {
                if (round >= maxRounds) {
                    yield message({
                        type: 'result', subtype: 'error_max_turns', is_error: true,
                        errors: [`stopped after ${maxRounds} rounds of tool calls in one request`],
                    });
                    return;
                }
                const reply: Reply = yield* this.ask(abort.signal);
                this.messages.push({
                    role: 'assistant',
                    content: reply.text || null,
                    ...(reply.calls.length ? { tool_calls: reply.calls } : {}),
                    ...(reply.reasoning ? { reasoning_content: reply.reasoning } : {}),
                });
                yield blockStop();
                if (reply.calls.length === 0) {
                    yield message({ type: 'result', subtype: 'success', is_error: false, result: reply.text });
                    return;
                }
                const pictures: Part[] = [];
                for (const call of reply.calls) {
                    if (abort.signal.aborted) {
                        // Every call needs its answer, or the conversation cannot go on.
                        this.messages.push({ role: 'tool', tool_call_id: call.id, content: 'Not run: the user interrupted.' });
                        continue;
                    }
                    yield toolStart(call.function.name);
                    const output = await this.runTool(call);
                    const note = output.images.length && this.noPictures ? ` ${NO_PICTURE}` : '';
                    this.messages.push({ role: 'tool', tool_call_id: call.id, content: output.text + note });
                    if (!this.noPictures) {
                        pictures.push(...output.images.map((url): Part => ({ type: 'image_url', image_url: { url } })));
                    }
                }
                // Tool answers carry text only: their pictures follow as a user message.
                if (pictures.length) {
                    this.messages.push({ role: 'user', content: [{ type: 'text', text: 'The picture returned by the tool call above:' }, ...pictures] });
                    this.messages = replacePictures(this.messages, KEPT_PICTURES, OLD_PICTURE);
                }
                if (abort.signal.aborted) {
                    throw new ProviderError('Interrupted.');
                }
            }
        } catch (error) {
            const reason = abort.signal.aborted ? 'interrupted' : error instanceof Error ? error.message : String(error);
            yield blockStop();
            yield message({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [scrub(reason, this.o.setup.apiKey)] });
        } finally {
            if (this.turnAbort === abort) {
                this.turnAbort = null;
            }
        }
    }

    /** One request: streamed text goes out as it comes; the reply is returned whole. */
    private async *ask(signal: AbortSignal): AsyncGenerator<SDKMessage, Reply> {
        let response: Response;
        try {
            response = await this.post(signal);
        } catch (error) {
            // A model that will not look at pictures: once more without them, and without them from now on.
            if (error instanceof ProviderError && [400, 404, 415, 422].includes(error.status) && hasPictures(this.messages)
                && !TOOLS_REFUSED.test(error.detail)) {
                const before = this.messages;
                this.messages = replacePictures(before, 0, NO_PICTURE);
                try {
                    response = await this.post(signal);
                } catch (again) {
                    this.messages = before;
                    throw again;
                }
                this.noPictures = true;
                this.o.notice?.(`${this.o.setup.model} does not take pictures, so Jarvis works on without screenshots and attached pictures.`);
            } else {
                throw error;
            }
        }
        const type = response.headers.get('content-type') ?? '';
        if (!type.includes('text/event-stream') || !response.body) {
            const json = await response.json().catch(() => {
                throw new ProviderError(`${this.o.setup.name} sent an answer Jarvis could not read.`);
            }) as Json;
            const reply = this.whole(json);
            if (reply.text) {
                yield textDelta(reply.text);
            }
            return reply;
        }
        return yield* this.stream(response.body, signal);
    }

    private async post(signal: AbortSignal): Promise<Response> {
        const { setup } = this.o;
        const fetcher = this.o.fetch ?? ((url, init) => globalThis.fetch(url, init));
        const body = JSON.stringify({
            model: setup.model,
            messages: this.messages,
            stream: true,
            ...(this.definitions.length ? { tools: this.definitions } : {}),
        });
        let response: Response;
        try {
            response = await fetcher(`${setup.baseUrl}/chat/completions`, { method: 'POST', headers: requestHeaders(setup.apiKey), body, signal });
        } catch (error) {
            if (signal.aborted) {
                throw error;
            }
            throw unreachable(setup, error);
        }
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw plainError(setup, response.status, scrub(text, setup.apiKey));
        }
        return response;
    }

    /** A reply that came whole (a service that does not stream). */
    private whole(json: Json): Reply {
        const choice: Json = Array.isArray(json.choices) && isPlain(json.choices[0]) ? json.choices[0] : {};
        const m: Json = isPlain(choice.message) ? choice.message : {};
        const slots: CallSlot[] = [];
        this.takeCalls(slots, m.tool_calls);
        const content = typeof m.content === 'string' ? m.content
            : Array.isArray(m.content) ? m.content.map((p) => (isPlain(p) && typeof p.text === 'string' ? p.text : '')).join('') : '';
        return { text: content, reasoning: typeof m.reasoning_content === 'string' ? m.reasoning_content : '', calls: this.calls(slots) };
    }

    private async *stream(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<SDKMessage, Reply> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        const noReplyMs = this.o.noReplyMs ?? NO_REPLY_MS;
        let pending = '';
        let finished = false;
        let text = '';
        let reasoning = '';
        const slots: CallSlot[] = [];
        const onAbort = () => void reader.cancel().catch(() => undefined);
        signal.addEventListener('abort', onAbort);
        try {
            for (;;) {
                let timer: ReturnType<typeof setTimeout> | undefined;
                const quiet = new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new ProviderError(`No answer from ${this.o.setup.name} for ${Math.round(noReplyMs / 1000)} seconds.`)), noReplyMs);
                });
                const chunk = await Promise.race([reader.read(), quiet]).finally(() => clearTimeout(timer));
                if (signal.aborted) {
                    throw new ProviderError('Interrupted.');
                }
                if (chunk.done) {
                    finished = true;
                    break;
                }
                pending += decoder.decode(chunk.value, { stream: true });
                const lines = pending.split(/\r?\n/);
                pending = lines.pop() ?? '';
                for (const line of lines) {
                    if (!line.startsWith('data:')) {
                        continue;
                    }
                    const data = line.slice(5).trim();
                    if (data === '' || data === '[DONE]') {
                        continue;
                    }
                    let json: Json;
                    try {
                        json = JSON.parse(data) as Json;
                    } catch {
                        continue;
                    }
                    if (json.error) {
                        throw plainError(this.o.setup, typeof (json.error as Json).code === 'number' ? (json.error as Json).code as number : 0,
                            scrub(JSON.stringify(json), this.o.setup.apiKey));
                    }
                    const choice = Array.isArray(json.choices) && isPlain(json.choices[0]) ? json.choices[0] : null;
                    const delta = choice && isPlain(choice.delta) ? choice.delta : null;
                    if (!delta) {
                        continue;
                    }
                    if (typeof delta.content === 'string' && delta.content) {
                        text += delta.content;
                        yield textDelta(delta.content);
                    }
                    if (typeof delta.reasoning_content === 'string') {
                        reasoning += delta.reasoning_content;
                    }
                    this.takeCalls(slots, delta.tool_calls);
                }
            }
        } finally {
            signal.removeEventListener('abort', onAbort);
            if (!finished) {
                void reader.cancel().catch(() => undefined);
            }
            try {
                reader.releaseLock();
            } catch {
                // A read was still waiting; the cancel above ends it.
            }
        }
        return { text, reasoning, calls: this.calls(slots) };
    }

    /** Pieces of tool calls into their slots (by index; services without one send each call whole, with its id). */
    private takeCalls(slots: CallSlot[], raw: unknown): void {
        if (!Array.isArray(raw)) {
            return;
        }
        for (const piece of raw) {
            if (!isPlain(piece)) {
                continue;
            }
            const f: Json = isPlain(piece.function) ? piece.function : {};
            const id = typeof piece.id === 'string' ? piece.id : '';
            let slot: CallSlot | undefined;
            if (typeof piece.index === 'number') {
                slot = slots[piece.index] ??= { id: '', name: '', arguments: '' };
            } else {
                slot = (id && slots.find((s) => s.id === id)) || (id || slots.length === 0 ? undefined : slots[slots.length - 1]);
                if (!slot) {
                    slot = { id: '', name: '', arguments: '' };
                    slots.push(slot);
                }
            }
            if (id) {
                slot.id = id;
            }
            if (typeof f.name === 'string' && f.name && slot.name !== f.name) {
                slot.name += f.name;
            }
            if (typeof f.arguments === 'string') {
                slot.arguments += f.arguments;
            } else if (isPlain(f.arguments)) {
                slot.arguments = JSON.stringify(f.arguments);
            }
        }
    }

    private calls(slots: CallSlot[]): ToolCall[] {
        return slots.filter((s) => s && s.name).map((s) => ({
            id: s.id || `call_${++this.callCount}`,
            type: 'function',
            function: { name: s.name, arguments: s.arguments || '{}' },
        }));
    }

    /** Runs a tool call with the studio's own handler, its arguments checked as the Claude path's MCP server checks them. */
    private async runTool(call: ToolCall): Promise<{ text: string; images: string[] }> {
        const tool = this.byName.get(call.function.name);
        if (!tool) {
            return { text: `Failed: there is no tool called ${call.function.name}.`, images: [] };
        }
        let args: unknown;
        try {
            args = JSON.parse(call.function.arguments || '{}');
        } catch {
            return { text: 'Failed: the arguments were not valid JSON. Send them again as one JSON object.', images: [] };
        }
        const parsed = z.object(tool.schema).safeParse(args ?? {});
        if (!parsed.success) {
            return { text: `Failed: the arguments do not fit the tool.\n${z.prettifyError(parsed.error)}`, images: [] };
        }
        const result = await callTool(tool, parsed.data);
        const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).filter(Boolean).join('\n');
        const images = result.content.flatMap((c) => (c.type === 'image' ? [`data:${c.mimeType};base64,${c.data}`] : []));
        return { text: text || (result.isError ? 'Failed.' : 'Done.'), images };
    }
}

/** A session on an OpenAI-compatible service: reads user turns from `prompt` and answers as Claude Code's sessions do. */
export function compatibleSession(options: CompatibleSessionOptions): CompatibleSession {
    const loop = new Loop(options);
    const messages = loop.run();
    return {
        [Symbol.asyncIterator]: () => messages,
        interrupt: async () => loop.interrupt(),
        close: () => loop.close(),
    };
}

// ---- Model list --------------------------------------------------------------------------------------------------

export interface CompatibleModelInfo {
    value: string;
    name: string;
    /** false when the service says the model cannot call tools. */
    tools?: boolean;
    /** false when the service says the model takes no pictures. */
    images?: boolean;
}

/** Families that are not chat models (embeddings, speech, pictures, moderation), left out of the list. */
const NOT_CHAT = /(^|[-/:_.])(embed|embedding|embeddings|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image|imagen|sora|babbage|davinci|rerank|ocr|veo|lyria|aqa)($|[-/:_.\d])/i;

/** GET {baseUrl}/models: the models the service offers to this key, chat models only, in order of name. */
export async function compatibleModelList(setup: Pick<CompatibleSetup, 'name' | 'baseUrl' | 'apiKey' | 'local' | 'model'>, fetcher?: Fetcher,
    timeoutMs = 30_000): Promise<CompatibleModelInfo[]> {
    const run = fetcher ?? ((url, init) => globalThis.fetch(url, init));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let response: Response;
    try {
        response = await run(`${setup.baseUrl}/models`, { method: 'GET', headers: requestHeaders(setup.apiKey, false), signal: abort.signal });
    } catch (error) {
        throw abort.signal.aborted ? new ProviderError(`No answer from ${setup.name} within ${Math.round(timeoutMs / 1000)} seconds.`) : unreachable(setup, error);
    } finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        throw plainError(setup, response.status, scrub(await response.text().catch(() => ''), setup.apiKey));
    }
    const json = await response.json().catch(() => null) as Json | null;
    const data: unknown[] = !json ? [] : Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    const out: CompatibleModelInfo[] = [];
    for (const raw of data) {
        if (!isPlain(raw)) {
            continue;
        }
        const id = typeof raw.id === 'string' ? raw.id : typeof raw.name === 'string' ? raw.name : '';
        const capabilities: Json = isPlain(raw.capabilities) ? raw.capabilities : {};
        if (!id || NOT_CHAT.test(id) || capabilities.completion_chat === false) {
            continue;
        }
        const parameters = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : null;
        const architecture: Json = isPlain(raw.architecture) ? raw.architecture : {};
        const inputs = Array.isArray(architecture.input_modalities) ? architecture.input_modalities
            : Array.isArray(raw.input_modalities) ? raw.input_modalities : null;
        const tools = parameters ? parameters.includes('tools')
            : typeof capabilities.function_calling === 'boolean' ? capabilities.function_calling : undefined;
        const images = inputs ? inputs.includes('image') : typeof capabilities.vision === 'boolean' ? capabilities.vision : undefined;
        out.push({
            value: id,
            name: typeof raw.name === 'string' && raw.name !== id ? `${raw.name} (${id})` : id,
            ...(tools === undefined ? {} : { tools }),
            ...(images === undefined ? {} : { images }),
        });
    }
    const unique = out.filter((m, i) => out.findIndex((x) => x.value === m.value) === i);
    return unique.sort((a, b) => a.value.localeCompare(b.value));
}
