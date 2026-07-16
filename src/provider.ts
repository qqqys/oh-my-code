import type { ModelConfig } from './config.js';
import { isConfigured } from './config.js';

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
  | { type: 'error'; error: string; recoverable: boolean };

export interface Provider {
  readonly model: string;
  stream(
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown>;
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

class TestProvider implements Provider {
  readonly model: string;
  private readonly failed = new Set<string>();

  constructor(model: string) {
    this.model = model;
  }

  async *stream(
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown> {
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

    for (const token of TEST_RESPONSE) {
      if (signal?.aborted) {
        yield { type: 'error', error: 'cancelled', recoverable: false };
        return;
      }
      yield { type: 'delta', text: token };
      await delay(40);
    }
    const promptTokens = estimateTokens(messages);
    const completionTokens = TEST_RESPONSE.length;
    yield { type: 'done', usage: { promptTokens, completionTokens } };
  }
}

class UnconfiguredProvider implements Provider {
  readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  async *stream(): AsyncGenerator<StreamEvent, void, unknown> {
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
