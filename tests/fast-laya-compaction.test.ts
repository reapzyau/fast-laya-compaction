import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyDecisions,
  buildLayaRequest,
  collectToolCalls,
  compact,
  compactMessages,
  decideCall,
  estimateTokens,
  fitLine,
  focusedState,
  LayaClient,
  mapLimit,
  MODEL_STATE_TOKENS,
  parseLayaResponse,
  questionsFor,
  reductionRatio,
  resolveOptions,
  stateTokensFor,
  type LayaAsker,
  type LayaQuestions,
  type Message,
} from '../src/index.js';

function message(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}

function call(id: string, tool: string, input: Record<string, unknown>, text: string): Message {
  return message('assistant', '', { toolUses: [{ tool_use_id: id, tool, input, text }] });
}

function result(id: string, text: string, isError = false): Message {
  return message('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

const fileA = 'export const a = 1;\n'.repeat(50);
const fileB = 'export const b = 2;\n'.repeat(50);

function transcript(): Message[] {
  return [
    message('user', 'Never edit anything under src/generated. Fix the failing test.'),
    call('tool-1', 'Read', { file_path: 'src/a.ts' }, fileA),
    result('tool-1', fileA),
    message('assistant', 'a.ts looks fine; checking b.ts'),
    call('tool-2', 'Read', { file_path: 'src/b.ts' }, fileB),
    result('tool-2', fileB),
    call('tool-3', 'Bash', { command: 'npm test' }, 'FAIL b.test.ts'),
    result('tool-3', 'FAIL b.test.ts: expected 2 to be 3', true),
    message('assistant', 'The failure is in b.test.ts; fixing now.'),
    message('user', 'go ahead'),
  ];
}

type Seen = { state: unknown; questions: string[] };

function fakeLaya(
  answer: (name: string) => number,
  seen: Seen[] = [],
  extra: (state: unknown) => Record<string, unknown> = () => ({}),
): LayaAsker {
  return {
    async ask(state, questions: LayaQuestions) {
      seen.push({ state, questions: Object.keys(questions) });
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul' as const, noul: answer(key) }]),
        ),
        ...extra(state),
      };
    },
  };
}

/** A realistic long session: 40 tool calls over a handful of files. */
function longTranscript(): Message[] {
  const files = ['src/parser.ts', 'src/lexer.ts', 'src/checkout.ts', 'src/cart.ts', 'README.md'];
  const messages: Message[] = [
    message(
      'user',
      'Fix the failing parser test in the checkout service. Do not touch legacy/. Keep the public parser API backward compatible, and add a changelog entry when done. ' +
        'Context: the CI job has been red since Tuesday and the release is blocked on it. '.repeat(3),
    ),
  ];
  for (let i = 0; i < 40; i += 1) {
    const file = files[i % files.length]!;
    const kind = i % 4;
    const id = `toolu_${i}`;
    if (kind === 0) {
      const body = `// ${file}\n${'export function step(tokens: Token[]): Node { return next(tokens); }\n'.repeat(60)}`;
      messages.push(call(id, 'Read', { file_path: file }, body), result(id, body));
    } else if (kind === 1) {
      messages.push(
        call(id, 'Edit', { file_path: file, old_string: 'if (token === COMMA) advance();', new_string: 'if (token === COMMA) {\n  if (next === CLOSE) continue;\n  advance();\n}' }, 'updated'),
        result(id, `The file ${file} has been updated.`),
      );
    } else if (kind === 2) {
      const out = `FAIL src/parser.test.ts\n  parser > accepts a trailing comma\n    Expected: true\n    Received: false\n${'    at step (src/parser.ts:42:11)\n'.repeat(30)}`;
      messages.push(call(id, 'Bash', { command: 'npx vitest run src/parser.test.ts --reporter verbose' }, out), result(id, out, true));
    } else {
      messages.push(call(id, 'Grep', { pattern: 'COMMA', path: 'src' }, 'src/parser.ts:42\nsrc/lexer.ts:17'), result(id, 'src/parser.ts:42\nsrc/lexer.ts:17'));
    }
    if (i % 5 === 4) {
      messages.push(message('assistant', `Step ${i}: the token loop in ${file} stops one token early when a comma precedes the closing brace; adjusting the transition without changing the exported API.`));
    }
  }
  messages.push(message('user', 'Looks close. Run the whole suite and then write the changelog entry.'));
  return messages;
}

