import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'oh-my-code-integration-'));
const socket = join(temporaryDirectory, 'tmux.sock');
const session = `oh-my-code-${process.pid}`;
const cli = resolve('dist/cli.js');
const nodeBin = process.execPath;

// A throwaway file the edit turns act on. It lives in the workspace so the edit
// tool accepts it, and is removed in the finally block so the tree stays clean.
const fixturePath = resolve('omc-e2e-fixture.txt');
const fixtureOriginal = 'alpha\nbeta\ngamma\n';

// A multi-package repository the context turn inspects. It is its own Git repo
// (nested inside the workspace) so repository-context discovery can report
// uncommitted and untracked work without touching the outer repo. Removed in the
// finally block.
const repoFixturePath = resolve('omc-e2e-repo');

// A fixed session id so the live run can be terminated and then resumed by a
// fresh process. The stored transcript lives under the (git-ignored) .omc dir
// and is removed in the finally block.
const sessionId = 'omc-e2e-session';
const sessionFile = resolve('.omc', 'sessions', `${sessionId}.json`);

function buildRepoFixture() {
  rmSync(repoFixturePath, { recursive: true, force: true });
  mkdirSync(join(repoFixturePath, 'packages', 'api'), { recursive: true });
  mkdirSync(join(repoFixturePath, 'packages', 'web'), { recursive: true });
  writeFileSync(join(repoFixturePath, 'AGENTS.md'), '# Fixture repository guidance\n');
  writeFileSync(join(repoFixturePath, 'packages', 'api', 'AGENTS.md'), '# API package guidance\n');
  writeFileSync(
    join(repoFixturePath, 'package.json'),
    JSON.stringify({ name: 'fixture-root', scripts: { build: 'tsc', test: 'vitest run' } }) + '\n',
  );
  writeFileSync(
    join(repoFixturePath, 'packages', 'api', 'package.json'),
    JSON.stringify({ name: 'api', scripts: { test: 'vitest run' } }) + '\n',
  );
  writeFileSync(
    join(repoFixturePath, 'packages', 'web', 'package.json'),
    JSON.stringify({ name: 'web', scripts: { build: 'tsc', test: 'vitest run' } }) + '\n',
  );
  writeFileSync(
    join(repoFixturePath, 'Makefile'),
    'build:\n\ttsc\nunit:\n\tvitest run\nintegration:\n\tnode scripts/integration.mjs\n',
  );
  writeFileSync(join(repoFixturePath, 'tsconfig.json'), '{}\n');
  writeFileSync(join(repoFixturePath, 'packages', 'api', 'tracked.txt'), 'original\n');

  function git(...args) {
    return spawnSync('git', ['-C', repoFixturePath, ...args], { encoding: 'utf8' });
  }
  if (git('init').status !== 0) throw new Error('fixture git init failed');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E Bot');
  git('add', '.');
  const commit = git('commit', '-m', 'fixture initial');
  if (commit.status !== 0) throw new Error('fixture commit failed: ' + commit.stderr);

  // Leave uncommitted (modified) tracked work and a new untracked file so the
  // context summary has real Git state to report.
  writeFileSync(join(repoFixturePath, 'packages', 'api', 'tracked.txt'), 'changed\n');
  writeFileSync(join(repoFixturePath, 'notes.txt'), 'untracked work\n');
}

function tmux(...args) {
  return spawnSync('tmux', ['-S', socket, ...args], {
    encoding: 'utf8',
  });
}

function capturePane(target = session, withEscapes = false) {
  // Capture only the visible pane (not scrollback) so stale frames from the
  // full-screen TUI redraw do not produce false-positive matches. The -e flag
  // keeps the ANSI escape sequences (tmux otherwise renders them away), which the
  // color-capability checks rely on.
  const captured = tmux('capture-pane', withEscapes ? '-pe' : '-p', '-t', target);
  if (captured.status !== 0) {
    throw new Error(captured.stderr || 'Failed to capture tmux pane');
  }
  return captured.stdout;
}

function sendKeys(...keys) {
  for (const key of keys) {
    const result = tmux('send-keys', '-t', session, key);
    if (result.status !== 0) {
      throw new Error(result.stderr || `Failed to send key: ${key}`);
    }
  }
}

function waitForContent(expected, timeoutMs = 30_000, target = session) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const content = capturePane(target);
    if (content.includes(expected)) {
      return content;
    }
    spawnSync('sleep', ['0.25']);
  }
  throw new Error(`Timed out waiting for content: ${expected}`);
}

