import { describe, expect, it } from 'vitest';
import {
  compactSession,
  decisionLog,
  decisionLogLines,
  register,
  resolveHookConfig,
  summarize,
  toSessionMessages,
  withEnv,
} from '../hooks/fast-laya.ts';
import { applyDecisions, collectToolCalls, decideCall, type Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };

function message(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): SessionMessage {
  return message('assistant', '', {
    toolUses: [{ tool_use_id: id, tool, input, text }],
    handle: `h-${id}`,
  });
}

function result(id: string, text: string, isError = false): SessionMessage {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }], handle: `r-${id}` });
}

const fileA = 'export const a = 1;\n'.repeat(50);

function transcript(): SessionMessage[] {
  return [
    message('user', 'Fix the failing test.', { handle: 'h-0' }),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    call('tool-2', 'Bash', { command: 'npm test' }, 'FAIL'),
    result('tool-2', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'Fixing now.', { handle: 'h-5' }),
    message('user', 'go ahead', { handle: 'h-6' }),
  ];
}

type Sent = { url: string; headers: Record<string, string>; body: string };

function layaFetch(answer: (name: string) => number, sent: Sent[] = []) {
  return async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    sent.push({ url, headers: init?.headers ?? {}, body: init?.body ?? '' });
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

describe('hook config', () => {
  it('reads userConfig values and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({ compactAtPercent: 60, minReductionRatio: 0.25, model: 'laya-typed-decisions' });
    expect(
      resolveHookConfig({
        baseUrl: 'http://gpu:8765/v1/systemone',
        apiKey: 'k',
        keepThreshold: 0.3,
        maxStateTokens: 700,
        concurrency: 4,
        maxRequestTokens: 30_000,
        model: 'laya-multilingual',
        goal: 'g',
        compactAtPercent: 'no',
      }),
    ).toEqual({
      baseUrl: 'http://gpu:8765/v1/systemone',
      apiKey: 'k',
      keepThreshold: 0.3,
      maxStateTokens: 700,
      concurrency: 4,
      model: 'laya-multilingual',
      goal: 'g',
      compactAtPercent: 60,
      minReductionRatio: 0.25,
    });
  });
});

describe('session message mapping', () => {
  it('returns the engine objects for untouched messages and handle-less copies for rebuilt ones', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    messages[1]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[2]!.toolResults![0]!.text = 'x'.repeat(2000);
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out).toHaveLength(messages.length);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]?.handle).toBeUndefined();
    expect(out[1]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-laya-compaction truncated 1700 chars`),
    );
    expect(out[2]?.handle).toBeUndefined();
    expect(out[2]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-laya-compaction truncated 1700 chars`),
    );
    expect(out[2]?.toolResults?.[0]).toMatchObject({ tool_use_id: 'tool-1', isError: false });
    expect(out[3]).toBe(messages[3]);
    expect(out[4]).toBe(messages[4]);
  });

  it('preserves short dropped-result messages and their handles', () => {
    const messages = transcript();
    messages[1]!.toolUses[0]!.text = 'y'.repeat(100);
    messages[2]!.toolResults![0]!.text = 'y'.repeat(100);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 }),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.9 }, { keepThreshold: 0.5 }),
    ];
    const out = toSessionMessages(messages, applyDecisions(messages, decisions, calls, 300));
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });
});

