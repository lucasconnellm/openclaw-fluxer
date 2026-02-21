import {
  applyAccountNameToChannelSection,
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import {
  listFluxerAccountIds,
  resolveDefaultFluxerAccountId,
  resolveFluxerAccount,
  type ResolvedFluxerAccount,
} from "./accounts.js";
import { FluxerConfigSchema } from "./config-schema.js";
import { monitorFluxerProvider } from "./monitor.js";
import { looksLikeFluxerTargetId, normalizeFluxerMessagingTarget } from "./normalize.js";
import { probeFluxer } from "./probe.js";
import { getFluxerRuntime } from "./runtime.js";
import { sendMediaFluxer, sendMessageFluxer, sendReactionFluxer } from "./send.js";
import {
  voiceJoinFluxer,
  voiceLeaveFluxer,
  voiceStatusFluxer,
  voiceSubscribeFluxer,
  voiceUnsubscribeFluxer,
} from "./voice.js";

const meta = {
  id: "fluxer",
  label: "Fluxer",
  selectionLabel: "Fluxer (@fluxerjs/core)",
  detailLabel: "Fluxer Bot",
  docsPath: "/channels/fluxer",
  docsLabel: "fluxer",
  blurb: "Fluxer channel integration powered by @fluxerjs/core.",
  aliases: ["fx"],
  systemImage: "arrow.triangle.2.circlepath",
  order: 75,
  quickstartAllowFrom: true,
};

function normalizeAllowEntry(entry: string): string {
  return entry
    .trim()
    .replace(/^(fluxer|user):/i, "")
    .toLowerCase();
}

const fluxerMessageActions: ChannelMessageActionAdapter = {
  listActions: () => ["react", "voice-status"],
  supportsAction: ({ action }) => action === "react" || action === "voice-status",
  handleAction: async ({ action, params, accountId }) => {
    if (action !== "react" && action !== "voice-status") {
      throw new Error(`Fluxer action ${action} not supported`);
    }

    if (action === "voice-status") {
      const guildId = typeof params.guildId === "string" ? params.guildId.trim() : "";
      const userId = typeof params.userId === "string" ? params.userId.trim() : "";
      const mode = typeof params.mode === "string" ? params.mode.trim().toLowerCase() : "status";
      const channelId = typeof params.channelId === "string" ? params.channelId.trim() : "";

      if (!guildId) {
        throw new Error("Fluxer voice-status requires guildId");
      }

      if (mode === "join") {
        if (!channelId) {
          throw new Error("Fluxer voice join requires channelId");
        }
        const result = await voiceJoinFluxer({
          guildId,
          channelId,
          accountId: accountId ?? undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Joined voice channel ${result.channelId} in guild ${result.guildId}`,
            },
          ],
          details: result,
        };
      }

      if (mode === "leave") {
        const result = await voiceLeaveFluxer({
          guildId,
          accountId: accountId ?? undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Left voice channel in guild ${result.guildId}`,
            },
          ],
          details: result,
        };
      }

      if (mode === "subscribe") {
        if (!channelId) {
          throw new Error("Fluxer voice subscribe requires channelId");
        }
        if (!userId) {
          throw new Error("Fluxer voice subscribe requires userId");
        }
        const result = await voiceSubscribeFluxer({
          guildId,
          channelId,
          userId,
          accountId: accountId ?? undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Subscribed to ${result.userId} in ${result.channelId}. Active: ${result.activeSubscriptions.join(", ") || "none"}`,
            },
          ],
          details: result,
        };
      }

      if (mode === "unsubscribe") {
        if (!channelId) {
          throw new Error("Fluxer voice unsubscribe requires channelId");
        }
        if (!userId) {
          throw new Error("Fluxer voice unsubscribe requires userId");
        }
        const result = await voiceUnsubscribeFluxer({
          guildId,
          channelId,
          userId,
          accountId: accountId ?? undefined,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Unsubscribed ${result.userId} in ${result.channelId}. Active: ${result.activeSubscriptions.join(", ") || "none"}`,
            },
          ],
          details: result,
        };
      }

      if (!userId) {
        throw new Error("Fluxer voice-status requires userId for status mode");
      }

      const result = await voiceStatusFluxer({
        guildId,
        userId,
        accountId: accountId ?? undefined,
      });

      const location = result.voiceChannelId
        ? `${result.voiceChannelName ?? result.voiceChannelId} (${result.voiceChannelId})`
        : "not in voice";

      return {
        content: [
          {
            type: "text" as const,
            text: `User ${result.userId} voice: ${location}; botConnected=${result.botConnected}`,
          },
        ],
        details: result,
      };
    }

    const toRaw =
      typeof params.to === "string"
        ? params.to
        : typeof params.chatId === "string"
          ? params.chatId
          : typeof params.channelId === "string"
            ? params.channelId
            : "";
    const to = toRaw.trim();
    if (!to) {
      throw new Error("Fluxer react requires to/channelId/chatId target");
    }

    const messageId = typeof params.messageId === "string" ? params.messageId.trim() : "";
    if (!messageId) {
      throw new Error("Fluxer react requires messageId");
    }

    const emoji = typeof params.emoji === "string" ? params.emoji.trim() : "";
    if (!emoji) {
      throw new Error("Fluxer react requires emoji");
    }

    const remove = params.remove === true;
    const result = await sendReactionFluxer(
      {
        to,
        messageId,
        emoji,
        remove,
      },
      {
        accountId: accountId ?? undefined,
      },
    );

    return {
      content: [
        {
          type: "text" as const,
          text: remove
            ? `Removed reaction ${emoji} from ${messageId}`
            : `Reacted with ${emoji} on ${messageId}`,
        },
      ],
      details: result.meta,
    };
  },
};

