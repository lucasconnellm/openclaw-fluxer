import type {
  ChannelAccountSnapshot,
  ChatType,
  OpenClawConfig,
  ReplyPayload,
  RuntimeEnv,
} from "openclaw/plugin-sdk";
import {
  buildAgentMediaPayload,
  createDedupeCache,
  createReplyPrefixOptions,
  createTypingCallbacks,
  logInboundDrop,
  logTypingFailure,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  recordPendingHistoryEntryIfEnabled,
  resolveControlCommandGate,
  formatErrorMessage,
  type HistoryEntry,
} from "openclaw/plugin-sdk";
import { resolveFluxerAccount } from "./accounts.js";
import { createFluxerClient, type FluxerClient, type FluxerClientConfig } from "./client.js";
import {
  normalizeFluxerInboundEvent,
  type FluxerNormalizedMessageCreateEvent,
} from "./normalize.js";
import { getFluxerRuntime } from "./runtime.js";
import { sendMessageFluxer } from "./send.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MonitorFluxerOpts = {
  accountId?: string;
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
  createClient?: (config: FluxerClientConfig) => FluxerClient;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_RECONNECT = {
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  maxAttempts: 0,
  jitterRatio: 0.2,
} as const;

const RECENT_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_MESSAGE_MAX = 2000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveRuntime(opts: MonitorFluxerOpts): RuntimeEnv {
  return (
    opts.runtime ?? {
      log: console.log,
      error: console.error,
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    }
  );
}

function randomJitter(delayMs: number, jitterRatio: number): number {
  if (!jitterRatio) return delayMs;
  const delta = delayMs * jitterRatio;
  const offset = (Math.random() * 2 - 1) * delta;
  return Math.max(250, Math.round(delayMs + offset));
}

export function computeReconnectDelayMs(params: {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}): number {
  const exp = Math.min(params.attempt - 1, 8);
  const base = Math.min(params.maxDelayMs, params.baseDelayMs * 2 ** exp);
  return randomJitter(base, params.jitterRatio);
}

async function sleepWithAbort(ms: number, abortSignal: AbortSignal): Promise<void> {
  if (ms <= 0 || abortSignal.aborted) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) return "";
  if (trimmed === "*") return "*";
  return trimmed
    .replace(/^(fluxer|user):/i, "")
    .replace(/^@/, "")
    .toLowerCase();
}

function normalizeAllowList(entries: Array<string | number>): string[] {
  const normalized = entries.map((entry) => normalizeAllowEntry(String(entry))).filter(Boolean);
  return Array.from(new Set(normalized));
}

function isSenderAllowed(params: {
  senderId: string;
  senderName?: string;
  allowFrom: string[];
}): boolean {
  const { allowFrom } = params;
  if (allowFrom.length === 0) return false;
  if (allowFrom.includes("*")) return true;
  const normalizedId = normalizeAllowEntry(params.senderId);
  const normalizedName = params.senderName ? normalizeAllowEntry(params.senderName) : "";
  return allowFrom.some(
    (entry) => entry === normalizedId || (normalizedName && entry === normalizedName),
  );
}

function resolveThreadSessionKeys(params: {
  baseSessionKey: string;
  threadId?: string | null;
  parentSessionKey?: string;
}): { sessionKey: string; parentSessionKey?: string } {
  const threadId = (params.threadId ?? "").trim();
  if (!threadId) {
    return { sessionKey: params.baseSessionKey, parentSessionKey: undefined };
  }
  return {
    sessionKey: `${params.baseSessionKey}:thread:${threadId}`,
    parentSessionKey: params.parentSessionKey,
  };
}

function formatInboundFromLabel(params: {
  isGroup: boolean;
  groupLabel?: string;
  groupId?: string;
  directLabel: string;
  directId?: string;
}): string {
  if (params.isGroup) {
    const label = params.groupLabel?.trim() || "Group";
    const id = params.groupId?.trim();
    return id ? `${label} id:${id}` : label;
  }
  const directLabel = params.directLabel.trim();
  const directId = params.directId?.trim();
  if (!directId || directId === directLabel) return directLabel;
  return `${directLabel} id:${directId}`;
}

// ---------------------------------------------------------------------------
// Monitor implementation
// ---------------------------------------------------------------------------