describe('options', () => {
  it('fills in defaults, derives the state budget from the model and ignores non-finite values', () => {
    expect(resolveOptions()).toEqual({
      goal: '',
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      maxStateTokens: 768,
      truncateHeadChars: 300,
      concurrency: 8,
    });
    expect(resolveOptions({ model: 'laya-english' }).maxStateTokens).toBe(320);
    expect(resolveOptions({ model: 'laya-multilingual' }).maxStateTokens).toBe(768);
    expect(resolveOptions({ model: 'laya-typed-decisions' }).maxStateTokens).toBe(768);
    expect(resolveOptions({ model: 'laya' }).maxStateTokens).toBe(320);
    expect(resolveOptions({ model: 'something-else' }).maxStateTokens).toBe(320);
    expect(resolveOptions({ model: 'laya-multilingual', maxStateTokens: 500 }).maxStateTokens).toBe(500);
    expect(stateTokensFor(undefined)).toBe(MODEL_STATE_TOKENS['laya-typed-decisions']);
    expect(resolveOptions({
      keepThreshold: Number.NaN,
      preserveRecentMessages: 2.7,
      truncateHeadChars: -1.2,
      concurrency: 0,
    })).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 2,
      truncateHeadChars: 0,
      concurrency: 1,
    });
  });
});

describe('token estimate', () => {
  it('charges words, digits and symbols separately and never undercounts JSON badly', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBe(2);
    expect(estimateTokens('internationalization')).toBe(4);
    expect(estimateTokens('12345678')).toBe(4);
    const json = JSON.stringify({ file_path: '/Users/x/src/a.ts', old_string: 'a = 1;', n: 42 });
    expect(estimateTokens(json)).toBeGreaterThanOrEqual(Math.ceil(json.length / 3));
  });
});

describe('tool call collection', () => {
  it('pairs each tool call with its result and pins recent ones', () => {
    const calls = collectToolCalls(transcript(), 3);
    expect(calls.map((c) => [c.id, c.tool, c.callIndex, c.resultIndex, c.pinned])).toEqual([
      ['t1', 'Read', 1, 2, false],
      ['t2', 'Read', 4, 5, false],
      ['t3', 'Bash', 6, 7, true],
    ]);
    expect(calls[2]?.isError).toBe(true);
    expect(calls[0]?.resultChars).toBe(fileA.length);
  });

  it('ignores calls without a result', () => {
    expect(collectToolCalls([message('user', 'hi'), call('x', 'Read', {}, '')], 0)).toHaveLength(0);
  });
});

