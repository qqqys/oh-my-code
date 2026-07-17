import { describe, expect, it } from 'vitest';

import type { ModelConfig } from '../src/config.js';
import {
  activeProfileForConfig,
  catalogProfiles,
  describeProfile,
  effectiveConfigText,
  findProfile,
  profileToConfig,
  profilesListing,
  resolveSwitch,
  validateProfile,
  type ModelProfile,
} from '../src/profiles.js';

const full: ModelProfile = {
  name: 'openai-gpt4o',
  provider: 'openai',
  model: 'gpt-4o',
  capabilities: { streaming: true, tools: true },
};

describe('validateProfile', () => {
  it('accepts a well-formed profile', () => {
    expect(validateProfile(full).valid).toBe(true);
  });

  it('rejects a missing or malformed name', () => {
    expect(validateProfile({ ...full, name: '' }).valid).toBe(false);
    expect(validateProfile({ ...full, name: 'has space' }).valid).toBe(false);
    expect(validateProfile({ ...full, name: '-leading-dash' }).valid).toBe(false);
  });

  it('rejects an unknown provider', () => {
    expect(validateProfile({ ...full, provider: 'gemini' as never }).valid).toBe(false);
  });

  it('rejects a missing or whitespace model', () => {
    expect(validateProfile({ ...full, model: '' }).valid).toBe(false);
    expect(validateProfile({ ...full, model: 'gpt 4o' }).valid).toBe(false);
  });

  it('rejects a non-http baseUrl', () => {
    expect(validateProfile({ ...full, baseUrl: 'ftp://example.com' }).valid).toBe(false);
    expect(validateProfile({ ...full, baseUrl: 'https://api.example.com' }).valid).toBe(true);
  });

  it('rejects non-boolean capabilities', () => {
    expect(validateProfile({ ...full, capabilities: { streaming: 'yes' as never, tools: true } }).valid).toBe(
      false,
    );
  });
});

describe('catalog and lookup', () => {
  it('returns only validated built-in profiles', () => {
    const catalog = catalogProfiles();
    expect(catalog.length).toBeGreaterThan(0);
    for (const profile of catalog) {
      expect(validateProfile(profile).valid).toBe(true);
    }
    expect(catalog.map((p) => p.name)).toContain('test');
    expect(catalog.map((p) => p.name)).toContain('test-mini');
  });

  it('finds profiles case-insensitively', () => {
    const catalog = catalogProfiles();
    expect(findProfile(catalog, 'TEST-MINI')?.name).toBe('test-mini');
    expect(findProfile(catalog, 'nope')).toBeUndefined();
  });

  it('represents the active config, synthesizing when not in the catalog', () => {
    const catalog = catalogProfiles();
    expect(activeProfileForConfig({ provider: 'test', model: 'test-model' }, catalog).name).toBe('test');
    const synthesized = activeProfileForConfig({ provider: 'openai', model: 'custom-model' }, catalog);
    expect(synthesized.name).toBe('active');
    expect(synthesized.model).toBe('custom-model');
  });
});

describe('credential safety', () => {
  const withKey: ModelConfig = {
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'sk-super-secret-value',
    baseUrl: 'https://api.example.com',
  };

  it('carries the key into the activated config but never into the profile', () => {
    const config = profileToConfig(full, withKey);
    expect(config.apiKey).toBe('sk-super-secret-value');
    // A profile has no apiKey field at all.
    expect((full as unknown as Record<string, unknown>)['apiKey']).toBeUndefined();
  });

  it('prefers the profile endpoint over the current one', () => {
    const profile: ModelProfile = { ...full, baseUrl: 'https://profile.example.com' };
    expect(profileToConfig(profile, withKey).baseUrl).toBe('https://profile.example.com');
  });

  it('never prints the key value in the effective-config view', () => {
    const text = effectiveConfigText(full, withKey);
    expect(text).toContain('API key:      set');
    expect(text).not.toContain('sk-super-secret-value');
  });

  it('never prints the key in a profile description', () => {
    expect(describeProfile(full)).not.toContain('sk-');
  });
});

describe('listing and switching', () => {
  const catalog = catalogProfiles();
  const active = findProfile(catalog, 'test')!;

  it('lists every profile and marks the active one', () => {
    const listing = profilesListing(catalog, active);
    expect(listing).toContain('Active profile: test');
    expect(listing).toContain('openai-gpt4o');
    expect(listing).toContain('- test (test:test-model) [streaming, tools]  (active)');
  });

  it('reports usage when no name is given', () => {
    const result = resolveSwitch(catalog, '', { provider: 'test', model: 'test-model' });
    expect(result.kind).toBe('usage');
  });

  it('rejects an unknown profile with an actionable list', () => {
    const result = resolveSwitch(catalog, 'nope', { provider: 'test', model: 'test-model' });
    expect(result.kind).toBe('not-found');
    expect(result.text).toContain('No profile named "nope"');
    expect(result.text).toContain('test-mini');
  });

  it('switches to a full-capability profile and applies to subsequent turns', () => {
    const result = resolveSwitch(catalog, 'test', { provider: 'test', model: 'test-model' });
    expect(result.kind).toBe('switched');
    if (result.kind !== 'switched') throw new Error('expected switched');
    expect(result.text).toContain('Switched to');
    expect(result.text).toContain('Applies to subsequent turns.');
    expect(result.config.model).toBe('test-model');
  });

  it('adds a capability fallback note for a no-tools profile', () => {
    const result = resolveSwitch(catalog, 'test-mini', { provider: 'test', model: 'test-model' });
    if (result.kind !== 'switched') throw new Error('expected switched');
    expect(result.text).toContain('does not support coding tools');
    expect(result.profile.capabilities.tools).toBe(false);
  });
});
