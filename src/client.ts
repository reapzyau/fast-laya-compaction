import { buildLayaRequest, parseLayaResponse } from './request.js';
import type { LayaAsker, LayaQuestions, LayaResponse, LayaState } from './types.js';

export interface LayaClientOptions {
  /** Optional; defaults to `process.env.LAYA_API_KEY`. Sent as a bearer token only when set. */
  apiKey?: string;
  /** Defaults to `laya-typed-decisions`. */
  model?: string;
  /** Defaults to `process.env.LAYA_BASE_URL`, then `http://127.0.0.1:8765/v1/systemone`. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Asks a Laya server over HTTP with the global `fetch` (or an injected one). */
export class LayaClient implements LayaAsker {
  private readonly apiKey: string | undefined;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: LayaClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.LAYA_API_KEY;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? process.env.LAYA_BASE_URL;
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: LayaState, questions: LayaQuestions): Promise<LayaResponse> {
    const request = buildLayaRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return parseLayaResponse(response.status, response.ok, await response.text());
  }
}
