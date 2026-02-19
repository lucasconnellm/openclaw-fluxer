import { Client, Events, type Message, type PartialMessage } from "@fluxerjs/core";
import type { BaseProbeResult } from "openclaw/plugin-sdk";
import type { FluxerApiError, FluxerErrorClass } from "./types.js";

// ---------------------------------------------------------------------------
// Public client types
// ---------------------------------------------------------------------------

export type FluxerSendTextInput = {
  target: string;
  text: string;
  replyToId?: string;
  accountId?: string;
  abortSignal?: AbortSignal;
};

export type FluxerSendTextResult = {
  messageId: string;
  chatId: string;
  timestamp?: number;
};

export type FluxerProbeResult = BaseProbeResult<string | null> & {
  checkedAt: number;
  latencyMs?: number;
  mode: "live" | "stub";
  botId?: string;
  botName?: string;
};

export type FluxerMonitorInboundParams = {
  accountId: string;
  abortSignal: AbortSignal;
  onEvent: (event: unknown) => Promise<void> | void;
  onConnected?: () => void;
  onDisconnected?: (info?: { reason?: string }) => void;
};

export type FluxerReactInput = {
  channelId: string;
  messageId: string;
  emoji: string;
  remove?: boolean;
  abortSignal?: AbortSignal;
};

export type FluxerClient = {
  sendText: (input: FluxerSendTextInput) => Promise<FluxerSendTextResult>;
  react: (input: FluxerReactInput) => Promise<void>;
  probe: (params: { timeoutMs: number; abortSignal?: AbortSignal }) => Promise<FluxerProbeResult>;
  monitorInbound: (params: FluxerMonitorInboundParams) => Promise<void>;
};

export type FluxerClientConfig = {
  accountId: string;
  baseUrl: string;
  apiToken: string;
  /** Auth scheme for outbound REST requests. Default: "bot". */
  authScheme?: string;
};

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export function classifyHttpStatus(status: number): FluxerErrorClass {
  if (status === 401 || status === 403) return "auth";
  if (status === 400 || status === 422) return "validation";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limit";
  if (status >= 500) return "server";
  return "unknown";
}

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  if (typeof candidate.statusCode === "number" && Number.isFinite(candidate.statusCode)) {
    return candidate.statusCode;
  }
  if (typeof candidate.status === "number" && Number.isFinite(candidate.status)) {
    return candidate.status;
  }
  return undefined;
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { retryAfter?: unknown; retryAfterMs?: unknown };
  if (typeof candidate.retryAfterMs === "number" && Number.isFinite(candidate.retryAfterMs)) {
    return candidate.retryAfterMs;
  }
  if (typeof candidate.retryAfter === "number" && Number.isFinite(candidate.retryAfter)) {
    // @fluxerjs/rest uses seconds for retryAfter.
    return candidate.retryAfter > 1000 ? candidate.retryAfter : candidate.retryAfter * 1000;
  }
  return undefined;
}

export function classifyError(error: unknown): FluxerErrorClass {
  const status = getStatusCode(error);
  if (status !== undefined) {
    return classifyHttpStatus(status);
  }
  if (error instanceof TypeError) return "transport";
  if (error instanceof Error && error.name === "AbortError") return "transport";
  return "unknown";
}

export function isRetryable(errorClass: FluxerErrorClass): boolean {
  return errorClass === "rate-limit" || errorClass === "server" || errorClass === "transport";
}

export function createFluxerApiError(
  message: string,
  status: number | undefined,
  errorClass: FluxerErrorClass,
  retryAfterMs?: number,
): FluxerApiError {
  const err = new Error(message) as FluxerApiError;
  err.status = status;
  err.errorClass = errorClass;
  err.retryAfterMs = retryAfterMs;
  err.retryable = isRetryable(errorClass);
  return err;
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

export type RetryOpts = {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  abortSignal?: AbortSignal;
};

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const initialDelay = opts.initialDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  const jitterRatio = opts.jitterRatio ?? 0.2;

  let lastError: unknown;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const errClass = classifyError(error);
      if (!isRetryable(errClass) || attempt >= maxAttempts) {
        throw error;
      }
      if (opts.abortSignal?.aborted) throw error;

      const retryAfter = getRetryAfterMs(error);
      const waitMs =
        retryAfter && retryAfter > 0
          ? Math.min(retryAfter, maxDelay)
          : applyJitter(delay, jitterRatio);

      await sleepMs(waitMs, opts.abortSignal);
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  throw lastError;
}

function applyJitter(delayMs: number, jitterRatio: number): number {
  if (jitterRatio <= 0) return delayMs;
  const delta = delayMs * jitterRatio;
  const offset = (Math.random() * 2 - 1) * delta;
  return Math.max(100, Math.round(delayMs + offset));
}