export const fluxerPlugin: ChannelPlugin<ResolvedFluxerAccount> = {
  id: "fluxer",
  meta,
  pairing: {
    idLabel: "fluxerUserId",
    normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
    notifyApproval: async ({ id }) => {
      console.log(`[fluxer] User ${id} approved for pairing`);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group", "channel"],
    reactions: true,
    threads: false,
    media: true,
    nativeCommands: false,
  },
  reload: { configPrefixes: ["channels.fluxer"] },
  configSchema: buildChannelConfigSchema(FluxerConfigSchema),
  config: {
    listAccountIds: (cfg) => listFluxerAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveFluxerAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultFluxerAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "fluxer",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "fluxer",
        accountId,
        clearBaseFields: ["apiToken", "baseUrl", "name"],
      }),
    isConfigured: (account) => Boolean(account.apiToken?.trim() && account.baseUrl?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.apiToken?.trim() && account.baseUrl?.trim()),
      tokenSource: account.tokenSource,
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveFluxerAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => normalizeAllowEntry(String(entry))).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.fluxer?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.fluxer.accounts.${resolvedAccountId}.`
        : "channels.fluxer.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("fluxer"),
        normalizeEntry: (raw) => normalizeAllowEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- Fluxer groups: groupPolicy="open" allows any group participant to trigger. Set channels.fluxer.groupPolicy="allowlist" + channels.fluxer.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  messaging: {
    normalizeTarget: normalizeFluxerMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeFluxerTargetId,
      hint: "<channelId|user:ID|group:ID>",
    },
  },
  actions: fluxerMessageActions,
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "fluxer",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "FLUXER_API_TOKEN can only be used for the default account.";
      }
      if (!input.useEnv && (!input.token || !input.httpUrl)) {
        return "Fluxer requires token and --http-url (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "fluxer",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "fluxer",
            })
          : namedConfig;

      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            fluxer: {
              ...next.channels?.fluxer,
              enabled: true,
              ...(input.useEnv
                ? {}
                : {
                    ...(input.token ? { apiToken: input.token } : {}),
                    ...(input.httpUrl ? { baseUrl: input.httpUrl } : {}),
                  }),
            },
          },
        };
      }

      return {
        ...next,
        channels: {
          ...next.channels,
          fluxer: {
            ...next.channels?.fluxer,
            enabled: true,
            accounts: {
              ...next.channels?.fluxer?.accounts,
              [accountId]: {
                ...next.channels?.fluxer?.accounts?.[accountId],
                enabled: true,
                ...(input.token ? { apiToken: input.token } : {}),
                ...(input.httpUrl ? { baseUrl: input.httpUrl } : {}),
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getFluxerRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    resolveTarget: ({ to }) => {
      const normalized = to ? normalizeFluxerMessagingTarget(to) : undefined;
      if (!normalized) {
        return {
          ok: false,
          error: new Error(
            "Delivering to Fluxer requires --to <channelId|user:ID|group:ID|channel:ID>",
          ),
        };
      }
      return { ok: true, to: normalized };
    },
    sendText: async ({ to, text, accountId }) => {
      const result = await sendMessageFluxer(to, text, {
        accountId: accountId ?? undefined,
      });
      return { channel: "fluxer", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }) => {
      if (!mediaUrl) {
        const result = await sendMessageFluxer(to, text, {
          accountId: accountId ?? undefined,
          replyToId: replyToId ?? undefined,
        });
        return { channel: "fluxer", ...result };
      }
      const result = await sendMediaFluxer(
        {
          to,
          text,
          mediaUrl,
        },
        {
          accountId: accountId ?? undefined,
          replyToId: replyToId ?? undefined,
        },
      );
      return { channel: "fluxer", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      reconnectAttempts: 0,
      lastDisconnect: null,
    },
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("fluxer", accounts),
    buildChannelSummary: ({ snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      connected: snapshot.connected ?? false,
      reconnectAttempts: snapshot.reconnectAttempts ?? 0,
      tokenSource: snapshot.tokenSource ?? "none",
      baseUrl: snapshot.baseUrl ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeFluxer(account.baseUrl, account.apiToken, timeoutMs, {
        accountId: account.accountId,
        authScheme: account.config.authScheme,
      }),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.apiToken?.trim() && account.baseUrl?.trim()),
      tokenSource: account.tokenSource,
      baseUrl: account.baseUrl,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      reconnectAttempts: runtime?.reconnectAttempts ?? 0,
      lastDisconnect: runtime?.lastDisconnect ?? null,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;

      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
        tokenSource: account.tokenSource,
        connected: false,
        reconnectAttempts: 0,
      });

      ctx.log?.info(`[${account.accountId}] starting Fluxer monitor`);

      return monitorFluxerProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