export async function monitorFluxerProvider(opts: MonitorFluxerOpts = {}): Promise<void> {
  const core = getFluxerRuntime();
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? core.config.loadConfig();
  const abortSignal = opts.abortSignal ?? new AbortController().signal;
  const account = resolveFluxerAccount({
    cfg,
    accountId: opts.accountId,
  });

  const apiToken = account.apiToken?.trim();
  const baseUrl = account.baseUrl?.trim();
  if (!apiToken || !baseUrl) {
    throw new Error(
      `Fluxer not configured for account "${account.accountId}" (missing apiToken or baseUrl)`,
    );
  }

  const logger = core.logging.getChildLogger({ module: "fluxer" });
  const logVerbose = (message: string) => {
    if (!core.logging.shouldLogVerbose()) return;
    logger.debug?.(message);
  };

  const clientFactory = opts.createClient ?? createFluxerClient;

  const reconnectConfig = {
    baseDelayMs: account.config.reconnect?.baseDelayMs ?? DEFAULT_RECONNECT.baseDelayMs,
    maxDelayMs: account.config.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT.maxDelayMs,
    maxAttempts: account.config.reconnect?.maxAttempts ?? DEFAULT_RECONNECT.maxAttempts,
    jitterRatio: account.config.reconnect?.jitterRatio ?? DEFAULT_RECONNECT.jitterRatio,
  };

  // Dedupe cache
  const recentMessages = createDedupeCache({
    ttlMs: RECENT_MESSAGE_TTL_MS,
    maxSize: RECENT_MESSAGE_MAX,
  });

  // History tracking for group contexts
  const historyLimit = Math.max(
    0,
    cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const channelHistories = new Map<string, HistoryEntry[]>();

  // Debouncer
  const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "fluxer",
  });
  const debouncer = core.channel.debounce.createInboundDebouncer<{
    event: FluxerNormalizedMessageCreateEvent;
  }>({
    debounceMs: inboundDebounceMs,
    buildKey: (entry) => {
      const threadKey = "channel"; // TODO(fluxer-threads): support thread-level debounce keys
      return `fluxer:${account.accountId}:${entry.event.chatId}:${threadKey}`;
    },
    shouldDebounce: (entry) => {
      const text = entry.event.text.trim();
      if (!text) return false;
      return !core.channel.text.hasControlCommand(text, cfg);
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) return;
      if (entries.length === 1) {
        await handleInboundMessage(last.event);
        return;
      }
      // Merge debounced text burst into a single dispatch
      const combinedText = entries
        .map((e) => e.event.text.trim())
        .filter(Boolean)
        .join("\n");
      const mergedEvent: FluxerNormalizedMessageCreateEvent = {
        ...last.event,
        text: combinedText,
      };
      await handleInboundMessage(mergedEvent);
    },
    onError: (err) => {
      runtime.error?.(`fluxer debounce flush failed: ${String(err)}`);
    },
  });

  async function handleInboundMessage(event: FluxerNormalizedMessageCreateEvent): Promise<void> {
    const {
      messageId,
      chatId,
      chatType: evtChatType,
      senderId,
      senderName,
      text,
      mediaUrls,
    } = event;

    // Dedupe
    const dedupeKey = `${account.accountId}:${messageId}`;
    if (recentMessages.check(dedupeKey)) {
      logVerbose(`fluxer: drop duplicate message ${messageId}`);
      return;
    }

    const kind: ChatType =
      evtChatType === "direct" ? "direct" : evtChatType === "group" ? "group" : "channel";
    const chatTypeStr: "direct" | "group" | "channel" = kind;

    // Policy resolution
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
    const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";

    const configAllowFrom = normalizeAllowList(account.config.allowFrom ?? []);
    const configGroupAllowFrom = normalizeAllowList(account.config.groupAllowFrom ?? []);
    const storeAllowFrom = normalizeAllowList(
      await core.channel.pairing.readAllowFromStore("fluxer").catch(() => []),
    );
    const effectiveAllowFrom = Array.from(new Set([...configAllowFrom, ...storeAllowFrom]));
    const effectiveGroupAllowFrom = Array.from(
      new Set([
        ...(configGroupAllowFrom.length > 0 ? configGroupAllowFrom : configAllowFrom),
        ...storeAllowFrom,
      ]),
    );

    // Command gate
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "fluxer",
    });
    const hasControlCommand = core.channel.text.hasControlCommand(text, cfg);
    const isControlCommand = allowTextCommands && hasControlCommand;
    const useAccessGroups = cfg.commands?.useAccessGroups !== false;
    const senderAllowedForCommands = isSenderAllowed({
      senderId,
      senderName,
      allowFrom: effectiveAllowFrom,
    });
    const groupAllowedForCommands = isSenderAllowed({
      senderId,
      senderName,
      allowFrom: effectiveGroupAllowFrom,
    });
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: effectiveAllowFrom.length > 0, allowed: senderAllowedForCommands },
        { configured: effectiveGroupAllowFrom.length > 0, allowed: groupAllowedForCommands },
      ],
      allowTextCommands,
      hasControlCommand,
    });
    const commandAuthorized =
      kind === "direct"
        ? dmPolicy === "open" || senderAllowedForCommands
        : commandGate.commandAuthorized;

    // ---- DM policy ----
    if (kind === "direct") {
      if (dmPolicy === "disabled") {
        logInboundDrop({
          log: logVerbose,
          channel: "fluxer",
          reason: "dmPolicy=disabled",
          target: senderId,
        });
        return;
      }
      if (dmPolicy !== "open" && !senderAllowedForCommands) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "fluxer",
            id: senderId,
            meta: { name: senderName },
          });
          logVerbose(`fluxer: pairing request sender=${senderId} created=${created}`);
          if (created) {
            try {
              await sendMessageFluxer(
                `user:${senderId}`,
                core.channel.pairing.buildPairingReply({
                  channel: "fluxer",
                  idLine: `Your Fluxer user id: ${senderId}`,
                  code,
                }),
                { accountId: account.accountId },
              );
              opts.statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerbose(`fluxer: pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
        } else {
          logInboundDrop({
            log: logVerbose,
            channel: "fluxer",
            reason: `dmPolicy=${dmPolicy}`,
            target: senderId,
          });
        }
        return;
      }
    }

    // ---- Group policy ----
    if (kind !== "direct") {
      if (groupPolicy === "disabled") {
        logInboundDrop({
          log: logVerbose,
          channel: "fluxer",
          reason: "groupPolicy=disabled",
          target: chatId,
        });
        return;
      }
      if (groupPolicy === "allowlist") {
        if (effectiveGroupAllowFrom.length === 0) {
          logInboundDrop({
            log: logVerbose,
            channel: "fluxer",
            reason: "groupPolicy=allowlist (empty list)",
            target: chatId,
          });
          return;
        }
        if (!groupAllowedForCommands) {
          logInboundDrop({
            log: logVerbose,
            channel: "fluxer",
            reason: "sender not in groupAllowFrom",
            target: senderId,
          });
          return;
        }
      }
    }

    // ---- Control command gate (non-DM) ----
    if (kind !== "direct" && commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerbose,
        channel: "fluxer",
        reason: "control command (unauthorized)",
        target: senderId,
      });
      return;
    }

    // ---- Routing ----
    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "fluxer",
      accountId: account.accountId,
      peer: {
        kind,
        id: kind === "direct" ? senderId : chatId,
      },
    });

    const baseSessionKey = route.sessionKey;
    const threadKeys = resolveThreadSessionKeys({
      baseSessionKey,
      // TODO(fluxer-threads): extract threadId from event when available
    });
    const sessionKey = threadKeys.sessionKey;
    const historyKey = kind === "direct" ? null : sessionKey;

    // ---- Mention gating ----
    const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
    const wasMentioned =
      kind !== "direct" && core.channel.mentions.matchesMentionPatterns(text, mentionRegexes);

    const shouldRequireMention =
      kind !== "direct" &&
      core.channel.groups.resolveRequireMention({
        cfg,
        channel: "fluxer",
        accountId: account.accountId,
        groupId: chatId,
      });
    const shouldBypassMention =
      isControlCommand && shouldRequireMention && !wasMentioned && commandAuthorized;
    const effectiveWasMentioned = wasMentioned || shouldBypassMention;
    const canDetectMention = mentionRegexes.length > 0;

    const recordPendingHistory = () => {
      const trimmed = text.trim();
      recordPendingHistoryEntryIfEnabled({
        historyMap: channelHistories,
        limit: historyLimit,
        historyKey: historyKey ?? "",
        entry:
          historyKey && trimmed
            ? {
                sender: senderName ?? senderId,
                body: trimmed,
                timestamp: event.timestamp,
                messageId,
              }
            : null,
      });
    };

    if (kind !== "direct" && shouldRequireMention && canDetectMention) {
      if (!effectiveWasMentioned) {
        recordPendingHistory();
        return;
      }
    }

    // ---- Build context ----
    const bodyText = text.trim();
    if (!bodyText && mediaUrls.length === 0) return;

    // Record inbound activity
    core.channel.activity.record({
      channel: "fluxer",
      accountId: account.accountId,
      direction: "inbound",
    });

    opts.statusSink?.({
      lastInboundAt: Date.now(),
      lastMessageAt: event.timestamp,
    });

    const fromLabel = formatInboundFromLabel({
      isGroup: kind !== "direct",
      groupLabel: chatId,
      groupId: chatId,
      directLabel: senderName ?? senderId,
      directId: senderId,
    });

    const to = kind === "direct" ? `user:${senderId}` : `channel:${chatId}`;

    // System event
    const preview = bodyText.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel =
      kind === "direct"
        ? `Fluxer DM from ${senderName ?? senderId}`
        : `Fluxer message in ${chatId} from ${senderName ?? senderId}`;
    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey,
      contextKey: `fluxer:message:${chatId}:${messageId}`,
    });

    const textWithId = `${bodyText}\n[fluxer message id: ${messageId} channel: ${chatId}]`;
    const body = core.channel.reply.formatInboundEnvelope({
      channel: "Fluxer",
      from: fromLabel,
      timestamp: event.timestamp,
      body: textWithId,
      chatType: chatTypeStr,
      sender: { name: senderName ?? senderId, id: senderId },
    });

    let combinedBody = body;
    if (historyKey) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: channelHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          core.channel.reply.formatInboundEnvelope({
            channel: "Fluxer",
            from: fromLabel,
            timestamp: entry.timestamp,
            body: `${entry.body}${
              entry.messageId ? ` [id:${entry.messageId} channel:${chatId}]` : ""
            }`,
            chatType: chatTypeStr,
            senderLabel: entry.sender,
          }),
      });
    }

    const mediaPayload = buildAgentMediaPayload(mediaUrls.map((path) => ({ path })));
    const inboundHistory =
      historyKey && historyLimit > 0
        ? (channelHistories.get(historyKey) ?? []).map((entry) => ({
            sender: entry.sender,
            body: entry.body,
            timestamp: entry.timestamp,
          }))
        : undefined;

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: bodyText,
      InboundHistory: inboundHistory,
      RawBody: bodyText,
      CommandBody: bodyText,
      From:
        kind === "direct"
          ? `fluxer:${senderId}`
          : kind === "group"
            ? `fluxer:group:${chatId}`
            : `fluxer:channel:${chatId}`,
      To: to,
      SessionKey: sessionKey,
      ParentSessionKey: threadKeys.parentSessionKey,
      AccountId: route.accountId,
      ChatType: chatTypeStr,
      ConversationLabel: fromLabel,
      GroupSubject: kind !== "direct" ? chatId : undefined,
      GroupChannel: kind !== "direct" ? `#${chatId}` : undefined,
      SenderName: senderName ?? senderId,
      SenderId: senderId,
      Provider: "fluxer" as const,
      Surface: "fluxer" as const,
      MessageSid: messageId,
      Timestamp: event.timestamp,
      WasMentioned: kind !== "direct" ? effectiveWasMentioned : undefined,
      CommandAuthorized: commandAuthorized,
      OriginatingChannel: "fluxer" as const,
      OriginatingTo: to,
      ...mediaPayload,
    });

    // Update last route for DMs
    if (kind === "direct") {
      const sessionCfg = cfg.session;
      const storePath = core.channel.session.resolveStorePath(sessionCfg?.store, {
        agentId: route.agentId,
      });
      await core.channel.session.updateLastRoute({
        storePath,
        sessionKey: route.mainSessionKey,
        deliveryContext: {
          channel: "fluxer",
          to,
          accountId: route.accountId,
        },
      });
    }

    logVerbose(
      `fluxer inbound: from=${ctxPayload.From} len=${bodyText.length} preview="${bodyText.slice(0, 200).replace(/\n/g, "\\n")}"`,
    );

    // ---- Dispatch ----
    const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "fluxer", account.accountId, {
      fallbackLimit: account.config.textChunkLimit ?? 4000,
    });
    const tableMode = core.channel.text.resolveMarkdownTableMode({
      cfg,
      channel: "fluxer",
      accountId: account.accountId,
    });

    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: route.agentId,
      channel: "fluxer",
      accountId: account.accountId,
    });

    const typingCallbacks = createTypingCallbacks({
      start: async () => undefined,
      onStartError: (err) => {
        logTypingFailure({
          log: (message) => logger.debug?.(message),
          channel: "fluxer",
          target: chatId,
          error: err,
        });
      },
    });

    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        ...prefixOptions,
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
        deliver: async (payload: ReplyPayload) => {
          const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
          const replyText = core.channel.text.convertMarkdownTables(payload.text ?? "", tableMode);

          if (mediaUrls.length === 0) {
            const chunkMode = core.channel.text.resolveChunkMode(cfg, "fluxer", account.accountId);
            const chunks = core.channel.text.chunkMarkdownTextWithMode(
              replyText,
              textLimit,
              chunkMode,
            );
            for (const chunk of chunks.length > 0 ? chunks : [replyText]) {
              if (!chunk) continue;
              await sendMessageFluxer(to, chunk, {
                accountId: account.accountId,
              });
            }
          } else {
            let first = true;
            for (const mediaUrl of mediaUrls) {
              const caption = first ? replyText : "";
              first = false;
              const message = mediaUrl ? `${caption}\n\nAttachment: ${mediaUrl}` : caption;
              await sendMessageFluxer(to, message, {
                accountId: account.accountId,
              });
            }
          }
          runtime.log?.(`delivered reply to ${to}`);
        },
        onError: (err, info) => {
          runtime.error?.(`fluxer ${info.kind} reply failed: ${String(err)}`);
        },
        onReplyStart: typingCallbacks.onReplyStart,
      });

    await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        onModelSelected,
      },
    });
    markDispatchIdle();

    if (historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: channelHistories,
        historyKey,
        limit: historyLimit,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Reconnect loop with @fluxerjs/core-backed monitor
  // -------------------------------------------------------------------------

  let reconnectAttempts = 0;

  while (!abortSignal.aborted) {
    const client = clientFactory({
      accountId: account.accountId,
      baseUrl,
      apiToken,
      authScheme: account.config.authScheme,
    });

    try {
      logger.info(`[${account.accountId}] Fluxer monitor connecting`);

      await client.monitorInbound({
        accountId: account.accountId,
        abortSignal,
        onConnected: () => {
          reconnectAttempts = 0;
          opts.statusSink?.({
            connected: true,
            reconnectAttempts: 0,
            lastError: null,
          });
          logger.info(`[${account.accountId}] Fluxer monitor connected`);
        },
        onDisconnected: (info) => {
          opts.statusSink?.({
            connected: false,
            lastDisconnect: {
              at: Date.now(),
              error: info?.reason,
            },
          });
          logVerbose(`[${account.accountId}] Fluxer disconnected: reason=${info?.reason}`);
        },
        onEvent: async (raw) => {
          const normalized = normalizeFluxerInboundEvent(raw);
          if (!normalized) return;

          logVerbose(
            `[${account.accountId}] normalized inbound ${normalized.kind} ${normalized.messageId} (${normalized.chatId})`,
          );

          await debouncer.enqueue({ event: normalized });
        },
      });

      if (abortSignal.aborted) break;
      throw new Error("Fluxer inbound monitor disconnected");
    } catch (error) {
      if (abortSignal.aborted) break;

      reconnectAttempts += 1;
      const maxAttempts = reconnectConfig.maxAttempts;
      const message = formatErrorMessage(error);
      opts.statusSink?.({
        connected: false,
        reconnectAttempts,
        lastError: message,
        lastDisconnect: {
          at: Date.now(),
          error: message,
        },
      });

      logger.warn(
        `[${account.accountId}] Fluxer monitor disconnected (attempt ${reconnectAttempts}${maxAttempts ? `/${maxAttempts}` : ""}): ${message}`,
      );

      if (maxAttempts > 0 && reconnectAttempts >= maxAttempts) {
        throw new Error(
          `Fluxer monitor exceeded reconnect maxAttempts=${maxAttempts} for account ${account.accountId}`,
        );
      }

      const delayMs = computeReconnectDelayMs({
        attempt: reconnectAttempts,
        baseDelayMs: reconnectConfig.baseDelayMs,
        maxDelayMs: reconnectConfig.maxDelayMs,
        jitterRatio: reconnectConfig.jitterRatio,
      });

      try {
        await sleepWithAbort(delayMs, abortSignal);
      } catch {
        break;
      }
    }
  }

  opts.statusSink?.({ connected: false });
  runtime.log?.(`fluxer monitor stopped for account ${account.accountId}`);
}
