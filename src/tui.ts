import process from 'node:process';

import { ComposerState, type TranscriptMessage } from './composer.js';
import { loadConfig, redact, type ModelConfig } from './config.js';
import { createProvider, type ChatMessage, type Provider, type Usage } from './provider.js';

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

const fg = {
  reset: (s: string) => `${ESC}0m${s}${ESC}0m`,
  bold: (s: string) => `${ESC}1m${s}${ESC}0m`,
  dim: (s: string) => `${ESC}2m${s}${ESC}0m`,
  green: (s: string) => `${ESC}32m${s}${ESC}0m`,
  yellow: (s: string) => `${ESC}33m${s}${ESC}0m`,
  blue: (s: string) => `${ESC}34m${s}${ESC}0m`,
  cyan: (s: string) => `${ESC}36m${s}${ESC}0m`,
  gray: (s: string) => `${ESC}90m${s}${ESC}0m`,
  white: (s: string) => `${ESC}37m${s}${ESC}0m`,
  red: (s: string) => `${ESC}31m${s}${ESC}0m`,
  reverse: (s: string) => `${ESC}7m${s}${ESC}0m`,
} as const;

export const LOGO = [
  '  ___  _   _     __  __            ____          _      ',
  ' / _ \\| | | |   |  \\/  | ___   _  / ___|___   __| | ___ ',
  '| | | | |_| |   | |\\/| |/ _ \\ | | |   / _ \\ / _` |/ _ \\',
  '| |_| |  _  |   | |  | | (_) || | |__| (_) | (_| |  __/',
  ' \\___/|_| |_|   |_|  |_|\\___/ |_|  \\____\\___/ \\__,_|\\___|',
];

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
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function visibleLength(text: string): number {
  return Array.from(stripAnsi(text)).length;
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
  return `  ${left} ${pad(content, innerWidth)} ${right}`;
}

function wrapText(text: string, maxWidth: number): string[] {
  const points = Array.from(text);
  const lines: string[] = [];
  for (let i = 0; i < points.length; i += maxWidth) {
    lines.push(points.slice(i, i + maxWidth).join(''));
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

function actionHints(status: StatusInfo): string {
  const hints: string[] = ['Enter send', '↑↓ history', 'Esc cancel', 'Ctrl+C exit'];
  if (status.canRetry) {
    hints.splice(2, 0, 'Ctrl+R retry');
  }
  if (status.canRegenerate) {
    hints.splice(status.canRetry ? 3 : 2, 0, 'Ctrl+G regen');
  }
  return hints.join('  ·  ');
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
  },
): string {
  const lines: string[] = [];

  // Logo block
  for (const line of LOGO) {
    lines.push(center(fg.cyan(fg.bold(line)), width));
  }
  lines.push(center(fg.dim(`v${version}`), width));
  lines.push('');

  // Status card
  const cardInner = width > 10 ? width - 10 : 1;
  lines.push(`  ${fg.blue('┌' + '─'.repeat(cardInner + 2) + '┐')}`);
  lines.push(fg.blue(boxLine('│', fg.bold('  Status'), '│', cardInner)));
  lines.push(fg.blue(boxLine('│', '', '│', cardInner)));
  lines.push(fg.blue(boxLine('│', `  Model:      ${status.model}`, '│', cardInner)));
  lines.push(fg.blue(boxLine('│', `  Connection: ${connectionLabel(status.connection)}`, '│', cardInner)));
  lines.push(fg.blue(boxLine('│', `  Repository: ${fg.dim('none')}`, '│', cardInner)));
  lines.push(`  ${fg.blue('└' + '─'.repeat(cardInner + 2) + '┘')}`);
  lines.push('');

  // Transcript area
  lines.push(`  ${fg.gray('─ Transcript ' + '─'.repeat(Math.max(0, width - 16)))}`);
  lines.push('');
  const transcriptWidth = width - 6;
  if (messages.length === 0 && status.streamingText.length === 0 && status.error === null) {
    lines.push(center(fg.dim('No messages yet.'), width));
    lines.push('');
  } else {
    for (const message of messages) {
      const label = message.role === 'user' ? fg.cyan(fg.bold('You')) : fg.green(fg.bold('Assistant'));
      lines.push(`  ${label}`);
      for (const wrapped of wrapText(message.text, transcriptWidth)) {
        lines.push(`  ${wrapped}`);
      }
      lines.push('');
    }
    if (status.streamingText.length > 0) {
      lines.push(`  ${fg.green(fg.bold('Assistant'))} ${fg.dim('(streaming…)')}`);
      for (const wrapped of wrapText(status.streamingText, transcriptWidth)) {
        lines.push(`  ${wrapped}`);
      }
      lines.push('');
    }
    if (status.error !== null) {
      lines.push(`  ${fg.red(fg.bold('Error'))}`);
      for (const wrapped of wrapText(status.error, transcriptWidth)) {
        lines.push(`  ${fg.red(wrapped)}`);
      }
      lines.push('');
    }
  }
  lines.push('');

  // Composer
  lines.push(`  ${fg.gray('─ Composer ' + '─'.repeat(Math.max(0, width - 14)))}`);
  lines.push('');
  lines.push(renderComposerLine(composerInput, composerCursor, '❯'));
  lines.push('');

  // Footer — fill remaining lines
  while (lines.length < height - 2) {
    lines.push('');
  }

  lines.push(center(usageLabel(status.usage), width));
  lines.push(center(fg.dim(actionHints(status)), width));

  // Pad every line to full width so a redraw fully overwrites the prior frame
  // and no stale characters bleed through.
  return lines
    .slice(0, height)
    .map((line) => pad(line, width))
    .join('\r\n');
}

export interface TuiOptions {
  version: string;
  config?: ModelConfig;
}

const KEY = {
  enter: 0x0d,
  escape: 0x1b,
  backspace: 0x7f,
  delete: 0x08,
  ctrlC: 0x03,
  ctrlD: 0x04,
  ctrlG: 0x07,
  ctrlR: 0x12,
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
      default: return { type: 'unknown' };
    }
  }

  // Multi-byte Unicode character
  if (first >= 0x20 && first !== 0x7f) {
    return { type: 'char', value: str };
  }

  return { type: 'unknown' };
}

