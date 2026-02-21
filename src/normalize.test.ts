import { describe, expect, it } from "vitest";
import { normalizeFluxerInboundEvent } from "./normalize.js";

describe("normalizeFluxerInboundEvent", () => {
  it("normalizes message with text only", () => {
    const event = {
      type: "message-create",
      data: {
        messageId: "msg-123",
        chatId: "ch-456",
        senderId: "user-789",
        text: "Hello world",
        timestamp: 1700000000000,
      },
    };

    const result = normalizeFluxerInboundEvent(event);

    expect(result).not.toBeNull();
    expect(result?.kind).toBe("message-create");
    expect(result?.messageId).toBe("msg-123");
    expect(result?.text).toBe("Hello world");
    expect(result?.mediaUrls).toEqual([]);
  });

  it("normalizes sticker-only message (no text)", () => {
    const event = {
      type: "message-create",
      data: {
        messageId: "msg-sticker",
        chatId: "ch-456",
        senderId: "user-789",
        text: "",
        timestamp: 1700000000000,
        attachments: [{ url: "https://fluxerusercontent.com/stickers/111.gif" }],
      },
    };

    const result = normalizeFluxerInboundEvent(event);

    expect(result).not.toBeNull();
    expect(result?.kind).toBe("message-create");
    expect(result?.messageId).toBe("msg-sticker");
    expect(result?.text).toBe("[attachment]");
    expect(result?.mediaUrls).toEqual(["https://fluxerusercontent.com/stickers/111.gif"]);
  });

  it("normalizes GIF-only message (no text)", () => {
    const event = {
      type: "message-create",
      data: {
        messageId: "msg-gif",
        chatId: "ch-456",
        senderId: "user-789",
        text: "",
        timestamp: 1700000000000,
        attachments: [{ url: "https://cdn.example.com/funny.gif" }],
      },
    };

    const result = normalizeFluxerInboundEvent(event);

    expect(result).not.toBeNull();
    expect(result?.kind).toBe("message-create");
    expect(result?.messageId).toBe("msg-gif");
    expect(result?.text).toBe("[attachment]");
    expect(result?.mediaUrls).toEqual(["https://cdn.example.com/funny.gif"]);
  });

  it("normalizes message with multiple stickers", () => {
    const event = {
      type: "message-create",
      data: {
        messageId: "msg-multi-sticker",
        chatId: "ch-456",
        senderId: "user-789",
        text: "",
        timestamp: 1700000000000,
        attachments: [
          { url: "https://fluxerusercontent.com/stickers/111.png" },
          { url: "https://fluxerusercontent.com/stickers/222.gif" },
        ],
      },
    };

    const result = normalizeFluxerInboundEvent(event);

    expect(result).not.toBeNull();
    expect(result?.mediaUrls).toEqual([
      "https://fluxerusercontent.com/stickers/111.png",
      "https://fluxerusercontent.com/stickers/222.gif",
    ]);
  });

  it("normalizes message with both text and stickers", () => {
    const event = {
      type: "message-create",
      data: {
        messageId: "msg-both",
        chatId: "ch-456",
        senderId: "user-789",
        text: "Check this out!",
        timestamp: 1700000000000,
        attachments: [{ url: "https://fluxerusercontent.com/stickers/333.gif" }],
      },
    };

    const result = normalizeFluxerInboundEvent(event);

    expect(result).not.toBeNull();
    expect(result?.text).toBe("Check this out!");
    expect(result?.mediaUrls).toEqual(["https://fluxerusercontent.com/stickers/333.gif"]);
  });

  it("returns null for empty message (no text and no media)", () => {
    const event = {
      type: "message-create",
      data: {
        messageId: "msg-empty",
        chatId: "ch-456",
        senderId: "user-789",
        text: "",
        timestamp: 1700000000000,
        attachments: [],
      },
    };

    const result = normalizeFluxerInboundEvent(event);
    expect(result).toBeNull();
  });

  it("returns null for message with missing senderId", () => {
    const event = {
      type: "message-create",
      data: {
        messageId: "msg-no-sender",
        chatId: "ch-456",
        text: "Hello",
        attachments: [{ url: "https://example.com/sticker.gif" }],
      },
    };

    const result = normalizeFluxerInboundEvent(event);
    expect(result).toBeNull();
  });

  it("normalizes message with mixed attachments and sticker URLs", () => {
    const event = {
      type: "message-create",
      data: {
        messageId: "msg-mixed",
        chatId: "ch-456",
        senderId: "user-789",
        text: "",
        timestamp: 1700000000000,
        attachments: [
          { url: "https://cdn.example.com/photo.jpg" },
          { url: "https://fluxerusercontent.com/stickers/444.gif" },
          { url: "https://tenor.com/view/funny-gif-12345" },
        ],
      },
    };

    const result = normalizeFluxerInboundEvent(event);

    expect(result).not.toBeNull();
    expect(result?.mediaUrls).toEqual([
      "https://cdn.example.com/photo.jpg",
      "https://fluxerusercontent.com/stickers/444.gif",
      "https://tenor.com/view/funny-gif-12345",
    ]);
  });
});
