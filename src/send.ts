import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveFluxerAccount } from "./accounts.js";
import { createFluxerClient, type FluxerClient, type FluxerClientConfig } from "./client.js";
import { normalizeFluxerMessagingTarget } from "./normalize.js";
import { getFluxerRuntime } from "./runtime.js";

export type SendFluxerOpts = {
  accountId?: string;
  replyToId?: string;
  cfg?: OpenClawConfig;
  client?: FluxerClient;
  createClient?: (config: FluxerClientConfig) => FluxerClient;
};

function resolveClientDeps(opts: SendFluxerOpts) {
  const runtime = getFluxerRuntime();
  const cfg = opts.cfg ?? runtime.config.loadConfig();
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

  const clientFactory = opts.createClient ?? createFluxerClient;
  const client =
    opts.client ??
    clientFactory({
      accountId: account.accountId,
      baseUrl,
      apiToken,
      authScheme: account.config.authScheme,
    });

  return { runtime, cfg, account, client };
}

function resolveFluxerChannelId(target: string): string {
  const trimmed = target.trim();
  const idx = trimmed.indexOf(":");
  if (idx <= 0) {
    return trimmed;
  }
  const kind = trimmed.slice(0, idx).toLowerCase();
  const id = trimmed.slice(idx + 1).trim();
  if (kind === "channel" || kind === "group") {
    return id;
  }
  throw new Error("Fluxer reactions require a channel/group target (use channel:<id> or group:<id>)");
}

export async function sendMessageFluxer(
  to: string,
  text: string,
  opts: SendFluxerOpts = {},
): Promise<{
  messageId: string;
  chatId: string;
  timestamp?: number;
  meta?: Record<string, unknown>;
}> {
  const { runtime, account, client } = resolveClientDeps(opts);

  const target = normalizeFluxerMessagingTarget(to);
  if (!target) {
    throw new Error("Fluxer target is required (expected channel:<id> | user:<id> | group:<id>)");
  }

  const result = await client.sendText({
    target,
    text,
    replyToId: opts.replyToId,
    accountId: account.accountId,
  });

  runtime.channel.activity.record({
    channel: "fluxer",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    messageId: result.messageId,
    chatId: result.chatId,
    timestamp: result.timestamp,
    meta: {
      target,
      accountId: account.accountId,
    },
  };
}

export async function editMessageFluxer(
  params: {
    channelId: string;
    messageId: string;
    text: string;
  },
  opts: SendFluxerOpts = {},
): Promise<{
  messageId: string;
  chatId: string;
  timestamp?: number;
  meta?: Record<string, unknown>;
}> {
  const { runtime, account, client } = resolveClientDeps(opts);

  const channelId = params.channelId.trim();
  const messageId = params.messageId.trim();
  const text = params.text.trim();
  if (!channelId) throw new Error("Fluxer edit requires channelId");
  if (!messageId) throw new Error("Fluxer edit requires messageId");
  if (!text) throw new Error("Fluxer edit requires text");

  const result = await client.editText({
    channelId,
    messageId,
    text,
    accountId: account.accountId,
  });

  runtime.channel.activity.record({
    channel: "fluxer",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    messageId: result.messageId,
    chatId: result.chatId,
    timestamp: result.timestamp,
    meta: {
      channelId,
      messageId,
      accountId: account.accountId,
    },
  };
}

export async function sendMediaFluxer(
  params: {
    to: string;
    text?: string;
    mediaUrl: string;
  },
  opts: SendFluxerOpts = {},
): Promise<{
  messageId: string;
  chatId: string;
  timestamp?: number;
  meta?: Record<string, unknown>;
}> {
  const { runtime, account, client } = resolveClientDeps(opts);

  const target = normalizeFluxerMessagingTarget(params.to);
  if (!target) {
    throw new Error("Fluxer target is required (expected channel:<id> | user:<id> | group:<id>)");
  }

  const mediaUrl = params.mediaUrl.trim();
  if (!mediaUrl) {
    throw new Error("Fluxer mediaUrl is required");
  }

  const result = await client.sendMedia({
    target,
    text: params.text,
    mediaUrl,
    replyToId: opts.replyToId,
    accountId: account.accountId,
  });

  runtime.channel.activity.record({
    channel: "fluxer",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    messageId: result.messageId,
    chatId: result.chatId,
    timestamp: result.timestamp,
    meta: {
      target,
      mediaUrl,
      accountId: account.accountId,
    },
  };
}

export async function sendReactionFluxer(
  params: {
    to: string;
    messageId: string;
    emoji: string;
    remove?: boolean;
  },
  opts: SendFluxerOpts = {},
): Promise<{ ok: true; meta: Record<string, unknown> }> {
  const { runtime, account, client } = resolveClientDeps(opts);

  const target = normalizeFluxerMessagingTarget(params.to);
  if (!target) {
    throw new Error("Fluxer target is required (expected channel:<id> or group:<id>)");
  }

  const channelId = resolveFluxerChannelId(target);
  const messageId = params.messageId.trim();
  const emoji = params.emoji.trim();
  if (!messageId) {
    throw new Error("Fluxer react requires messageId");
  }
  if (!emoji) {
    throw new Error("Fluxer react requires emoji");
  }

  await client.react({
    channelId,
    messageId,
    emoji,
    remove: params.remove,
  });

  runtime.channel.activity.record({
    channel: "fluxer",
    accountId: account.accountId,
    direction: "outbound",
  });

  return {
    ok: true,
    meta: {
      target,
      channelId,
      accountId: account.accountId,
      messageId,
      emoji,
      remove: Boolean(params.remove),
    },
  };
}
