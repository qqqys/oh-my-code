import { describe, expect, it } from 'vitest';

import { helpText, run, VERSION } from '../src/app.js';

describe('foundation CLI', () => {
  it('prints help when no arguments are provided', () => {
    expect(run([])).toEqual({ code: 0, output: helpText() });
  });

  it('prints the current version', () => {
    expect(run(['--version'])).toEqual({ code: 0, output: VERSION });
  });

  it('rejects unknown options', () => {
    const result = run(['--unknown']);

    expect(result.code).toBe(2);
    expect(result.output).toContain('Unknown option: --unknown');
  });
});
