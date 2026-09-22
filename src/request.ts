import type { LayaAnswer, LayaQuestions, LayaResponse, LayaState } from './types.js';

/** Where `laya-server` listens by default. */
export const SYSTEM_ONE_URL = 'http://127.0.0.1:8765/v1/systemone';
export const DEFAULT_MODEL = 'laya-typed-decisions';

/**
 * Approximate state room per question for each Laya model: every question is
 * evaluated in its own window, state and question together, and anything over
 * is cut. The router `laya` may pick the 512-token English model.
 */
export const MODEL_STATE_TOKENS: Readonly<Record<string, number>> = {
  'laya-english': 320,
  'laya-multilingual': 768,
  'laya-typed-decisions': 768,
  laya: 320,
};

/** State budget for an unknown model: the smallest window. */
export const DEFAULT_STATE_TOKENS = 320;

export function stateTokensFor(model: string | undefined): number {
  return MODEL_STATE_TOKENS[model ?? DEFAULT_MODEL] ?? DEFAULT_STATE_TOKENS;
}

export interface LayaRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Laya call, for any fetch-like transport. */
export function buildLayaRequest(
  params: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  },
  state: LayaState,
  questions: LayaQuestions,
): LayaRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (params.apiKey) headers.authorization = `Bearer ${params.apiKey}`;
  return {
    url: params.baseUrl || SYSTEM_ONE_URL,
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: params.model || DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

/** Validates a Laya response body; throws on anything but an `answers` object. */
export function parseLayaResponse(
  status: number,
  ok: boolean,
  text: string,
): LayaResponse {
  if (!ok) {
    throw new Error(`Laya request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Laya returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Laya response is missing answers');
  }
  return parsed as LayaResponse;
}

/** Whether the server reported cutting this request to fit the model's window. */
export function wasTruncated(response: LayaResponse): boolean {
  return response.truncation !== undefined && response.truncation !== null;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, LayaAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Laya answer for ${name}`);
  }
  return answer.noul;
}
