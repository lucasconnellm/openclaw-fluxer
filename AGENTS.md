# AGENTS.md

## Commit and release policy

This repository requires **Conventional Commits**.

- Required format examples:
  - `feat: ...`
  - `fix: ...`
  - `chore: ...`
  - `docs: ...`
  - `refactor: ...`
  - `test: ...`
  - `ci: ...`
- Non-conventional commit messages are not allowed.

## Tooling expectations

- Package manager: `pnpm`
- Install: `pnpm install`
- Hooks setup: `pnpm run prepare`
- Full local check: `pnpm run check`
- Guided commit flow: `pnpm commit`

## Hooks

- `pre-commit`: runs `pnpm run check` (typecheck + tests)
- `commit-msg`: runs commitlint using conventional commit rules

## Release automation

- `release-please` is configured for this repo.
- It uses commit history to produce/update release PRs and `CHANGELOG.md`.
- Keeping commits conventional and atomic is mandatory for clean release notes.
