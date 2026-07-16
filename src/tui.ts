import process from 'node:process';

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
} as const;

export const LOGO = [
  '  ___  _   _     __  __            ____          _      ',
  ' / _ \\| | | |   |  \\/  | ___   _  / ___|___   __| | ___ ',
  '| | | | |_| |   | |\\/| |/ _ \\ | | |   / _ \\ / _` |/ _ \\',
  '| |_| |  _  |   | |  | | (_) || | |__| (_) | (_| |  __/',
  ' \\___/|_| |_|   |_|  |_|\\___/ |_|  \\____\\___/ \\__,_|\\___|',
];

function pad(text: string, width: number): string {
  const visible = stripAnsi(text);
  if (visible.length >= width) return text;
  return text + ' '.repeat(width - visible.length);
}

function center(text: string, width: number): string {
  const visible = stripAnsi(text);
  if (visible.length >= width) return text;
  const left = Math.floor((width - visible.length) / 2);
  return ' '.repeat(left) + text;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function boxLine(left: string, content: string, right: string, innerWidth: number): string {
  return `  ${left} ${pad(content, innerWidth)} ${right}`;
}

export function renderScreen(width: number, height: number, version: string): string {
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
  lines.push(fg.blue(boxLine('│', `  Model:      ${fg.yellow('not connected')}`, '│', cardInner)));
  lines.push(fg.blue(boxLine('│', `  Repository: ${fg.dim('none')}`, '│', cardInner)));
  lines.push(fg.blue(boxLine('│', `  Session:    ${fg.dim('none')}`, '│', cardInner)));
  lines.push(`  ${fg.blue('└' + '─'.repeat(cardInner + 2) + '┘')}`);
  lines.push('');

  // Transcript area
  lines.push(`  ${fg.gray('─ Transcript ' + '─'.repeat(Math.max(0, width - 16)))}`);
  lines.push('');
  lines.push(center(fg.dim('No messages yet.'), width));
  lines.push('');

  // Composer
  lines.push(`  ${fg.gray('─ Composer ' + '─'.repeat(Math.max(0, width - 14)))}`);
  lines.push('');
  lines.push(`  ${fg.green('❯')} ${fg.dim('Type a message or command…')}`);
  lines.push('');

  // Footer — fill remaining lines
  while (lines.length < height - 1) {
    lines.push('');
  }

  const footer = center(
    fg.dim('Ctrl+C exit  ·  '),
    width,
  );
  lines.push(footer);

  return lines.slice(0, height).join('\r\n');
}

export interface TuiOptions {
  version: string;
}

export async function launchTui(options: TuiOptions): Promise<void> {
  const { version } = options;
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY || !stdout.isTTY) {
    const { columns, rows } = stdout;
    const screen = renderScreen(columns ?? 80, rows ?? 24, version);
    stdout.write(screen + '\n');
    return;
  }

  let running = true;
  let inputBuffer = '';

  function getSize(): { width: number; height: number } {
    return {
      width: stdout.columns ?? 80,
      height: stdout.rows ?? 24,
    };
  }

  function render(): void {
    const { width, height } = getSize();
    const screen = renderScreen(width, height, version);
    stdout.write(seq.home + screen);
  }

  function exit(): void {
    if (!running) return;
    running = false;
    cleanup();
    stdout.write(seq.cursorShow + seq.altOff);
    process.exit(0);
  }

  function onKeypress(data: Buffer): void {
    for (const byte of data) {
      if (byte === 0x03 || byte === 0x04) {
        exit();
        return;
      }
      if (byte === 0x1b) continue;
      if (byte === 0x7f || byte === 0x08) {
        inputBuffer = inputBuffer.slice(0, -1);
        render();
        continue;
      }
      if (byte === 0x0d) {
        inputBuffer = '';
        render();
        continue;
      }
      if (byte >= 0x20 && byte < 0x7f) {
        inputBuffer += String.fromCharCode(byte);
        render();
      }
    }
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
  stdin.setEncoding('utf8');

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
