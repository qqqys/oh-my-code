import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { createProvider, type StreamEvent } from '../src/provider.js';
import type { ToolCall, ToolResult } from '../src/tools.js';

async function collect(
  gen: AsyncGenerator<StreamEvent, void, ToolResult | undefined>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

async function drive(
  gen: AsyncGenerator<StreamEvent, void, ToolResult | undefined>,
  onTool: (call: ToolCall) => ToolResult,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  let input: ToolResult | undefined;
  while (true) {
    const step = await gen.next(input);
    if (step.done) break;
    input = undefined;
    const value = step.value;
    events.push(value);
    if (value.type === 'tool_call') {
      input = onTool(value.call);
    }
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

  it('reports usage on completion', async () => {
    const config = loadConfig({});
    const provider = createProvider(config);
    const events = await collect(provider.stream([{ role: 'user', text: 'Hello world' }]));

    const done = events.find((e) => e.type === 'done');
    expect(done?.type).toBe('done');
    if (done?.type === 'done') {
      expect(done.usage.promptTokens).toBeGreaterThan(0);
      expect(done.usage.completionTokens).toBeGreaterThan(0);
    }
  });

  it('yields a non-recoverable error for empty input', async () => {
    const config = loadConfig({});
    const provider = createProvider(config);
    const events = await collect(provider.stream([{ role: 'user', text: '   ' }]));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type === 'error') {
      expect(events[0].recoverable).toBe(false);
    }
  });

  it('fails once on a recover trigger then succeeds on retry', async () => {
    const config = loadConfig({});
    const provider = createProvider(config);

    // First attempt: recoverable failure
    const first = await collect(provider.stream([{ role: 'user', text: 'please recover now' }]));
    expect(first).toHaveLength(1);
    expect(first[0]?.type).toBe('error');
    if (first[0]?.type === 'error') {
      expect(first[0].recoverable).toBe(true);
    }

    // Retry: succeeds
    const second = await collect(provider.stream([{ role: 'user', text: 'please recover now' }]));
    const done = second.find((e) => e.type === 'done');
    expect(done?.type).toBe('done');
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

describe('TestProvider tool use', () => {
  it('yields a list_files tool call for a list request', async () => {
    const config = loadConfig({});
    const provider = createProvider(config);
    const gen = provider.stream([{ role: 'user', text: 'list files in src' }]);
    const first = await gen.next();
    expect(first.value?.type).toBe('tool_call');
    if (first.value?.type === 'tool_call') {
      expect(first.value.call.name).toBe('list_files');
      expect(first.value.call.args.path).toBe('src');
    }
  });

  it('yields a read_file tool call for a read request', async () => {
    const config = loadConfig({});
    const provider = createProvider(config);
    const gen = provider.stream([{ role: 'user', text: 'read src/app.ts' }]);
    const first = await gen.next();
    expect(first.value?.type).toBe('tool_call');
    if (first.value?.type === 'tool_call') {
      expect(first.value.call.name).toBe('read_file');
      expect(first.value.call.args.path).toBe('src/app.ts');
    }
  });

  it('yields a search_content tool call for a search request', async () => {
    const config = loadConfig({});
    const provider = createProvider(config);
    const gen = provider.stream([{ role: 'user', text: 'search for VERSION' }]);
    const first = await gen.next();
    expect(first.value?.type).toBe('tool_call');
    if (first.value?.type === 'tool_call') {
      expect(first.value.call.name).toBe('search_content');
      expect(first.value.call.args.pattern).toBe('VERSION');
    }
  });

  it('streams a summary response after receiving a tool result', async () => {
    const config = loadConfig({});
    const provider = createProvider(config);
    const gen = provider.stream([{ role: 'user', text: 'list files in src' }]);
    const events = await drive(gen, (call) => ({
      name: call.name,
      output: 'app.ts\ncli.ts',
      truncated: false,
      error: null,
    }));

    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall?.type).toBe('tool_call');

    const text = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e.type === 'delta' ? e.text : ''))
      .join('');
    expect(text).toContain('list_files');

    const done = events.find((e) => e.type === 'done');
    expect(done?.type).toBe('done');
  });

  it('reports a tool error in the response', async () => {
    const config = loadConfig({});
    const provider = createProvider(config);
    const gen = provider.stream([{ role: 'user', text: 'read .env' }]);
    const events = await drive(gen, (call) => ({
      name: call.name,
      output: '',
      truncated: false,
      error: 'Path may contain secrets: .env',
    }));

    const text = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e.type === 'delta' ? e.text : ''))
      .join('');
    expect(text).toContain('could not complete');
  });
});

describe('UnconfiguredProvider', () => {
  it('yields a redacted non-recoverable configuration error', async () => {
    const config = loadConfig({ OMC_PROVIDER: 'openai' });
    const provider = createProvider(config);
    const events = await collect(provider.stream([{ role: 'user', text: 'Hello' }]));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    if (events[0]?.type === 'error') {
      expect(events[0].error).toContain('Configuration invalid');
      expect(events[0].error).not.toContain('undefined');
      expect(events[0].recoverable).toBe(false);
    }
  });
});
