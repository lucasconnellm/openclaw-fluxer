# @lucasconnellm/openclaw-fluxer

Fluxer channel plugin for OpenClaw, built on top of `@fluxerjs/core`.

## Current status

Installable local plugin scaffold with:

- inbound monitoring via `@fluxerjs/core` gateway client
- outbound send via `@fluxerjs/core` REST/client helpers
- OpenClaw DM/group policy gates, pairing, routing, debounce/dedupe
- status/probe wiring in OpenClaw channel model

## Quick local install (linked dev mode)

```bash
openclaw plugins install -l /home/crusty/oc-recontrib/openclaw-fluxer
openclaw plugins enable fluxer
openclaw gateway restart
```

`-l` keeps it linked, so gateway restarts pick up local code changes.

## Minimum config to test

Set these under `channels.fluxer`:

```yaml
channels:
  fluxer:
    enabled: true
    apiToken: "<YOUR_FLUXER_BOT_TOKEN>"
    baseUrl: "https://api.fluxer.app"
```

### Notes on `baseUrl`

- If your API root is standard hosted Fluxer, `https://api.fluxer.app` is correct.
- If self-hosted behind `/api/v1`, set `baseUrl` to the parent API root (for example `https://fluxer.example/api`) so the SDK resolves `/v1` correctly.

## Recommended test policy config

For quickest smoke testing from DMs/groups:

```yaml
channels:
  fluxer:
    enabled: true
    apiToken: "<YOUR_FLUXER_BOT_TOKEN>"
    baseUrl: "https://api.fluxer.app"

    # Fast testing mode (open DM with explicit wildcard requirement)
    dmPolicy: open
    allowFrom: ["*"]

    # Group policy (open for testing, tighten later)
    groupPolicy: open
```

Safer default is:

```yaml
channels:
  fluxer:
    dmPolicy: pairing
    groupPolicy: allowlist
```

## Optional config knobs

```yaml
channels:
  fluxer:
    authScheme: bot        # bot (default) | bearer
    textChunkLimit: 4000
    reconnect:
      baseDelayMs: 1000
      maxDelayMs: 30000
      maxAttempts: 0
      jitterRatio: 0.2
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
