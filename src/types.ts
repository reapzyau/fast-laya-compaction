export type Role = 'user' | 'assistant';

/**
 * A tool_use block of an assistant message. `text` and `isError` mirror the
 * outcome once the transcript holds it (Claude Code attaches them).
 */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

/** A tool_result block of a user message. */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

/**
 * One transcript message. The shape is a subset of Claude Code's
 * `SessionMessage`, so a session transcript can be passed in as is.
 */
export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id used in the Laya state and question names (`t1`, `t2`, ...). */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  /** Index of the message holding the tool_use block. */
  callIndex: number;
  /** Index of the message holding the tool_result block. */
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean;
}

export interface CallAnswer {
  /** Laya's probability that the call itself still matters. */
  keepCall: number;
  /** Laya's probability that the full result still needs to stay verbatim. */
  keepResult: number;
}

export type CallAction = 'keep' | 'drop_result' | 'drop_call';

export interface CallDecision extends CallAnswer {
  id: string;
  tool: string;
  action: CallAction;
  reason: 'pinned' | 'kept' | 'result_dropped' | 'call_dropped';
}

/** The per-call state sent to Laya: plain text, fitted to `maxStateTokens`. */
export interface FocusedState {
  state: string;
  /** Estimated tokens of `state`; never above the budget it was fitted to. */
  tokens: number;
}

export interface CompactOptions {
  /** Ongoing task description; defaults to the last few user prompts. */
  goal?: string;
  /** Minimum keep probability for a call or result to stay. Default 0.5. */
  keepThreshold?: number;
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Laya model; only used here to pick the default `maxStateTokens`. Default `laya-english`. */
  model?: string;
  /** Estimated token ceiling for each per-call state. Defaults from the model (320 for `laya-english`). */
  maxStateTokens?: number;
  /** Characters of a dropped tool result to retain. Default 300. */
  truncateHeadChars?: number;
  /** Laya requests in flight at once (one per candidate call). Default 8. */
  concurrency?: number;
}

export interface ResolvedCompactOptions {
  goal: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  truncateHeadChars: number;
  concurrency: number;
}

export interface CompactResult {
  /** The compacted transcript; untouched messages are the input objects. */
  messages: Message[];
  decisions: CallDecision[];
  stats: {
    messagesBefore: number;
    messagesAfter: number;
    charsBefore: number;
    charsAfter: number;
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    pinned: number;
    /** Largest per-call state, in estimated tokens; 0 when no request was made. */
    stateTokens: number;
    /** One per candidate call. */
    requests: number;
    /** Responses in which Laya reported cutting the input to fit its window. */
    truncatedRequests: number;
    ms: number;
  };
}

/** The `state` of a Laya request: a string or any JSON-serialisable object. */
export type LayaState = string | object;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: {
    true?: string;
    false?: string;
  };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type LayaQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type LayaQuestions = Record<string, LayaQuestion>;

export interface NoulAnswer {
  type?: 'noul';
  noul: number;
}

export interface ChoiceAnswer {
  type?: 'choice';
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type?: 'score';
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type LayaAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface LayaResponse {
  model?: string;
  answers: Record<string, LayaAnswer>;
  /** Present when the server cut state or question to fit the model's window. */
  truncation?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  [key: string]: unknown;
}

/** Anything that can answer Laya questions: `LayaClient`, or a host-provided adapter. */
export interface LayaAsker {
  ask(state: LayaState, questions: LayaQuestions): Promise<LayaResponse>;
}
