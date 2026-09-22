# fast-laya-compaction

Claude Code plugin that replaces the compaction summary with decisions from
Laya, an open-weights System One model (Convai Innovations, Apache-2.0) you run
on your own machine: every tool call and result is scored, stale ones are
dropped or truncated, everything kept stays verbatim. Also usable as an npm
library.

A port of [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction),
which does the same with TypeSafe's hosted Jev model. Laya is served with the
same Jev-compatible wire format, so the library shape is unchanged; what
changed is the state each question sees (below).

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Laya says are no longer needed. User and assistant text
stays verbatim and in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## What changed from upstream, and why

Jev takes a 32k-token request, so upstream sends the *whole history* (up to
25k tokens) as one state and batches many questions against it.

Laya evaluates **each question in its own small window, state and question
together**:

| Model | Window per question | State room (default `maxStateTokens`) |
| --- | ---: | ---: |
| `laya-typed-decisions` (default) | 1024 | 768 |
| `laya-multilingual` | 1024 | 768 |
| `laya-english` | 512 | 320 |
| `laya` (router → English or multilingual) | treat as 512 | 320 |

Anything over is cut by the server, which reports it with a `truncation` key in
the response (and an `x-laya-truncated` header). A 25k-token history would
leave Laya nearly blind, so this port replaces the whole-history state with a
**focused state per call**, and sends one request per call.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. For every other call, a **focused state** is built: plain text, not JSON,
   fitted into `maxStateTokens` by construction (it never throws). In priority
   order:
   - `Goal: …` the goal (`goal` option, else the last three user prompts),
     head and tail kept, capped at a quarter of the budget;
   - `This call t6: Edit file_path=src/parser.ts … → ok, 40 chars`;
   - `Result starts: …` the first ~200 characters of the result,
     whitespace collapsed;
   - `Later:` what happened after the call, one line each: first the later
     calls that repeat one of this call's input values, marked
     `[same file_path]` (a later read or edit of the same file is the strongest
     sign an earlier result is stale; path-like values rank above ones with
     spaces), taking at most half the remaining room; then the newest messages
     and calls, newest last. Lines are cut to fit and dropped when they don't.

   Tokens are estimated without a tokenizer (a word per six letters, half a
   token per digit, ~one per other symbol), calibrated upstream to land a
   little above real counts.
