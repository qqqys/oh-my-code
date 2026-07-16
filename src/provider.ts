import type { ModelConfig } from './config.js';
import { isConfigured } from './config.js';
import type { ToolCall, ToolResult } from './tools.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage: Usage }
  | { type: 'error'; error: string; recoverable: boolean }
  | { type: 'tool_call'; call: ToolCall };

export interface Provider {
  readonly model: string;
  stream(
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, ToolResult | undefined>;
}

const TEST_RESPONSE = [
  'I',
  ' received',
  ' your',
  ' message',
  '.',
  ' Here',
  ' is',
  ' a',
  ' deterministic',
  ' streamed',
  ' response',
  ' for',
  ' testing',
  '.',
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += Math.ceil(message.text.length / 4);
  }
  return Math.max(1, total);
}

function tokenize(text: string): string[] {
  const words = text.split(' ').filter((word) => word.length > 0);
  return words.map((word, index) => (index === 0 ? word : ` ${word}`));
}

function extractAfter(text: string, keyword: string): string | null {
  const re = new RegExp(`\\b${keyword}\\b\\s+([\\w./-]+)`, 'i');
  const match = text.match(re);
  return match?.[1] ?? null;
}

function extractFileName(text: string): string | null {
  const match = text.match(/([\w./-]*\.\w+)/);
  return match?.[1] ?? null;
}

function detectToolIntent(text: string): ToolCall | null {
  const lower = text.toLowerCase();
  if (/\blist\b/.test(lower)) {
    return { name: 'list_files', args: { path: extractAfter(text, 'in') ?? '.' } };
  }
  if (/\bread\b/.test(lower)) {
    return { name: 'read_file', args: { path: extractFileName(text) ?? 'README.md' } };
  }
  if (/\bsearch\b/.test(lower) || /\bgrep\b/.test(lower)) {
    return {
      name: 'search_content',
      args: {
        pattern: extractAfter(text, 'for') ?? 'TODO',
        path: extractAfter(text, 'in') ?? '.',
      },
    };
  }
  return null;
}

class TestProvider implements Provider {
  readonly model: string;
  private readonly failed = new Set<string>();

  constructor(model: string) {
    this.model = model;
  }

  async *stream(
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, ToolResult | undefined> {
    const last = messages[messages.length - 1];
    if (last === undefined || last.text.trim().length === 0) {
      yield { type: 'error', error: 'No message content provided.', recoverable: false };
      return;
    }

    // Deterministic recoverable failure: fail once when the user message
    // contains "recover", then succeed on retry.
    if (last.text.includes('recover') && !this.failed.has(last.text)) {
      this.failed.add(last.text);
      yield { type: 'error', error: 'Simulated transient network error.', recoverable: true };
      return;
    }

    const intent = detectToolIntent(last.text);
    if (intent !== null) {
      const result = yield { type: 'tool_call', call: intent };
      if (signal?.aborted) {
        yield { type: 'error', error: 'cancelled', recoverable: false };
        return;
      }
      const response =
        result?.error !== undefined && result.error !== null
          ? `The ${intent.name} tool could not complete: ${result.error}`
          : `I inspected the repository with ${intent.name}. The results are shown above.`;
      yield* this.streamText(response, messages, signal);
      return;
    }

    yield* this.streamText(TEST_RESPONSE.join(''), messages, signal);
  }

  private async *streamText(
    text: string,
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    for (const token of tokenize(text)) {
      if (signal?.aborted) {
        yield { type: 'error', error: 'cancelled', recoverable: false };
        return;
      }
      yield { type: 'delta', text: token };
      await delay(20);
    }
    const promptTokens = estimateTokens(messages);
    const completionTokens = tokenize(text).length;
    yield { type: 'done', usage: { promptTokens, completionTokens } };
  }
}

class UnconfiguredProvider implements Provider {
  readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  async *stream(): AsyncGenerator<StreamEvent, void, ToolResult | undefined> {
    yield {
      type: 'error',
      error: 'Configuration invalid: set an API key via OPENAI_API_KEY, ANTHROPIC_API_KEY, or OMC_API_KEY.',
      recoverable: false,
    };
  }
}

export function createProvider(config: ModelConfig): Provider {
  if (!isConfigured(config)) {
    return new UnconfiguredProvider(config.model);
  }
  return new TestProvider(config.model);
}
