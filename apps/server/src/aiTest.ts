// Options > AI assistant > Test connection: one short request with the chosen credentials and model, the same way
// Jarvis's sessions make theirs (Claude through Claude Code; an OpenAI-compatible service through Jarvis's own loop).

import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { compatibleModels, type AiAuth, type AiProvider, type CompatiblePreset, type Effort } from '@jarvis/core/settings';
import { sessionSetup } from './agent.js';
import { compatibleTarget } from './aiModels.js';
import { compatibleSession, compatibleSetup, type Fetcher } from './agentOpenAI.js';
import { PROJECTS_DIR } from './paths.js';
import type { AiConfig } from './settings.js';

export interface AiTestResult {
    ok: boolean;
    /** The model that answered, as the session reported it. */
    model?: string;
    /** Where the credential came from (Claude Code's apiKeySource: ANTHROPIC_API_KEY, none for a claude.ai login, ...). */
    credential?: string;
    ms: number;
    reply?: string;
    error?: string;
    /** The models Claude Code offers with these credentials. */
    models?: { value: string; name: string; efforts?: Effort[] }[];
}

/** What the form shows (not yet applied): the provider, a typed key, the login choice, the service, model and effort. */
export interface AiTestOverride {
    provider?: AiProvider;
    auth?: AiAuth;
    apiKey?: string;
    model?: string;
    effort?: Effort;
    preset?: CompatiblePreset;
    baseUrl?: string;
}

const TEST_TIMEOUT_MS = 90_000;
const TEST_PROMPT = 'Reply with the single word OK.';
const TEST_SYSTEM = 'You are a connection test. Reply with the single word OK and nothing else.';

/** Runs the test. */
export async function testAi(saved: AiConfig, override: AiTestOverride, run: typeof query = query, fetcher?: Fetcher): Promise<AiTestResult> {
    if ((override.provider ?? saved.provider) === 'openai-compatible') {
        return testCompatible(saved, override, fetcher);
    }
    const config: AiConfig = {
        ...saved,
        provider: 'claude',
        auth: override.auth ?? saved.auth,
        apiKey: override.apiKey?.trim() || saved.apiKey,
        fast: { model: override.model ?? saved.fast.model, effort: override.effort ?? saved.fast.effort },
    };
    const setup = sessionSetup(config, 'fast');
    const begun = Date.now();
    if ('error' in setup || 'provider' in setup) {
        return { ok: false, ms: 0, error: 'error' in setup ? setup.error : 'Not a Claude session.' };
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TEST_TIMEOUT_MS);
    const result: AiTestResult = { ok: false, ms: 0 };
    try {
        const session = run({
            prompt: TEST_PROMPT,
            options: {
                systemPrompt: TEST_SYSTEM,
                model: setup.model,
                effort: setup.effort,
                ...(setup.env ? { env: setup.env } : {}),
                tools: [],
                settingSources: [],
                persistSession: false,
                permissionMode: 'dontAsk',
                maxTurns: 1,
                cwd: PROJECTS_DIR,
                abortController: abort,
            },
        });
        for await (const message of session as AsyncIterable<SDKMessage>) {
            if (message.type === 'system' && message.subtype === 'init') {
                result.model = message.model;
                result.credential = message.apiKeySource;
                const models = await session.supportedModels().catch(() => []);
                result.models = models.map((m) => ({
                    value: m.value, name: m.displayName, ...(m.supportedEffortLevels ? { efforts: m.supportedEffortLevels } : {}),
                }));
            } else if (message.type === 'assistant' && message.error) {
                result.error = ASSISTANT_ERRORS[message.error] ?? `Claude answered with an error (${message.error}).`;
            } else if (message.type === 'result') {
                if (message.subtype === 'success' && !message.is_error) {
                    result.ok = true;
                    result.reply = message.result.slice(0, 200);
                } else {
                    result.error ??= message.subtype === 'success' ? message.result.slice(0, 300) : (message.errors?.join('; ') || message.subtype);
                }
            }
        }
    } catch (error) {
        result.error ??= abort.signal.aborted ? 'No answer within 90 seconds.' : error instanceof Error ? error.message : String(error);
    } finally {
        clearTimeout(timer);
    }
    result.ms = Date.now() - begun;
    if (!result.ok) {
        result.error ??= 'The test request did not finish.';
        // The key must never come back in a message, whatever the CLI printed.
        if (config.apiKey) {
            result.error = result.error.split(config.apiKey).join('••••');
        }
    }
    return result;
}

/** One user turn, then the end of the input. */
function once(text: string): AsyncIterable<SDKUserMessage> {
    return (async function* () {
        yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage;
    })();
}

/** The test through Jarvis's own loop for OpenAI-compatible services: a plain reply, no tools. */
async function testCompatible(saved: AiConfig, override: AiTestOverride, fetcher?: Fetcher): Promise<AiTestResult> {
    const target = compatibleTarget(saved, override.preset, override.baseUrl, override.apiKey);
    const models = compatibleModels(saved.compatible, target.preset);
    const config: AiConfig = {
        ...saved,
        provider: 'openai-compatible',
        compatible: {
            ...saved.compatible,
            preset: target.preset,
            ...(target.preset === 'custom' ? { baseUrl: target.baseUrl } : {}),
            models: { ...saved.compatible.models, [target.preset]: { ...models, fast: override.model ?? models.fast } },
        },
        compatibleKeys: { ...saved.compatibleKeys, [target.preset]: target.apiKey },
    };
    const setup = compatibleSetup(config, 'fast');
    if ('error' in setup) {
        return { ok: false, ms: 0, error: setup.error };
    }
    const begun = Date.now();
    const session = compatibleSession({ prompt: once(TEST_PROMPT), setup, systemPrompt: TEST_SYSTEM, tools: [], fetch: fetcher });
    const result: AiTestResult = {
        ok: false, ms: 0, model: setup.model, credential: setup.apiKey ? `the ${setup.name} API key` : 'no key',
    };
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        session.close();
    }, TEST_TIMEOUT_MS);
    let text = '';
    try {
        for await (const message of session) {
            const m = message as { type: string; subtype?: string; result?: string; errors?: string[]; event?: { delta?: { text?: string } } };
            if (m.type === 'stream_event' && typeof m.event?.delta?.text === 'string') {
                text += m.event.delta.text;
            } else if (m.type === 'result') {
                if (m.subtype === 'success') {
                    result.ok = true;
                    result.reply = (m.result || text).trim().slice(0, 200);
                } else {
                    result.error = m.errors?.join('; ') || m.subtype;
                }
                break;
            }
        }
    } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
    } finally {
        clearTimeout(timer);
        session.close();
    }
    result.ms = Date.now() - begun;
    if (!result.ok) {
        result.error = timedOut ? 'No answer within 90 seconds.' : result.error ?? 'The test request did not finish.';
        if (setup.apiKey) {
            result.error = result.error.split(setup.apiKey).join('••••');
        }
    }
    return result;
}

const ASSISTANT_ERRORS: Partial<Record<string, string>> = {
    authentication_failed: 'The credentials were refused: check the API key, or log in to Claude Code on this computer.',
    billing_error: 'The account has a billing problem.',
    rate_limit: 'Rate limited: try again in a moment.',
    overloaded: 'Claude is overloaded: try again in a moment.',
    model_not_found: 'That model is not available with these credentials.',
    invalid_request: 'The request was refused as invalid (is the effort level supported by this model?).',
};
