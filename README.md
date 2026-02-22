![Openclaw Fluxer Plugin banner](docs/assets/openclaw-fluxer-banner.jpg)

# Openclaw Fluxer Plugin

Fluxer channel plugin for OpenClaw, built on top of `@fluxerjs/core`.

## Experimental disclaimer

This project is **highly experimental** and provided **"as is"**.
By using it, you accept all risk and are solely responsible for any outcomes,
including service interruptions, data issues, policy violations, account actions,
or other repercussions. The author/maintainer is **not liable** for any damages
or consequences resulting from use of this software.

## Current status

Installable local plugin scaffold with:

- inbound monitoring via `@fluxerjs/core` gateway client
- outbound send via `@fluxerjs/core` REST/client helpers
- OpenClaw DM/group policy gates, pairing, routing, debounce/dedupe
- status/probe wiring in OpenClaw channel model

## Voice status (very experimental)

Voice support is currently **highly experimental** and does **not** behave reliably against official hosted `Fluxer.app` servers yet.

Given the pace of upstream Fluxer server changes and current instability, voice work in this plugin will remain lower priority until server behavior is more stable.

## Install

Install from the published plugin package:

```bash
openclaw plugins install @lucasconnellm/fluxer
openclaw plugin enable fluxer
openclaw gateway restart
```

The package is now named `@lucasconnellm/fluxer` because OpenClaw appears to infer
plugin identity from the repo/package name. Publishing under `openclaw-fluxer`
was causing install/registration mismatches in practice.

If you’re developing locally, use a linked install as needed.

## Configure

Use OpenClaw’s JSON config format. Set your `fluxer` block like this:

```json
{
  "fluxer": {
    "enabled": true,
    "apiToken": "<REDACTED>",
    "baseUrl": "https://api.fluxer.app",
    "authScheme": "bot",
    "dmPolicy": "allowlist",
    "allowFrom": [
      "<YOUR_USER_ID>"
    ],
    "groupPolicy": "allowlist",
    "groupAllowFrom": [
      "<YOUR_USER_ID>"
    ]
  }
}
```

### Notes on `baseUrl`

- If your API root is standard hosted Fluxer, `https://api.fluxer.app` is correct.
- If self-hosted behind `/api/v1`, set `baseUrl` to the parent API root (for example `https://fluxer.example/api`) so the SDK resolves `/v1` correctly.

### Optional config knobs

```json
{
  "fluxer": {
    "authScheme": "bot",
    "textChunkLimit": 4000,
    "reconnect": {
      "baseDelayMs": 1000,
      "maxDelayMs": 30000,
      "maxAttempts": 0,
      "jitterRatio": 0.2
    },
    "streaming": {
      "enabled": false,
      "mode": "partial",
      "minCharsDelta": 40,
      "idleMs": 700,
      "maxEdits": 40
    }
  }
}
```

`streaming` enables draft preview edits while a response is generating. Start with `enabled: false` and enable per account after validation.

You can also use env vars (default account only):

- `FLUXER_API_TOKEN`
- `FLUXER_BASE_URL`

## Feature parity snapshot (vs Discord channel plugin)

- ✅ DM + channel/group inbound/outbound
- ✅ pairing / allowlist / policy gates
- ✅ message update + delete inbound events captured
- ✅ reaction add inbound event captured
- ✅ media attachment URLs passed inbound
- ✅ outbound media supports native URL attachments via @fluxerjs/core file payloads
- ✅ outbound reactions wired (`react` action)
- ⚠️ slash command registration is experimental (`slashCommandPrefixes`, default tries `/models`)
- ⚠️ streaming draft previews are experimental (`streaming` config; partial/block modes)
- ⚠️ voice support is highly experimental and currently unreliable on official Fluxer.app servers
- ⚠️ thread routing parity not complete

## Development workflow (pnpm + commit standards)

This repo uses **pnpm**, **Husky**, **Commitizen**, **Commitlint**, and **release-please**.

### Install

```bash
pnpm install
pnpm run prepare
```

### Local quality gates

- Pre-commit hook runs `pnpm run check` (typecheck + tests)
- Commit message hook enforces **Conventional Commits**

### Conventional Commits (required)

Use commit messages like:

- `feat: add outbound typing support`
- `fix: handle fluxer websocket reconnect jitter`
- `chore: bump @fluxerjs/core to 1.2.0`

Do **not** use non-conventional commit messages. They will be rejected by commit hooks and will break release automation quality.

### Commit helper (Commitizen)

Use the guided commit flow:

```bash
pnpm commit
```

### CI

GitHub Actions CI runs on:

- pull requests
- manual workflow dispatch

### Releases (release-please)

`release-please` runs on `main` and opens/updates a release PR based on Conventional Commits.
When merged, it updates version/changelog and creates the GitHub release/tag consumed by publish automation.

## License

MIT — see [LICENSE](LICENSE).
