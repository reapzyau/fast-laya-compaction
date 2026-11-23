import { buildJevRequest, parseJevResponse } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export interface JevClientOptions {
  /** Cloudflare API token with Workers AI access. Defaults to `process.env.CLEF_API_TOKEN`. */
  apiKey?: string;
  /** Defaults to `process.env.CLOUDFLARE_ACCOUNT_ID`. */
  accountId?: string;
  /** `clef` (default) or `clef-flash`. */
  model?: string;
  /** Overrides the Workers AI URL built from `accountId`. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Asks Clef over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly accountId: string | undefined;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.CLEF_API_TOKEN ?? '';
    this.accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error('CLEF_API_TOKEN is not configured');
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, accountId: this.accountId, baseUrl: this.baseUrl },
      state,
      questions,
    );
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return parseJevResponse(response.status, response.ok, await response.text());
  }
}
