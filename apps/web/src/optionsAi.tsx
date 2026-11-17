// Options > AI assistant: which provider runs Jarvis (Claude through Claude Code, or an OpenAI-compatible service with
// its API key), the models behind Fast and Best, and the skills Jarvis may use. The models come from the server (GET
// /api/ai/models), loaded when the page opens; Claude's aliases stand in while the list loads or when it fails.

import { useEffect, useRef, useState } from 'react';
import {
    COMPATIBLE_PRESETS, compatibleModels, compatiblePreset, enabledSkillIds, validBaseUrl, type AiSettings, type CompatibleModels,
    type CompatiblePreset, type CompatibleSettings, type Effort,
} from '@jarvis/core/settings';
import {
    claudeModelOptions, compatibleModelOptions, effortFor, effortsOf, effortText, fetchAiModels, listStatus, type AiModelInfo,
    type AiModelList, type ModelListForm,
} from './aiModels';
import { fetchSkills, toggleSkill, type SkillEntry } from './aiSkills';
import { testAiConnection, type AiTestResult } from './options';
import { Check, Choice, Note, Section, withCategory, type PageProps } from './optionsPages';

const credentialText = (source?: string) => source === 'ANTHROPIC_API_KEY' ? 'the API key'
    : source === 'none' ? 'the Claude login' : source === '/login managed key' ? 'the Claude Code login (Console key)' : source ?? 'unknown';

/** The model list's status line and its Refresh list button. */
export function ModelListRow({ list, loading, onRefresh, hint }: { list: AiModelList | null; loading: boolean; onRefresh: () => void; hint?: string }) {
    const status = listStatus(list, loading);
    return (
        <div className="op-row">
            <span className={`op-list-status${list && !list.ok && !loading ? ' error' : ''}`} role="status">{status}{hint && !loading ? ` ${hint}` : ''}</span>
            <button type="button" className="sk-small" disabled={loading} onClick={onRefresh}>Refresh list</button>
        </div>
    );
}

/** A model picked from the list, or typed as an id. */
function ModelField({ value, options, onChange, placeholder }: {
    value: string; options: AiModelInfo[]; onChange: (model: string) => void; placeholder: string;
}) {
    const listed = options.some((m) => m.value === value);
    const [choseOther, setChoseOther] = useState(false);
    const other = choseOther || (!listed && value !== '');
    return (
        <>
            <Choice
                label="Model"
                value={other ? 'other' : value}
                options={[
                    ...(value === '' && !other ? [['', 'Choose a model…'] as [string, string]] : []),
                    ...options.map((m): [string, string] => [m.value, m.name]),
                    ['other', 'Another model id…'],
                ]}
                onChange={(v) => {
                    setChoseOther(v === 'other');
                    if (v !== 'other') {
                        onChange(v);
                    }
                }}
            />
            {other && (
                <label className="tb-field">
                    <span>Model id</span>
                    <span className="tb-input">
                        <input value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder={placeholder} spellCheck={false} />
                    </span>
                </label>
            )}
        </>
    );
}

const TestButton = ({ testing, onTest }: { testing: boolean; onTest: () => void }) => (
    <div className="op-row">
        <button type="button" className="sk-small" disabled={testing} onClick={onTest}>{testing ? 'Testing…' : 'Test connection'}</button>
    </div>
);

export function ModelChoice(props: {
    title: string; value: { model: string; effort: Effort }; options: AiModelInfo[]; onChange: (v: { model: string; effort: Effort }) => void;
    onTest: () => void; testing: boolean;
}) {
    const { title, value, options, onChange, onTest, testing } = props;
    const listed = options.some((m) => m.value === value.model);
    const efforts = effortsOf(value.model, options);
    const offered = efforts.includes(value.effort);
    return (
        <Section title={title}>
            <ModelField
                value={value.model}
                options={options}
                placeholder="claude-…"
                onChange={(model) => onChange({ model, effort: effortFor(model, value.effort, options) })}
            />
            {efforts.length > 0 ? (
                <Choice
                    label="Effort"
                    value={value.effort}
                    options={[
                        ...efforts.map((e): [Effort, string] => [e, effortText(e)]),
                        ...(offered ? [] : [[value.effort, `${effortText(value.effort)} (not offered for this model)`] as [Effort, string]]),
                    ]}
                    onChange={(effort) => onChange({ ...value, effort })}
                />
            ) : <Note>This model takes no effort level.</Note>}
            {listed && efforts.length > 0 && efforts.length < 5 && <Note>Effort levels of this model: {efforts.map(effortText).join(', ')}.</Note>}
            <TestButton testing={testing} onTest={onTest} />
        </Section>
    );
}

