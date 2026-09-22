/**
 * Runs the shipped defaults over a real Claude Code session transcript, so the
 * reduction figure in the README comes from a real history rather than the
 * labelled cases. Needs a running laya-server.
 *
 *   npm run bench:transcript -- ~/.claude/projects/<project>/<session>.jsonl 300
 *
 * The second argument caps how many parsed messages are used (0 = all). Options
 * are the library defaults unless overridden with `--model=`/`--baseUrl=`.
 */
import { readFileSync } from 'node:fs';

import { compactMessages, reductionRatio, type Message, type ToolResult, type ToolUse } from '../src/index.js';

/** Parses a Claude Code session `.jsonl` into the library's `Message[]`. */
export function parseSessionJsonl(jsonl: string): Message[] {
  const messages: Message[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    const role = entry.type;
    if (!entry.message || (role !== 'user' && role !== 'assistant')) continue;
    const raw = entry.message.content;
    const blocks: Record<string, unknown>[] = Array.isArray(raw)
      ? (raw as Record<string, unknown>[])
      : typeof raw === 'string'
        ? [{ type: 'text', text: raw }]
        : [];
    let text = '';
    const toolUses: ToolUse[] = [];
    const toolResults: ToolResult[] = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        text += typeof block.text === 'string' ? block.text : '';
      } else if (block.type === 'tool_use') {
        toolUses.push({
          tool_use_id: String(block.id),
          tool: String(block.name),
          input: (block.input as Record<string, unknown>) ?? {},
        });
      } else if (block.type === 'tool_result') {
        toolResults.push({
          tool_use_id: String(block.tool_use_id),
          text: resultText(block.content),
          isError: block.is_error === true,
        });
      }
    }
    if (!text && toolUses.length === 0 && toolResults.length === 0) continue;
    const message: Message = { role, text, toolUses };
    if (toolResults.length > 0) message.toolResults = toolResults;
    messages.push(message);
  }
  return messages;
}

/** A `tool_result` body is a string, a list of blocks, or something else. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string' ? part : String((part as { text?: unknown })?.text ?? ''),
      )
      .join('\n');
  }
  return JSON.stringify(content ?? '');
}

function flag(name: string): string | undefined {
  const found = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`));
  return found?.slice(name.length + 3);
}

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const path = positional[0];
if (!path) {
  console.error('usage: npm run bench:transcript -- <path-to-session.jsonl> [limit]');
  process.exit(1);
}
const limit = Number(positional[1] ?? '0');

const messages = parseSessionJsonl(readFileSync(path, 'utf8'));
const slice = limit > 0 ? messages.slice(0, limit) : messages;
const model = flag('model');
const baseUrl = flag('baseUrl');
const result = await compactMessages(slice, {
  ...(model ? { model } : {}),
  ...(baseUrl ? { baseUrl } : {}),
});

console.log(
  `messages ${result.stats.messagesBefore} → ${result.stats.messagesAfter}  chars ${(
    result.stats.charsBefore / 1000
  ).toFixed(0)}k → ${(result.stats.charsAfter / 1000).toFixed(0)}k  reduction ${(
    reductionRatio(result) * 100
  ).toFixed(1)}%`,
);
console.log(
  `calls ${result.stats.calls} (kept ${result.stats.kept}, results dropped ${result.stats.resultsDropped}, calls dropped ${result.stats.callsDropped}, pinned ${result.stats.pinned}); ${result.stats.requests} requests, ${result.stats.truncatedRequests} truncated, state <=~${result.stats.stateTokens} tokens, ${result.stats.ms} ms`,
);
