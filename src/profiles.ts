// Model profiles: validated, credential-free descriptions of a model the user
// can switch between during a session. A profile never holds an API key — the
// key always comes from the environment when a profile is activated — so
// listing, validating, and describing profiles can never expose a secret.
//
// This is self-contained today and forward-compatible with a future layered
// settings layer (#53): that layer can supply additional profiles without
// changing the validation or the rendering call sites.

import type { ModelConfig, ProviderKind } from './config.js';

export interface ModelCapabilities {
  streaming: boolean;
  tools: boolean;
}

export interface ModelProfile {
  name: string;
  provider: ProviderKind;
  model: string;
  baseUrl?: string;
  capabilities: ModelCapabilities;
}

export interface ProfileValidation {
  valid: boolean;
  problems: string[];
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const PROVIDERS: readonly ProviderKind[] = ['test', 'openai', 'anthropic'];

// Built-in, validated profiles. None carry credentials. `test-mini` declares no
// tool support so the capability-fallback path is exercisable end to end.
const BUILTIN_PROFILES: readonly ModelProfile[] = [
  {
    name: 'openai-gpt4o',
    provider: 'openai',
    model: 'gpt-4o',
    capabilities: { streaming: true, tools: true },
  },
  {
    name: 'anthropic-sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    capabilities: { streaming: true, tools: true },
  },
  {
    name: 'test',
    provider: 'test',
    model: 'test-model',
    capabilities: { streaming: true, tools: true },
  },
  {
    name: 'test-mini',
    provider: 'test',
    model: 'test-model-mini',
    capabilities: { streaming: true, tools: false },
  },
];

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Validate a profile's structural fields only. Credentials are never part of a
// profile, so validation neither requires nor reveals a key.
export function validateProfile(input: Partial<ModelProfile>): ProfileValidation {
  const problems: string[] = [];

  const name = input.name;
  if (name === undefined || name.trim().length === 0) {
    problems.push('name is required');
  } else if (!NAME_PATTERN.test(name)) {
    problems.push('name must start with a letter or number and use only letters, numbers, . _ -');
  }

  if (input.provider === undefined || !PROVIDERS.includes(input.provider)) {
    problems.push(`provider must be one of ${PROVIDERS.join(', ')}`);
  }

  const model = input.model;
  if (model === undefined || model.trim().length === 0) {
    problems.push('model is required');
  } else if (/\s/.test(model)) {
    problems.push('model must not contain whitespace');
  }

  if (input.baseUrl !== undefined && !isHttpUrl(input.baseUrl)) {
    problems.push('baseUrl must be a valid http(s) URL');
  }

  const caps = input.capabilities;
  if (caps === undefined || typeof caps.streaming !== 'boolean' || typeof caps.tools !== 'boolean') {
    problems.push('capabilities.streaming and capabilities.tools must be booleans');
  }

  return { valid: problems.length === 0, problems };
}

// The validated catalog the user can choose from. Invalid entries are dropped
// defensively so a malformed built-in can never reach the switch path.
export function catalogProfiles(): ModelProfile[] {
  return BUILTIN_PROFILES.filter((profile) => validateProfile(profile).valid);
}

export function findProfile(
  catalog: readonly ModelProfile[],
  name: string,
): ModelProfile | undefined {
  const wanted = name.trim().toLowerCase();
  return catalog.find((profile) => profile.name.toLowerCase() === wanted);
}

// The profile that represents the current effective config. Falls back to a
// synthesized profile when the active model is not in the built-in catalog so
// the current model is always represented.
export function activeProfileForConfig(
  config: ModelConfig,
  catalog: readonly ModelProfile[],
): ModelProfile {
  const match = catalog.find(
    (profile) => profile.provider === config.provider && profile.model === config.model,
  );
  if (match !== undefined) return match;

  const profile: ModelProfile = {
    name: 'active',
    provider: config.provider,
    model: config.model,
    capabilities: { streaming: true, tools: true },
  };
  if (config.baseUrl !== undefined) profile.baseUrl = config.baseUrl;
  return profile;
}

// Build the ModelConfig to activate a profile with. The API key is carried over
// from the current config (profiles never hold one), so switching never moves a
// credential through a profile.
export function profileToConfig(profile: ModelProfile, current: ModelConfig): ModelConfig {
  const config: ModelConfig = { provider: profile.provider, model: profile.model };
  const baseUrl = profile.baseUrl ?? current.baseUrl;
  if (baseUrl !== undefined) config.baseUrl = baseUrl;
  if (current.apiKey !== undefined) config.apiKey = current.apiKey;
  return config;
}

// A non-secret, single-line description for listings and switch confirmations.
export function describeProfile(profile: ModelProfile): string {
  const caps = [
    profile.capabilities.streaming ? 'streaming' : 'no-streaming',
    profile.capabilities.tools ? 'tools' : 'no-tools',
  ];
  const base = profile.baseUrl !== undefined ? ` @ ${profile.baseUrl}` : '';
  return `${profile.name} (${profile.provider}:${profile.model}${base}) [${caps.join(', ')}]`;
}

// The "/model list" output: every validated profile with the active one marked.
export function profilesListing(
  catalog: readonly ModelProfile[],
  active: ModelProfile,
): string {
  const lines = catalog.map((profile) => {
    const marker = profile.name === active.name ? '  (active)' : '';
    return `- ${describeProfile(profile)}${marker}`;
  });
  return `Active profile: ${active.name}\nAvailable profiles:\n${lines.join('\n')}`;
}

// The "/model show" output: the effective, non-secret configuration. Mirrors the
// status card's redaction — provider, model, endpoint, capabilities — never a key.
export function effectiveConfigText(profile: ModelProfile, config: ModelConfig): string {
  const caps = [
    profile.capabilities.streaming ? 'streaming' : 'no-streaming',
    profile.capabilities.tools ? 'tools' : 'no-tools',
  ];
  return [
    'Effective configuration (no secrets):',
    `  Profile:      ${profile.name}`,
    `  Provider:     ${config.provider}`,
    `  Model:        ${config.model}`,
    `  Endpoint:     ${config.baseUrl ?? '(default)'}`,
    `  API key:      ${config.apiKey !== undefined && config.apiKey.length > 0 ? 'set' : 'not set'}`,
    `  Capabilities: ${caps.join(', ')}`,
  ].join('\n');
}

export type SwitchResult =
  | { kind: 'usage'; text: string }
  | { kind: 'not-found'; text: string }
  | { kind: 'invalid'; text: string }
  | { kind: 'switched'; text: string; profile: ModelProfile; config: ModelConfig };

// Resolve a "/model use <name>" request into an actionable result. A successful
// switch carries the new config (key inherited from the current config, never
// from the profile) and notes any capability fallback the user should expect.
export function resolveSwitch(
  catalog: readonly ModelProfile[],
  name: string,
  current: ModelConfig,
): SwitchResult {
  if (name.trim().length === 0) {
    return { kind: 'usage', text: 'Usage: /model use <name>. Run /model list to see profiles.' };
  }
  const profile = findProfile(catalog, name);
  if (profile === undefined) {
    const names = catalog.map((p) => p.name).join(', ');
    return { kind: 'not-found', text: `No profile named "${name}". Available profiles: ${names}.` };
  }
  const validation = validateProfile(profile);
  if (!validation.valid) {
    return { kind: 'invalid', text: `Profile "${name}" is invalid: ${validation.problems.join('; ')}.` };
  }
  const config = profileToConfig(profile, current);
  const notes = [`Switched to ${describeProfile(profile)}.`, 'Applies to subsequent turns.'];
  if (!profile.capabilities.tools) {
    notes.push('Note: this profile does not support coding tools; tool calls will be skipped.');
  }
  if (!profile.capabilities.streaming) {
    notes.push('Note: this profile does not stream; responses will appear when complete.');
  }
  return { kind: 'switched', text: notes.join('\n'), profile, config };
}
