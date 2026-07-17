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

function extractCommand(text: string): string | null {
  const match = text.match(/\b(?:run|execute|shell)\b\s+(.+)$/i);
  const command = match?.[1]?.trim();
  return command !== undefined && command.length > 0 ? command : null;
}

// Parse "edit <path> :: <old> :: <new>" into a scoped edit. The "::" delimiter
// keeps the three fields unambiguous on a single submitted line.
function extractEdit(
  text: string,
): { path: string; oldString: string; newString: string } | null {
  const match = text.match(/\bedit\b\s+(.+)$/i);
  const body = match?.[1]?.trim();
  if (body === undefined || body.length === 0) return null;
  const parts = body.split('::').map((part) => part.trim());
  if (parts.length !== 3) return null;
  const [path, oldString, newString] = parts;
  if (path === undefined || oldString === undefined || newString === undefined) return null;
  if (path.length === 0) return null;
  return { path, oldString, newString };
}

function detectToolIntent(text: string): ToolCall | null {
  const lower = text.toLowerCase();
  if (/\bedit\b/.test(lower)) {
    const edit = extractEdit(text);
    if (edit !== null) {
      return {
        name: 'apply_edit',
        args: { path: edit.path, old_string: edit.oldString, new_string: edit.newString },
      };
    }
  }
  if (/\bcontext\b/.test(lower) || /\borient\b/.test(lower)) {
    return { name: 'repo_context', args: { path: extractAfter(text, 'in') ?? '.' } };
  }
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
  if (/\brun\b/.test(lower) || /\bexecute\b/.test(lower) || /\bshell\b/.test(lower)) {
    const command = extractCommand(text);
    if (command !== null) {
      return { name: 'run_command', args: { command } };
    }
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
      const verb =
        intent.name === 'run_command'
          ? 'ran'
          : intent.name === 'apply_edit'
            ? 'proposed an edit with'
            : 'inspected the repository with';
      const response =
        result?.error !== undefined && result.error !== null
          ? `The ${intent.name} tool could not complete: ${result.error}`
          : `I ${verb} ${intent.name}. The results are shown above.`;
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
