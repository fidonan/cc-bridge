# Publishing Notes

This repository is in a good state to publish as your own experimental fork, but it should be positioned clearly.

## Recommended positioning

Suggested repo description:

`Local bridge for sustained collaboration between two Claude Code windows`

Suggested framing:

- this is an experimental fork derived from `agent-bridge`
- explicitly acknowledge and thank the upstream author
- the fork preserves the original project's control-plane value
- the current focus is `Claude Code A <-> cc-bridge <-> Claude Code B`
- the practical use case is two-window collaboration, especially under `cc switch` / different-model workflows

## Recommended files to commit

These are appropriate to include in your first public push:

- core source under `src/`
- new scripts under `scripts/`
- `README.md`
- `README.zh-CN.md`
- `QUICKSTART.md`
- `SOP.md`
- `MULTI_CLAUDE_WINDOWS.md`
- `PROMPTS.md`
- `PUBLISHING.md`
- `package.json`
- `bun.lock`
- existing docs under `docs/`
- CI / metadata files already tracked in `.github/`

## Files that should not be committed

Do not commit:

- `node_modules/`
- local log files
- local pid files
- `/tmp/cc-bridge/*`
- your personal Claude config such as `~/.claude.json`
- any environment files containing tokens or secrets

## Before pushing

Recommended checklist:

1. Make sure the README is the first thing a stranger can understand.
2. Keep the upstream attribution, but do not leave package metadata pointing at the upstream repo.
3. Confirm the main documented commands use `cc-bridge-*` naming.
4. Confirm no local credentials or machine-specific state are tracked.
5. Run:

```bash
bun run typecheck
git status
```

## Suggested first commit scope

For a clean first public commit, include:

- the dual-Claude bridge changes
- the `wait_for_messages` support
- the new scripts and docs

Avoid mixing in unrelated experiments.

## Suggested README emphasis

The README should clearly communicate:

- what the original upstream project proved
- what this fork changes
- why pull-mode Claude-to-Claude needs additional machinery
- what has already been validated locally

## Suggested next step after local cleanup

Once you create your own GitHub repo, update:

- `package.json` repository / homepage / bugs fields
- any README links that should point to your new repo instead of local paths
