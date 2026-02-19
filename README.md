![Openclaw Fluxer Plugin banner](docs/assets/openclaw-fluxer-banner.jpg)

# Openclaw Fluxer Plugin

Fluxer channel plugin for OpenClaw, built on top of `@fluxerjs/core`.

## Current status

Installable local plugin scaffold with:

- inbound monitoring via `@fluxerjs/core` gateway client
- outbound send via `@fluxerjs/core` REST/client helpers
- OpenClaw DM/group policy gates, pairing, routing, debounce/dedupe
- status/probe wiring in OpenClaw channel model

## Install

Install from the published plugin package:

```bash
openclaw plugins install @lucasconnellm/openclaw-fluxer
openclaw plugin enable fluxer
openclaw gateway restart
```

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
    }
  }
}
```

You can also use env vars (default account only):

- `FLUXER_API_TOKEN`
- `FLUXER_BASE_URL`

## Feature parity snapshot (vs Discord channel plugin)

- ✅ DM + channel/group inbound/outbound
- ✅ pairing / allowlist / policy gates
- ✅ message update + delete inbound events captured
- ✅ reaction add inbound event captured
- ✅ media attachment URLs passed inbound
- ⚠️ outbound media currently URL/caption fallback (native file send wiring not finished)
- ⚠️ outbound reactions not wired yet
- ⚠️ thread routing parity not complete

## Dev checks

```bash
npm install
npm run typecheck
npm test
```
