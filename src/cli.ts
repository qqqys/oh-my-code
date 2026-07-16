#!/usr/bin/env node

const major = Number(process.versions.node.split('.')[0] ?? 0);
if (major < 22) {
  process.stderr.write(
    `oh-my-code requires Node.js 22 or later. Current: ${process.versions.node}\n`,
  );
  process.exit(1);
}

import { run, VERSION } from './app.js';
import { launchTui } from './tui.js';

const args = process.argv.slice(2);

if (args.length === 0 && process.stdout.isTTY) {
  await launchTui({ version: VERSION });
} else {
  const result = run(args);
  const stream = result.code === 0 ? process.stdout : process.stderr;
  stream.write(`${result.output}\n`);
  process.exitCode = result.code;
}