/** The model list for the form's credentials: loaded when the page opens and when they change, again on Refresh list. */
function useModelList(form: ModelListForm) {
    const [list, setList] = useState<AiModelList | null>(null);
    const [loading, setLoading] = useState(false);
    const asked = useRef(0);
    const key = JSON.stringify(form);
    const load = async (refresh: boolean) => {
        const n = ++asked.current;
        setLoading(true);
        const answer = await fetchAiModels(form, refresh);
        // An answer to an older question (the credentials changed meanwhile) is dropped.
        if (n === asked.current) {
            setList(answer);
            setLoading(false);
        }
    };
    useEffect(() => {
        // A moment's wait, so a base URL being typed is not asked about at every key.
        const timer = window.setTimeout(() => void load(false), 300);
        return () => window.clearTimeout(timer);
    }, [key]);
    return { list, loading, refresh: () => void load(true) };
}

type Which = 'fast' | 'best';

function TestResult({ result }: { result: { which: Which; r: AiTestResult } | null }) {
    if (!result) {
        return null;
    }
    const { which, r } = result;
    return (
        <p className={`op-test ${r.ok ? 'ok' : 'error'}`} role="status">
            {which === 'fast' ? 'Fast' : 'Best'}:{' '}
            {r.ok
                ? `connected. ${r.model ?? 'The model'} answered in ${(r.ms / 1000).toFixed(1)} s, using ${credentialText(r.credential)}.`
                : `not connected. ${r.error ?? ''}`}
        </p>
    );
}

/** Claude through Claude Code: its login or an Anthropic API key, and Claude's models with their effort levels. */
function ClaudeForm({ draft, setDraft, saved }: PageProps) {
    const ai = draft.settings.ai;
    const set = (patch: Partial<typeof ai>) => setDraft(withCategory(draft, 'ai', { ...ai, ...patch }));
    const [testing, setTesting] = useState<Which | null>(null);
    const [result, setResult] = useState<{ which: Which; r: AiTestResult } | null>(null);
    const models = useModelList({ provider: 'claude', auth: ai.auth });
    const options = claudeModelOptions(models.list);
    const keyKept = saved.ai.apiKeySet && draft.apiKey === null;
    const removing = saved.ai.apiKeySet && draft.apiKey === '';
    const test = async (which: Which) => {
        setTesting(which);
        setResult(null);
        const r = await testAiConnection({ provider: 'claude', auth: ai.auth, apiKey: draft.apiKey || undefined, ...ai[which] });
        setTesting(null);
        setResult({ which, r });
    };
    return (
        <>
            <Section title="Connection">
                <label className="tb-check">
                    <input type="radio" name="op-auth" checked={ai.auth === 'local'} onChange={() => set({ auth: 'local' })} />
                    <span>Claude Code on this computer (its own login, as before)</span>
                </label>
                <label className="tb-check">
                    <input type="radio" name="op-auth" checked={ai.auth === 'apiKey'} onChange={() => set({ auth: 'apiKey' })} />
                    <span>An Anthropic API key</span>
                </label>
                {ai.auth === 'apiKey' && (
                    <>
                        {keyKept && (
                            <div className="op-row">
                                <span className="op-key">Key kept: {saved.ai.apiKeyMasked}</span>
                                <button type="button" className="sk-small" onClick={() => setDraft({ ...draft, apiKey: '' })}>Remove key</button>
                            </div>
                        )}
                        {removing && (
                            <div className="op-row">
                                <span className="op-key">The kept key is removed when you apply.</span>
                                <button type="button" className="sk-small" onClick={() => setDraft({ ...draft, apiKey: null })}>Keep it</button>
                            </div>
                        )}
                        <label className="tb-field">
                            <span>{saved.ai.apiKeySet ? 'New API key' : 'API key'}</span>
                            <span className="tb-input">
                                <input
                                    type="password"
                                    autoComplete="new-password"
                                    spellCheck={false}
                                    value={draft.apiKey ?? ''}
                                    placeholder="sk-ant-…"
                                    onChange={(e) => setDraft({ ...draft, apiKey: e.target.value === '' ? null : e.target.value })}
                                />
                            </span>
                        </label>
                        {!saved.ai.apiKeySet && !draft.apiKey && <Note>No key is kept yet: Jarvis cannot answer until one is applied.</Note>}
                    </>
                )}
                <Note>
                    The key is kept only on this computer, in the studio's settings file, which only you can read; it is never written into
                    projects or logs, and only Jarvis's own requests to Anthropic use it.
                </Note>
                <ModelListRow
                    list={models.list}
                    loading={models.loading}
                    onRefresh={models.refresh}
                    hint={ai.auth === 'apiKey' && draft.apiKey ? 'The list uses the kept key: apply a new key to list its models.' : undefined}
                />
            </Section>
            <ModelChoice title="Fast" value={ai.fast} options={options} onChange={(fast) => set({ fast })} onTest={() => void test('fast')} testing={testing === 'fast'} />
            <ModelChoice title="Best" value={ai.best} options={options} onChange={(best) => set({ best })} onTest={() => void test('best')} testing={testing === 'best'} />
            <TestResult result={result} />
        </>
    );
}

