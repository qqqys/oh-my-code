import { describe, expect, it } from 'vitest';

import {
  autoCompact,
  compactTranscript,
  estimateContextTokens,
  isCompacted,
  renderCompactionSummary,
  shouldCompact,
} from '../src/compact.js';
import type { CommandOutcome, TranscriptMessage } from '../src/composer.js';

const user = (text: string): TranscriptMessage => ({ role: 'user', text });
const assistant = (text: string): TranscriptMessage => ({ role: 'assistant', text });
const appliedEdit = (path: string): TranscriptMessage => ({
  role: 'tool',
  text: `applied edit to ${path}`,
  toolName: 'apply_edit',
  toolArgs: `path: ${path}`,
  editOutcome: 'applied',
});
const rejectedEdit = (path: string): TranscriptMessage => ({
  role: 'tool',
  text: `rejected edit to ${path}`,
  toolName: 'apply_edit',
  toolArgs: `path: ${path}`,
  editOutcome: 'rejected',
});
const command = (args: string, outcome: CommandOutcome, text = ''): TranscriptMessage => ({
  role: 'tool',
  text,
  toolName: 'run_command',
  toolArgs: args,
  outcome,
});
const notice = (toolName: string): TranscriptMessage => ({
  role: 'tool',
  text: 'local notice',
  toolName,
  toolArgs: 'list',
});

describe('estimateContextTokens', () => {
  it('counts user and assistant text but skips tool output and slash commands', () => {
    const messages: TranscriptMessage[] = [
      user('hello world'),
      assistant('a reply'),
      command('echo hi', 'ok', 'hi'),
      user('/compact'),
    ];
    // Only the two real messages count: ceil(11/4) + ceil(7/4) = 3 + 2 = 5.
    expect(estimateContextTokens(messages)).toBe(5);
  });

  it('is at least one even for an empty transcript', () => {
    expect(estimateContextTokens([])).toBe(1);
  });
});

describe('shouldCompact / isCompacted', () => {
  it('triggers once the context crosses the limit', () => {
    const messages: TranscriptMessage[] = [user('x'.repeat(400))];
    expect(shouldCompact(messages, 50)).toBe(true);
    expect(shouldCompact(messages, 500)).toBe(false);
  });

  it('does not re-trigger on an already-compacted transcript', () => {
    const compacted = compactTranscript([user('x'.repeat(400)), assistant('done')], 50);
    expect(isCompacted(compacted.messages)).toBe(true);
    expect(shouldCompact(compacted.messages, 1)).toBe(false);
  });
});

describe('renderCompactionSummary', () => {
  it('preserves intent, changed files, commands, approvals, and pending actions', () => {
    const messages: TranscriptMessage[] = [
      user('refactor the auth module'),
      appliedEdit('src/auth.ts'),
      command('npm run build', 'ok', 'build ok'),
      command('rm -rf dist', 'denied'),
      assistant('Refactored the auth module and verified the build.'),
      user('now run the tests'),
    ];
    const summary = renderCompactionSummary(messages);

    expect(summary).toContain('[Compacted summary]');
    expect(summary).toContain('Intent:');
    expect(summary).toContain('refactor the auth module');
    expect(summary).toContain('Changed files (applied edits):');
    expect(summary).toContain('src/auth.ts');
    expect(summary).toContain('Commands run:');
    expect(summary).toContain('npm run build → ok');
    expect(summary).toContain('Approval outcomes:');
    expect(summary).toContain('rm -rf dist → denied');
    expect(summary).toContain('Pending actions:');
    expect(summary).toContain('now run the tests');
  });

  it('never lists rejected edits as changed files', () => {
    const summary = renderCompactionSummary([user('try it'), rejectedEdit('src/foo.ts')]);
    expect(summary).not.toContain('Changed files (applied edits):');
    expect(summary).not.toContain('src/foo.ts');
  });

  it('excludes local slash-command notices from every derived list', () => {
    const summary = renderCompactionSummary([
      user('do work'),
      notice('model'),
      notice('policy'),
      notice('handoff'),
    ]);
    expect(summary).not.toContain('model');
    expect(summary).not.toContain('policy');
    expect(summary).not.toContain('handoff');
  });

  it('reports no pending action when the transcript ends on an assistant turn', () => {
    const summary = renderCompactionSummary([user('do work'), assistant('done')]);
    expect(summary).toContain('Pending actions:');
    expect(summary).toContain('- none');
  });

  it('treats a trailing slash command as no pending model request', () => {
    const summary = renderCompactionSummary([user('do work'), assistant('done'), user('/compact')]);
    expect(summary).toContain('- none');
  });

  it('keeps only the most recent intent and decisions, oldest-first', () => {
    const summary = renderCompactionSummary([
      user('first'),
      assistant('decided first'),
      user('second'),
      assistant('decided second'),
      user('third'),
      assistant('decided third'),
      user('fourth'),
      assistant('decided fourth'),
    ]);
    // Intent and decisions are bounded to the three most recent, oldest-first.
    expect(summary).toContain('second');
    expect(summary).toContain('fourth');
    expect(summary).not.toContain('first');
    expect(summary).toContain('decided fourth');
    expect(summary).not.toContain('decided first');
  });
});

describe('compactTranscript', () => {
  it('produces a summary, an acknowledgement, and a recent tail', () => {
    const messages: TranscriptMessage[] = [
      user('old request'),
      assistant('old reply'),
      appliedEdit('src/a.ts'),
      user('recent request'),
      assistant('recent reply'),
    ];
    const result = compactTranscript(messages, 1);
    const compacted = result.messages;

    expect(result.compacted).toBe(true);
    // The transcript is collapsed to a fixed shape regardless of input length:
    // the summary, an acknowledgement, and a bounded recent tail.
    expect(compacted.length).toBeLessThan(messages.length + 2);
    // Head is the summary (user) then the acknowledgement (assistant).
    expect(compacted[0]?.role).toBe('user');
    expect(compacted[0]?.text.startsWith('[Compacted summary]')).toBe(true);
    expect(compacted[1]?.role).toBe('assistant');
    // The most recent messages are kept verbatim.
    expect(compacted[compacted.length - 1]).toEqual(assistant('recent reply'));
    expect(compacted[compacted.length - 2]).toEqual(user('recent request'));
  });

  it('keeps at most the last few messages as the tail', () => {
    const messages: TranscriptMessage[] = Array.from({ length: 20 }, (_, index) => user(`m${index}`));
    const compacted = compactTranscript(messages, 1).messages;
    // 2 framing messages (summary + acknowledgement) + 4 tail.
    expect(compacted).toHaveLength(6);
    expect(compacted[compacted.length - 1]).toEqual(user('m19'));
  });
});

describe('autoCompact', () => {
  it('is a no-op below the limit', () => {
    const messages: TranscriptMessage[] = [user('short')];
    const result = autoCompact(messages, 10_000);
    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
  });

  it('compacts a large transcript above the limit and reports the size drop', () => {
    // A realistically long session: many verbose turns whose structured summary
    // is far smaller than the sum of the original messages.
    const messages: TranscriptMessage[] = [];
    for (let index = 0; index < 12; index += 1) {
      messages.push(user(`Please work on task number ${index} and explain each step in detail`));
      messages.push(assistant(`Here is a detailed explanation of step ${index} `.repeat(8)));
    }
    messages.push(user('continue please'));
    const result = autoCompact(messages, 50);
    expect(result.compacted).toBe(true);
    expect(result.after).toBeLessThan(result.before);
    expect(isCompacted(result.messages)).toBe(true);
  });
});