describe('compactSession', () => {
  it('runs the library over the engine fetch and reports the outcome', async () => {
    const sent: Sent[] = [];
    const config = { ...resolveHookConfig({ preserveRecentMessages: 1 }), model: 'laya-multilingual' };
    const { result: output, messages } = await compactSession(
      transcript(),
      config,
      layaFetch((name) => (name === 'call_t2' || name === 'result_t2' ? 0.9 : 0.1), sent),
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]!.url).toBe('http://127.0.0.1:8765/v1/systemone');
    expect(sent[0]!.headers.authorization).toBeUndefined();
    expect(JSON.parse(sent[0]!.body).model).toBe('laya-multilingual');
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'keep']);
    expect(messages.map((m) => m.handle)).toEqual(['h-0', 'h-tool-2', 'r-tool-2', 'h-5', 'h-6']);
    expect(summarize(output)).toMatch(/^\d+% reduction; 1 kept, 1 call_dropped; 2 request\(s\), state <=~\d+ tokens$/);
    expect(decisionLog(output)).toBe('t1:Read:drop_call/call=0.10/result=0.10 t2:Bash:keep/call=0.90/result=0.90');
    expect(decisionLogLines(output)).toEqual([`decisions: ${decisionLog(output)}`]);
  });

  it('sends the key and base URL when configured and reports truncation', async () => {
    const sent: Sent[] = [];
    const config = {
      ...resolveHookConfig({ preserveRecentMessages: 1 }),
      apiKey: 'k',
      baseUrl: 'http://gpu:8765/v1/systemone',
    };
    const fetchFn = async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
      const response = await layaFetch(() => 0.9, sent)(url, init);
      const body = JSON.parse(response.text) as Record<string, unknown>;
      return { ...response, text: JSON.stringify({ ...body, truncation: { state: 40 } }) };
    };
    const { result: output } = await compactSession(transcript(), config, fetchFn);
    expect(sent.every((r) => r.headers.authorization === 'Bearer k')).toBe(true);
    expect(sent.every((r) => r.url === 'http://gpu:8765/v1/systemone')).toBe(true);
    expect(output.stats.truncatedRequests).toBe(2);
    expect(summarize(output)).toMatch(/, 2 truncated by Laya$/);
  });

  it('splits a long decision log into ui.log lines under the host limit', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    const { result: output } = await compactSession(transcript(), config, layaFetch(() => 0.1));
    const lines = decisionLogLines(output, 60);
    expect(lines).toEqual([
      'decisions (1/2): t1:Read:drop_call/call=0.10/result=0.10',
      'decisions (2/2): t2:Bash:drop_call/call=0.10/result=0.10',
    ]);
    expect(lines.every((line) => line.length <= 60)).toBe(true);
    expect(decisionLogLines({ ...output, decisions: [] })).toEqual(['decisions: (none)']);
  });

  it('throws on failed or unreachable requests so the hook falls back', async () => {
    const config = resolveHookConfig({ preserveRecentMessages: 1 });
    await expect(
      compactSession(transcript(), config, async () => ({ status: 500, ok: false, text: 'x' })),
    ).rejects.toThrow(/500/);
    await expect(
      compactSession(transcript(), config, async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:8765');
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

function envSource(env: Record<string, string>, settingsEnv: Record<string, string> = {}) {
  return {
    env: { get: async (name: string) => env[name] },
    settings: { read: async () => ({ env: settingsEnv }) },
  };
}

describe('environment fallbacks', () => {
  it('prefers options, then LAYA_BASE_URL / LAYA_API_KEY, then the settings env, else leaves them unset', async () => {
    const base = resolveHookConfig({});
    expect(await withEnv(envSource({}), base)).toEqual(base);
    expect(
      await withEnv(envSource({ LAYA_BASE_URL: 'http://env/v1/systemone', LAYA_API_KEY: 'env-key' }), base),
    ).toMatchObject({ baseUrl: 'http://env/v1/systemone', apiKey: 'env-key' });
    expect(
      await withEnv(envSource({}, { LAYA_BASE_URL: 'http://settings/v1/systemone', LAYA_API_KEY: 's-key' }), base),
    ).toMatchObject({ baseUrl: 'http://settings/v1/systemone', apiKey: 's-key' });
    expect(
      await withEnv(
        envSource({ LAYA_API_KEY: 'env-key' }),
        resolveHookConfig({ apiKey: 'opt', baseUrl: 'http://opt/v1/systemone' }),
      ),
    ).toMatchObject({ baseUrl: 'http://opt/v1/systemone', apiKey: 'opt' });
  });
});

type Handler = (...args: any[]) => Promise<unknown>;

function fakeEngine(fetchImpl: (url: string, init?: unknown) => Promise<unknown>) {
  const handlers = new Map<string, Handler>();
  const toasts: string[] = [];
  const logs: string[] = [];
  const $ = {
    env: { get: async () => undefined },
    settings: { read: async () => ({}) },
    http: { fetch: fetchImpl },
    ui: {
      log: (text: string) => logs.push(text),
      toast: (text: string) => toasts.push(text),
    },
  };
  const on = (event: string, handler: Handler) => handlers.set(event, handler);
  return { handlers, toasts, logs, $, on };
}

describe('session.compact hook', () => {
  it('falls back to the built-in summary when the Laya server is down', async () => {
    const engine = fakeEngine(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8765');
    });
    register(engine.on as never, { preserveRecentMessages: 1 });
    const event = { messages: transcript() };
    const builtIn = { summary: 'built-in' };
    const out = await engine.handlers.get('session.compact')!(engine.$, event, async () => builtIn);
    expect(out).toBe(builtIn);
    expect(engine.toasts).toEqual(['fallback to built-in summary (connect ECONNREFUSED 127.0.0.1:8765)']);
  });

  it('replaces the summary with the pruned history when the reduction is large enough', async () => {
    const engine = fakeEngine(async (_url, init) => {
      const response = await layaFetch(() => 0.1)(_url, init as { body?: string });
      return { ...response, headers: {} };
    });
    register(engine.on as never, { preserveRecentMessages: 1, minReductionRatio: 0.1 });
    const out = (await engine.handlers.get('session.compact')!(
      engine.$,
      { messages: transcript() },
      async () => ({ summary: 'built-in' }),
    )) as { messages: SessionMessage[] };
    expect(out.messages.map((m) => m.handle)).toEqual(['h-0', 'h-5', 'h-6']);
    expect(engine.toasts[0]).toMatch(/^kept 3\/7 messages, no summary \(/);
  });
});