// Verify the responsive + color-capability contract: the interface stays usable
// at three terminal sizes under both full color and reduced color. Each case is
// an isolated short-lived session so it cannot disturb the main flow's session.
function verifyResponsiveMatrix() {
  // A hue SGR parameter (30-37 or 90-97) anywhere in a sequence. Bold/dim/reverse
  // (1/2/7) and reset (0) never match, so this detects color and only color.
  const hue = /\x1b\[[0-9;]*(?:3[0-7]|9[0-7])m/;
  const sizes = [
    { name: 'minimum', x: 60, y: 12 },
    { name: 'typical', x: 80, y: 24 },
    { name: 'wide', x: 120, y: 40 },
  ];
  const colors = [
    { name: 'full', env: 'FORCE_COLOR=1', expectHue: true },
    { name: 'none', env: 'NO_COLOR=1', expectHue: false },
  ];
  for (const size of sizes) {
    for (const color of colors) {
      const matrixSession = `${session}-matrix`;
      const cmd = `env OMC_PROVIDER=test OMC_APPROVAL_TIMEOUT_MS=2000 ${color.env} ${JSON.stringify(nodeBin)} ${JSON.stringify(cli)}`;
      const started = tmux('new-session', '-d', '-x', String(size.x), '-y', String(size.y), '-s', matrixSession, cmd);
      if (started.status !== 0) {
        throw new Error(started.stderr || `Unable to start matrix session ${size.name}/${color.name}`);
      }
      try {
        waitForContent('Composer', 30_000, matrixSession);
        const plain = capturePane(matrixSession);
        // The composer and footer are essential and stay on-screen at every size.
        if (!plain.includes('Composer')) {
          throw new Error(`matrix ${size.name}/${color.name}: composer missing`);
        }
        if (!plain.includes('Ctrl+C')) {
          throw new Error(`matrix ${size.name}/${color.name}: footer hints missing`);
        }
        // Frame integrity: no rendered line is wider than the pane (no wrap/corruption).
        for (const line of plain.split('\n')) {
          if (line.replace(/\s+$/, '').length > size.x) {
            throw new Error(`matrix ${size.name}/${color.name}: line wider than ${size.x} columns`);
          }
        }
        // Color capability: hue is present only when full color is requested.
        const withEscapes = capturePane(matrixSession, true);
        if (color.expectHue && !hue.test(withEscapes)) {
          throw new Error(`matrix ${size.name}/${color.name}: expected hue codes in full-color mode`);
        }
        if (!color.expectHue && hue.test(withEscapes)) {
          throw new Error(`matrix ${size.name}/${color.name}: hue leaked into reduced-color mode`);
        }
      } finally {
        tmux('kill-session', '-t', matrixSession);
        spawnSync('sleep', ['0.1']);
      }
    }
  }
}

// Verify /model management in an isolated session: listing validated profiles,
// inspecting non-secret config, a rejected switch, a successful switch to a
// reduced-capability profile, and the resulting tool-skip fallback. Kept in its
// own session so the profile switch cannot disturb the main flow.
function verifyModelProfiles() {
  const modelSession = `${session}-model`;
  const cmd = `env OMC_PROVIDER=test OMC_APPROVAL_TIMEOUT_MS=2000 ${JSON.stringify(nodeBin)} ${JSON.stringify(cli)}`;
  const started = tmux('new-session', '-d', '-x', '120', '-y', '40', '-s', modelSession, cmd);
  if (started.status !== 0) {
    throw new Error(started.stderr || 'Unable to start model session');
  }
  const send = (...keys) => {
    for (const key of keys) {
      const result = tmux('send-keys', '-t', modelSession, key);
      if (result.status !== 0) throw new Error(result.stderr || `Failed to send key: ${key}`);
    }
  };
  try {
    waitForContent('Composer', 30_000, modelSession);

    // Listing shows every validated profile with the active one marked.
    send('/model list', 'Enter');
    waitForContent('Active profile: test', 30_000, modelSession);
    waitForContent('openai-gpt4o', 30_000, modelSession);
    waitForContent('test-mini', 30_000, modelSession);

    // Inspecting config reveals non-secret fields only.
    spawnSync('sleep', ['0.3']);
    send('/model show', 'Enter');
    waitForContent('Effective configuration', 30_000, modelSession);
    waitForContent('Capabilities:', 30_000, modelSession);

    // A rejected switch is actionable: it names the unknown profile.
    spawnSync('sleep', ['0.3']);
    send('/model use nope', 'Enter');
    waitForContent('No profile named "nope"', 30_000, modelSession);

    // A successful switch updates the visible status and notes the fallback.
    spawnSync('sleep', ['0.3']);
    send('/model use test-mini', 'Enter');
    waitForContent('Switched to test-mini', 30_000, modelSession);
    waitForContent('does not support coding tools', 30_000, modelSession);
    waitForContent('test-model-mini', 30_000, modelSession);

    // Capability fallback: a tool request is skipped, not executed.
    spawnSync('sleep', ['0.3']);
    send('list files in src', 'Enter');
    waitForContent('Skipped', 30_000, modelSession);
    waitForContent('does not support tools', 30_000, modelSession);

    // Switching back to a full-capability profile succeeds.
    spawnSync('sleep', ['0.3']);
    send('/model use test', 'Enter');
    waitForContent('Switched to test ', 30_000, modelSession);
  } finally {
    tmux('kill-session', '-t', modelSession);
    spawnSync('sleep', ['0.1']);
  }
}

// Verify tool permission policies in an isolated session: a user deny and a
// conflicting project allow for the same command resolve to deny (a project
// cannot broaden past the user), a temporary override is inspectable, revoking
// the user rule changes the decision, and the audit trail records each change.
// Policy paths point at a throwaway directory so the run never touches the
// operator's real ~/.omc or the repository's own policy file.
function verifyPolicyGovernance() {
  const policySession = `${session}-policy`;
  const policyDirectory = join(temporaryDirectory, 'policy');
  const policyEnv = [
    'OMC_PROVIDER=test',
    'OMC_APPROVAL_TIMEOUT_MS=2000',
    `OMC_USER_POLICY_PATH=${JSON.stringify(join(policyDirectory, 'user.json'))}`,
    `OMC_PROJECT_POLICY_PATH=${JSON.stringify(join(policyDirectory, 'project.json'))}`,
    `OMC_POLICY_AUDIT_PATH=${JSON.stringify(join(policyDirectory, 'audit.json'))}`,
  ].join(' ');
  const cmd = `env ${policyEnv} ${JSON.stringify(nodeBin)} ${JSON.stringify(cli)}`;
  const started = tmux('new-session', '-d', '-x', '120', '-y', '40', '-s', policySession, cmd);
  if (started.status !== 0) {
    throw new Error(started.stderr || 'Unable to start policy session');
  }
  const send = (...keys) => {
    for (const key of keys) {
      const result = tmux('send-keys', '-t', policySession, key);
      if (result.status !== 0) throw new Error(result.stderr || `Failed to send key: ${key}`);
    }
  };
  try {
    waitForContent('Composer', 30_000, policySession);

    // A user deny and a conflicting project allow for the same command.
    send('/policy set user deny git push', 'Enter');
    waitForContent('Policy set: user deny', 30_000, policySession);
    spawnSync('sleep', ['0.3']);
    send('/policy set project allow git push', 'Enter');
    waitForContent('Policy set: project allow', 30_000, policySession);

    // Conflict resolves to deny: the project cannot broaden past the user.
    spawnSync('sleep', ['0.3']);
    send('/policy explain git push', 'Enter');
    waitForContent('Decision: deny', 30_000, policySession);
    waitForContent('denied by user policy', 30_000, policySession);

    // A temporary override is created and inspectable, but deny still wins.
    spawnSync('sleep', ['0.3']);
    send('/policy temp allow git push', 'Enter');
    waitForContent('Policy set: temporary allow', 30_000, policySession);
    spawnSync('sleep', ['0.3']);
    send('/policy list', 'Enter');
    waitForContent('temporary:', 30_000, policySession);

    // Revoking the user rule changes the decision; the project allow is still
    // capped at the default ask ceiling, so it never silently broadens.
    spawnSync('sleep', ['0.3']);
    send('/policy revoke user git push', 'Enter');
    waitForContent('Policy revoked: user', 30_000, policySession);
    spawnSync('sleep', ['0.3']);
    send('/policy explain git push', 'Enter');
    waitForContent('Decision: ask', 30_000, policySession);

    // The audit trail records the mutations.
    spawnSync('sleep', ['0.3']);
    send('/policy audit', 'Enter');
    waitForContent('[revoke]', 30_000, policySession);
    waitForContent('[set]', 30_000, policySession);
  } finally {
    tmux('kill-session', '-t', policySession);
    spawnSync('sleep', ['0.1']);
  }
}

try {
  // Launch the TUI with the test provider. The pane is tall enough to hold the
  // full multi-turn transcript so the final capture shows every tool in action;
  // a shorter pane would scroll the earlier turns off-screen.
  // Start from a clean session record so a stale file from a prior run cannot
  // shadow this one.
  rmSync(sessionFile, { force: true });
  const launchCmd = `env OMC_PROVIDER=test OMC_APPROVAL_TIMEOUT_MS=2000 OMC_SESSION_ID=${sessionId} ${JSON.stringify(nodeBin)} ${JSON.stringify(cli)}`;
  const started = tmux('new-session', '-d', '-x', '120', '-y', '340', '-s', session, launchCmd);
  if (started.status !== 0) {
    throw new Error(started.stderr || 'Unable to start tmux integration session');
  }

  // Wait for the TUI to render
  waitForContent('Composer');
  waitForContent('Transcript');

  // Verify model identity and connection state are shown
  const initial = capturePane();
  if (!initial.includes('Model:')) {
    throw new Error('Expected Model: in status card');
  }
  if (!initial.includes('Connection:')) {
    throw new Error('Expected Connection: in status card');
  }

  // === Turn 1: list files (repository discovery) ===
  sendKeys('list files in src', 'Enter');
  // The agent invokes the list_files tool and its result appears in the transcript
  waitForContent('list_files');
  waitForContent('app.ts');
  waitForContent('ready');

  // === Turn 2: read a file ===
  spawnSync('sleep', ['0.3']);
  sendKeys('read tsconfig.build.json', 'Enter');
  waitForContent('read_file');
  // The file content is shown in the transcript
  waitForContent('outDir');
  waitForContent('ready');

  // === Turn 3: search repository content ===
  spawnSync('sleep', ['0.3']);
  sendKeys('search for launchTui', 'Enter');
  waitForContent('search_content');
  // A matching file is reported with its path
  waitForContent('src/tui.ts');
  waitForContent('ready');

  // === Turn 4: run a command through the approval boundary (allow once) ===
  spawnSync('sleep', ['0.3']);
  sendKeys('run echo hello-allow', 'Enter');
  // The approval card blocks execution until a decision is recorded
  waitForContent('Approval required');
  waitForContent('Risk:');
  sendKeys('y');
  waitForContent('hello-allow');
  waitForContent('ready');

  // === Turn 5: deny a command ===
  spawnSync('sleep', ['0.3']);
  sendKeys('run echo hello-deny', 'Enter');
  waitForContent('Approval required');
  sendKeys('n');
  waitForContent('Command denied');
  waitForContent('ready');

  // === Turn 6: let the approval window time out ===
  spawnSync('sleep', ['0.3']);
  sendKeys('run echo hello-timeout', 'Enter');
  waitForContent('Approval required');
  // No decision is sent; the approval auto-denies after the timeout
  waitForContent('Command timed out');
  waitForContent('ready');

  // === Turn 7: apply a scoped edit through the diff review boundary ===
  writeFileSync(fixturePath, fixtureOriginal, 'utf8');
  spawnSync('sleep', ['0.3']);
  sendKeys('edit omc-e2e-fixture.txt :: beta :: BETA', 'Enter');
  // The diff card blocks until a decision is recorded; nothing is written yet.
  waitForContent('Edit proposed');
  waitForContent('+ BETA');
  sendKeys('y');
  waitForContent('Edit applied');
  waitForContent('ready');
  if (!readFileSync(fixturePath, 'utf8').includes('BETA')) {
    throw new Error('Accepted edit was not written to disk');
  }

  // === Turn 8: reject an edit; the file must stay untouched ===
  spawnSync('sleep', ['0.3']);
  sendKeys('edit omc-e2e-fixture.txt :: gamma :: GAMMA', 'Enter');
  waitForContent('Edit proposed');
  sendKeys('n');
  waitForContent('Edit rejected');
  waitForContent('ready');
  const afterReject = readFileSync(fixturePath, 'utf8');
  if (afterReject.includes('GAMMA')) {
    throw new Error('Rejected edit must not modify the file');
  }
  if (!afterReject.includes('BETA')) {
    throw new Error('Previously applied edit should still be present');
  }

  // === Revert: undo only the applied edit (Ctrl+U) ===
  spawnSync('sleep', ['0.3']);
  sendKeys('C-u');
  waitForContent('Edit reverted');
  waitForContent('ready');
  // Revert restores the original content, leaving no trace of the applied edit.
  if (readFileSync(fixturePath, 'utf8') !== fixtureOriginal) {
    throw new Error('Revert did not restore the original file content');
  }

  // === Turn 9: build repository context from a multi-package fixture ===
  buildRepoFixture();
  spawnSync('sleep', ['0.3']);
  sendKeys('show repository context in omc-e2e-repo', 'Enter');
  waitForContent('repo_context');
  // Nested instructions are resolved according to scope.
  waitForContent('packages/api/AGENTS.md');
  waitForContent('scope: packages/api');
  // The summary identifies every package from real manifests.
  waitForContent('fixture-root');
  waitForContent('packages/web');
  // Focused test commands derived from real build tooling.
  waitForContent('make unit');
  // Uncommitted and untracked user work is reported.
  waitForContent('untracked: notes.txt');
  waitForContent('modified: packages/api/tracked.txt');
  waitForContent('ready');
  // Discovery is read-only: the working tree is exactly as left.
  if (readFileSync(join(repoFixturePath, 'packages', 'api', 'tracked.txt'), 'utf8') !== 'changed\n') {
    throw new Error('repo_context modified tracked work');
  }
  if (readFileSync(join(repoFixturePath, 'notes.txt'), 'utf8') !== 'untracked work\n') {
    throw new Error('repo_context modified untracked work');
  }

  // === Turn 10: a complete coding loop whose verification passes ===
  // The fixture file is back to its original content after the turn-8 revert.
  spawnSync('sleep', ['0.3']);
  sendKeys('complete omc-e2e-fixture.txt :: beta :: BETA :: grep BETA omc-e2e-fixture.txt', 'Enter');
  // The loop inspects the target file, then proposes the scoped edit.
  waitForContent('read_file');
  waitForContent('Edit proposed');
  sendKeys('y');
  waitForContent('Edit applied');
  // Focused verification runs through the approval boundary and passes.
  waitForContent('Approval required');
  sendKeys('y');
  waitForContent('Coding loop complete');
  waitForContent('Changes:');
  waitForContent('Tests:');
  waitForContent('Next (user-owned):');
  waitForContent('ready');
  if (!readFileSync(fixturePath, 'utf8').includes('BETA')) {
    throw new Error('Loop edit was not written to disk');
  }

  // === Turn 11: a complete coding loop whose verification fails (blocked) ===
  spawnSync('sleep', ['0.3']);
  sendKeys('complete omc-e2e-fixture.txt :: gamma :: GAMMA :: grep MISSING omc-e2e-fixture.txt', 'Enter');
  waitForContent('read_file');
  waitForContent('Edit proposed');
  sendKeys('y');
  waitForContent('Edit applied');
  waitForContent('Approval required');
  sendKeys('y');
  // Verification finds no match, so the loop reports a clear blocked result
  // instead of claiming success.
  waitForContent('Coding loop blocked');
  waitForContent('Remaining risks:');
  waitForContent('ready');

  // === Turn 12: a rich answer that fans out into distinct transcript blocks ===
  // While it streams it shows a live progress block; once committed the same turn
  // renders Markdown, code, and reasoning blocks side by side.
  spawnSync('sleep', ['0.3']);
  sendKeys('explain the transcript blocks', 'Enter');
  waitForContent('Progress');
  waitForContent('Markdown');
  waitForContent('Code');
  waitForContent('return a + b');
  waitForContent('Reasoning');
  waitForContent('ready');

  // === Turn 13: a recoverable error renders as an error block, then retries ===
  spawnSync('sleep', ['0.3']);
  sendKeys('please recover from this', 'Enter');
  waitForContent('Error');
  waitForContent('Simulated transient network error');
  waitForContent('Ctrl+R retry');
  sendKeys('C-r');
  waitForContent('ready');

  // Verify usage reflects all thirteen completed turns (footer stays pinned on-screen)
  const finalScreen = waitForContent('turns: 13');

  // The command, edit, and coding-loop paths must each be visible in the transcript.
  for (const token of [
    'hello-allow',
    'Command denied',
    'Command timed out',
    'Edit applied',
    'Edit rejected',
    'Edit reverted',
    'Coding loop complete',
    'Coding loop blocked',
    'Markdown',
    'Code',
    'Reasoning',
  ]) {
    if (!finalScreen.includes(token)) {
      throw new Error(`Expected ${token} in final transcript`);
    }
  }

  // Preserve the verified TUI itself for PR evidence before the tmux session exits.
  const evidenceDirectory = resolve('artifacts/e2e');
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(join(evidenceDirectory, 'oh-my-code.tmux.txt'), finalScreen, 'utf8');

  // === Responsive + color-capability contract: three sizes × two capabilities ===
  verifyResponsiveMatrix();

  // === Model profiles: list, inspect, reject, switch, and capability fallback ===
  verifyModelProfiles();

  // === Tool permission policies: conflict, temporary override, revocation, audit ===
  verifyPolicyGovernance();

  // === Durability: terminate a live session, then resume it in a fresh process ===

  // The live session persisted its transcript to disk as it progressed.
  if (!existsSync(sessionFile)) {
    throw new Error('Live session was not persisted to disk');
  }

  // Queue one more command, then terminate the process before it can run. The
  // user message is persisted before streaming begins, so this leaves a pending
  // safe action on disk for a fresh process to resume rather than discard.
  spawnSync('sleep', ['0.3']);
  sendKeys('run echo hello-resume', 'Enter');
  waitForContent('Approval required');
  waitForContent('hello-resume');

  // Kill the process abruptly (simulating a crash) mid-turn.
  tmux('kill-session', '-t', session);
  spawnSync('sleep', ['0.3']);
  const killed = tmux('has-session', '-t', session);
  if (killed.status === 0) {
    throw new Error('Live session was not terminated');
  }

  // The persisted transcript ends with the unanswered user message: exactly the
  // pending safe action a resume must continue.
  const persisted = JSON.parse(readFileSync(sessionFile, 'utf8'));
  const persistedLast = persisted.messages[persisted.messages.length - 1];
  if (persistedLast === undefined || persistedLast.role !== 'user') {
    throw new Error('Pending user message was not persisted for resume');
  }

  // === Resume the same session in a fresh process ===
  const resumeCmd = `env OMC_PROVIDER=test OMC_APPROVAL_TIMEOUT_MS=2000 ${JSON.stringify(nodeBin)} ${JSON.stringify(cli)} sessions resume ${sessionId}`;
  const resumed = tmux('new-session', '-d', '-x', '120', '-y', '340', '-s', session, resumeCmd);
  if (resumed.status !== 0) {
    throw new Error(resumed.stderr || 'Unable to resume session');
  }

  // The full transcript is restored, including usage from all thirteen turns.
  waitForContent('Transcript');
  waitForContent('turns: 13');
  waitForContent('list_files');
  waitForContent('Coding loop blocked');

  // The interrupted turn resumes as a pending safe action: the same command
  // comes back for approval instead of being lost or silently re-run.
  waitForContent('Approval required');
  waitForContent('hello-resume');

  // Allowing it finishes exactly the one interrupted turn. Completed turns are
  // not replayed: usage advances from 13 to 14 (one new turn), not higher.
  sendKeys('y');
  waitForContent('hello-resume');
  waitForContent('ready');
  const resumedScreen = waitForContent('turns: 14');
  // A restored assistant turn must not be re-streamed: the live progress block
  // (header "Progress (streaming…)") is absent once the resume settles.
  if (resumedScreen.includes('Progress (streaming')) {
    throw new Error('Resume re-streamed a completed turn');
  }

  // Preserve the resumed transcript for PR evidence.
  writeFileSync(join(evidenceDirectory, 'oh-my-code.resumed.txt'), resumedScreen, 'utf8');

  // Exit the resumed session cleanly.
  sendKeys('C-c');
  spawnSync('sleep', ['0.5']);
  const hasSession = tmux('has-session', '-t', session);
  if (hasSession.status === 0) {
    throw new Error('Resumed TUI did not exit after Ctrl+C');
  }

  process.stdout.write('integration: ok\n');
} finally {
  tmux('kill-server');
  rmSync(temporaryDirectory, { recursive: true, force: true });
  rmSync(fixturePath, { force: true });
  rmSync(repoFixturePath, { recursive: true, force: true });
  rmSync(sessionFile, { force: true });
}
