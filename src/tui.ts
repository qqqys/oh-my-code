import { resolve, sep } from 'node:path';
import process from 'node:process';

import {
  ApprovalStore,
  buildRequest,
  defaultApprovalPath,
  isAllowed,
  type ApprovalOutcome,
  type ApprovalRequest,
  type Risk,
} from './approval.js';
import {
  blockBodyLines,
  blockGlyph,
  blockPlainText,
  errorBlock,
  messageBlocks,
  progressBlock,
  type Block,
  type BlockKind,
} from './blocks.js';
import { runCommand } from './command.js';
import { ComposerState, type CommandOutcome, type EditOutcome, type TranscriptMessage } from './composer.js';
import { loadConfig, redact, type ModelConfig } from './config.js';
import { discoverContext } from './context.js';
import {
  commitEdit,
  prepareEdit,
  revertEdit,
  type DiffLine,
  type EditOperation,
  type EditPrepared,
} from './edit.js';
import { createProvider, type ChatMessage, type Provider, type Usage } from './provider.js';
import {
  createSession,
  isValidSessionId,
  loadSession,
  newSessionId,
  saveSession,
  shouldResumeStreaming,
  SessionError,
  type Session,
} from './session.js';
import { fullTheme, resolveTheme, type Theme } from './theme.js';
import { executeTool, type ToolCall, type ToolResult } from './tools.js';

const ESC = '\x1b[';

const seq = {
  home: `${ESC}H`,
  clear: `${ESC}2J`,
  altOn: `${ESC}1049h`,
  altOff: `${ESC}1049l`,
  cursorHide: `${ESC}25l`,
  cursorShow: `${ESC}25h`,
  moveTo: (row: number, col: number) => `${ESC}${row};${col}H`,
} as const;

// The active theme. Defaults to the full-color identity so rendering is
// deterministic under test; launchTui swaps it for the reduced-color theme when
// the terminal cannot (or should not) render hue. setActiveTheme lets tests
// exercise either path.
let fg: Theme = fullTheme;

export function setActiveTheme(theme: Theme): void {
  fg = theme;
}

export const LOGO = [
  '  ___  _   _     __  __            ____          _      ',
  ' / _ \\| | | |   |  \\/  | ___   _  / ___|___   __| | ___ ',
  '| | | | |_| |   | |\\/| |/ _ \\ | | |   / _ \\ / _` |/ _ \\',
  '| |_| |  _  |   | |  | | (_) || | |__| (_) | (_| |  __/',
  ' \\___/|_| |_|   |_|  |_|\\___/ |_|  \\____\\___/ \\__,_|\\___|',
];

// The widest logo line; below this width the ASCII logo is replaced by a compact
// one-line title so the interface stays usable on narrow terminals.
const LOGO_WIDTH = LOGO.reduce((max, line) => Math.max(max, Array.from(line).length), 0);

// Layout thresholds that trade decoration for usability as the terminal shrinks.
// The composer and footer are always preserved; the logo (6 rows) and the full
// status card (7 rows) are dropped first so the transcript keeps room even on a
// classic 80x24 terminal. Below the card threshold a one-line status replaces it.
const LOGO_MIN_HEIGHT = 28;
const STATUS_CARD_MIN_HEIGHT = 24;

export type ConnectionState = 'idle' | 'connecting' | 'streaming' | 'done' | 'error';

export interface UsageInfo {
  turns: number;
  promptTokens: number;
  completionTokens: number;
}

export interface StatusInfo {
  model: string;
  connection: ConnectionState;
  streamingText: string;
  error: string | null;
  usage: UsageInfo;
  canRetry: boolean;
  canRegenerate: boolean;
  canUndo: boolean;
  repository?: string;
  statusMessage?: string;
}

// Transcript navigation state: which block is selected (or -1 to follow the
// tail) and which block indices are collapsed.
export interface TranscriptNav {
  selectedBlock: number;
  collapsed: ReadonlySet<number>;
}

export interface ApprovalCardInfo {
  command: string;
  cwd: string;
  risk: Risk;
  scope: string;
  countdown: number;
}

export interface EditCardInfo {
  path: string;
  diff: readonly DiffLine[];
  added: number;
  removed: number;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function visibleLength(text: string): number {
  return Array.from(stripAnsi(text)).length;
}

// Truncate a possibly-styled line to at most `width` visible columns, preserving
// ANSI escape sequences and appending a reset so a cut never leaves an open
// style bleeding into the next frame.
function clipToWidth(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  let out = '';
  let visible = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\x1b') {
      const match = /^\x1b\[[0-9;]*[a-zA-Z]/.exec(text.slice(i));
      if (match !== null) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    if (visible >= width) break;
    out += text[i];
    visible += 1;
    i += 1;
  }
  return `${out}${ESC}0m`;
}

function pad(text: string, width: number): string {
  const visible = visibleLength(text);
  if (visible >= width) return text;
  return text + ' '.repeat(width - visible);
}

function center(text: string, width: number): string {
  const visible = visibleLength(text);
  if (visible >= width) return text;
  const left = Math.floor((width - visible) / 2);
  return ' '.repeat(left) + text;
}

function boxLine(left: string, content: string, right: string, innerWidth: number): string {
  return `  ${left} ${pad(clipToWidth(content, innerWidth), innerWidth)} ${right}`;
}

function wrapText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const segment of text.split('\n')) {
    const points = Array.from(segment);
    if (points.length === 0) {
      lines.push('');
      continue;
    }
    for (let i = 0; i < points.length; i += maxWidth) {
      lines.push(points.slice(i, i + maxWidth).join(''));
    }
  }
  return lines.length > 0 ? lines : [''];
}

