## Tmux E2E verification

- Repository: `qqqys/oh-my-code`
- Pull request: `#67`
- Commit: `0b60d1f92178ada8ff24257645e4e53bccc1defd`
- Viewport: `120x36`
- Scenario: Qwen-style pixel wordmark, session panel, quiet transcript, and framed composer
- Result: **PASS**

### Assertions

- Product identity and session context are visible without wrapping.
- The empty state gives a clear next action.
- The composer is fixed directly above the session footer.
- No credential, account name, or private workspace path appears in the capture.

![Exact-head tmux capture](https://raw.githubusercontent.com/qqqys/oh-my-code/e2e-evidence/e2e/0b60d1f92178ada8ff24257645e4e53bccc1defd/terminal.png)

- [Readable transcript](https://raw.githubusercontent.com/qqqys/oh-my-code/e2e-evidence/e2e/0b60d1f92178ada8ff24257645e4e53bccc1defd/transcript.txt)
- [ANSI capture](https://raw.githubusercontent.com/qqqys/oh-my-code/e2e-evidence/e2e/0b60d1f92178ada8ff24257645e4e53bccc1defd/terminal.ansi)
- [Timeline](https://raw.githubusercontent.com/qqqys/oh-my-code/e2e-evidence/e2e/0b60d1f92178ada8ff24257645e4e53bccc1defd/timeline.json)
