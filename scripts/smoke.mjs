import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['dist/cli.js', '--version'], {
  encoding: 'utf8',
});

if (result.status !== 0 || result.stdout.trim() !== '0.0.0') {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(1);
}

process.stdout.write('smoke: ok\n');
