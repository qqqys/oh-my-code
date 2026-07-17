import { describe, expect, it } from 'vitest';

import {
  detectColorCapability,
  fullTheme,
  monoTheme,
  resolveTheme,
  themeFor,
} from '../src/theme.js';

describe('color-capability detection', () => {
  it('forces full color when FORCE_COLOR is set', () => {
    expect(detectColorCapability({ FORCE_COLOR: '1', NO_COLOR: '1', TERM: 'dumb' })).toBe('full');
  });

  it('treats FORCE_COLOR=0 as not forcing', () => {
    expect(detectColorCapability({ FORCE_COLOR: '0', TERM: 'dumb' })).toBe('none');
  });

  it('honors NO_COLOR', () => {
    expect(detectColorCapability({ NO_COLOR: '1', TERM: 'xterm-256color' })).toBe('none');
  });

  it('treats a missing or dumb TERM as no color', () => {
    expect(detectColorCapability({})).toBe('none');
    expect(detectColorCapability({ TERM: 'dumb' })).toBe('none');
    expect(detectColorCapability({ TERM: '' })).toBe('none');
  });

  it('reports full color for a capable terminal', () => {
    expect(detectColorCapability({ TERM: 'xterm-256color' })).toBe('full');
  });
});

describe('theme selection', () => {
  it('maps the capability to the matching theme', () => {
    expect(themeFor('full')).toBe(fullTheme);
    expect(themeFor('none')).toBe(monoTheme);
  });

  it('lets an explicit OMC_THEME override win', () => {
    expect(resolveTheme({ OMC_THEME: 'full', NO_COLOR: '1' })).toBe(fullTheme);
    expect(resolveTheme({ OMC_THEME: 'mono', TERM: 'xterm-256color' })).toBe(monoTheme);
  });

  it('falls back to detection on an unknown override', () => {
    expect(resolveTheme({ OMC_THEME: 'rainbow', TERM: 'xterm' })).toBe(fullTheme);
    expect(resolveTheme({ OMC_THEME: 'rainbow', TERM: 'dumb' })).toBe(monoTheme);
  });

  it('auto-detects when no override is present', () => {
    expect(resolveTheme({ NO_COLOR: '1' })).toBe(monoTheme);
    expect(resolveTheme({ TERM: 'xterm' })).toBe(fullTheme);
  });
});

describe('theme tokens', () => {
  it('full theme carries hue codes for the dark blue-purple identity', () => {
    expect(fullTheme.green('x')).toContain('\x1b[32m');
    expect(fullTheme.red('x')).toContain('\x1b[31m');
    expect(fullTheme.cyan('x')).toContain('\x1b[36m');
  });

  it('mono theme drops all hue but keeps intensity and structure', () => {
    // No hue: meaning is carried by glyphs and labels, never color alone.
    for (const token of ['green', 'red', 'cyan', 'blue', 'yellow', 'magenta', 'gray', 'white'] as const) {
      expect(monoTheme[token]('x')).toBe('x');
    }
    // Intensity/structure survive so emphasis and selection stay visible.
    expect(monoTheme.bold('x')).toContain('\x1b[1m');
    expect(monoTheme.dim('x')).toContain('\x1b[2m');
    expect(monoTheme.reverse('x')).toContain('\x1b[7m');
  });
});