function sleepMs(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

// ---------------------------------------------------------------------------
// @fluxerjs/core helpers
// ---------------------------------------------------------------------------

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function resolveRestApiAndVersion(baseUrl: string): { api: string; version: string } {
  const normalized = normalizeBaseUrl(baseUrl);
  const parsed = new URL(normalized);
  const rawPath = parsed.pathname.replace(/\/+$/, "");

  // Match /.../v1 style paths and split version from API root.
  const m = rawPath.match(/^(.*)\/v(\d+)$/i);
  if (m) {
    const apiPath = m[1] || "";
    return {
      api: `${parsed.origin}${apiPath}`,
      version: m[2],
    };
  }

  return {
    api: `${parsed.origin}${rawPath}`,
    version: "1",
  };
}

function resolveAuthPrefix(authScheme?: string): "Bot" | "Bearer" {
  const normalized = (authScheme ?? "bot").trim().toLowerCase();
  if (normalized === "bearer") {
    return "Bearer";
  }
  return "Bot";
}

function createCoreClient(config: FluxerClientConfig): Client {
  const { api, version } = resolveRestApiAndVersion(config.baseUrl);
  const client = new Client({
    intents: 0,
    rest: {
      api,
      version,
      authPrefix: resolveAuthPrefix(config.authScheme),
    },
  });
  client.rest.setToken(config.apiToken);
  return client;
}

async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return work;
  }

  const timeoutController = new AbortController();
  if (abortSignal) {
    if (abortSignal.aborted) {
      timeoutController.abort();
    } else {
      abortSignal.addEventListener("abort", () => timeoutController.abort(), { once: true });
    }
  }

  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      timeoutController.abort();
      reject(new Error(`Fluxer request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    work
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function parseTarget(to: string): { kind: "channel" | "group" | "user"; id: string } {
  const trimmed = to.trim();
  const index = trimmed.indexOf(":");
  if (index <= 0) {
    return { kind: "channel", id: trimmed };
  }
  const kind = trimmed.slice(0, index).toLowerCase();
  const id = trimmed.slice(index + 1).trim();
  if (kind === "user") return { kind: "user", id };
  if (kind === "group") return { kind: "group", id };
  return { kind: "channel", id };
}

function resolveChatType(message: Message): "direct" | "group" | "channel" {
  const channel = message.channel;
  if (channel?.isDM()) {
    // Group DM channels usually have a name; 1:1 DM channels usually do not.
    return channel.name ? "group" : "direct";
  }
  return "channel";
}

function attachmentUrls(message: Message): string[] {
  return Array.from(message.attachments.values())
    .map((attachment) => (typeof attachment.url === "string" ? attachment.url.trim() : ""))
    .filter(Boolean);
}

function formatError(error: unknown): FluxerApiError {
  if (error instanceof Error && "errorClass" in error) {
    return error as FluxerApiError;
  }
  const status = getStatusCode(error);
  const errorClass = classifyError(error);
  const retryAfterMs = getRetryAfterMs(error);
  return createFluxerApiError(
    error instanceof Error ? error.message : String(error),
    status,
    errorClass,
    retryAfterMs,
  );
}

// ---------------------------------------------------------------------------
// Main client factory
// ---------------------------------------------------------------------------

export function createFluxerClient(config: FluxerClientConfig): FluxerClient {
  return {
    sendText: async (input) => {
      const body = input.text.trim();
      if (!body) {
        throw new Error("Fluxer sendText requires non-empty text");
      }

      return withRetry(
        async () => {
          const client = createCoreClient(config);
          try {
            const target = parseTarget(input.target);

            if (target.kind === "user") {
              const user = await client.users.fetch(target.id);
              const dm = await user.createDM();
              let sent;
              if (input.replyToId) {
                try {
                  const original = await client.fetchMessage(dm.id, input.replyToId);
                  sent = await original.reply(body);
                } catch {
                  sent = await dm.send(body);
                }
              } else {
                sent = await dm.send(body);
              }
              return {
                messageId: sent.id,
                chatId: sent.channelId,
                timestamp: sent.createdAt?.getTime?.(),
              };
            }

            const channelId = target.id;
            let sent;
            if (input.replyToId) {
              try {
                const original = await client.fetchMessage(channelId, input.replyToId);
                sent = await original.reply(body);
              } catch {
                sent = await client.channels.send(channelId, body);
              }
            } else {
              sent = await client.channels.send(channelId, body);
            }

            return {
              messageId: sent.id,
              chatId: sent.channelId,
              timestamp: sent.createdAt?.getTime?.(),
            };
          } catch (error) {
            throw formatError(error);
          } finally {
            await client.destroy().catch(() => undefined);
          }
        },
        { abortSignal: input.abortSignal },
      );
    },

    react: async (input) => {
      const channelId = input.channelId.trim();
      const messageId = input.messageId.trim();
      const emoji = input.emoji.trim();
      if (!channelId) {
        throw new Error("Fluxer react requires channelId");
      }
      if (!messageId) {
        throw new Error("Fluxer react requires messageId");
      }
      if (!emoji) {
        throw new Error("Fluxer react requires emoji");
      }

      return withRetry(
        async () => {
          const client = createCoreClient(config);
          try {
            const message = await client.fetchMessage(channelId, messageId);
            if (input.remove) {
              await message.removeReaction(emoji);
            } else {
              await message.react(emoji);
            }
          } catch (error) {
            throw formatError(error);
          } finally {
            await client.destroy().catch(() => undefined);
          }
        },
        { abortSignal: input.abortSignal },
      );
    },

    probe: async ({ timeoutMs, abortSignal }) => {
      const startedAt = Date.now();
      const client = createCoreClient(config);
      try {
        const me = await withTimeout(
          client.rest.get<{
            id?: string;
            username?: string;
            global_name?: string;
            display_name?: string;
          }>("/users/@me"),
          timeoutMs,
          abortSignal,
        );

        return {
          ok: true,
          error: null,
          checkedAt: Date.now(),
          latencyMs: Date.now() - startedAt,
          mode: "live",
          botId: me.id,
          botName: me.display_name ?? me.global_name ?? me.username,
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          checkedAt: Date.now(),
          latencyMs: Date.now() - startedAt,
          mode: "live",
        };
      } finally {
        await client.destroy().catch(() => undefined);
      }
    },

    monitorInbound: async ({ abortSignal, onEvent, onConnected, onDisconnected }) => {
      const client = createCoreClient(config);

      const messageCreateHandler = (message: Message) => {
        const rawEvent = {
          type: "message-create",
          data: {
            messageId: message.id,
            chatId: message.channelId,
            chatType: resolveChatType(message),
            senderId: message.author.id,
            senderName: message.author.globalName ?? message.author.username,
            text: message.content ?? "",
            timestamp: message.createdAt?.getTime?.() ?? Date.now(),
            attachments: attachmentUrls(message).map((url) => ({ url })),
          },
        };
        return Promise.resolve(onEvent(rawEvent));
      };

      const messageUpdateHandler = (_oldMessage: Message | null, newMessage: Message) => {
        const rawEvent = {
          type: "message-update",
          data: {
            messageId: newMessage.id,
            chatId: newMessage.channelId,
            text: newMessage.content ?? "",
            timestamp: newMessage.editedAt?.getTime?.() ?? Date.now(),
          },
        };
        return Promise.resolve(onEvent(rawEvent));
      };

      const messageDeleteHandler = (deleted: PartialMessage) => {
        const rawEvent = {
          type: "message-delete",
          data: {
            messageId: deleted.id,
            chatId: deleted.channelId,
            timestamp: Date.now(),
          },
        };
        return Promise.resolve(onEvent(rawEvent));
      };

      const reactionAddHandler = (
        _reaction: unknown,
        _user: unknown,
        messageId: string,
        channelId: string,
        emoji: { name?: string; id?: string } | string,
        userId: string,
      ) => {
        const emojiValue =
          typeof emoji === "string" ? emoji : emoji.id ? `${emoji.name ?? "emoji"}:${emoji.id}` : emoji.name;
        const rawEvent = {
          type: "reaction-add",
          data: {
            messageId,
            chatId: channelId,
            userId,
            emoji: emojiValue ?? null,
            timestamp: Date.now(),
          },
        };
        return Promise.resolve(onEvent(rawEvent));
      };

      client.on(Events.MessageCreate, (message) => {
        void messageCreateHandler(message).catch(() => undefined);
      });
      client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
        void messageUpdateHandler(oldMessage, newMessage).catch(() => undefined);
      });
      client.on(Events.MessageDelete, (deleted) => {
        void messageDeleteHandler(deleted).catch(() => undefined);
      });
      client.on(Events.MessageReactionAdd, (reaction, user, messageId, channelId, emoji, userId) => {
        void reactionAddHandler(reaction, user, messageId, channelId, emoji, userId).catch(
          () => undefined,
        );
      });

      let connectionError: unknown = null;
      let connectionErrorMessage: string | undefined;
      const onError = (error: unknown) => {
        connectionError = error;
        connectionErrorMessage = error instanceof Error ? error.message : String(error);
      };
      client.on(Events.Error, onError);

      try {
        await client.login(config.apiToken);
        onConnected?.();

        await Promise.race([
          waitForAbort(abortSignal),
          new Promise<void>((_, reject) => {
            const timer = setInterval(() => {
              if (connectionError) {
                clearInterval(timer);
                reject(connectionError);
              }
            }, 250);
            abortSignal.addEventListener(
              "abort",
              () => {
                clearInterval(timer);
              },
              { once: true },
            );
          }),
        ]);
      } finally {
        const disconnectReason = abortSignal.aborted ? "aborted" : connectionErrorMessage;
        onDisconnected?.({ reason: disconnectReason });
        await client.destroy().catch(() => undefined);
      }
    },
  };
}
