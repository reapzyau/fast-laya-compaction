/**
 * Scores a Laya model and a question wording against the 18 labelled cases in
 * `cases.ts`. Needs a running laya-server; this is not part of `npm test`,
 * which stays offline.
 *
 *   npm run bench
 *   npm run bench -- --models=laya-typed-decisions --wordings=criteria
 *   npm run bench -- --baseUrl=http://gpu:8765/v1/systemone --min=12
 */
import { LayaClient, noulAnswer, questionsFor, type NoulQuestion } from '../src/index.js';
import { BENCH_CASES, type BenchCase } from './cases.js';

/**
 * The wordings compared. `criteria` is whatever `questionsFor` ships, so this
 * bench always scores the real default; `plain` is the wording it replaced,
 * kept as the baseline the README's table reports.
 */
export const WORDINGS: Readonly<Record<string, NoulQuestion>> = {
  criteria: questionsFor({ id: 'x' }).result_x as NoulQuestion,
  plain: {
    type: 'noul',
    instructions:
      "The assistant still needs this tool call's full output verbatim; re-running the tool would not do.",
  },
};

export interface Score {
  model: string;
  wording: string;
  correct: number;
  total: number;
  keepAvg: number;
  dropAvg: number;
  /** keepAvg − dropAvg: how far apart the two classes sit. */
  separation: number;
  misses: string[];
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/** Scores one model+wording pair, one request per case. */
export async function scoreWording(
  cases: readonly BenchCase[],
  ask: (state: string, question: NoulQuestion) => Promise<number>,
  question: NoulQuestion,
  threshold: number,
): Promise<Omit<Score, 'model' | 'wording'>> {
  const values: number[] = [];
  for (const benchCase of cases) values.push(await ask(benchCase.state, question));
  const keeps = cases.map((c, i) => ({ ...c, value: values[i]! })).filter((c) => c.keep);
  const drops = cases.map((c, i) => ({ ...c, value: values[i]! })).filter((c) => !c.keep);
  const keepAvg = mean(keeps.map((c) => c.value));
  const dropAvg = mean(drops.map((c) => c.value));
  return {
    correct:
      keeps.filter((c) => c.value >= threshold).length +
      drops.filter((c) => c.value < threshold).length,
    total: cases.length,
    keepAvg,
    dropAvg,
    separation: keepAvg - dropAvg,
    misses: [
      ...keeps
        .filter((c) => c.value < threshold)
        .map((c) => `dropped ${c.tag} (${c.value.toFixed(2)})`),
      ...drops
        .filter((c) => c.value >= threshold)
        .map((c) => `kept ${c.tag} (${c.value.toFixed(2)})`),
    ],
  };
}

function flag(name: string, fallback: string): string {
  const found = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const models = flag('models', 'laya-typed-decisions,laya-english').split(',');
const wordings = flag('wordings', 'criteria,plain').split(',');
const threshold = Number(flag('threshold', '0.5'));
const min = Number(flag('min', '12'));
const baseUrl = flag('baseUrl', '');

const scores: Score[] = [];
for (const model of models) {
  const client = new LayaClient(baseUrl ? { model, baseUrl } : { model });
  const ask = async (state: string, question: NoulQuestion): Promise<number> =>
    noulAnswer((await client.ask(state, { q: question })).answers, 'q');
  for (const wording of wordings) {
    const question = WORDINGS[wording];
    if (!question) throw new Error(`Unknown wording "${wording}" (have: ${Object.keys(WORDINGS).join(', ')})`);
    scores.push({ model, wording, ...(await scoreWording(BENCH_CASES, ask, question, threshold)) });
  }
}

console.log(`${BENCH_CASES.length} labelled cases, keepThreshold ${threshold}\n`);
console.log('| model | wording | correct | keep avg | drop avg | separation |');
console.log('| --- | --- | ---: | ---: | ---: | ---: |');
for (const s of scores) {
  console.log(
    `| \`${s.model}\` | ${s.wording} | ${s.correct}/${s.total} | ${s.keepAvg.toFixed(3)} | ${s.dropAvg.toFixed(3)} | ${s.separation.toFixed(3)} |`,
  );
}
for (const s of scores) {
  if (s.misses.length > 0) console.log(`\n${s.model} / ${s.wording} missed: ${s.misses.join(', ')}`);
}

const shipped = scores.find((s) => s.model === 'laya-typed-decisions' && s.wording === 'criteria');
if (shipped && shipped.correct < min) {
  console.error(
    `\nThe shipped default scored ${shipped.correct}/${shipped.total}, below the floor of ${min}.`,
  );
  process.exitCode = 1;
}
