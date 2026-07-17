import { describe, expect, it } from 'vitest';

import {
  assistantBlocks,
  blockBodyLines,
  blockGlyph,
  blockPlainText,
  errorBlock,
  messageBlocks,
  progressBlock,
  type Block,
} from '../src/blocks.js';
import type { TranscriptMessage } from '../src/composer.js';

describe('messageBlocks', () => {
  it('maps a user message to a single prompt block', () => {
    const blocks = messageBlocks({ role: 'user', text: 'hello world' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('prompt');
    expect(blocks[0]?.header).toBe('You');
    expect(blocks[0]?.lines).toEqual(['hello world']);
  });

  it('maps a generic tool call to a tool block with name and args', () => {
    const message: TranscriptMessage = {
      role: 'tool',
      text: 'app.ts\ncli.ts',
      toolName: 'list_files',
      toolArgs: 'path: src',
    };
    const [block] = messageBlocks(message);
    expect(block?.kind).toBe('tool');
    expect(block?.header).toBe('Tool list_files (path: src)');
    expect(block?.lines).toEqual(['app.ts', 'cli.ts']);
  });

  it('flags truncated tool output', () => {
    const message: TranscriptMessage = {
      role: 'tool',
      text: 'partial',
      toolName: 'read_file',
      truncated: true,
    };
    const [block] = messageBlocks(message);
    expect(block?.truncated).toBe(true);
  });
});

describe('assistantBlocks', () => {
  it('classifies plain prose as a reasoning block', () => {
    const blocks = assistantBlocks('Just a plain sentence with no markers.');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('reasoning');
    expect(blocks[0]?.header).toBe('Reasoning');
  });

  it('classifies structured prose as a Markdown block', () => {
    const blocks = assistantBlocks('## Heading\n\n- one\n- two');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('markdown');
    expect(blocks[0]?.header).toBe('Markdown');
  });

  it('splits fenced code into its own block with a language', () => {
    const blocks = assistantBlocks('## intro\n```ts\nconst a = 1;\n```\nplain outro');
    expect(blocks.map((b) => b.kind)).toEqual(['markdown', 'code', 'reasoning']);
    const code = blocks[1];
    expect(code?.language).toBe('ts');
    expect(code?.lines).toEqual(['const a = 1;']);
  });

  it('keeps an unterminated fence as a code block rather than dropping it', () => {
    const blocks = assistantBlocks('text\n```js\nhalf written');
    expect(blocks.map((b) => b.kind)).toEqual(['reasoning', 'code']);
    expect(blocks[1]?.lines).toEqual(['half written']);
  });

  it('returns a single empty reasoning block for empty text', () => {
    const blocks = assistantBlocks('');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('reasoning');
  });
});

describe('command and edit blocks', () => {
  it('renders a successful command as a tool block', () => {
    const message: TranscriptMessage = {
      role: 'tool',
      text: 'hello',
      toolName: 'run_command',
      toolArgs: 'command: echo hello',
      outcome: 'ok',
    };
    const [block] = messageBlocks(message);
    expect(block?.kind).toBe('tool');
    expect(block?.header).toBe('Command (command: echo hello)');
  });

  it('renders a failed command as a warning block', () => {
    const message: TranscriptMessage = {
      role: 'tool',
      text: 'boom',
      toolName: 'run_command',
      outcome: 'non-zero',
    };
    const [block] = messageBlocks(message);
    expect(block?.kind).toBe('warning');
    expect(block?.header).toBe('Command failed');
  });

  it('renders a denied command as a warning block', () => {
    const message: TranscriptMessage = {
      role: 'tool',
      text: 'Denied by user.',
      toolName: 'run_command',
      outcome: 'denied',
    };
    const [block] = messageBlocks(message);
    expect(block?.kind).toBe('warning');
    expect(block?.header).toBe('Command denied');
  });

  it('renders an applied edit as a diff block carrying the diff lines', () => {
    const message: TranscriptMessage = {
      role: 'tool',
      text: 'Applied edit to src/app.ts.',
      toolName: 'apply_edit',
      toolArgs: 'path: src/app.ts',
      editOutcome: 'applied',
      diff: [
        { kind: 'del', text: 'const a = 1' },
        { kind: 'add', text: 'const a = 2' },
      ],
    };
    const [block] = messageBlocks(message);
    expect(block?.kind).toBe('diff');
    expect(block?.header).toBe('Edit applied (path: src/app.ts)');
    expect(block?.diff).toHaveLength(2);
  });
});

describe('block bodies and plain-text fallback', () => {
  it('prefixes diff bodies with +/- markers', () => {
    const block: Block = {
      kind: 'diff',
      header: 'Edit applied',
      lines: ['ignored when a diff is present'],
      diff: [
        { kind: 'del', text: 'old' },
        { kind: 'add', text: 'new' },
        { kind: 'ctx', text: 'same' },
      ],
    };
    expect(blockBodyLines(block)).toEqual(['- old', '+ new', '  same']);
  });

  it('builds a plain-text payload with the header and body', () => {
    const block: Block = { kind: 'code', header: 'Code', lines: ['const a = 1;'], language: 'ts' };
    expect(blockPlainText(block)).toBe('Code [ts]\nconst a = 1;');
  });

  it('gives every block kind a distinct glyph', () => {
    const kinds = [
      'prompt',
      'reasoning',
      'markdown',
      'code',
      'diff',
      'tool',
      'warning',
      'progress',
      'error',
    ] as const;
    const glyphs = new Set(kinds.map((kind) => blockGlyph(kind)));
    expect(glyphs.size).toBe(kinds.length);
  });

  it('labels progress and error blocks', () => {
    expect(progressBlock('working').header).toContain('streaming');
    expect(errorBlock('it broke').header).toBe('Error');
  });
});
