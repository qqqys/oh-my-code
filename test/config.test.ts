import { describe, expect, it } from 'vitest';

import { isConfigured, loadConfig, redact } from '../src/config.js';

describe('loadConfig', () => {
  it('defaults to the test provider when no keys are present', () => {
    const config = loadConfig({});
    expect(config.provider).toBe('test');
    expect(config.model).toBe('test-model');
  });

  it('detects OpenAI from OPENAI_API_KEY', () => {
    const config = loadConfig({ OPENAI_API_KEY: 'sk-test' });
    expect(config.provider).toBe('openai');
    expect(config.model).toBe('gpt-4o');
    expect(config.apiKey).toBe('sk-test');
  });

  it('detects Anthropic from ANTHROPIC_API_KEY', () => {
    const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe('claude-sonnet-4-20250514');
  });

  it('honors explicit OMC_PROVIDER', () => {
    const config = loadConfig({ OMC_PROVIDER: 'test' });
    expect(config.provider).toBe('test');
  });

  it('honors OMC_MODEL override', () => {
    const config = loadConfig({ OMC_MODEL: 'custom-model' });
    expect(config.model).toBe('custom-model');
  });

  it('reads OMC_API_KEY as a fallback key', () => {
    const config = loadConfig({ OMC_API_KEY: 'omc-key' });
    expect(config.apiKey).toBe('omc-key');
  });

  it('reads OMC_BASE_URL', () => {
    const config = loadConfig({ OMC_BASE_URL: 'https://api.example.com' });
    expect(config.baseUrl).toBe('https://api.example.com');
  });
});

describe('redact', () => {
  it('never includes the API key in the output', () => {
    const config = loadConfig({ OPENAI_API_KEY: 'sk-secret-key-12345' });
    const output = redact(config);
    expect(output).not.toContain('sk-secret-key-12345');
    expect(output).toContain('key set');
  });

  it('shows no key when unset', () => {
    const config = loadConfig({});
    const output = redact(config);
    expect(output).toContain('no key');
  });
});

describe('isConfigured', () => {
  it('returns true for the test provider', () => {
    const config = loadConfig({});
    expect(isConfigured(config)).toBe(true);
  });

  it('returns true when a key is present', () => {
    const config = loadConfig({ OPENAI_API_KEY: 'sk-test' });
    expect(isConfigured(config)).toBe(true);
  });

  it('returns false for a real provider without a key', () => {
    const config = loadConfig({ OMC_PROVIDER: 'openai' });
    expect(isConfigured(config)).toBe(false);
  });
});