export async function launchTui(options: TuiOptions): Promise<void> {
  const { version } = options;
  const config = options.config ?? loadConfig();
  const provider: Provider = createProvider(config);
  const stdin = process.stdin;
  const stdout = process.stdout;
  const composer = new ComposerState();

  let connection: ConnectionState = 'idle';
  let streamingText = '';
  let errorMessage: string | null = null;
  let streaming = false;
  let abortController: AbortController | null = null;
  let lastErrorRecoverable = false;
  const usage: UsageInfo = { turns: 0, promptTokens: 0, completionTokens: 0 };

  function lastMessage(): TranscriptMessage | undefined {
    return composer.messages[composer.messages.length - 1];
  }

  function canRetry(): boolean {
    return !streaming && connection === 'error' && lastErrorRecoverable;
  }

  function canRegenerate(): boolean {
    return !streaming && lastMessage()?.role === 'assistant';
  }

  function buildStatus(): StatusInfo {
    return {
      model: redact(config),
      connection,
      streamingText,
      error: errorMessage,
      usage,
      canRetry: canRetry(),
      canRegenerate: canRegenerate(),
    };
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    const { columns, rows } = stdout;
    const screen = renderScreen(columns ?? 80, rows ?? 24, version, [], '', 0, buildStatus());
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
    const chatMessages: ChatMessage[] = composer.messages.map((m) => ({
      role: m.role,
      text: m.text,
    }));

    try {
      for await (const event of provider.stream(chatMessages, abortController.signal)) {
        if (!running) break;
        switch (event.type) {
          case 'delta':
            connection = 'streaming';
            streamingText += event.text;
            render();
            break;
          case 'done':
            connection = 'done';
            composer.messages.push({ role: 'assistant', text: streamingText });
            applyUsage(event.usage);
            usage.turns += 1;
            streamingText = '';
            render();
            break;
          case 'error':
            if (event.error === 'cancelled') {
              connection = 'done';
              streamingText = '';
              usage.turns += 1;
            } else {
              connection = 'error';
              errorMessage = event.error;
              lastErrorRecoverable = event.recoverable;
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
      render();
    }
  }

  function retry(): void {
    if (!canRetry()) return;
    void streamResponse();
  }

  function regenerate(): void {
    if (!canRegenerate()) return;
    // Remove the last assistant message, then re-stream the prior user turn.
    if (lastMessage()?.role === 'assistant') {
      composer.messages.pop();
    }
    void streamResponse();
  }

  function onKeypress(data: Buffer): void {
    const key = parseKey(data);
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
          void streamResponse();
        }
        break;
      }
      case 'retry':
        retry();
        return;
      case 'regenerate':
        regenerate();
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

  return new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!running) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
}
