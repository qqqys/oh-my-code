import type { TranscriptMessage } from './composer.js';

// Compaction replaces a long transcript with a short, structured summary so a
// session can keep going (or be resumed) without re-sending every prior turn to
// the model. The summary deliberately preserves *execution state* — user intent,
// the files the agent changed, the commands it ran, and any action left pending —
// rather than a prose retelling. Tool side effects and approval state are read
// from the structured transcript fields (toolName, outcome, editOutcome), never
// inferred from generated assistant prose, so a compacted session can never
// "remember" a side effect that did not actually happen.

// Default context budget, in the same rough token units the provider uses for
// usage (≈ characters / 4). Compaction is offered once the live context crosses
// this many tokens; the operator still confirms it with /compact.
export const DEFAULT_CONTEXT_LIMIT = 4096;

// The number of most-recent messages kept verbatim after the summary, so the
// model retains the immediate working context (the latest exchange) in full.
const RECENT_KEPT = 4;

// The most recent assistant turns carried into the summary as "recent decisions",
// bounded so a very long session does not produce an unbounded summary.
const MAX_DECISIONS = 3;

// Tool messages are capped per kind in the summary so one noisy session cannot
// produce a giant list; the most recent of each kind are the ones that matter.
const MAX_FILE_ROWS = 12;
const MAX_COMMAND_ROWS = 8;

// Slash-command notices are local UI affordances (their user line starts with
// "/"), never real execution. They are excluded from every derived list.
const NOTICE_TOOLS = new Set(['model', 'policy', 'handoff', 'compact']);

export interface CompactionResult {
  // The compacted transcript: the summary as a user message, the model's
  // acknowledgement as an assistant message, then the most recent messages
  // kept verbatim.
  messages: TranscriptMessage[];
  // The rendered summary, also shown to the operator as a /compact notice.
  summary: string;
  // True when the transcript was large enough to compact; false when nothing
  // was done (too short, or already compacted with no new growth).
  compacted: boolean;
  // The estimated token size of the original context, for reporting.
  before: number;
  // The estimated token size of the compacted context, for reporting.
  after: number;
}

// A rough token estimate consistent with the provider's usage heuristic
// (≈ characters / 4), so the trigger threshold matches what is actually sent.
export function estimateContextTokens(messages: readonly TranscriptMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === 'user' && message.text.startsWith('/')) continue;
    if (message.role === 'tool') continue;
    total += Math.ceil(message.text.length / 4);
  }
  return Math.max(1, total);
}

// True when the live context has grown past the budget and compaction is worth
// offering. The budget is configurable so tests (and operators) can lower it.
export function shouldCompact(
  messages: readonly TranscriptMessage[],
  limit: number = DEFAULT_CONTEXT_LIMIT,
): boolean {
  if (isCompacted(messages)) return false;
  return estimateContextTokens(messages) >= limit;
}

// A transcript is considered already compacted when its head is a compaction
// summary, so auto-compaction does not loop and /compact can short-circuit.
export function isCompacted(messages: readonly TranscriptMessage[]): boolean {
  const first = messages[0];
  return first !== undefined && first.role === 'user' && first.text.startsWith('[Compacted summary]');
}

function isNotice(message: TranscriptMessage): boolean {
  return message.toolName !== undefined && NOTICE_TOOLS.has(message.toolName);
}

function isAppliedEdit(message: TranscriptMessage): boolean {
  return message.toolName === 'apply_edit' && message.editOutcome === 'applied';
}

function isRunCommand(message: TranscriptMessage): boolean {
  return message.toolName === 'run_command';
}

// A pending action is an unanswered user request at the tail. A slash command is
// a local notice (handled synchronously), never a pending model request.
function pendingRequest(messages: readonly TranscriptMessage[]): string | null {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== 'user') return null;
  if (last.text.startsWith('/')) return null;
  return last.text;
}

function uniqueFromEnd(values: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value === undefined) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    ordered.push(value);
    if (ordered.length >= max) break;
  }
  return ordered.reverse();
}

function changedFiles(messages: readonly TranscriptMessage[]): string[] {
  const files: string[] = [];
  for (const message of messages) {
    if (isAppliedEdit(message) && message.toolArgs !== undefined) {
      files.push(message.toolArgs);
    }
  }
  return uniqueFromEnd(files, MAX_FILE_ROWS);
}

function commandLabels(message: TranscriptMessage): string[] {
  const labels: string[] = [];
  const args = message.toolArgs ?? '';
  const outcome = message.outcome ?? 'ok';
  const label = args.length > 0 ? `${args} → ${outcome}` : outcome;
  if (message.text.length > 0) {
    labels.push(`${label}: ${message.text}`);
  } else {
    labels.push(label);
  }
  return labels;
}

