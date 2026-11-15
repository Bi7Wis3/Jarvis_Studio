// Options > AI assistant > Test connection: one short request to Claude with the chosen credentials and model, the
// same way Jarvis's sessions reach it.

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AiAuth, Effort } from '@jarvis/core/settings';
import { sessionSetup } from './agent.js';
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

const TEST_TIMEOUT_MS = 90_000;

/** Runs the test. `override` is what the form shows (not yet applied): a typed key, the auth choice, model and effort. */
export async function testAi(saved: AiConfig, override: { auth?: AiAuth; apiKey?: string; model?: string; effort?: Effort },
    run: typeof query = query): Promise<AiTestResult> {
    const config: AiConfig = {
        ...saved,
        auth: override.auth ?? saved.auth,
        apiKey: override.apiKey?.trim() || saved.apiKey,
        fast: { model: override.model ?? saved.fast.model, effort: override.effort ?? saved.fast.effort },
    };
    const setup = sessionSetup(config, 'fast');
    const begun = Date.now();
    if ('error' in setup) {
        return { ok: false, ms: 0, error: setup.error };
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TEST_TIMEOUT_MS);
    const result: AiTestResult = { ok: false, ms: 0 };
    try {
        const session = run({
            prompt: 'Reply with the single word OK.',
            options: {
                systemPrompt: 'You are a connection test. Reply with the single word OK and nothing else.',
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

const ASSISTANT_ERRORS: Partial<Record<string, string>> = {
    authentication_failed: 'The credentials were refused: check the API key, or log in to Claude Code on this computer.',
    billing_error: 'The account has a billing problem.',
    rate_limit: 'Rate limited: try again in a moment.',
    overloaded: 'Claude is overloaded: try again in a moment.',
    model_not_found: 'That model is not available with these credentials.',
    invalid_request: 'The request was refused as invalid (is the effort level supported by this model?).',
};