describe('focused state', () => {
  it('holds the goal, the call, the head of its result and what came after', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const { state, tokens } = focusedState(messages, calls, calls[0]!, { maxStateTokens: 320 });
    const lines = state.split('\n');
    expect(lines[0]).toMatch(/^Goal: Never edit anything under src\/generated\. Fix the failing test\. go ahead$/);
    expect(lines[1]).toBe(`This call t1: Read file_path=src/a.ts → ok, ${fileA.length} chars`);
    expect(lines[2]).toMatch(/^Result starts: export const a = 1; export const a = 1;/);
    expect(lines[3]).toBe('Later:');
    expect(state).toContain('assistant: a.ts looks fine; checking b.ts');
    expect(state).toContain('t3: Bash command=npm test → error,');
    expect(state.trimEnd().endsWith('user: go ahead')).toBe(true);
    expect(state).not.toContain('export const b = 2');
    expect(tokens).toBe(estimateTokens(state));
    expect(tokens).toBeLessThanOrEqual(320);
  });

  it('never exceeds maxStateTokens, however small the budget or long the session', () => {
    const messages = longTranscript();
    const calls = collectToolCalls(messages, 6);
    for (const budget of [0, 5, 20, 40, 80, 160, 320, 768]) {
      for (const call of calls) {
        const { state, tokens } = focusedState(messages, calls, call, { maxStateTokens: budget });
        expect(tokens).toBe(estimateTokens(state));
        expect(tokens).toBeLessThanOrEqual(budget);
      }
    }
    const { state } = focusedState(messages, calls, calls[0]!, { maxStateTokens: 320 });
    expect(state).toMatch(/^Goal: /);
    expect(state).toContain('This call t1: Read file_path=src/parser.ts');
  });

  it('caps the goal at a quarter of the budget, keeping its head and tail', () => {
    const messages = longTranscript();
    const calls = collectToolCalls(messages, 6);
    const { state } = focusedState(messages, calls, calls[3]!, { maxStateTokens: 320 });
    const goal = state.split('\n')[0]!;
    expect(estimateTokens(goal)).toBeLessThanOrEqual(80);
    expect(goal).toContain(' … ');
    expect(goal.endsWith('write the changelog entry.')).toBe(true);
  });

  it('lists later calls on the same input first, marked, then the newest events', () => {
    const messages = longTranscript();
    const calls = collectToolCalls(messages, 6);
    const { state } = focusedState(messages, calls, calls[0]!, { maxStateTokens: 320 });
    const later = state.split('Later:\n')[1]!.split('\n');
    // t1 read src/parser.ts; the first later line is the next call on that file.
    expect(later[0]).toMatch(/^t\d+: \w+ file_path=src\/parser\.ts .* \[same file_path\]$/);
    const firstRecent = later.findIndex((line) => !line.endsWith('[same file_path]'));
    expect(firstRecent).toBeGreaterThan(0);
    expect(later.at(-1)).toBe('user: Looks close. Run the whole suite and then write the changelog entry.');
  });

  it('uses an explicit goal and fits lines by measurement', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const { state } = focusedState(messages, calls, calls[1]!, { maxStateTokens: 320, goal: 'ship it' });
    expect(state.split('\n')[0]).toBe('Goal: ship it');
    expect(fitLine('P: ', 'hello world', 100)).toBe('P: hello world');
    const cut = fitLine('P: ', 'lorem ipsum '.repeat(100), 10);
    expect(cut.startsWith('P: lorem')).toBe(true);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(10);
    expect(fitLine('Prefix: ', 'x'.repeat(50), 1)).toBe('');
  });
});

