export const VERSION = '0.0.0';

export function helpText(): string {
  return [
    'Oh My Code',
    '',
    'Usage:',
    '  oh-my-code [options]',
    '',
    'Options:',
    '  -h, --help     Show help',
    '  -v, --version  Show version',
    '',
    'The interactive TUI is being delivered in issue #10.',
  ].join('\n');
}

export function run(args: readonly string[]): { code: number; output: string } {
  if (args.includes('--version') || args.includes('-v')) {
    return { code: 0, output: VERSION };
  }

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    return { code: 0, output: helpText() };
  }

  return {
    code: 2,
    output: `Unknown option: ${args[0]}\n\n${helpText()}`,
  };
}