3. Each call gets one request with two short `noul` questions, `call_tN` ("the
   fact that this tool call was made, with its input, must stay in the
   history") and `result_tN` ("the full output of this tool call must stay in
   the history word for word"). Both carry a `criteria.true` and a
   `criteria.false` line saying what each side looks like — that wording is
   worth 4 of the 18 labelled cases below. The call's id, tool and result size
   stay in the state, never in the question. Requests run `concurrency` at a
   time (8 by default).
4. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
5. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Laya failures (server down, HTTP errors, malformed answers) throw; the caller
(or the Claude Code hook) decides what to fall back to.

A focused state from the 40-call session in the tests, 312 estimated tokens
against the narrower 320-token `laya-english` budget (the goal line is
shortened here):

```text
Goal: Fix the failing parser test in the checkout service. Do not touch legacy/. … Looks close. Run the whole suite and then write the changelog entry.
This call t6: Edit file_path=src/parser.ts old_string=if (token === COMMA) advance(); new_string=if (token === COMMA) { if (next === CLOSE) continue; advance(); } → ok, 40 chars
Result starts: The file src/parser.ts has been updated.
Later:
t21: Read file_path=src/parser.ts → ok, 4157 chars [same file_path]
t26: Edit file_path=src/parser.ts old_string=if (token === COMMA) advance(); new_string … dvance(); } → ok, 40 chars [same file_path]
t39: Bash command=npx vite … , 1119 chars
t40: Grep pattern=COMMA path=src → ok, 32 chars
assistant: Step 39: the token loop in README.md stops one token early when a comma precedes the closing brace; adjusting the transition without changing the exported API.
user: Looks close. Run the whole suite and then write the changelog entry.
```

## Does it work?

`bench/` holds 18 labelled focused states of the shape above — nine whose tool
result must survive compaction, nine whose result is safe to delete (superseded
reads, finished tasks, abandoned paths, duplicate fetches). `npm run bench`
scores a model and a question wording against them, one request per case,
against your own server:

```sh
npm run bench                                         # the four rows below
npm run bench -- --models=laya-typed-decisions --wordings=criteria
npm run bench:transcript -- ~/.claude/projects/<project>/<session>.jsonl 300
```

| model | question wording | correct | separation |
| --- | --- | ---: | ---: |
| `laya-typed-decisions` (default) | criteria (default) | **14/18** | 0.020 |
| `laya-typed-decisions` | plain | 10/18 | −0.005 |
| `laya-english` | plain (the old default) | 10/18 | −0.054 |
| `laya-english` | criteria | 7/18 | −0.049 |

"criteria" is the shipped wording: each question carries a `criteria.true` and
a `criteria.false` line. "plain" is the single-instruction wording it replaced.
The winning pair gets all nine drop cases right; its four misses are all keeps
it would have deleted.

On a real 300-message Claude Code transcript (573k characters, 97 tool calls),
the defaults cut **23.7%** of the characters against **5.7%** for the old
`laya-english` + plain configuration, and dropped no tool call at all — the
whole saving came from truncating results.

Honest about what that means:

- The separation between the two classes is only ~0.02. The ranking is right
  far more often than the absolute probabilities are; a `keepThreshold` tuned
  away from 0.5 will move the score around a lot.
- Laya errs toward deleting things still needed. All four misses of the winning
  configuration are keep cases scored just under the threshold (0.46–0.48), and
  a deleted result is only recoverable by re-running the tool.
- 23.7% on a real session sits just *under* the plugin's `minReductionRatio`
  fallback floor of `0.25`, so that very session would still have fallen back
  to Claude Code's built-in summary. The new defaults move the typical session
  from nowhere near the floor to right on it; they do not clear it by a
  comfortable margin. Lower `minReductionRatio` if you would rather keep a 20%
  verbatim history than take a summary.
- 18 cases is a small, hand-written bench written by the same person who chose
  the wording. Treat it as a regression guard, not as evidence of a general
  capability.

## Running Laya locally

Laya is served by [laya-server](https://github.com/noahbclarkson/laya-server),
which exposes the System One endpoint at `http://127.0.0.1:8765/v1/systemone`:

```sh
git clone https://github.com/noahbclarkson/laya-server ~/laya-server && cd ~/laya-server
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python torch --index-url https://download.pytorch.org/whl/cu128   # or the CPU wheel
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python server.py --models typed-decisions  # listens on 127.0.0.1:8765
```

Or with Docker: `docker compose up -d` in that repository.

No API key is needed for a local server. If you put it behind auth or on
another host, set `LAYA_API_KEY` and `LAYA_BASE_URL` (or the `apiKey` and
`baseUrl` options).

## Install and usage

```sh
npm install fast-laya-compaction
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-laya-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `LayaAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildLayaRequest` and
`parseLayaResponse` give you the HTTP request and response validation. The
building blocks (`collectToolCalls`, `focusedState`, `questionsFor`,
`decideCall`, `applyDecisions`) and `MODEL_STATE_TOKENS` are exported too.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `baseUrl` | `LAYA_BASE_URL`, else `http://127.0.0.1:8765/v1/systemone` | System One endpoint (`compactMessages`/`LayaClient`) |
| `apiKey` | `LAYA_API_KEY`, else none | Optional bearer token; no `authorization` header without one |
| `model` | `laya-typed-decisions` | Laya model; also picks the default `maxStateTokens` |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in each state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | from `model` (`768` / `320`) | Estimated token ceiling for each per-call state |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |
| `concurrency` | `8` | Laya requests in flight at once |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, `requests` (one per candidate call),
`stateTokens` (the largest per-call state, in estimated tokens) and
`truncatedRequests` (responses in which Laya reported cutting the input).

## Limitations

- Laya judges each call from a ~768-token summary with the 1024-token models
  (~320 with `laya-english`). It sees the goal, the call, the start of its
  result and the most relevant later events, never the whole session. Expect it
  to be less sure than a model that reads everything; tune `keepThreshold` if
  it drops too much.
- If the estimate undercounts and the server truncates anyway, the request
  still answers but is counted in `truncatedRequests` (and shown in the hook's
  toast).
- One request per call: a 40-call session is 40 small requests, run
  `concurrency` at a time.
- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Laya sees).
- Token sizes are estimates, not a tokenizer.
- A probability is not a proof that a result is safe to delete. The assistant
  can always re-run the tool.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-laya.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors (including the Laya
server being down) or insufficient reduction. See
[`hooks/README.md`](hooks/README.md) for configuration and the Claude Code
2.1.274 type reference.

### Install in Claude Code

Start a Laya server first (above). Function hooks are an early-access Claude
Code feature (2.1.274+), so the opt-in flag must be set wherever Claude Code
runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

Add `"LAYA_BASE_URL"` / `"LAYA_API_KEY"` to that `env` block only if your
server is not the local default or needs a key.

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add reapzyau/fast-laya-compaction
claude plugin install fast-laya-compaction@fast-laya-compaction
```

The install prompts for the plugin options (server URL, optional key, model,
thresholds, …); leave them unset or at their defaults for a local
`laya-typed-decisions` server. Restart Claude Code or run `/reload-plugins`.
From then
on `/compact` (and auto-compaction) goes through Laya: the toast reads
`kept N/M messages, no summary (…)` when the pruned history replaced the
built-in summary, or `fallback to built-in summary (…)` when Laya could not
remove enough (short sessions) or failed (for example, the server is not
running).

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
npm run demo             # needs a running laya-server
npm run bench            # needs a running laya-server; see "Does it work?"
npm run bench:transcript -- <path-to-session.jsonl> [limit]
```

The unit tests use a fake Laya and never touch the network. The demo and the
two bench commands are the live checks against your local server.

## Animated demo (macOS)

`demo/LayaDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Laya lets go turn
red and collapse away, and the rest stays verbatim. It never calls a server; it
exists to be screen recorded.

```sh
demo/LayaDemo/build.sh   # builds demo/LayaDemo/build/LayaDemo.app and launches it
```

Press space in the app to replay from the start.

## Credits

- [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction):
  the original library, plugin and demo, built for TypeSafe's Jev model (MIT).
- Laya by Convai Innovations: open-weights System One models, Apache-2.0.
- [laya-server](https://github.com/noahbclarkson/laya-server): the local server
  with the Jev-compatible `/v1/systemone` endpoint.
