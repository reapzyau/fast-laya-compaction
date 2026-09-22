import type { FocusedState, Message, ToolCall, ToolResult } from './types.js';

/** Characters of the result shown to Laya, before fitting. */
const RESULT_HEAD = 200;
/** Characters of one serialised input value on a call line, before fitting. */
const INPUT_VALUE_CHARS = 200;
/** Share of the budget the goal may take. */
const GOAL_SHARE = 0.25;
/** Most tokens one later line (message text or call) may take. */
const LATER_LINE_TOKENS = 48;
/** Below this many free tokens a later line is not worth starting. */
const MIN_LINE_TOKENS = 6;
/** A later line cut shorter than this says too little to keep. */
const MIN_CUT_TOKENS = 10;

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

/**
 * Estimates tokens without a tokenizer: a word costs one token per six
 * letters, a digit half a token, any other symbol nine tenths. Calibrated
 * upstream against the usage a System One server reports for real
 * transcripts, where it lands 2–18% above the true count. Whitespace is free,
 * so lines joined by newlines never cost more than the lines on their own.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else tokens += 0.9;
  }
  return Math.ceil(tokens);
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function isPinned(
  index: number,
  total: number,
  preserveRecentMessages: number,
): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

/**
 * Pairs every tool_use with its tool_result by `tool_use_id`. Calls without a
 * result are not candidates (there is nothing to drop yet).
 */
export function collectToolCalls(
  messages: readonly Message[],
  preserveRecentMessages: number,
): ToolCall[] {
  const results = new Map<string, { index: number; result: ToolResult }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { index, result });
    }
  });
  const calls: ToolCall[] = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id);
      if (!found) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.result.text.length,
        isError: found.result.isError ?? false,
        pinned:
          isPinned(callIndex, messages.length, preserveRecentMessages) ||
          isPinned(found.index, messages.length, preserveRecentMessages),
      });
    }
  });
  return calls;
}

/** The last three user prompts, as the default `goal`. */
export function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter(
      (message) =>
        message.role === 'user' &&
        message.text.trim().length > 0 &&
        (message.toolResults ?? []).length === 0,
    )
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join('\n');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable]';
  }
}

/** A call as one line: `t3: Read file_path=src/a.ts → ok, 1000 chars`. */
export function callLine(call: ToolCall): string {
  const input = Object.entries(call.input)
    .map(([key, value]) => `${key}=${truncate(oneLine(valueText(value)), INPUT_VALUE_CHARS)}`)
    .join(' ');
  return `${call.id}: ${call.tool}${input ? ` ${input}` : ''} → ${
    call.isError ? 'error' : 'ok'
  }, ${call.resultChars} chars`;
}

/**
 * The longest cut of `text` (head only, or head and tail) whose line
 * `prefix + cut` is estimated at `maxTokens` or less; '' when not even the
 * prefix with a one-character cut fits. Binary search over the kept length;
 * only candidates that were measured to fit are ever returned.
 */