/** A plain http address that is not this computer: a key sent there travels unencrypted. */
const openAddress = (url: string): boolean => {
    try {
        const u = new URL(url);
        return u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    } catch {
        return false;
    }
};

/** An OpenAI-compatible service: which one, its base URL and key, and its models for Fast and Best. */
function CompatibleForm({ draft, setDraft, saved }: PageProps) {
    const ai = draft.settings.ai;
    const c = ai.compatible;
    const preset = compatiblePreset(c.preset);
    const setCompatible = (patch: Partial<CompatibleSettings>) => setDraft(withCategory(draft, 'ai', { ...ai, compatible: { ...c, ...patch } }));
    const models = compatibleModels(c);
    const setModels = (patch: Partial<CompatibleModels>) => setCompatible({ models: { ...c.models, [c.preset]: { ...models, ...patch } } });
    const custom = c.preset === 'custom';
    const urlOk = !custom || validBaseUrl(c.baseUrl);
    const kept = saved.ai.compatibleKeys?.[c.preset] ?? '';
    const typed = draft.compatibleKeys?.[c.preset];
    const setKey = (key: string | undefined) => {
        const keys = { ...draft.compatibleKeys };
        if (key === undefined) {
            delete keys[c.preset];
        } else {
            keys[c.preset] = key;
        }
        setDraft({ ...draft, compatibleKeys: keys });
    };
    const list = useModelList({ provider: 'openai-compatible', preset: c.preset, ...(custom && urlOk ? { baseUrl: c.baseUrl } : {}) });
    const options = compatibleModelOptions(list.list);
    const [testing, setTesting] = useState<Which | null>(null);
    const [result, setResult] = useState<{ which: Which; r: AiTestResult } | null>(null);
    const test = async (which: Which) => {
        setResult(null);
        if (!models[which]) {
            setResult({ which, r: { ok: false, ms: 0, error: 'Choose a model first.' } });
            return;
        }
        setTesting(which);
        const r = await testAiConnection({
            provider: 'openai-compatible', preset: c.preset, model: models[which], ...(custom ? { baseUrl: c.baseUrl } : {}), ...(typed ? { apiKey: typed } : {}),
        });
        setTesting(null);
        setResult({ which, r });
    };
    const modelSection = (which: Which) => (
        <Section title={which === 'fast' ? 'Fast' : 'Best'}>
            <ModelField value={models[which]} options={options} placeholder="model id" onChange={(model) => setModels(which === 'fast' ? { fast: model } : { best: model })} />
            {(() => {
                const entry = options.find((m) => m.value === models[which]);
                return entry?.tools === false ? <Note>{preset.name} says this model cannot call tools: Jarvis cannot work in the studio with it.</Note> : null;
            })()}
            <TestButton testing={testing === which} onTest={() => void test(which)} />
        </Section>
    );
    return (
        <>
            <Section title="Service">
                <Choice
                    label="Service"
                    value={c.preset}
                    options={COMPATIBLE_PRESETS.map((p): [CompatiblePreset, string] => [p.id, p.name])}
                    onChange={(id) => setCompatible({ preset: id })}
                />
                <label className="tb-field">
                    <span>Base URL</span>
                    <span className="tb-input">
                        <input
                            value={custom ? c.baseUrl : preset.baseUrl}
                            readOnly={!custom}
                            placeholder="https://…/v1"
                            spellCheck={false}
                            onChange={(e) => setCompatible({ baseUrl: e.target.value.trim() })}
                        />
                    </span>
                </label>
                {custom && !urlOk && <Note>The base URL starts with http:// or https:// and ends where chat/completions and models are found, often /v1.</Note>}
                {custom && urlOk && openAddress(c.baseUrl) && <Note>This address is not encrypted (http): a key sent there could be read on the way.</Note>}
                {preset.local ? <Note>Runs on this computer: no key is needed. Start {preset.name.replace(' (on this computer)', '')} and load a model first.</Note> : (
                    <>
                        {kept && typed === undefined && (
                            <div className="op-row">
                                <span className="op-key">Key kept: {kept}</span>
                                <button type="button" className="sk-small" onClick={() => setKey('')}>Remove key</button>
                            </div>
                        )}
                        {kept && typed === '' && (
                            <div className="op-row">
                                <span className="op-key">The kept key is removed when you apply.</span>
                                <button type="button" className="sk-small" onClick={() => setKey(undefined)}>Keep it</button>
                            </div>
                        )}
                        <label className="tb-field">
                            <span>{kept ? 'New API key' : custom ? 'API key (if it needs one)' : 'API key'}</span>
                            <span className="tb-input">
                                <input
                                    type="password"
                                    autoComplete="new-password"
                                    spellCheck={false}
                                    value={typed ?? ''}
                                    placeholder={preset.keyHint || 'key'}
                                    onChange={(e) => setKey(e.target.value === '' ? undefined : e.target.value)}
                                />
                            </span>
                        </label>
                        {!kept && !typed && !custom && <Note>No key is kept for {preset.name} yet: Jarvis cannot answer until one is applied.</Note>}
                        <Note>
                            Each service keeps its own key, only on this computer in the studio's settings file, which only you can read. It is
                            never written into projects or logs, and goes only to this service's base URL.
                        </Note>
                    </>
                )}
                <ModelListRow
                    list={list.list}
                    loading={list.loading}
                    onRefresh={list.refresh}
                    hint={typed ? 'The list uses the kept key: apply a new key to list its models.' : undefined}
                />
            </Section>
            {modelSection('fast')}
            {modelSection('best')}
            <TestResult result={result} />
            <Note>
                Jarvis needs a model that can call tools (function calling) to work in the studio: local models need tool-calling support, and
                many small ones lack it. Quality varies a lot by model; Jarvis's instructions were written for Claude. Models that take no
                pictures work on without screenshots.
            </Note>
        </>
    );
}

/** The skills found, each with its description and a check box, and what they do on the provider chosen. */
export function SkillsList({ found, ai, onChange }: {
    found: SkillEntry[] | { error: string } | null; ai: AiSettings; onChange: (skills: string[]) => void;
}) {
    const list = found && !('error' in found) ? found : [];
    const on = enabledSkillIds(list, ai.skills);
    return (
        <Section title="Skills">
            {found === null && <Note>Loading skills…</Note>}
            {found && 'error' in found && <Note>{found.error}</Note>}
            {found && !('error' in found) && list.length === 0 && <Note>No skills were found.</Note>}
            {list.map((s) => (
                <div key={s.id} className="op-skill">
                    <Check
                        label={`${s.name}${s.source === 'own' ? ' (your own)' : ''}`}
                        value={on.includes(s.id)}
                        onChange={(v) => onChange(toggleSkill(ai.skills, list, s.id, v))}
                    />
                    <Note>{s.description}</Note>
                </div>
            ))}
            {ai.provider === 'claude' ? (
                <Note>
                    Jarvis uses a skill only when a job calls for it. Manage hands the pieces of a large job to part builders on the Fast
                    model and checks their work itself: it costs more tokens and time, so small jobs are done directly.
                </Note>
            ) : (
                <Note>
                    With another provider there are no part builders: the text of the skills that are on is given to the model as guidance,
                    and it does every piece itself.
                </Note>
            )}
            <Note>
                Your own skills go in the projects folder, under .studio/skills: one folder per skill holding a SKILL.md with a name and a
                description at the top, then the instructions. They are listed here the next time this page opens.
            </Note>
        </Section>
    );
}

function Skills({ draft, setDraft }: PageProps) {
    const ai = draft.settings.ai;
    const [found, setFound] = useState<SkillEntry[] | { error: string } | null>(null);
    useEffect(() => {
        void fetchSkills().then((answer) => setFound('error' in answer ? answer : answer.skills));
    }, []);
    return <SkillsList found={found} ai={ai} onChange={(skills) => setDraft(withCategory(draft, 'ai', { ...ai, skills }))} />;
}

export function AiPage(props: PageProps) {
    const { draft, setDraft } = props;
    const ai = draft.settings.ai;
    return (
        <>
            <Section title="Provider">
                <label className="tb-check">
                    <input
                        type="radio"
                        name="op-provider"
                        checked={ai.provider === 'claude'}
                        onChange={() => setDraft(withCategory(draft, 'ai', { ...ai, provider: 'claude' }))}
                    />
                    <span>Claude, through Claude Code (as before)</span>
                </label>
                <label className="tb-check">
                    <input
                        type="radio"
                        name="op-provider"
                        checked={ai.provider === 'openai-compatible'}
                        onChange={() => setDraft(withCategory(draft, 'ai', { ...ai, provider: 'openai-compatible' }))}
                    />
                    <span>Another provider with an API key (OpenAI-compatible: OpenAI, Gemini, Mistral, Groq, DeepSeek, xAI, OpenRouter, Ollama, LM Studio…)</span>
                </label>
            </Section>
            {ai.provider === 'claude' ? <ClaudeForm {...props} /> : <CompatibleForm {...props} />}
            <Skills {...props} />
            <Note>A change applies to Jarvis's next request: its conversation starts afresh; the project is not touched.</Note>
        </>
    );
}
