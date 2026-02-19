type FluxerRecord = Record<string, unknown>;

function isRecord(value: unknown): value is FluxerRecord {
  return typeof value === "object" && value !== null;
}

function readString(record: FluxerRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readTimestamp(record: FluxerRecord, keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const asNumber = Number(value);
      if (Number.isFinite(asNumber)) {
        return asNumber;
      }
      const asDate = Date.parse(value);
      if (Number.isFinite(asDate)) {
        return asDate;
      }
    }
  }
  return Date.now();
}

function normalizeEventType(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .trim()
    .toLowerCase()
    .replace(/[_.\s]+/g, "-");
}

function readMediaUrls(payload: FluxerRecord): string[] {
  const attachments = payload.attachments;
  if (!Array.isArray(attachments)) {
    return [];
  }

  const urls: string[] = [];
  for (const item of attachments) {
    if (!isRecord(item)) continue;
    const url = readString(item, ["url", "proxy_url", "media_url", "href"]);
    if (url) {
      urls.push(url);
    }
  }

  return urls;
}

export function normalizeFluxerMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("channel:")) {
    const id = trimmed.slice("channel:".length).trim();
    return id ? `channel:${id}` : undefined;
  }
  if (lower.startsWith("group:")) {
    const id = trimmed.slice("group:".length).trim();
    return id ? `group:${id}` : undefined;
  }
  if (lower.startsWith("user:")) {
    const id = trimmed.slice("user:".length).trim();
    return id ? `user:${id}` : undefined;
  }
  if (lower.startsWith("fluxer:")) {
    const id = trimmed.slice("fluxer:".length).trim();
    return id ? `channel:${id}` : undefined;
  }
  if (trimmed.startsWith("@")) {
    const id = trimmed.slice(1).trim();
    return id ? `user:${id}` : undefined;
  }
  if (trimmed.startsWith("#")) {
    const id = trimmed.slice(1).trim();
    return id ? `channel:${id}` : undefined;
  }

  return `channel:${trimmed}`;
}

export function looksLikeFluxerTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  if (/^(user|channel|group|fluxer):/i.test(trimmed)) {
    return true;
  }
  if (/^[@#]/.test(trimmed)) {
    return true;
  }
  return /^[a-z0-9][a-z0-9:_-]{3,}$/i.test(trimmed);
}

export type FluxerNormalizedMessageCreateEvent = {
  kind: "message-create";
  eventId?: string;
  messageId: string;
  chatId: string;
  chatType: "direct" | "group" | "channel";
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: number;
  mediaUrls: string[];
  raw: unknown;
};

export type FluxerNormalizedInboundEvent = FluxerNormalizedMessageCreateEvent;

function normalizeChatType(raw: string | undefined): "direct" | "group" | "channel" {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "direct" || normalized === "dm" || normalized === "user") {
    return "direct";
  }
  if (normalized === "group") {
    return "group";
  }
  return "channel";
}

export function normalizeFluxerInboundEvent(raw: unknown): FluxerNormalizedInboundEvent | null {
  if (!isRecord(raw)) {
    return null;
  }

  const type = normalizeEventType(
    readString(raw, ["type", "event", "eventType", "event_type", "name", "t"]),
  );
  if (type !== "message-create" && type !== "message-created") {
    return null;
  }

  const payload = isRecord(raw.data) ? raw.data : isRecord(raw.d) ? raw.d : raw;

  const messageId = readString(payload, ["messageId", "message_id", "id"]);
  const chatId = readString(payload, [
    "chatId",
    "chat_id",
    "conversationId",
    "channelId",
    "channel_id",
  ]);
  const nestedAuthor = isRecord(payload.author) ? payload.author : undefined;
  const senderId =
    readString(payload, ["senderId", "sender_id", "authorId", "author_id", "userId"]) ??
    (nestedAuthor ? readString(nestedAuthor, ["id", "user_id"]) : undefined);
  const text = readString(payload, ["text", "body", "content"]);
  const mediaUrls = readMediaUrls(payload);

  if (!messageId || !chatId || !senderId) {
    return null;
  }
  if (!text && mediaUrls.length === 0) {
    return null;
  }

  const eventId = readString(raw, ["eventId", "event_id", "id"]);
  const senderName =
    readString(payload, ["senderName", "sender_name", "authorName", "username"]) ??
    (nestedAuthor
      ? readString(nestedAuthor, ["global_name", "display_name", "username", "name"])
      : undefined);
  const chatType = normalizeChatType(
    readString(payload, ["chatType", "chat_type", "conversationType", "conversation_type"]),
  );
  const timestamp = readTimestamp(payload, ["timestamp", "ts", "createdAt", "created_at", "time"]);

  return {
    kind: "message-create",
    eventId,
    messageId,
    chatId,
    chatType,
    senderId,
    senderName,
    text: text ?? "[attachment]",
    timestamp,
    mediaUrls,
    raw,
  };
}
