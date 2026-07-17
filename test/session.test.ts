import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { TranscriptMessage } from '../src/composer.js';
import {
  createSession,
  deleteSession,
  isValidSessionId,
  listSessions,
  loadSession,
  saveSession,
  SESSION_VERSION,
  sessionsDir,
  SessionError,
  shouldResumeStreaming,
} from '../src/session.js';

const created: string[] = [];

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'omc-session-'));
  created.push(dir);
  return dir;
}

function writeRaw(workspace: string, id: string, contents: string): void {
  const dir = sessionsDir(workspace);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), contents, 'utf8');
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('isValidSessionId', () => {
  it('accepts safe ids and rejects traversal and empties', () => {
    expect(isValidSessionId('abc-123')).toBe(true);
    expect(isValidSessionId('a.b_c-d')).toBe(true);
    expect(isValidSessionId('')).toBe(false);
    expect(isValidSessionId('../evil')).toBe(false);
    expect(isValidSessionId('a/b')).toBe(false);
    expect(isValidSessionId('has space')).toBe(false);
  });
});

describe('saveSession / loadSession', () => {
  it('round-trips the transcript and usage', () => {
    const workspace = makeWorkspace();
    const session = createSession('round-trip');
    const messages: TranscriptMessage[] = [
      { role: 'user', text: 'list files in src' },
      { role: 'tool', text: 'app.ts', toolName: 'list_files', toolArgs: 'path: src', truncated: false },
      { role: 'assistant', text: 'Here is the listing.' },
    ];
    session.messages = messages;
    session.usage = { turns: 1, promptTokens: 10, completionTokens: 5 };
    saveSession(workspace, session);

    const loaded = loadSession(workspace, 'round-trip');
    expect(loaded.id).toBe('round-trip');
    expect(loaded.version).toBe(SESSION_VERSION);
    expect(loaded.messages).toEqual(messages);
    expect(loaded.usage).toEqual({ turns: 1, promptTokens: 10, completionTokens: 5 });
  });

  it('salvages a message with extra or partial fields', () => {
    const workspace = makeWorkspace();
    writeRaw(
      workspace,
      'partial',
      JSON.stringify({
        version: SESSION_VERSION,
        id: 'partial',
        messages: [
          { role: 'user', text: 'hi' },
          { role: 'tool', text: 'out', toolName: 'read_file', outcome: 'ok', junk: 42 },
          { role: 'banana', text: 'dropped' },
          { role: 'assistant' },
        ],
        usage: { turns: 2 },
      }),
    );
    const loaded = loadSession(workspace, 'partial');
    // The bad-role message and the text-less message are dropped; the rest survive.
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[1]?.toolName).toBe('read_file');
    expect(loaded.messages[1]?.outcome).toBe('ok');
    expect(loaded.usage).toEqual({ turns: 2, promptTokens: 0, completionTokens: 0 });
  });
});

describe('loadSession failure modes', () => {
  it('fails safely when the session is missing', () => {
    const workspace = makeWorkspace();
    expect(() => loadSession(workspace, 'ghost')).toThrowError(/was not found/);
  });

  it('fails safely on corrupt JSON with recovery guidance', () => {
    const workspace = makeWorkspace();
    writeRaw(workspace, 'broken', '{ not valid json');
    try {
      loadSession(workspace, 'broken');
      throw new Error('expected SessionError');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).message).toContain('corrupt');
      expect((error as SessionError).message).toContain('sessions delete broken');
    }
  });

  it('fails safely on an incompatible version', () => {
    const workspace = makeWorkspace();
    writeRaw(workspace, 'future', JSON.stringify({ version: 999, id: 'future', messages: [] }));
    try {
      loadSession(workspace, 'future');
      throw new Error('expected SessionError');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).message).toContain('incompatible');
      expect((error as SessionError).message).toContain('sessions delete future');
    }
  });

  it('fails safely on a non-object document', () => {
    const workspace = makeWorkspace();
    writeRaw(workspace, 'arrayish', '[]');
    expect(() => loadSession(workspace, 'arrayish')).toThrowError(/corrupt/);
  });
});

describe('listSessions', () => {
  it('returns an empty list when there are no sessions', () => {
    expect(listSessions(makeWorkspace())).toEqual([]);
  });

  it('lists saved sessions and flags unreadable ones', () => {
    const workspace = makeWorkspace();
    const a = createSession('alpha');
    a.usage.turns = 3;
    a.messages = [{ role: 'user', text: 'hi' }];
    saveSession(workspace, a);
    writeRaw(workspace, 'broken', '{ not json');

    const summaries = listSessions(workspace);
    const byId = new Map(summaries.map((s) => [s.id, s]));
    expect(byId.get('alpha')?.readable).toBe(true);
    expect(byId.get('alpha')?.turns).toBe(3);
    expect(byId.get('broken')?.readable).toBe(false);
  });
});

describe('deleteSession', () => {
  it('removes a saved session and reports absence', () => {
    const workspace = makeWorkspace();
    saveSession(workspace, createSession('to-delete'));
    expect(deleteSession(workspace, 'to-delete')).toBe(true);
    expect(deleteSession(workspace, 'to-delete')).toBe(false);
  });

  it('rejects an invalid id', () => {
    const workspace = makeWorkspace();
    expect(() => deleteSession(workspace, '../evil')).toThrowError(SessionError);
  });
});

describe('shouldResumeStreaming', () => {
  it('continues only an unanswered user message', () => {
    expect(shouldResumeStreaming([{ role: 'user', text: 'hi' }])).toBe(true);
    expect(
      shouldResumeStreaming([
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'done' },
      ]),
    ).toBe(false);
    expect(
      shouldResumeStreaming([
        { role: 'user', text: 'hi' },
        { role: 'tool', text: 'out', toolName: 'list_files' },
      ]),
    ).toBe(false);
    expect(shouldResumeStreaming([])).toBe(false);
  });
});
