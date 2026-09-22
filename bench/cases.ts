/**
 * The labelled bench: 18 focused states of the shape `focusedState` builds,
 * nine that must be kept and nine that must be dropped. Each `state` is a
 * hand-written but realistic per-call state (goal, the call, the head of its
 * result, what happened after it); `keep: true` means a correct judge answers
 * the `result_tN` question above `keepThreshold`.
 *
 * These are the cases the shipped defaults were chosen on; see the README's
 * "Does it work?" section for the scores and their limits.
 */
export interface BenchCase {
  /** Short name, used in the miss list. */
  tag: string;
  /** The focused state, as Laya sees it. */
  state: string;
  /** Whether the result must survive compaction. */
  keep: boolean;
}

export const KEEP_CASES: readonly BenchCase[] = [
  {
    tag: 'failing-test',
    keep: true,
    state: `Goal: fix the failing auth test.
This call t3: Bash command=npm test -- auth.spec.ts → error, 2900 chars
Result starts: FAIL auth.spec.ts > rejects expired tokens: expected 401, received 200 at auth.spec.ts:42
Later:
assistant: The expiry check is missing. Let me re-read that stack trace before editing.`,
  },
  {
    tag: 'constraint-doc',
    keep: true,
    state: `Goal: migrate the parser without breaking the public API.
This call t7: Read file_path=API_CONTRACT.md → ok, 3100 chars
Result starts: Public API: parse(tokens), tokenize(src). These signatures must not change in any minor release.
Later:
t12: Edit file_path=src/parser.ts → ok, 40 chars
user: Keep going, and do not change the exported signatures.`,
  },
  {
    tag: 'current-file',
    keep: true,
    state: `Goal: finish the changelog entry for the parser fix.
This call t9: Read file_path=CHANGELOG.md → ok, 1800 chars
Result starts: ## Unreleased
- Fixed trailing comma handling in the checkout parser
Later:
assistant: I will append the new entry under Unreleased.`,
  },
  {
    tag: 'config-values',
    keep: true,
    state: `Goal: deploy the worker to staging.
This call t4: Read file_path=wrangler.toml → ok, 900 chars
Result starts: name = "checkout-worker"
account_id = "8f2c19"
[env.staging]
route = "staging.example.com/*"
Later:
assistant: Now I will run the deploy against the staging environment.`,
  },
  {
    tag: 'error-cause',
    keep: true,
    state: `Goal: fix the broken build.
This call t11: Bash command=npm run build → error, 1500 chars
Result starts: error TS2345: Argument of type 'string' is not assignable to parameter of type 'Token' at src/lex.ts:88
Later:
assistant: That is the only type error. Opening src/lex.ts at line 88.`,
  },
  {
    tag: 'api-schema',
    keep: true,
    state: `Goal: write a client for the payments API.
This call t6: WebFetch url=https://api.example.com/openapi.json → ok, 12000 chars
Result starts: POST /charges requires {amount:int, currency:string, idempotency_key:string}; returns 201 with {id, status}
Later:
assistant: Writing the charge() function against that schema now.`,
  },
  {
    tag: 'user-data',
    keep: true,
    state: `Goal: summarise the survey results.
This call t2: Read file_path=data/survey.csv → ok, 9000 chars
Result starts: respondent,role,pain_point
1,agency owner,too many tools
2,solo marketer,no system
Later:
assistant: I will group the pain points by role and count them.`,
  },
  {
    tag: 'grep-targets',
    keep: true,
    state: `Goal: rename the legacy helper everywhere.
This call t5: Grep pattern=oldHelper path=src → ok, 700 chars
Result starts: src/a.ts:12
src/b.ts:40
src/c.ts:91
Later:
assistant: Three call sites. I will edit them one at a time.
t9: Edit file_path=src/a.ts → ok, 30 chars`,
  },
  {
    tag: 'half-done-list',
    keep: true,
    state: `Goal: update every client page with the new footer.
This call t3: Glob pattern=clients/**/index.html → ok, 400 chars
Result starts: clients/acme/index.html
clients/borg/index.html
clients/cane/index.html
Later:
t8: Edit file_path=clients/acme/index.html → ok, 30 chars
assistant: One down, two to go.`,
  },
];