describe('decisions', () => {
  const options = { keepThreshold: 0.5 };
  const unpinned = { id: 't1', tool: 'Read', pinned: false };

  it('keeps, drops the result, or drops the call based on the keep probabilities', () => {
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.7 }, options).action).toBe('keep');
    expect(decideCall(unpinned, { keepCall: 0.9, keepResult: 0.2 }, options).action).toBe('drop_result');
    expect(decideCall(unpinned, { keepCall: 0.1, keepResult: 0.2 }, options).action).toBe('drop_call');
    expect(decideCall({ ...unpinned, pinned: true }, { keepCall: 0, keepResult: 0 }, options)).toMatchObject({
      action: 'keep',
      reason: 'pinned',
    });
  });

  it('removes dropped calls and truncates dropped results', () => {
    const messages = transcript();
    messages[4]!.toolUses[0]!.text = 'x'.repeat(2000);
    messages[5]!.toolResults![0]!.text = 'x'.repeat(2000);
    const calls = collectToolCalls(messages, 0);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.1, keepResult: 0.1 }, options),
      decideCall(calls[1]!, { keepCall: 0.9, keepResult: 0.1 }, options),
      decideCall(calls[2]!, { keepCall: 0.9, keepResult: 0.9 }, options),
    ];
    const kept = applyDecisions(messages, decisions, calls, 300);

    expect(kept.map((m) => m.text || m.toolUses[0]?.tool_use_id || m.toolResults?.[0]?.tool_use_id)).toEqual([
      'Never edit anything under src/generated. Fix the failing test.',
      'a.ts looks fine; checking b.ts',
      'tool-2',
      'tool-2',
      'tool-3',
      'tool-3',
      'The failure is in b.test.ts; fixing now.',
      'go ahead',
    ]);
    expect(kept[0]).toBe(messages[0]);
    expect(kept[2]).not.toBe(messages[4]);
    expect(kept[2]?.toolUses[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-laya-compaction truncated 1700 chars`),
    );
    expect(kept[3]?.toolResults?.[0]?.text).toMatch(
      new RegExp(`^${'x'.repeat(300)}\\n\\[fast-laya-compaction truncated 1700 chars`),
    );
    expect(kept[2]).not.toBe(messages[4]);
    expect(kept[3]).not.toBe(messages[5]);
    expect(kept[4]).toBe(messages[6]);
    expect(kept[5]?.toolResults?.[0]?.text).toContain('expected 2 to be 3');

    const shortMessages = transcript();
    shortMessages[4]!.toolUses[0]!.text = 'y'.repeat(100);
    shortMessages[5]!.toolResults![0]!.text = 'y'.repeat(100);
    const shortKept = applyDecisions(shortMessages, decisions, calls, 300);
    expect(shortKept[2]).toBe(shortMessages[4]);
    expect(shortKept[3]).toBe(shortMessages[5]);
  });

  it('honours truncateHeadChars, including a zero head', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const decisions = [decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, { keepThreshold: 0.5 })];
    const original = messages[2]!.toolResults![0]!.text;
    const total = original.length;

    const kept = applyDecisions(messages, decisions, calls, 50);
    expect(kept[2]?.toolResults?.[0]?.text).toBe(
      `${original.slice(0, 50)}\n[fast-laya-compaction truncated ${total - 50} chars of this tool result; re-run the tool if needed]`,
    );
    expect(kept[1]?.toolUses[0]?.text).toBe(kept[2]?.toolResults?.[0]?.text);

    const noHead = applyDecisions(messages, decisions, calls, 0);
    expect(noHead[2]?.toolResults?.[0]?.text).toBe(
      `[fast-laya-compaction truncated ${total} chars of this tool result; re-run the tool if needed]`,
    );
  });
});

describe('questionsFor', () => {
  it('asks both sides with criteria and keeps the call context out of the question text', () => {
    const questions = questionsFor({ id: 't7' });
    expect(Object.keys(questions)).toEqual(['call_t7', 'result_t7']);
    expect(questions.call_t7).toEqual({
      type: 'noul',
      instructions: 'The fact that this tool call was made, with its input, must stay in the history.',
      criteria: {
        true: 'What was asked for still matters for the work that follows.',
        false: 'The call served a finished or abandoned step; forgetting it costs nothing.',
      },
    });
    expect(questions.result_t7).toEqual({
      type: 'noul',
      instructions: 'The full output of this tool call must stay in the history word for word.',
      criteria: {
        true:
          'The assistant will read facts from this output again; the information is not repeated anywhere later and re-running the tool would not recover it.',
        false:
          'The output is stale, superseded by a later call, or its task is finished; deleting it costs nothing.',
      },
    });
    for (const question of Object.values(questions)) {
      expect(JSON.stringify(question)).not.toContain('t7');
    }
  });
});

describe('compact', () => {
  it('sends one request per candidate call with that call\'s two questions', async () => {
    const seen: Seen[] = [];
    const messages = transcript();
    const output = await compact(
      messages,
      fakeLaya((name) => (name.startsWith('call_') ? 0.9 : 0.1), seen),
      { preserveRecentMessages: 1 },
    );

    expect(seen.map((r) => r.questions)).toEqual([
      ['call_t1', 'result_t1'],
      ['call_t2', 'result_t2'],
      ['call_t3', 'result_t3'],
    ]);
    expect(seen.every((r) => typeof r.state === 'string')).toBe(true);
    expect(seen[1]!.state).toContain('This call t2: Read file_path=src/b.ts');
    expect(output.stats.requests).toBe(3);
    expect(output.stats.truncatedRequests).toBe(0);
    expect(output.stats.stateTokens).toBe(
      Math.max(...seen.map((r) => estimateTokens(String(r.state)))),
    );
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_result', 'drop_result', 'drop_result']);
    expect(output.messages).toHaveLength(messages.length);
    expect(output.stats).toMatchObject({ resultsDropped: 3, kept: 0, callsDropped: 0, pinned: 0 });
    expect(reductionRatio(output)).toBeGreaterThan(0);
  });

  it('respects the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const asker: LayaAsker = {
      async ask(_state, questions) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return {
          answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 0.9 }])),
        };
      },
    };
    const output = await compact(longTranscript(), asker, { preserveRecentMessages: 6, concurrency: 3 });
    expect(output.stats.requests).toBeGreaterThan(30);
    expect(peak).toBe(3);

    const order = await mapLimit([30, 10, 20], 2, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return i;
    });
    expect(order).toEqual([0, 1, 2]);
  });

  it('counts responses that report truncation', async () => {
    const output = await compact(
      transcript(),
      fakeLaya(
        () => 0.9,
        [],
        (state) => (String(state).includes('This call t2') ? { truncation: { state: 12 } } : {}),
      ),
      { preserveRecentMessages: 1 },
    );
    expect(output.stats.truncatedRequests).toBe(1);
  });

  it('keeps every per-call state of a 40-call session under the model budget', async () => {
    const narrowSeen: Seen[] = [];
    const narrow = await compact(longTranscript(), fakeLaya(() => 0.9, narrowSeen), {
      preserveRecentMessages: 6,
      model: 'laya-english',
    });
    expect(narrowSeen.length).toBe(narrow.stats.requests);
    for (const request of narrowSeen) {
      expect(estimateTokens(String(request.state))).toBeLessThanOrEqual(320);
    }
    expect(narrow.stats.stateTokens).toBeLessThanOrEqual(320);

    const seen: Seen[] = [];
    const output = await compact(longTranscript(), fakeLaya(() => 0.9, seen), { preserveRecentMessages: 6 });
    expect(seen.length).toBe(output.stats.requests);
    for (const request of seen) expect(estimateTokens(String(request.state))).toBeLessThanOrEqual(768);
    expect(output.stats.stateTokens).toBeLessThanOrEqual(768);
    expect(output.stats.stateTokens).toBeGreaterThan(narrow.stats.stateTokens);

    const wide = await compact(longTranscript(), fakeLaya(() => 0.9), {
      preserveRecentMessages: 6,
      model: 'laya-multilingual',
    });
    expect(wide.stats.stateTokens).toBeGreaterThan(narrow.stats.stateTokens);
    expect(wide.stats.stateTokens).toBeLessThanOrEqual(768);
  });

  it('keeps everything without calling Laya when no tool call is a candidate', async () => {
    const seen: Seen[] = [];
    const messages = [message('user', 'hello'), message('assistant', 'hi')];
    const output = await compact(messages, fakeLaya(() => 0, seen));
    expect(seen).toHaveLength(0);
    expect(output.stats).toMatchObject({ requests: 0, stateTokens: 0, truncatedRequests: 0, calls: 0 });
    expect(output.messages).toEqual(messages);
  });

  it('reports a tiny reduction when Laya wants everything kept', async () => {
    const output = await compact(transcript(), fakeLaya(() => 0.95), { preserveRecentMessages: 1 });
    expect(output.decisions.every((d) => d.action === 'keep')).toBe(true);
    expect(reductionRatio(output)).toBe(0);
  });

  it('rejects malformed answers', async () => {
    const broken: LayaAsker = {
      ask: async () => ({ answers: { call_t1: { noul: 0.5 } } }),
    };
    await expect(compact(transcript(), broken, { preserveRecentMessages: 1 })).rejects.toThrow(
      /Invalid Laya answer/,
    );
  });
});

describe('HTTP client', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds a System One request for the local server, with auth only when a key is set', () => {
    const questions = { q: { type: 'noul' as const, instructions: 'x' } };
    const open = buildLayaRequest({}, 'state', questions);
    expect(open.url).toBe('http://127.0.0.1:8765/v1/systemone');
    expect(open.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(open.body)).toEqual({ model: 'laya-typed-decisions', state: 'state', questions });

    const keyed = buildLayaRequest({ apiKey: 'k', baseUrl: 'http://gpu:9000/v1/systemone', model: 'laya' }, 'state', questions);
    expect(keyed.headers.authorization).toBe('Bearer k');
    expect(keyed.url).toBe('http://gpu:9000/v1/systemone');
    expect(JSON.parse(keyed.body).model).toBe('laya');
  });

  it('rejects failed and malformed responses', () => {
    expect(() => parseLayaResponse(500, false, 'boom')).toThrow(/500/);
    expect(() => parseLayaResponse(200, true, 'not json')).toThrow(/malformed/);
    expect(() => parseLayaResponse(200, true, '{}')).toThrow(/missing answers/);
    expect(parseLayaResponse(200, true, '{"answers":{}}')).toEqual({ answers: {} });
  });

  function recordingFetch(calls: { url: string; headers: Record<string, string>; body: string }[]) {
    return (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
      const { questions } = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };
      const answers = Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 0.4 }]));
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as typeof fetch;
  }

  it('asks over fetch without a key, and with one from the options or LAYA_API_KEY', async () => {
    vi.stubEnv('LAYA_API_KEY', '');
    vi.stubEnv('LAYA_BASE_URL', '');
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const keyless = new LayaClient({ fetch: recordingFetch(seen), model: 'laya-test' });
    const response = await keyless.ask('state', { q: { type: 'noul', instructions: 'x' } });
    expect(response.answers.q).toEqual({ noul: 0.4 });
    expect(seen[0]!.url).toBe('http://127.0.0.1:8765/v1/systemone');
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(JSON.parse(seen[0]!.body).model).toBe('laya-test');

    await new LayaClient({ fetch: recordingFetch(seen), apiKey: 'opt' }).ask('s', {});
    expect(seen[1]!.headers.authorization).toBe('Bearer opt');

    vi.stubEnv('LAYA_API_KEY', 'env-key');
    vi.stubEnv('LAYA_BASE_URL', 'http://laya.lan:8765/v1/systemone');
    await new LayaClient({ fetch: recordingFetch(seen) }).ask('s', {});
    expect(seen[2]!.headers.authorization).toBe('Bearer env-key');
    expect(seen[2]!.url).toBe('http://laya.lan:8765/v1/systemone');

    await new LayaClient({ fetch: recordingFetch(seen), baseUrl: 'http://explicit/v1/systemone' }).ask('s', {});
    expect(seen[3]!.url).toBe('http://explicit/v1/systemone');
  });

  it('compacts end to end over fetch with no key configured', async () => {
    vi.stubEnv('LAYA_API_KEY', '');
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const output = await compactMessages(transcript(), { preserveRecentMessages: 1, fetch: recordingFetch(seen) });
    expect(seen).toHaveLength(3);
    expect(seen.every((r) => r.headers.authorization === undefined)).toBe(true);
    expect(output.decisions.map((d) => d.action)).toEqual(['drop_call', 'drop_call', 'drop_call']);
  });
});