function renderComposerLine(input: string, cursor: number, prompt: string): string {
  const points = Array.from(input);
  if (points.length === 0) {
    return `  ${fg.green(prompt)} ${fg.reverse(' ')}`;
  }
  const before = points.slice(0, cursor).join('');
  const at = points[cursor] ?? ' ';
  const after = points.slice(cursor + 1).join('');
  return `  ${fg.green(prompt)} ${before}${fg.reverse(at)}${after}`;
}

function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case 'idle':
      return fg.yellow('not connected');
    case 'connecting':
      return fg.yellow('connecting…');
    case 'streaming':
      return fg.green('streaming');
    case 'done':
      return fg.green('ready');
    case 'error':
      return fg.red('error');
  }
}

function usageLabel(usage: UsageInfo): string {
  const total = usage.promptTokens + usage.completionTokens;
  return fg.dim(`turns: ${usage.turns}  ·  tokens: ${total}`);
}

function actionHints(status: StatusInfo, selectedBlock: number): string {
  const hints: string[] = ['Enter send', '↑↓ history', 'Tab nav', 'Esc cancel', 'Ctrl+C exit'];
  // Once a block is selected, reveal the navigation-only shortcuts so they are
  // discoverable exactly when they apply.
  let at = 3;
  if (selectedBlock >= 0) {
    hints.splice(at, 0, 'Ctrl+E fold', 'Ctrl+Y copy');
    at += 2;
  }
  if (status.canRetry) {
    hints.splice(at, 0, 'Ctrl+R retry');
    at += 1;
  }
  if (status.canRegenerate) {
    hints.splice(at, 0, 'Ctrl+G regen');
    at += 1;
  }
  if (status.canUndo) {
    hints.splice(hints.length - 1, 0, 'Ctrl+U undo');
  }
  return hints.join('  ·  ');
}