function commandsRun(messages: readonly TranscriptMessage[]): string[] {
  const commands: string[] = [];
  for (const message of messages) {
    if (isRunCommand(message)) {
      commands.push(...commandLabels(message));
    }
  }
  return uniqueFromEnd(commands, MAX_COMMAND_ROWS);
}

function approvals(messages: readonly TranscriptMessage[]): string[] {
  const rows: string[] = [];
  for (const message of messages) {
    if (!isRunCommand(message)) continue;
    const outcome = message.outcome;
    if (outcome === 'denied' || outcome === 'timeout' || outcome === 'cancelled') {
      const args = message.toolArgs ?? '';
      rows.push(`${args} → ${outcome}`);
    }
  }
  return uniqueFromEnd(rows, MAX_COMMAND_ROWS);
}

function recentDecisions(messages: readonly TranscriptMessage[]): string[] {
  const decisions: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role !== 'assistant') continue;
    const firstLine = message.text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
    if (firstLine.length > 0) decisions.push(firstLine);
    if (decisions.length >= MAX_DECISIONS) break;
  }
  return decisions.reverse();
}

function intent(messages: readonly TranscriptMessage[]): string[] {
  const requests: string[] = [];
  for (const message of messages) {
    if (message.role === 'user' && !message.text.startsWith('/')) {
      requests.push(message.text);
    }
  }
  return uniqueFromEnd(requests, MAX_DECISIONS);
}

function bullet(lines: readonly string[]): string[] {
  return lines.map((line) => `- ${line}`);
}

// Render the structured summary. Sections that have no content are omitted so a
// short session produces a short summary.
export function renderCompactionSummary(messages: readonly TranscriptMessage[]): string {
  const sections: string[] = ['[Compacted summary]', '', 'Intent:'];
  const intentLines = intent(messages);
  if (intentLines.length > 0) {
    sections.push(...bullet(intentLines));
  } else {
    sections.push('- (none recorded)');
  }

  const decisionLines = recentDecisions(messages);
  if (decisionLines.length > 0) {
    sections.push('', 'Recent decisions:');
    sections.push(...bullet(decisionLines));
  }

  const fileLines = changedFiles(messages);
  if (fileLines.length > 0) {
    sections.push('', 'Changed files (applied edits):');
    sections.push(...bullet(fileLines));
  }

  const commandLines = commandsRun(messages);
  if (commandLines.length > 0) {
    sections.push('', 'Commands run:');
    sections.push(...bullet(commandLines));
  }

  const approvalLines = approvals(messages);
  if (approvalLines.length > 0) {
    sections.push('', 'Approval outcomes:');
    sections.push(...bullet(approvalLines));
  }

  const pending = pendingRequest(messages);
  sections.push('', 'Pending actions:');
  sections.push(pending !== null ? `- ${pending}` : '- none');

  return sections.join('\n');
}

// Compact a transcript into a summary plus a short tail of recent messages. The
// summary is a user message (so it enters the model context as the new history)
// followed by a brief assistant acknowledgement; the recent tail is kept verbatim
// so the immediate working context survives in full.
export function compactTranscript(
  messages: readonly TranscriptMessage[],
  limit: number = DEFAULT_CONTEXT_LIMIT,
): CompactionResult {
  const before = estimateContextTokens(messages);
  const summary = renderCompactionSummary(messages);
  const summaryMessage: TranscriptMessage = { role: 'user', text: summary };
  const acknowledgement: TranscriptMessage = {
    role: 'assistant',
    text: 'Understood. Continuing from the compacted summary above; prior turns are condensed.',
  };

  const tail = messages.slice(Math.max(0, messages.length - RECENT_KEPT));
  const compacted: TranscriptMessage[] = [summaryMessage, acknowledgement, ...tail];
  const after = estimateContextTokens(compacted);

  return { messages: compacted, summary, compacted: true, before, after };
}

// Auto-compaction: compact only when the context has grown past the budget and
// is not already compacted. Returns a no-op result (compacted: false) otherwise,
// so callers can branch on whether the transcript changed.
export function autoCompact(
  messages: readonly TranscriptMessage[],
  limit: number = DEFAULT_CONTEXT_LIMIT,
): CompactionResult {
  if (!shouldCompact(messages, limit)) {
    const size = estimateContextTokens(messages);
    return { messages: messages.slice(), summary: '', compacted: false, before: size, after: size };
  }
  return compactTranscript(messages, limit);
}
