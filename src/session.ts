import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TranscriptMessage } from './composer.js';

// Bump when the on-disk session shape changes in a way an older build cannot
// safely read. A mismatch fails closed with recovery guidance rather than
// guessing at an unknown layout.
export const SESSION_VERSION = 1;

export interface SessionUsage {
  turns: number;
  promptTokens: number;
  completionTokens: number;
}

export interface Session {
  version: number;
  id: string;
  createdAt: string;
  updatedAt: string;
  messages: TranscriptMessage[];
  usage: SessionUsage;
}

export interface SessionSummary {
  id: string;
  updatedAt: string;
  turns: number;
  messages: number;
  readable: boolean;
}

// Raised for any session that cannot be loaded so callers can show recovery
// guidance instead of crashing on partial or incompatible data.
export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

// Session ids become file names, so they are restricted to a safe character
// set to prevent traversal and surprising paths.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function isValidSessionId(id: string): boolean {
  return id.length > 0 && id.length <= 128 && SAFE_ID.test(id);
}

export function sessionsDir(workspace: string): string {
  return join(workspace, '.omc', 'sessions');
}

function sessionPath(workspace: string, id: string): string {
  return join(sessionsDir(workspace), `${id}.json`);
}

export function newSessionId(now: number = Date.now()): string {
  const stamp = now.toString(36);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

export function createSession(id: string): Session {
  const timestamp = new Date().toISOString();
  return {
    version: SESSION_VERSION,
    id,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
    usage: { turns: 0, promptTokens: 0, completionTokens: 0 },
  };
}

export function saveSession(workspace: string, session: Session): void {
  const dir = sessionsDir(workspace);
  mkdirSync(dir, { recursive: true });
  session.updatedAt = new Date().toISOString();
  writeFileSync(sessionPath(workspace, session.id), JSON.stringify(session, null, 2) + '\n', 'utf8');
}

// The optional TranscriptMessage fields are validated individually so a partial
// or hand-edited record is salvaged field by field instead of being rejected
// wholesale. Mirrors the literal unions in composer.ts.
function parseMessage(value: unknown): TranscriptMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const role = v.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return null;
  if (typeof v.text !== 'string') return null;
  const message: TranscriptMessage = { role, text: v.text };
  if (typeof v.toolName === 'string') message.toolName = v.toolName;
  if (typeof v.toolArgs === 'string') message.toolArgs = v.toolArgs;
  if (typeof v.truncated === 'boolean') message.truncated = v.truncated;
  if (
    v.outcome === 'ok'
    || v.outcome === 'non-zero'
    || v.outcome === 'timeout'
    || v.outcome === 'cancelled'
    || v.outcome === 'denied'
  ) {
    message.outcome = v.outcome;
  }
  if (
    v.editOutcome === 'applied'
    || v.editOutcome === 'rejected'
    || v.editOutcome === 'reverted'
    || v.editOutcome === 'conflict'
  ) {
    message.editOutcome = v.editOutcome;
  }
  return message;
}

function parseUsage(value: unknown): SessionUsage {
  if (typeof value !== 'object' || value === null) {
    return { turns: 0, promptTokens: 0, completionTokens: 0 };
  }
  const v = value as Record<string, unknown>;
  return {
    turns: typeof v.turns === 'number' ? v.turns : 0,
    promptTokens: typeof v.promptTokens === 'number' ? v.promptTokens : 0,
    completionTokens: typeof v.completionTokens === 'number' ? v.completionTokens : 0,
  };
}

export function loadSession(workspace: string, id: string): Session {
  if (!isValidSessionId(id)) {
    throw new SessionError(`Invalid session id "${id}".`);
  }
  let raw: string;
  try {
    raw = readFileSync(sessionPath(workspace, id), 'utf8');
  } catch {
    throw new SessionError(`Session "${id}" was not found. List sessions with: oh-my-code sessions list`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionError(
      `Session "${id}" is corrupt and cannot be read. Remove it with: oh-my-code sessions delete ${id}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SessionError(
      `Session "${id}" is corrupt and cannot be read. Remove it with: oh-my-code sessions delete ${id}`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== SESSION_VERSION) {
    throw new SessionError(
      `Session "${id}" uses an incompatible format (version ${String(obj.version)}). Remove it with: oh-my-code sessions delete ${id}`,
    );
  }
  if (!Array.isArray(obj.messages)) {
    throw new SessionError(
      `Session "${id}" is corrupt and cannot be read. Remove it with: oh-my-code sessions delete ${id}`,
    );
  }
  const messages: TranscriptMessage[] = [];
  for (const item of obj.messages) {
    const message = parseMessage(item);
    if (message !== null) messages.push(message);
  }
  return {
    version: SESSION_VERSION,
    id,
    createdAt: typeof obj.createdAt === 'string' ? obj.createdAt : new Date().toISOString(),
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
    messages,
    usage: parseUsage(obj.usage),
  };
}

export function listSessions(workspace: string): SessionSummary[] {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir(workspace));
  } catch {
    return [];
  }
  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -'.json'.length);
    if (!isValidSessionId(id)) continue;
    try {
      const session = loadSession(workspace, id);
      summaries.push({
        id,
        updatedAt: session.updatedAt,
        turns: session.usage.turns,
        messages: session.messages.length,
        readable: true,
      });
    } catch {
      // Unreadable sessions still appear so the user can see and delete them.
      summaries.push({ id, updatedAt: '', turns: 0, messages: 0, readable: false });
    }
  }
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return summaries;
}

export function deleteSession(workspace: string, id: string): boolean {
  if (!isValidSessionId(id)) {
    throw new SessionError(`Invalid session id "${id}".`);
  }
  try {
    rmSync(sessionPath(workspace, id));
    return true;
  } catch {
    return false;
  }
}

export function formatSession(session: Session): string {
  const lines: string[] = [
    `Session ${session.id}`,
    `Created: ${session.createdAt}`,
    `Updated: ${session.updatedAt}`,
    `Turns: ${session.usage.turns}  Messages: ${session.messages.length}`,
    '',
  ];
  for (const message of session.messages) {
    if (message.role === 'tool') {
      const name = message.toolName ?? 'tool';
      lines.push(`[tool ${name}] ${message.text}`);
    } else {
      lines.push(`${message.role}: ${message.text}`);
    }
  }
  return lines.join('\n') + '\n';
}

// A session is safe to continue automatically only when its last event is an
// unanswered user message. Completed turns (ending in an assistant or tool
// message) are restored as-is so finished mutations are never replayed.
export function shouldResumeStreaming(messages: readonly TranscriptMessage[]): boolean {
  const last = messages[messages.length - 1];
  return last !== undefined && last.role === 'user';
}
