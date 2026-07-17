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

// A complete coding loop driven from a single deterministic request:
//   complete <path> :: <old> :: <new> :: <verify> [:: <retry-old> :: <retry-new>]
// The optional trailing pair is one bounded edit-and-test retry, used only when
// the first verification fails.
interface CompletePlan {
  path: string;
  oldString: string;
  newString: string;
  verify: string;
  retry: { oldString: string; newString: string } | null;
}

function extractCompletePlan(text: string): CompletePlan | null {
  const match = text.match(/\b(?:complete|implement|fix)\b\s+(.+)$/i);
  const body = match?.[1]?.trim();
  if (body === undefined || body.length === 0) return null;
  const parts = body.split('::').map((part) => part.trim());
  if (parts.length < 4) return null;
  const [path, oldString, newString, verify] = parts;
  if (path === undefined || oldString === undefined || newString === undefined || verify === undefined) {
    return null;
  }
  if (path.length === 0 || verify.length === 0) return null;
  const retryOld = parts[4];
  const retryNew = parts[5];
  const retry =
    retryOld !== undefined && retryNew !== undefined && retryOld.length > 0
      ? { oldString: retryOld, newString: retryNew }
      : null;
  return { path, oldString, newString, verify, retry };
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

    // A "complete/fix/implement <path> :: ... :: <verify>" request drives the
    // full coding loop in one turn: inspect, scoped edit, focused verification,
    // a bounded retry on failure, and a structured handoff summary.
    const plan = extractCompletePlan(last.text);
    if (plan !== null) {
      yield* this.runCodingLoop(plan, messages, signal);
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

  // Drive one full coding loop and stop for user handoff. Every step is a normal
  // tool call the TUI already knows how to execute and review; the loop only
  // sequences them and branches on their results.
  private async *runCodingLoop(
    plan: CompletePlan,
    messages: readonly ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, void, ToolResult | undefined> {
    // 1. Inspect the code the request targets.
    yield { type: 'tool_call', call: { name: 'read_file', args: { path: plan.path } } };
    if (signal?.aborted) {
      yield { type: 'error', error: 'cancelled', recoverable: false };
      return;
    }

    // 2. Make the scoped edit (reviewed at the diff boundary).
    const edit = yield {
      type: 'tool_call',
      call: {
        name: 'apply_edit',
        args: { path: plan.path, old_string: plan.oldString, new_string: plan.newString },
      },
    };
    if (signal?.aborted) {
      yield { type: 'error', error: 'cancelled', recoverable: false };
      return;
    }
    if (edit === undefined || edit.error !== null) {
      yield* this.streamText(this.blockedSummary(plan, 'edit', false), messages, signal);
      return;
    }

    // 3. Run the focused verification.
    let verify = yield { type: 'tool_call', call: { name: 'run_command', args: { command: plan.verify } } };
    if (signal?.aborted) {
      yield { type: 'error', error: 'cancelled', recoverable: false };
      return;
    }
    let passed = verify !== undefined && verify.error === null;
    let retried = false;

    // 4. On failure, make one bounded edit-and-test attempt when a retry is given.
    if (!passed && plan.retry !== null) {
      retried = true;
      const retryEdit = yield {
        type: 'tool_call',
        call: {
          name: 'apply_edit',
          args: { path: plan.path, old_string: plan.retry.oldString, new_string: plan.retry.newString },
        },
      };
      if (signal?.aborted) {
        yield { type: 'error', error: 'cancelled', recoverable: false };
        return;
      }
      if (retryEdit !== undefined && retryEdit.error === null) {
        verify = yield { type: 'tool_call', call: { name: 'run_command', args: { command: plan.verify } } };
        if (signal?.aborted) {
          yield { type: 'error', error: 'cancelled', recoverable: false };
          return;
        }
        passed = verify !== undefined && verify.error === null;
      }
    }

    // 5. Summarize the diff and evidence, then stop for handoff.
    const summary = passed
      ? this.completeSummary(plan, retried)
      : this.blockedSummary(plan, 'verify', retried, verify);
    yield* this.streamText(summary, messages, signal);
  }

  // The final summary separates what changed, what was tested, what risk
  // remains, and what the user still owns, so handoff is unambiguous.
  private completeSummary(plan: CompletePlan, retried: boolean): string {
    const lines: string[] = ['Coding loop complete.', '', 'Changes:'];
    lines.push(`- Edited ${plan.path} with a scoped edit${retried ? ' (and one bounded retry)' : ''}.`);
    lines.push('', 'Tests:');
    if (retried) {
      lines.push(`- Ran \`${plan.verify}\` and it failed on the first attempt.`);
      lines.push(`- Re-applied a scoped edit and re-ran \`${plan.verify}\` -> passed.`);
    } else {
      lines.push(`- Ran \`${plan.verify}\` -> passed.`);
    }
    lines.push('', 'Remaining risks:');
    lines.push(
      retried
        ? '- The first attempt failed verification; the retry resolved it, so review the combined change carefully.'
        : '- None observed; verification passed on the first attempt.',
    );
    lines.push('', 'Next (user-owned):');
    lines.push('- Review the diff and commit when you are satisfied.');
    return lines.join('\n');
  }

  private blockedSummary(
    plan: CompletePlan,
    reason: 'edit' | 'verify',
    retried: boolean,
    verify?: ToolResult,
  ): string {
    const lines: string[] = ['Coding loop blocked.', ''];
    if (reason === 'edit') {
      lines.push('Changes:', '- No change applied; the edit was rejected or could not be applied.');
      lines.push('', 'Tests:', '- Not run.');
      lines.push('', 'Remaining risks:', '- None from this attempt; the file is unchanged.');
      lines.push('', 'Next (user-owned):', '- Re-propose the edit when ready.');
      return lines.join('\n');
    }
    const detail = verify !== undefined && verify.error !== null ? ` (${verify.error})` : '';
    lines.push(
      'Changes:',
      `- Edited ${plan.path} with a scoped edit${retried ? ' (and one bounded retry)' : ''}.`,
    );
    lines.push('', 'Tests:', `- Ran \`${plan.verify}\` -> failed${detail}.`);
    lines.push(
      '',
      'Remaining risks:',
      '- Verification is still failing; the change may be incorrect or incomplete.',
    );
    lines.push(
      '',
      'Next (user-owned):',
      `- Inspect the failing output above, adjust the change, then re-run \`${plan.verify}\`.`,
    );
    return lines.join('\n');
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