// Wrap a " · "-joined hint line so each row fits the terminal width. Keeps the
// footer readable at narrow sizes instead of overflowing or being clipped.
function wrapHints(hints: string, width: number): string[] {
  if (visibleLength(hints) <= width) return [hints];
  const parts = hints.split('  ·  ');
  const lines: string[] = [];
  let current = '';
  for (const part of parts) {
    const candidate = current.length === 0 ? part : `${current}  ·  ${part}`;
    if (current.length === 0 || visibleLength(candidate) <= width) {
      current = candidate;
    } else {
      lines.push(current);
      current = part;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

function riskLabel(risk: Risk): string {
  switch (risk) {
    case 'high':
      return fg.red(fg.bold('high'));
    case 'medium':
      return fg.yellow('medium');
    case 'low':
      return fg.green('low');
  }
}

function renderApprovalCard(info: ApprovalCardInfo): string[] {
  return [
    `  ${fg.yellow(fg.bold('⚠ Approval required'))}`,
    `  Command:   ${fg.bold(info.command)}`,
    `  Directory: ${info.cwd}`,
    `  Risk:      ${riskLabel(info.risk)}`,
    `  Scope:     ${info.scope}`,
    '',
    `  ${fg.dim('auto-deny in ' + info.countdown + 's')}`,
  ];
}

// The proposed-edit card shows a tight diff (removed lines red, added lines
// green) so the user can review exactly what will change before accepting.
function renderEditCard(info: EditCardInfo): string[] {
  const lines: string[] = [
    `  ${fg.cyan(fg.bold('✎ Edit proposed'))}`,
    `  File:  ${info.path}`,
    '',
  ];
  for (const line of info.diff) {
    if (line.kind === 'add') {
      lines.push(`  ${fg.green('+ ' + line.text)}`);
    } else if (line.kind === 'del') {
      lines.push(`  ${fg.red('- ' + line.text)}`);
    } else {
      lines.push(`  ${fg.dim('  ' + line.text)}`);
    }
  }
  lines.push('');
  lines.push(`  ${fg.green('+' + info.added)}  ${fg.red('-' + info.removed)}`);
  return lines;
}

// Each block kind has a stable color so the transcript reads as a consistent
// visual hierarchy. The glyph and label come from the block model.
function blockColor(kind: BlockKind): (s: string) => string {
  switch (kind) {
    case 'prompt':
      return fg.cyan;
    case 'reasoning':
      return fg.magenta;
    case 'markdown':
      return fg.white;
    case 'code':
      return fg.cyan;
    case 'diff':
      return fg.green;
    case 'tool':
      return fg.magenta;
    case 'warning':
      return fg.yellow;
    case 'progress':
      return fg.green;
    case 'error':
      return fg.red;
  }
}

// Render one block to styled lines: a header (glyph + label, reverse-video when
// selected) followed by an indented body, or a one-line collapse marker. The
// output is readable with styling stripped, satisfying the plain-text fallback.
function renderBlockLines(
  block: Block,
  transcriptWidth: number,
  selected: boolean,
  collapsed: boolean,
): string[] {
  const lines: string[] = [];
  const color = blockColor(block.kind);
  const truncTag = block.truncated === true ? ` ${fg.yellow('[truncated]')}` : '';
  const langTag =
    block.language !== undefined && block.language.length > 0 ? ` ${fg.dim('[' + block.language + ']')}` : '';
  const marker = selected ? fg.reverse(' ') : ' ';
  lines.push(`  ${marker}${color(fg.bold(blockGlyph(block.kind)))} ${color(block.header)}${langTag}${truncTag}`);

  if (collapsed) {
    const count = blockBodyLines(block).length;
    lines.push(`     ${fg.dim('[' + count + ' line' + (count === 1 ? '' : 's') + ' collapsed]')}`);
    lines.push('');
    return lines;
  }

  if (block.diff !== undefined && block.diff.length > 0) {
    for (const line of block.diff) {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      const lineColor = line.kind === 'add' ? fg.green : line.kind === 'del' ? fg.red : fg.dim;
      for (const wrapped of wrapText(`${prefix} ${line.text}`, transcriptWidth)) {
        lines.push(`     ${lineColor(wrapped)}`);
      }
    }
  } else {
    for (const line of block.lines) {
      const rendered = block.kind === 'code' ? `${fg.dim('│')} ${line}` : line;
      for (const wrapped of wrapText(rendered, transcriptWidth)) {
        lines.push(`     ${color(wrapped)}`);
      }
    }
  }
  lines.push('');
  return lines;
}

export function renderScreen(
  width: number,
  height: number,
  version: string,
  messages: readonly TranscriptMessage[] = [],
  composerInput = '',
  composerCursor = 0,
  status: StatusInfo = {
    model: 'none',
    connection: 'idle',
    streamingText: '',
    error: null,
    usage: { turns: 0, promptTokens: 0, completionTokens: 0 },
    canRetry: false,
    canRegenerate: false,
    canUndo: false,
  },
  approval: ApprovalCardInfo | null = null,
  edit: EditCardInfo | null = null,
  nav: TranscriptNav = { selectedBlock: -1, collapsed: new Set() },
): string {
  const header: string[] = [];

  // Identity: the full ASCII logo only when there is room; otherwise a compact
  // one-line title keeps the header small on narrow or short terminals.
  const showLogo = width >= LOGO_WIDTH && height >= LOGO_MIN_HEIGHT;
  if (showLogo) {
    for (const line of LOGO) {
      header.push(center(fg.cyan(fg.bold(line)), width));
    }
    header.push(center(fg.dim(`v${version}`), width));
  } else {
    header.push(`  ${fg.cyan(fg.bold('Oh My Code'))} ${fg.dim(`v${version}`)}`);
  }
  header.push('');

  // Status: a boxed card when tall enough, otherwise a single clipped line so
  // model/connection/repository remain visible without consuming the transcript.
  if (height >= STATUS_CARD_MIN_HEIGHT) {
    const cardInner = width > 10 ? width - 10 : 1;
    header.push(`  ${fg.blue('┌' + '─'.repeat(cardInner + 2) + '┐')}`);
    header.push(fg.blue(boxLine('│', fg.bold('  Status'), '│', cardInner)));
    header.push(fg.blue(boxLine('│', '', '│', cardInner)));
    header.push(fg.blue(boxLine('│', `  Model:      ${status.model}`, '│', cardInner)));
    header.push(fg.blue(boxLine('│', `  Connection: ${connectionLabel(status.connection)}`, '│', cardInner)));
    header.push(fg.blue(boxLine('│', `  Repository: ${status.repository ?? fg.dim('none')}`, '│', cardInner)));
    header.push(`  ${fg.blue('└' + '─'.repeat(cardInner + 2) + '┘')}`);
  } else {
    const repo = status.repository ?? 'none';
    header.push(
      `  ${fg.bold('Status')}  Model: ${status.model}  ·  ${connectionLabel(status.connection)}  ·  Repo: ${repo}`,
    );
  }
  header.push('');

  // Transcript header
  header.push(`  ${fg.gray('─ Transcript ' + '─'.repeat(Math.max(0, width - 16)))}`);
  header.push('');

  // Transcript body: every message becomes one or more typed blocks (reasoning,
  // Markdown, code, diff, tool, warning), plus a live progress block while
  // streaming and an error block on failure. The body scrolls as a whole when it
  // overflows, and can scroll to a selected block when navigating.
  const body: string[] = [];
  const blockStart: number[] = [];
  const transcriptWidth = width - 6;
  if (messages.length === 0 && status.streamingText.length === 0 && status.error === null) {
    body.push(center(fg.dim('No messages yet.'), width));
    body.push('');
  } else {
    const blocks: Block[] = [];
    for (const message of messages) {
      blocks.push(...messageBlocks(message));
    }
    if (status.streamingText.length > 0) blocks.push(progressBlock(status.streamingText));
    if (status.error !== null) blocks.push(errorBlock(status.error));
    let index = 0;
    for (const block of blocks) {
      blockStart.push(body.length);
      body.push(...renderBlockLines(block, transcriptWidth, index === nav.selectedBlock, nav.collapsed.has(index)));
      index += 1;
    }
  }

  // Composer + footer are pinned to the bottom; the transcript scrolls above.
  // While an approval is pending, the approval card replaces the composer.
  const composer: string[] =
    approval !== null
      ? [
          '',
          `  ${fg.gray('─ Approval ' + '─'.repeat(Math.max(0, width - 14)))}`,
          '',
          ...renderApprovalCard(approval),
          '',
        ]
      : edit !== null
        ? [
            '',
            `  ${fg.gray('─ Edit ' + '─'.repeat(Math.max(0, width - 10)))}`,
            '',
            ...renderEditCard(edit),
            '',
          ]
        : [
            '',
            `  ${fg.gray('─ Composer ' + '─'.repeat(Math.max(0, width - 14)))}`,
            '',
            renderComposerLine(composerInput, composerCursor, '❯'),
            '',
          ];
  const footerHints =
    approval !== null
      ? 'y allow once  ·  a always  ·  n deny  ·  Esc cancel  ·  Ctrl+C exit'
      : edit !== null
        ? 'y accept  ·  n reject  ·  Esc cancel  ·  Ctrl+C exit'
        : actionHints(status, nav.selectedBlock);
  const footer: string[] = [];
  if (status.statusMessage !== undefined && status.statusMessage.length > 0) {
    footer.push(center(fg.green(status.statusMessage), width));
  }
  footer.push(center(usageLabel(status.usage), width));
  // Wrap the hints so a narrow terminal keeps every shortcut on-screen instead
  // of clipping the later ones.
  for (const line of wrapHints(footerHints, width - 2)) {
    footer.push(center(fg.dim(line), width));
  }

  // The composer and footer are essential and pinned to the bottom. Trim blank
  // header padding first so they always remain on-screen at small heights.
  while (header.length + composer.length + footer.length > height && header.includes('')) {
    header.splice(header.lastIndexOf(''), 1);
  }
  const available = height - header.length - composer.length - footer.length;
  const lines: string[] = [...header];
  if (available > 0 && body.length > available) {
    // Reserve one row for the "more above" marker, leaving the rest for content.
    const contentRows = available - 1;
    // When a block is selected, scroll so its header is visible; otherwise keep
    // the newest content pinned to the bottom (follow-tail).
    let start: number;
    if (nav.selectedBlock >= 0 && nav.selectedBlock < blockStart.length) {
      const wanted = blockStart[nav.selectedBlock] ?? 0;
      start = Math.max(0, Math.min(wanted, body.length - contentRows));
    } else {
      start = Math.max(0, body.length - contentRows);
    }
    if (start > 0) {
      lines.push(center(fg.dim('...'), width));
      lines.push(...body.slice(start, start + contentRows));
    } else {
      // A selected block at the very top: use the full available height.
      lines.push(...body.slice(0, available));
    }
  } else if (available > 0) {
    lines.push(...body);
  }
  lines.push(...composer);
  while (lines.length < height - footer.length) {
    lines.push('');
  }
  lines.push(...footer);

  // Pad every line to full width so a redraw fully overwrites the prior frame
  // and no stale characters bleed through. clipToWidth keeps any line whose
  // content is wider than the terminal from wrapping and corrupting the frame.
  return lines
    .slice(0, height)
    .map((line) => pad(clipToWidth(line, width), width))
    .join('\r\n');
}

export interface TuiOptions {
  version: string;
  config?: ModelConfig;
  workspace?: string;
  sessionId?: string;
  resume?: boolean;
}

const KEY = {
  enter: 0x0d,
  escape: 0x1b,
  backspace: 0x7f,
  delete: 0x08,
  tab: 0x09,
  ctrlC: 0x03,
  ctrlD: 0x04,
  ctrlE: 0x05,
  ctrlG: 0x07,
  ctrlR: 0x12,
  ctrlU: 0x15,
  ctrlY: 0x19,
} as const;

function parseKey(data: Buffer): { type: string; value?: string } {
  const first = data[0];
  if (first === undefined) return { type: 'unknown' };

  if (data.length === 1) {
    if (first === KEY.enter) return { type: 'enter' };
    if (first === KEY.escape) return { type: 'escape' };
    if (first === KEY.backspace || first === KEY.delete) return { type: 'backspace' };
    if (first === KEY.ctrlC || first === KEY.ctrlD) return { type: 'exit' };
    if (first === KEY.ctrlR) return { type: 'retry' };
    if (first === KEY.ctrlG) return { type: 'regenerate' };
    if (first === KEY.ctrlU) return { type: 'undo' };
    if (first === KEY.tab) return { type: 'selectNext' };
    if (first === KEY.ctrlE) return { type: 'toggleCollapse' };
    if (first === KEY.ctrlY) return { type: 'copySelected' };
    if (first >= 0x20) return { type: 'char', value: data.toString('utf8') };
    return { type: 'unknown' };
  }

  const str = data.toString('utf8');

  // ANSI escape sequences
  if (str.startsWith('\x1b[')) {
    switch (str) {
      case '\x1b[A': return { type: 'up' };
      case '\x1b[B': return { type: 'down' };
      case '\x1b[C': return { type: 'right' };
      case '\x1b[D': return { type: 'left' };
      case '\x1b[H': return { type: 'home' };
      case '\x1b[F': return { type: 'end' };
      case '\x1b[3~': return { type: 'deleteForward' };
      case '\x1b[1~': return { type: 'home' };
      case '\x1b[4~': return { type: 'end' };
      case '\x1b[Z': return { type: 'selectPrev' };
      default: return { type: 'unknown' };
    }
  }

  // Multi-byte Unicode character
  if (first >= 0x20 && first !== 0x7f) {
    return { type: 'char', value: str };
  }

  return { type: 'unknown' };
}

function parseTimeoutEnv(value: string | undefined, fallback: number): number {
  const parsed = value !== undefined ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Resolve a user-supplied path inside the workspace, rejecting escapes.
function resolveCwd(workspace: string, inputPath: string): string | null {
  const root = resolve(workspace);
  const resolved = resolve(root, inputPath);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return null;
  }
  return resolved;
}

export async function launchTui(options: TuiOptions): Promise<void> {
  const { version } = options;
  const config = options.config ?? loadConfig();
  const provider: Provider = createProvider(config);
  const workspace = options.workspace ?? process.cwd();
  const stdin = process.stdin;
  const stdout = process.stdout;
  const composer = new ComposerState();

  // Pick the theme from the environment before the first frame: full color by
  // default, the reduced-color theme when the terminal cannot (or should not)
  // render hue. Every meaning is also carried by a glyph or label, so no
  // information is lost in either theme.
  setActiveTheme(resolveTheme());

  // Orient before any coding begins: a concise, evidence-based snapshot of the
  // repository shown in the status card. The full detail is available on demand
  // through the repo_context tool.
  const startupContext = discoverContext(workspace);
  const repositoryLabel = startupContext.git.isRepo
    ? `${startupContext.git.branch ?? 'detached'} · ${startupContext.packages.length} pkg`
    : `${startupContext.packages.length} pkg`;

  let connection: ConnectionState = 'idle';
  let streamingText = '';
  let errorMessage: string | null = null;
  let streaming = false;
  let abortController: AbortController | null = null;
  let lastErrorRecoverable = false;
  const usage: UsageInfo = { turns: 0, promptTokens: 0, completionTokens: 0 };

  // Transcript navigation: the selected block (-1 means "follow the tail") and
  // the set of collapsed block indices. A transient status message (e.g. a copy
  // confirmation) is shown in the footer until the next render clears it.
  let selectedBlock = -1;
  const collapsed = new Set<number>();
  let statusMessage: string | null = null;

  // Durable session: every launch persists its transcript so an interrupted run
  // can be resumed. Resuming seeds the transcript and usage from disk and fails
  // safely with recovery guidance when the stored session is missing or corrupt.
  let session: Session;
  if (options.resume === true) {
    const requested = options.sessionId ?? process.env['OMC_SESSION_ID'] ?? '';
    try {
      session = loadSession(workspace, requested);
    } catch (error) {
      const guidance =
        error instanceof SessionError ? error.message : `Could not resume session "${requested}".`;
      process.stderr.write(`${guidance}\n`);
      process.exitCode = 1;
      return;
    }
    for (const message of session.messages) {
      composer.messages.push(message);
    }
    usage.turns = session.usage.turns;
    usage.promptTokens = session.usage.promptTokens;
    usage.completionTokens = session.usage.completionTokens;
  } else {
    const requested = options.sessionId ?? process.env['OMC_SESSION_ID'];
    const sessionId = requested !== undefined && isValidSessionId(requested) ? requested : newSessionId();
    session = createSession(sessionId);
  }

  // Best-effort persistence: a write failure must never crash the live session.
  function persist(): void {
    session.messages = composer.messages.slice();
    session.usage = {
      turns: usage.turns,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    };
    try {
      saveSession(workspace, session);
    } catch {
      // Ignore persistence errors; the in-memory session keeps working.
    }
  }

  const approvalStore = ApprovalStore.load(defaultApprovalPath(workspace));
  const approvalTimeoutMs = parseTimeoutEnv(process.env['OMC_APPROVAL_TIMEOUT_MS'], 30_000);
  const commandTimeoutMs = parseTimeoutEnv(process.env['OMC_COMMAND_TIMEOUT_MS'], 120_000);
  let pendingApproval:
    | {
        request: ApprovalRequest;
        resolve: (outcome: ApprovalOutcome) => void;
        timer: ReturnType<typeof setInterval>;
      }
    | null = null;
  let approvalCountdown = 0;
  let pendingEdit:
    | {
        prepared: EditPrepared;
        resolve: (decision: 'accept' | 'reject') => void;
      }
    | null = null;
  // The most recently applied edit, kept so Ctrl+U can revert exactly that
  // operation and nothing else. Cleared once reverted or replaced.
  let lastEdit: EditOperation | null = null;

  function lastMessage(): TranscriptMessage | undefined {
    return composer.messages[composer.messages.length - 1];
  }

  function canRetry(): boolean {
    return !streaming && connection === 'error' && lastErrorRecoverable;
  }

  function canRegenerate(): boolean {
    return !streaming && lastMessage()?.role === 'assistant';
  }

  function canUndo(): boolean {
    return !streaming && pendingEdit === null && lastEdit !== null;
  }

  // The exact block list the renderer draws, recomputed for keyboard navigation
  // so selection, collapse, and copy operate on what the user sees.
  function currentBlocks(): Block[] {
    const blocks: Block[] = [];
    for (const message of composer.messages) {
      blocks.push(...messageBlocks(message));
    }
    if (streamingText.length > 0) blocks.push(progressBlock(streamingText));
    if (errorMessage !== null) blocks.push(errorBlock(errorMessage));
    return blocks;
  }

  function buildStatus(): StatusInfo {
    const status: StatusInfo = {
      model: redact(config),
      connection,
      streamingText,
      error: errorMessage,
      usage,
      canRetry: canRetry(),
      canRegenerate: canRegenerate(),
      canUndo: canUndo(),
      repository: repositoryLabel,
    };
    if (statusMessage !== null) status.statusMessage = statusMessage;
    return status;
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    const { columns, rows } = stdout;
    const screen = renderScreen(columns ?? 80, rows ?? 24, version, composer.messages, '', 0, buildStatus());
    stdout.write(screen + '\n');
    return;
  }

  let running = true;

  function getSize(): { width: number; height: number } {
    return {
      width: stdout.columns ?? 80,
      height: stdout.rows ?? 24,
    };
  }

  function render(): void {
    const { width, height } = getSize();
    const screen = renderScreen(
      width,
      height,
      version,
      composer.messages,
      composer.input,
      composer.cursorPosition,
      buildStatus(),
      approvalCard(),
      editCard(),
      { selectedBlock, collapsed },
    );
    stdout.write(seq.home + screen);
  }

  function exit(): void {
    if (!running) return;
    running = false;
    if (abortController) abortController.abort();
    cleanup();
    stdout.write(seq.cursorShow + seq.altOff);
    process.exit(0);
  }

  function applyUsage(delta: Usage): void {
    usage.promptTokens += delta.promptTokens;
    usage.completionTokens += delta.completionTokens;
  }

  function approvalCard(): ApprovalCardInfo | null {
    if (pendingApproval === null) return null;
    const { request } = pendingApproval;
    return {
      command: request.command,
      cwd: request.cwd,
      risk: request.risk,
      scope: request.scope,
      countdown: approvalCountdown,
    };
  }

  // Pause for an approval decision. Resolves when the user chooses allow/deny,
  // cancels, or the countdown expires. No command can start until this resolves.
  function requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    return new Promise<ApprovalOutcome>((resolve) => {
      approvalCountdown = Math.max(1, Math.ceil(approvalTimeoutMs / 1000));
      const timer = setInterval(() => {
        approvalCountdown -= 1;
        if (approvalCountdown <= 0) {
          if (pendingApproval !== null) {
            clearInterval(pendingApproval.timer);
            pendingApproval = null;
          }
          approvalCountdown = 0;
          render();
          resolve('timeout');
        } else {
          render();
        }
      }, 1000);
      pendingApproval = { request, resolve, timer };
      render();
    });
  }

  function resolveApproval(outcome: ApprovalOutcome): void {
    const pending = pendingApproval;
    if (pending === null) return;
    clearInterval(pending.timer);
    pendingApproval = null;
    approvalCountdown = 0;
    render();
    pending.resolve(outcome);
  }

  function pushCommandMessage(
    call: ToolCall,
    outcome: CommandOutcome,
    text: string,
    truncated: boolean,
  ): void {
    const argParts = Object.entries(call.args).map(([k, v]) => `${k}: ${v}`);
    const message: TranscriptMessage = {
      role: 'tool',
      text,
      toolName: 'run_command',
      toolArgs: argParts.join(', '),
      outcome,
    };
    if (truncated) message.truncated = true;
    composer.messages.push(message);
  }

  async function handleCommand(call: ToolCall): Promise<ToolResult> {
    const command = (call.args.command ?? '').trim();
    const pathArg = call.args.path ?? '.';
    if (command.length === 0) {
      pushCommandMessage(call, 'denied', 'No command provided.', false);
      return { name: 'run_command', output: '', truncated: false, error: 'No command provided.' };
    }
    const cwd = resolveCwd(workspace, pathArg);
    if (cwd === null) {
      const error = `Path escapes the workspace: ${pathArg}`;
      pushCommandMessage(call, 'denied', error, false);
      return { name: 'run_command', output: '', truncated: false, error };
    }

    const request = buildRequest(command, cwd);
    const outcome = approvalStore.matches(request) ? 'allow-rule' : await requestApproval(request);
    if (outcome === 'allow-rule' && !approvalStore.matches(request)) {
      approvalStore.add({ command: request.command, cwd: request.cwd });
    }

    if (!isAllowed(outcome)) {
      const label: CommandOutcome =
        outcome === 'timeout' ? 'timeout' : outcome === 'cancel' ? 'cancelled' : 'denied';
      const reason =
        outcome === 'timeout'
          ? 'Approval window expired; command not run.'
          : outcome === 'cancel'
            ? 'Cancelled before running.'
            : 'Denied by user.';
      pushCommandMessage(call, label, reason, false);
      return { name: 'run_command', output: '', truncated: false, error: reason };
    }

    const signal = abortController?.signal;
    const exec = await runCommand({
      command: request.command,
      cwd: request.cwd,
      timeoutMs: commandTimeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    });
    const label: CommandOutcome =
      exec.status === 'ok'
        ? 'ok'
        : exec.status === 'non-zero'
          ? 'non-zero'
          : exec.status === 'timeout'
            ? 'timeout'
            : 'cancelled';
    pushCommandMessage(call, label, exec.output, exec.truncated);
    const error = exec.status === 'ok' ? null : `exit ${exec.exitCode ?? exec.status}`;
    return { name: 'run_command', output: exec.output, truncated: exec.truncated, error };
  }

  function editCard(): EditCardInfo | null {
    if (pendingEdit === null) return null;
    const { prepared } = pendingEdit;
    return {
      path: prepared.operation.relativePath,
      diff: prepared.diff,
      added: prepared.added,
      removed: prepared.removed,
    };
  }

  // Pause for an accept/reject decision on a proposed edit. No write happens
  // until this resolves, so the file is untouched while the diff is under review.
  function requestEditDecision(prepared: EditPrepared): Promise<'accept' | 'reject'> {
    return new Promise<'accept' | 'reject'>((resolve) => {
      pendingEdit = { prepared, resolve };
      render();
    });
  }

  function resolveEdit(decision: 'accept' | 'reject'): void {
    const pending = pendingEdit;
    if (pending === null) return;
    pendingEdit = null;
    render();
    pending.resolve(decision);
  }

  function pushEditMessage(
    outcome: EditOutcome,
    argsLabel: string,
    text: string,
    diff?: readonly DiffLine[],
  ): void {
    const message: TranscriptMessage = {
      role: 'tool',
      text,
      toolName: 'apply_edit',
      toolArgs: argsLabel,
      editOutcome: outcome,
    };
    if (diff !== undefined && diff.length > 0) message.diff = diff.map((line) => ({ ...line }));
    composer.messages.push(message);
  }

  async function handleEdit(call: ToolCall): Promise<ToolResult> {
    const pathArg = (call.args.path ?? '').trim();
    const argsLabel = `path: ${pathArg.length > 0 ? pathArg : '(none)'}`;
    if (pathArg.length === 0) {
      pushEditMessage('conflict', argsLabel, 'No path provided.');
      return { name: 'apply_edit', output: '', truncated: false, error: 'No path provided.' };
    }
    const prepared = prepareEdit(
      {
        path: pathArg,
        oldString: call.args.old_string ?? '',
        newString: call.args.new_string ?? '',
      },
      workspace,
    );
    if ('status' in prepared) {
      pushEditMessage('conflict', argsLabel, prepared.error);
      return { name: 'apply_edit', output: '', truncated: false, error: prepared.error };
    }

    const decision = await requestEditDecision(prepared);
    if (decision === 'reject') {
      pushEditMessage('rejected', argsLabel, 'Rejected by user; file unchanged.');
      return { name: 'apply_edit', output: '', truncated: false, error: 'Edit rejected by user.' };
    }

    const committed = commitEdit(prepared.operation);
    if (committed.status === 'applied') {
      lastEdit = committed.operation;
      const summary = `Applied edit to ${committed.operation.relativePath}.`;
      pushEditMessage('applied', argsLabel, summary, prepared.diff);
      return { name: 'apply_edit', output: summary, truncated: false, error: null };
    }
    pushEditMessage('conflict', argsLabel, committed.error);
    return { name: 'apply_edit', output: '', truncated: false, error: committed.error };
  }

  // Revert only the most recent applied edit. revertEdit reverses that single
  // substitution and fails closed if the file changed, so unrelated work stays intact.
  function revertLastEdit(): void {
    if (lastEdit === null) return;
    const target = lastEdit;
    const argsLabel = `path: ${target.relativePath}`;
    const result = revertEdit(target);
    if (result.status === 'reverted') {
      lastEdit = null;
      pushEditMessage('reverted', argsLabel, `Reverted edit to ${target.relativePath}.`);
    } else {
      pushEditMessage('conflict', argsLabel, result.error);
    }
    persist();
    render();
  }

  // Move selection to the next block, entering navigation mode from the tail.
  function selectNextBlock(): void {
    const count = currentBlocks().length;
    if (count === 0) return;
    selectedBlock = selectedBlock < 0 ? 0 : Math.min(selectedBlock + 1, count - 1);
  }

  // Move selection to the previous block; from the tail this jumps to the last.
  function selectPrevBlock(): void {
    const count = currentBlocks().length;
    if (count === 0) return;
    selectedBlock = selectedBlock < 0 ? count - 1 : Math.max(selectedBlock - 1, 0);
  }

  function toggleCollapseBlock(): void {
    if (selectedBlock < 0) return;
    if (collapsed.has(selectedBlock)) collapsed.delete(selectedBlock);
    else collapsed.add(selectedBlock);
  }

  // Copy the selected block to the clipboard via OSC 52, with a visible
  // confirmation. Falls back to a status message when nothing is selected.
  function copySelectedBlock(): void {
    const block = currentBlocks()[selectedBlock];
    if (block === undefined) {
      statusMessage = 'No block selected';
      return;
    }
    const encoded = Buffer.from(blockPlainText(block), 'utf8').toString('base64');
    stdout.write(`\x1b]52;c;${encoded}\x07`);
    statusMessage = 'Copied block to clipboard';
  }

  async function streamResponse(): Promise<void> {
    if (streaming) return;
    const last = lastMessage();
    if (last === undefined || last.role !== 'user') return;

    streaming = true;
    errorMessage = null;
    lastErrorRecoverable = false;
    streamingText = '';
    connection = 'connecting';
    render();

    abortController = new AbortController();
    const chatMessages: ChatMessage[] = [];
    for (const m of composer.messages) {
      if (m.role === 'user' || m.role === 'assistant') {
        chatMessages.push({ role: m.role, text: m.text });
      }
    }

    try {
      const gen = provider.stream(chatMessages, abortController.signal);
      let toolInput: ToolResult | undefined;
      while (true) {
        const { value, done } = await gen.next(toolInput);
        if (done) break;
        if (!running) break;
        toolInput = undefined;
        switch (value.type) {
          case 'delta':
            connection = 'streaming';
            streamingText += value.text;
            render();
            break;
          case 'tool_call': {
            connection = 'streaming';
            if (value.call.name === 'run_command') {
              toolInput = await handleCommand(value.call);
            } else if (value.call.name === 'apply_edit') {
              toolInput = await handleEdit(value.call);
            } else {
              const result = executeTool(value.call, workspace);
              const argParts = Object.entries(value.call.args).map(([k, v]) => `${k}: ${v}`);
              composer.messages.push({
                role: 'tool',
                text: result.error ?? result.output,
                toolName: value.call.name,
                toolArgs: argParts.join(', '),
                truncated: result.truncated,
              });
              toolInput = result;
            }
            render();
            break;
          }
          case 'done':
            connection = 'done';
            composer.messages.push({ role: 'assistant', text: streamingText });
            applyUsage(value.usage);
            usage.turns += 1;
            streamingText = '';
            render();
            break;
          case 'error':
            if (value.error === 'cancelled') {
              connection = 'done';
              streamingText = '';
              usage.turns += 1;
            } else {
              connection = 'error';
              errorMessage = value.error;
              lastErrorRecoverable = value.recoverable;
            }
            render();
            break;
        }
      }
    } catch (error) {
      connection = 'error';
      errorMessage = error instanceof Error ? error.message : 'Unknown streaming error';
      lastErrorRecoverable = true;
      render();
    } finally {
      streaming = false;
      abortController = null;
      if (connection === 'connecting') {
        connection = 'done';
      }
      // A finished turn returns focus to the live tail so new output is visible.
      selectedBlock = -1;
      persist();
      render();
    }
  }

  function retry(): void {
    if (!canRetry()) return;
    void streamResponse();
  }

  function regenerate(): void {
    if (!canRegenerate()) return;
    // Remove the assistant reply and any tool messages from the last turn,
    // back to (but not including) the last user message, then re-stream.
    while (composer.messages.length > 0) {
      const last = composer.messages[composer.messages.length - 1];
      if (last === undefined || last.role === 'user') break;
      composer.messages.pop();
    }
    // Removing blocks shifts indices, so drop stale collapse/selection state.
    collapsed.clear();
    selectedBlock = -1;
    void streamResponse();
  }

  function onKeypress(data: Buffer): void {
    if (pendingApproval !== null) {
      const approvalKey = parseKey(data);
      if (approvalKey.type === 'exit') {
        exit();
        return;
      }
      if (approvalKey.type === 'escape') {
        resolveApproval('cancel');
        return;
      }
      if (approvalKey.type === 'char' && approvalKey.value !== undefined) {
        const choice = approvalKey.value.toLowerCase();
        if (choice === 'y') return resolveApproval('allow-once');
        if (choice === 'a') return resolveApproval('allow-rule');
        if (choice === 'n') return resolveApproval('deny');
      }
      return;
    }
    if (pendingEdit !== null) {
      const editKey = parseKey(data);
      if (editKey.type === 'exit') {
        exit();
        return;
      }
      if (editKey.type === 'escape') {
        resolveEdit('reject');
        return;
      }
      if (editKey.type === 'char' && editKey.value !== undefined) {
        const choice = editKey.value.toLowerCase();
        if (choice === 'y') return resolveEdit('accept');
        if (choice === 'n') return resolveEdit('reject');
      }
      return;
    }
    const key = parseKey(data);
    // A transient status toast (e.g. a copy confirmation) clears on the next key.
    if (key.type !== 'copySelected') statusMessage = null;
    switch (key.type) {
      case 'exit':
        exit();
        return;
      case 'char':
        if (key.value) composer.insert(key.value);
        break;
      case 'backspace':
        composer.backspace();
        break;
      case 'deleteForward':
        composer.deleteForward();
        break;
      case 'left':
        composer.moveLeft();
        break;
      case 'right':
        composer.moveRight();
        break;
      case 'home':
        composer.moveToStart();
        break;
      case 'end':
        composer.moveToEnd();
        break;
      case 'up':
        composer.historyUp();
        break;
      case 'down':
        composer.historyDown();
        break;
      case 'enter': {
        const submitted = composer.submit();
        if (submitted) {
          // A new prompt returns to the live tail so the answer is visible.
          selectedBlock = -1;
          // Persist the pending user message before streaming so an interrupted
          // turn can be resumed as a pending safe action.
          persist();
          void streamResponse();
        }
        break;
      }
      case 'selectNext':
        selectNextBlock();
        break;
      case 'selectPrev':
        selectPrevBlock();
        break;
      case 'toggleCollapse':
        toggleCollapseBlock();
        break;
      case 'copySelected':
        copySelectedBlock();
        break;
      case 'retry':
        retry();
        return;
      case 'regenerate':
        regenerate();
        return;
      case 'undo':
        revertLastEdit();
        return;
      case 'escape':
        if (streaming && abortController) {
          abortController.abort();
        } else {
          composer.cancel();
        }
        break;
      default:
        break;
    }
    render();
  }

  function onResize(): void {
    render();
  }

  function onSignal(): void {
    exit();
  }

  function cleanup(): void {
    stdin.removeListener('data', onKeypress);
    stdout.removeListener('resize', onResize);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }

  stdin.setRawMode(true);
  stdin.resume();

  stdout.write(seq.altOn + seq.cursorHide + seq.clear);

  stdin.on('data', onKeypress);
  stdout.on('resize', onResize);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  render();

  // On resume, continue only an interrupted, unanswered user message (a pending
  // safe action). Completed turns are left exactly as restored, so finished
  // mutations are never replayed.
  if (options.resume === true && shouldResumeStreaming(composer.messages)) {
    void streamResponse();
  }

  return new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!running) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
}
