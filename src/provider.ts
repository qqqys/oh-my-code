import type { ModelConfig } from './config.js';
import { isConfigured } from './config.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; error: string };

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

class TestProvider implements Provider {
  readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  async *stream(
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, unknown> {
    const last = messages[messages.length - 1];
    if (last === undefined || last.text.trim().length === 0) {
      yield { type: 'error', error: 'No message content provided.' };
      return;
    }

    for (const token of TEST_RESPONSE) {
      if (signal?.aborted) {
        yield { type: 'error', error: 'cancelled' };
        return;
      }
      yield { type: 'delta', text: token };
      await delay(40);
    }
    yield { type: 'done' };
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
    };
  }
}

export function createProvider(config: ModelConfig): Provider {
  if (!isConfigured(config)) {
    return new UnconfiguredProvider(config.model);
  }
  return new TestProvider(config.model);
}
