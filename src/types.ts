import type { DmPolicy, GroupPolicy } from "openclaw/plugin-sdk";

export type FluxerReconnectConfig = {
  /** Base reconnect delay in milliseconds. */
  baseDelayMs?: number;
  /** Maximum reconnect delay in milliseconds. */
  maxDelayMs?: number;
  /** Optional hard cap for reconnect attempts (0/undefined means unlimited). */
  maxAttempts?: number;
  /** Random jitter ratio (0.2 means +/-20%). */
  jitterRatio?: number;
};

export type FluxerAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** If false, do not start this Fluxer account. Default: true. */
  enabled?: boolean;
  /** Fluxer API token for bot auth. */
  apiToken?: string;
  /** Fluxer API base URL, e.g. https://api.fluxer.example. */
  baseUrl?: string;
  /** Direct message policy (pairing/allowlist/open/disabled). */
  dmPolicy?: DmPolicy;
  /** Allowlist for direct messages. */
  allowFrom?: Array<string | number>;
  /** Group message policy (allowlist/open/disabled). */
  groupPolicy?: GroupPolicy;
  /** Allowlist for group senders. */
  groupAllowFrom?: Array<string | number>;
  /** Outbound text chunk size (chars). */
  textChunkLimit?: number;
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  /** Reconnect tuning for inbound monitor loop. */
  reconnect?: FluxerReconnectConfig;
  /** Bot identity ID resolved from probe (cached at runtime). */
  botId?: string;
  /** Auth scheme for API requests (e.g. "bearer", "token", "bot"). Default: "bearer". */
  authScheme?: string;
};

export type FluxerConfig = {
  accounts?: Record<string, FluxerAccountConfig>;
} & FluxerAccountConfig;

// ---------------------------------------------------------------------------
// Transport adapter interfaces (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Error classification for Fluxer API responses.
 * Used by retry/rate-limit logic to decide whether to retry.
 */
export type FluxerErrorClass =
  | "auth" // 401/403 – do not retry
  | "validation" // 400/422 – do not retry
  | "not-found" // 404 – do not retry
  | "rate-limit" // 429 – retry after delay
  | "server" // 5xx – retry with backoff
  | "transport" // network/timeout – retry with backoff
  | "unknown"; // unclassified

/**
 * Structured error from Fluxer API calls.
 */
export type FluxerApiError = Error & {
  status?: number;
  errorClass: FluxerErrorClass;
  retryAfterMs?: number;
  retryable: boolean;
};

/**
 * Pluggable transport interface for all Fluxer API interactions.
 * All provider-specific HTTP/protocol details are isolated here.
 */
export type FluxerTransport = {
  /** Send a text message. */
  sendText(params: {
    to: string;
    text: string;
    replyToId?: string;
    idempotencyKey?: string;
  }): Promise<{ messageId: string; channelId?: string }>;

  /** Send media (URL or reference). */
  sendMedia?(params: {
    to: string;
    text?: string;
    mediaUrl: string;
    replyToId?: string;
  }): Promise<{ messageId: string; channelId?: string }>;

  /** Probe auth/identity endpoint. */
  probe(params: { timeoutMs: number; abortSignal?: AbortSignal }): Promise<{
    ok: boolean;
    status?: number;
    error?: string;
    botId?: string;
    botName?: string;
    latencyMs?: number;
  }>;

  /** Add a reaction (optional capability). */
  addReaction?(params: { messageId: string; emoji: string }): Promise<void>;

  /** Send a typing indicator for a channel (optional capability). */
  triggerTyping?(params: { channelId: string }): Promise<void>;
};

/**
 * Pluggable event source for inbound events.
 * Abstracts WebSocket, SSE, webhook relay, or long-poll transports.
 */
export type FluxerEventSource = {
  /**
   * Connect and stream events until the abort signal fires or the connection drops.
   * On clean disconnect (server-side close), the promise resolves.
   * On error, the promise rejects.
   */
  connect(params: {
    abortSignal: AbortSignal;
    onEvent: (raw: unknown) => void | Promise<void>;
    onConnected?: () => void;
    onDisconnected?: (info?: { code?: number; reason?: string }) => void;
  }): Promise<void>;
};

/**
 * Factory to create a FluxerEventSource for a given account.
 */
export type FluxerEventSourceFactory = (config: {
  baseUrl: string;
  apiToken: string;
  accountId: string;
  /** Discovered gateway URL override (from discovery bootstrap). */
  gatewayUrl?: string;
}) => FluxerEventSource;
