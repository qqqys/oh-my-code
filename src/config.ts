export type ProviderKind = 'test' | 'openai' | 'anthropic';

export interface ModelConfig {
  provider: ProviderKind;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

const KNOWN_KEYS: ReadonlyArray<{ env: string; provider: ProviderKind }> = [
  { env: 'OPENAI_API_KEY', provider: 'openai' },
  { env: 'ANTHROPIC_API_KEY', provider: 'anthropic' },
  { env: 'OMC_API_KEY', provider: 'openai' },
];

function detectProvider(env: NodeJS.ProcessEnv): ProviderKind {
  const explicit = env['OMC_PROVIDER'];
  if (explicit === 'test' || explicit === 'openai' || explicit === 'anthropic') {
    return explicit;
  }
  for (const { env: name, provider } of KNOWN_KEYS) {
    if (env[name]) return provider;
  }
  return 'test';
}

function detectApiKey(env: NodeJS.ProcessEnv): string | undefined {
  for (const { env: name } of KNOWN_KEYS) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const provider = detectProvider(env);
  const model = env['OMC_MODEL'] ?? defaultModel(provider);
  const apiKey = detectApiKey(env);
  const baseUrl = env['OMC_BASE_URL'];

  const config: ModelConfig = { provider, model };
  if (apiKey !== undefined) config.apiKey = apiKey;
  if (baseUrl !== undefined) config.baseUrl = baseUrl;
  return config;
}

function defaultModel(provider: ProviderKind): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o';
    case 'anthropic':
      return 'claude-sonnet-4-20250514';
    case 'test':
      return 'test-model';
  }
}

export function redact(config: ModelConfig): string {
  const hasKey = config.apiKey !== undefined && config.apiKey.length > 0;
  return `${config.provider}:${config.model}${hasKey ? ' (key set)' : ' (no key)'}`;
}

export function isConfigured(config: ModelConfig): boolean {
  if (config.provider === 'test') return true;
  return config.apiKey !== undefined && config.apiKey.length > 0;
}
