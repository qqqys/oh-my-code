export const VERSION = '0.0.0';

export function helpText(): string {
  return [
    'Oh My Code — repository-aware code agent CLI',
    '',
    'Usage:',
    '  oh-my-code [options]',
    '',
    'Options:',
    '  -h, --help     Show help',
    '  -v, --version  Show version',
    '',
    'Commands:',
    '  sessions list             List saved sessions',
    '  sessions show <id>        Show a saved session transcript',
    '  sessions resume <id>      Resume an interrupted session',
    '  sessions delete <id>      Delete a saved session',
    '',
    'Run without options to launch the interactive terminal.',
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