export const DROP_CASES: readonly BenchCase[] = [
  {
    tag: 'superseded-read',
    keep: false,
    state: `Goal: fix the failing parser test.
This call t3: Read file_path=src/parser.ts → ok, 4213 chars
Result starts: export function parse(tokens: Token[]): Node {
Later:
t5: Edit file_path=src/parser.ts → ok, 40 chars [same file_path]
t6: Read file_path=src/parser.ts → ok, 4400 chars [same file_path]
assistant: Tests pass now. Moving on to the changelog.`,
  },
  {
    tag: 'task-done',
    keep: false,
    state: `Goal: write the README.
This call t3: Glob pattern=**/*.png → ok, 120 chars
Result starts: assets/logo.png
Later:
t5: Write file_path=README.md → ok, 20 chars
assistant: README written.
user: Great, now let's look at the CI config.`,
  },
  {
    tag: 'abandoned-path',
    keep: false,
    state: `Goal: speed up the checkout endpoint.
This call t4: Read file_path=src/legacy/cache.ts → ok, 6000 chars
Result starts: // legacy cache, scheduled for deletion
Later:
assistant: The legacy cache is unrelated; ignoring it.
t8: Read file_path=src/checkout.ts → ok, 5200 chars
user: Yes, focus on the endpoint only.`,
  },
  {
    tag: 'passing-test',
    keep: false,
    state: `Goal: ship the parser fix.
This call t7: Bash command=npm test -- parser.spec.ts → ok, 800 chars
Result starts: PASS src/parser.spec.ts (12 tests)
Later:
t14: Bash command=npm test → ok, 2200 chars
assistant: Full suite green. Writing the changelog.`,
  },
  {
    tag: 'stale-listing',
    keep: false,
    state: `Goal: clean up the build output folder.
This call t2: Bash command=ls -la dist → ok, 1400 chars
Result starts: total 480
bundle.js
bundle.js.map
old-bundle.js
Later:
t6: Bash command=rm -rf dist → ok, 0 chars
t7: Bash command=npm run build → ok, 300 chars
assistant: Fresh build done.`,
  },
  {
    tag: 'wrong-guess',
    keep: false,
    state: `Goal: find where the timeout is configured.
This call t3: Grep pattern=timeout path=docs → ok, 200 chars
Result starts: docs/faq.md:20: the request timeout is documented in the API guide
Later:
assistant: Wrong place, that is only prose. Searching the source instead.
t4: Grep pattern=timeout path=src → ok, 900 chars`,
  },
  {
    tag: 'superseded-status',
    keep: false,
    state: `Goal: commit the changes.
This call t5: Bash command=git status → ok, 1100 chars
Result starts: modified: src/parser.ts
modified: CHANGELOG.md
Later:
t9: Bash command=git commit -m "fix parser" → ok, 200 chars
t10: Bash command=git status → ok, 90 chars [same command]
assistant: Working tree clean.`,
  },
  {
    tag: 'exploratory-tree',
    keep: false,
    state: `Goal: add a new skill to the repo.
This call t1: Bash command=find . -type d -maxdepth 2 → ok, 3000 chars
Result starts: ./src
./tests
./skills
./docs
Later:
assistant: Skills live in skills/. Creating the new folder there.
t4: Write file_path=skills/new/SKILL.md → ok, 20 chars
user: Looks right, carry on.`,
  },
  {
    tag: 'duplicate-fetch',
    keep: false,
    state: `Goal: summarise the pricing page.
This call t2: WebFetch url=https://example.com/pricing → ok, 7000 chars
Result starts: Starter $19/mo, Pro $49/mo, Team $99/mo
Later:
t3: WebFetch url=https://example.com/pricing → ok, 7100 chars [same url]
assistant: I have the current numbers from the second fetch.`,
  },
];

/** All 18 labelled cases, keeps first. */
export const BENCH_CASES: readonly BenchCase[] = [...KEEP_CASES, ...DROP_CASES];
