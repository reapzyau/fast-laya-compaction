import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

/** `clef` or `clef-flash`; both speak the Jev request format. */
export const DEFAULT_MODEL = 'clef';

/** The Workers AI endpoint for one Clef model on one Cloudflare account. */
export function clefUrl(accountId: string, model: string = DEFAULT_MODEL): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`;
}

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Clef call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    /** Cloudflare API token with Workers AI access. */
    apiKey: string;
    model?: string;
    accountId?: string;
    /** Overrides the Workers AI URL built from `accountId`. */
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  const model = params.model ?? DEFAULT_MODEL;
  if (!params.baseUrl && !params.accountId) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID is not configured');
  }
  return {
    url: params.baseUrl ?? clefUrl(params.accountId!, model),
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, state, questions }),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Validates a Clef response body; throws on anything but an `answers` object.
 * Accepts the bare body and the Workers AI REST envelope (`{ result: { answers } }`).
 */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    throw new Error(`Clef request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Clef returned malformed JSON');
  }
  if (isObject(parsed) && !('answers' in parsed) && isObject(parsed.result)) {
    parsed = parsed.result;
  }
  if (!isObject(parsed) || !isObject(parsed.answers)) {
    throw new Error('Clef response is missing answers');
  }
  return parsed as JevResponse;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Clef answer for ${name}`);
  }
  return answer.noul;
}
