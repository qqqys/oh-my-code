## Tmux E2E verification

- Repository: `qwen-code-dev-bot/oh-my-code`
- Pull request: `#67`
- Commit: `d32f0bf058fb1cec7a907faeb83223d5b70fd13d`
- Viewport: `120x36`
- Scenario: Responsive session hero and bottom-anchored composer at 120x36
- Result: **PASS**

### Assertions

- Product identity and session context are visible without wrapping.
- The empty state gives a clear next action.
- The composer is fixed directly above the session footer.
- No credential, account name, or private workspace path appears in the capture.

![Exact-head tmux capture](https://raw.githubusercontent.com/qqqys/oh-my-code/e2e-evidence/e2e/d32f0bf058fb1cec7a907faeb83223d5b70fd13d/terminal.png)

- [Readable transcript](https://raw.githubusercontent.com/qqqys/oh-my-code/e2e-evidence/e2e/d32f0bf058fb1cec7a907faeb83223d5b70fd13d/transcript.txt)
- [ANSI capture](https://raw.githubusercontent.com/qqqys/oh-my-code/e2e-evidence/e2e/d32f0bf058fb1cec7a907faeb83223d5b70fd13d/terminal.ansi)
- [Timeline](https://raw.githubusercontent.com/qqqys/oh-my-code/e2e-evidence/e2e/d32f0bf058fb1cec7a907faeb83223d5b70fd13d/timeline.json)
