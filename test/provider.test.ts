import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createProvider, type StreamEvent } from '../src/provider.js';

async function collect(
  gen: AsyncGenerator<StreamEvent, void, unknown>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe('TestProvider', () => {
  it('streams a deterministic sequence of deltas followed by done', async () => {
    const config = loadConfig({});
    const provider = createProvider(config);
    const events = await collect(provider.stream([{ role: 'user', text: 'Hello' }]));

    const deltas = events.filter((e) => e.type === 'delta');
    const done = events.filter((e) => e.type === 'done');

    expect(deltas.length).toBeGreaterThan(0);
    expect(done).toHaveLength(1);

    const text = deltas
      .map((e) => (e.type === 'delta' ? e.text : ''))
      .join('');
    expect(text).toContain('received your message');
  });

  it('yields an error for empty input', async () => {
    const config = loadConfig({});
    const provider = createProvider(config);
    const events = await collect(provider.stream([{ role: 'user', text: '   ' }]));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
  });

  it('supports cancellation via AbortSignal', async () => {
    const config = loadConfig({});
    const provider = createProvider(config);
    const controller = new AbortController();

    const gen = provider.stream([{ role: 'user', text: 'Hello' }], controller.signal);
    const first = await gen.next();
    expect(first.value?.type).toBe('delta');

    controller.abort();
    const rest = await collect(gen);
    const cancelled = rest.find(
      (e) => e.type === 'error' && e.error === 'cancelled',
    );
    expect(cancelled).toBeDefined();
  });

  it('exposes the configured model name', () => {
    const config = loadConfig({ OMC_MODEL: 'my-model' });
    const provider = createProvider(config);
    expect(provider.model).toBe('my-model');
  });
});

describe('UnconfiguredProvider', () => {
  it('yields a redacted configuration error', async () => {
    const config = loadConfig({ OMC_PROVIDER: 'openai' });
    const provider = createProvider(config);
    const events = await collect(provider.stream([{ role: 'user', text: 'Hello' }]));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type === 'error') {
      expect(events[0].error).toContain('Configuration invalid');
      expect(events[0].error).not.toContain('undefined');
    }
  });
});
