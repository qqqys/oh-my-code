import type { CommandOutcome, EditOutcome, TranscriptMessage } from './composer.js';
import type { DiffLine } from './edit.js';

// The distinct block kinds the transcript renders. Each has a stable glyph and
// color (see the renderer) and a plain-text fallback so the same content reads
// correctly with styling stripped.
export type BlockKind =
  | 'prompt'
  | 'reasoning'
  | 'markdown'
  | 'code'
  | 'diff'
  | 'tool'
  | 'warning'
  | 'progress'
  | 'error';

export interface Block {
  kind: BlockKind;
  header: string;
  lines: string[];
  diff?: DiffLine[];
  language?: string;
  truncated?: boolean;
}

export function blockGlyph(kind: BlockKind): string {
  switch (kind) {
    case 'prompt':
      return '❯';
    case 'reasoning':
      return '✻';
    case 'markdown':
      return '¶';
    case 'code':
      return '⌗';
    case 'diff':
      return '✎';
    case 'tool':
      return '⚙';
    case 'warning':
      return '⚠';
    case 'progress':
      return '⋯';
    case 'error':
      return '✖';
  }
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [''] : text.split('\n');
}

// A segment is treated as Markdown when it carries any common structural marker
// (headings, list items, blockquotes, bold, or inline code); otherwise it is a
// plain reasoning summary.
function looksLikeMarkdown(text: string): boolean {
  return /(^|\n)[ \t]*(#{1,6}[ \t]|[-*+][ \t]|\d+\.[ \t]|>|\*\*|`)/.test(text);
}

function commandLabel(outcome: CommandOutcome): string {
  switch (outcome) {
    case 'ok':
      return 'Command';
    case 'non-zero':
      return 'Command failed';
    case 'timeout':
      return 'Command timed out';
    case 'cancelled':
      return 'Command cancelled';
    case 'denied':
      return 'Command denied';
  }
}

function editLabel(outcome: EditOutcome): string {
  switch (outcome) {
    case 'applied':
      return 'Edit applied';
    case 'rejected':
      return 'Edit rejected';
    case 'reverted':
      return 'Edit reverted';
    case 'conflict':
      return 'Edit conflict';
  }
}

// Split an assistant message into ordered blocks: fenced code becomes code
// blocks and the surrounding prose becomes Markdown or reasoning blocks. This
// gives one turn a clear visual hierarchy instead of one wall of text.
export function assistantBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let prose: string[] = [];
  let code: string[] | null = null;
  let language = '';

  const flushProse = (): void => {
    const joined = prose.join('\n').trim();
    prose = [];
    if (joined.length === 0) return;
    const kind: BlockKind = looksLikeMarkdown(joined) ? 'markdown' : 'reasoning';
    blocks.push({
      kind,
      header: kind === 'markdown' ? 'Markdown' : 'Reasoning',
      lines: joined.split('\n'),
    });
  };

  const flushCode = (): void => {
    if (code === null) return;
    const block: Block = { kind: 'code', header: 'Code', lines: code };
    if (language.length > 0) block.language = language;
    blocks.push(block);
    code = null;
    language = '';
  };

  for (const line of lines) {
    const isFence = line.trimStart().startsWith('```');
    if (code !== null) {
      if (isFence) {
        flushCode();
      } else {
        code.push(line);
      }
      continue;
    }
    if (isFence) {
      flushProse();
      code = [];
      language = line.trimStart().slice(3).trim();
      continue;
    }
    prose.push(line);
  }
  // An unterminated fence is still shown as code rather than dropped.
  flushCode();
  flushProse();

  if (blocks.length === 0) {
    blocks.push({ kind: 'reasoning', header: 'Reasoning', lines: [''] });
  }
  return blocks;
}

function toolBlock(message: TranscriptMessage): Block {
  const name = message.toolName ?? 'tool';
  const args =
    message.toolArgs !== undefined && message.toolArgs.length > 0 ? ` (${message.toolArgs})` : '';

  if (message.toolName === 'apply_edit') {
    const label = editLabel(message.editOutcome ?? 'applied');
    const block: Block = { kind: 'diff', header: `${label}${args}`, lines: splitLines(message.text) };
    if (message.diff !== undefined && message.diff.length > 0) block.diff = message.diff;
    return block;
  }

  if (message.toolName === 'run_command') {
    const outcome = message.outcome ?? 'ok';
    const block: Block = {
      kind: outcome === 'ok' ? 'tool' : 'warning',
      header: `${commandLabel(outcome)}${args}`,
      lines: splitLines(message.text),
    };
    if (message.truncated === true) block.truncated = true;
    return block;
  }

  // Local /model command output: a tool block with a clean "Model" header. It is
  // kept out of the model context (only user/assistant messages are sent), so it
  // renders as a labeled notice rather than a real tool invocation.
  if (message.toolName === 'model') {
    return { kind: 'tool', header: `Model${args}`, lines: splitLines(message.text) };
  }

  // Local /policy command output: same treatment as /model, a labeled notice
  // kept out of the model context.
  if (message.toolName === 'policy') {
    return { kind: 'tool', header: `Policy${args}`, lines: splitLines(message.text) };
  }

  // Local /handoff command output: a labeled notice kept out of the model
  // context, like /model and /policy.
  if (message.toolName === 'handoff') {
    return { kind: 'tool', header: `Handoff${args}`, lines: splitLines(message.text) };
  }

  // Local /compact command output: a labeled notice kept out of the model
  // context, like the other local commands.
  if (message.toolName === 'compact') {
    return { kind: 'tool', header: `Compact${args}`, lines: splitLines(message.text) };
  }

  const block: Block = { kind: 'tool', header: `Tool ${name}${args}`, lines: splitLines(message.text) };
  if (message.truncated === true) block.truncated = true;
  return block;
}

// Every transcript message maps to one or more ordered blocks. Assistant
// messages can fan out into several blocks; all others are a single block.
export function messageBlocks(message: TranscriptMessage): Block[] {
  switch (message.role) {
    case 'user':
      return [{ kind: 'prompt', header: 'You', lines: splitLines(message.text) }];
    case 'assistant':
      return assistantBlocks(message.text);
    case 'tool':
      return [toolBlock(message)];
  }
}

export function progressBlock(text: string): Block {
  return { kind: 'progress', header: 'Progress (streaming…)', lines: splitLines(text) };
}

export function errorBlock(text: string): Block {
  return { kind: 'error', header: 'Error', lines: splitLines(text) };
}

// The body lines a block contributes to the transcript (and to copy). A diff
// block renders its diff with +/- markers; everything else uses its text lines.
export function blockBodyLines(block: Block): string[] {
  if (block.diff !== undefined && block.diff.length > 0) {
    return block.diff.map((line) => {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      return `${prefix} ${line.text}`;
    });
  }
  return block.lines;
}

// Plain-text fallback / clipboard payload: the header followed by the body,
// with no styling. Reads correctly when copied out of the terminal.
export function blockPlainText(block: Block): string {
  const suffix = block.language !== undefined && block.language.length > 0 ? ` [${block.language}]` : '';
  return [`${block.header}${suffix}`, ...blockBodyLines(block)].join('\n');
}