export function fitLine(
  prefix: string,
  text: string,
  maxTokens: number,
  keepTail = false,
): string {
  const whole = `${prefix}${text}`;
  if (estimateTokens(whole) <= maxTokens) return whole;
  const cut = (chars: number): string => {
    if (!keepTail || chars < 20) return `${prefix}${text.slice(0, chars)}…`;
    const tail = Math.floor(chars / 3);
    return `${prefix}${text.slice(0, chars - tail)} … ${text.slice(-tail)}`;
  };
  let lo = 0;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(cut(mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  if (lo === 0) return '';
  const line = cut(lo);
  return estimateTokens(line) <= maxTokens ? line : '';
}

function resultText(messages: readonly Message[], call: ToolCall): string {
  const found = messages[call.resultIndex]?.toolResults?.find(
    (result: ToolResult) => result.tool_use_id === call.tool_use_id,
  );
  return found?.text ?? '';
}

/**
 * The input key whose string value a later call repeats (a later read or edit
 * of the same file, a re-run of the same command), and whether that value is
 * resource-like (no whitespace: paths, patterns), which ranks it first.
 */
function sharedKey(call: ToolCall, other: ToolCall): { key: string; exact: boolean } | undefined {
  let found: { key: string; exact: boolean } | undefined;
  for (const [key, value] of Object.entries(call.input)) {
    if (typeof value !== 'string' || value.length < 3 || value.length > 300) continue;
    if (!Object.values(other.input).includes(value)) continue;
    const exact = !/\s/.test(value);
    if (exact) return { key, exact };
    found ??= { key, exact };
  }
  return found;
}

/** A later message text, or a later call (whose tail, `→ ok, N chars`, is kept when cut). */
type LaterEvent = { line: string; isCall: boolean; rank: number; shown: boolean };

/**
 * The state Laya sees for one call: plain text, in priority order — the goal
 * (at most a quarter of the budget), the call itself, the head of its result,
 * then what happened after it: later calls sharing an input value with it
 * (e.g. the same `file_path`) first, then the newest messages and calls,
 * newest last. Lines are shortened or dropped so the whole state always fits
 * `maxStateTokens`.
 */
export function focusedState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  call: ToolCall,
  options: { maxStateTokens: number; goal?: string },
): FocusedState {
  const budget = Math.max(0, Math.floor(options.maxStateTokens));
  const lines: string[] = [];
  let used = 0;
  const add = (line: string): boolean => {
    if (!line) return false;
    lines.push(line);
    used += estimateTokens(line);
    return true;
  };

  const goal = oneLine(options.goal || goalFromMessages(messages));
  if (goal) add(fitLine('Goal: ', goal, Math.floor(budget * GOAL_SHARE), true));
  add(fitLine('This call ', callLine(call), budget - used, true));
  const head = oneLine(resultText(messages, call).slice(0, RESULT_HEAD * 2)).slice(0, RESULT_HEAD);
  if (head) add(fitLine('Result starts: ', head, budget - used));

  const events: LaterEvent[] = [];
  const later = calls.filter((other) => other.callIndex > call.callIndex);
  for (let i = call.callIndex + 1; i < messages.length; i += 1) {
    const text = oneLine(messages[i]?.text ?? '');
    if (text) events.push({ line: `${messages[i]!.role}: ${text}`, isCall: false, rank: 0, shown: false });
    for (const other of later) {
      if (other.callIndex !== i) continue;
      const shared = sharedKey(call, other);
      const line = shared ? `${callLine(other)} [same ${shared.key}]` : callLine(other);
      events.push({ line, isCall: true, rank: shared ? (shared.exact ? 2 : 1) : 0, shown: false });
    }
  }
  if (events.length === 0) return { state: lines.join('\n'), tokens: estimateTokens(lines.join('\n')) };

  const header = 'Later:';
  const headerTokens = estimateTokens(header);
  const laterLines: string[] = [];
  let room = budget - used - headerTokens;
  // Same-input calls go first but may take only half the room, so the newest
  // events still show.
  let relatedRoom = Math.floor(room / 2);
  const related = events.filter((event) => event.rank > 0).sort((a, b) => b.rank - a.rank);
  for (const event of related) {
    if (relatedRoom < MIN_LINE_TOKENS) break;
    const line = fitLine('', event.line, Math.min(relatedRoom, LATER_LINE_TOKENS), true);
    if (!line || (line !== event.line && estimateTokens(line) < MIN_CUT_TOKENS)) break;
    laterLines.push(line);
    event.shown = true;
    const cost = estimateTokens(line);
    relatedRoom -= cost;
    room -= cost;
  }
  const recent: string[] = [];
  for (let e = events.length - 1; e >= 0 && room >= MIN_LINE_TOKENS; e -= 1) {
    const event = events[e]!;
    if (event.shown) continue;
    const line = fitLine('', event.line, Math.min(room, LATER_LINE_TOKENS), event.isCall);
    if (!line || (line !== event.line && estimateTokens(line) < MIN_CUT_TOKENS)) break;
    recent.push(line);
    room -= estimateTokens(line);
  }
  laterLines.push(...recent.reverse());
  if (laterLines.length > 0) add([header, ...laterLines].join('\n'));
  const state = lines.join('\n');
  return { state, tokens: estimateTokens(state) };
}
