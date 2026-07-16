#!/usr/bin/env node

import { run } from './app.js';

const result = run(process.argv.slice(2));
const stream = result.code === 0 ? process.stdout : process.stderr;

stream.write(`${result.output}\n`);
process.exitCode = result.code;
