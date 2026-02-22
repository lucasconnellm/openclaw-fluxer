import { describe, expect, it } from "vitest";
import type { Message, APIMessageSticker } from "@fluxerjs/core";
import { Collection } from "@fluxerjs/collection";
import { resolveChatType, collectMediaUrls } from "./client.js";

interface MockMessageInput {
  channel?: { isDM: () => boolean; name: string | null } | null;
  guildId?: string | null;
  content?: string;
  attachments?: Map<string, { url: string }>;
  stickers?: APIMessageSticker[];
}

function mockMessage(input: MockMessageInput): Message {
  return {
    channel: input.channel ?? null,
    guildId: input.guildId ?? null,
    content: input.content ?? "",
    attachments: input.attachments
      ? new Collection(input.attachments)
      : new Collection<string, { url: string }>(),
    stickers: input.stickers ?? [],
  } as unknown as Message;
}

describe("resolveChatType", () => {
  it("classifies 1:1 DM when channel is cached", () => {
    const message = mockMessage({
      channel: { isDM: () => true, name: null },
      guildId: null,
    });

    expect(resolveChatType(message)).toBe("direct");
  });

  it("classifies group DM when channel is cached and named", () => {
    const message = mockMessage({
      channel: { isDM: () => true, name: "Weekend plans" },
      guildId: null,
    });

    expect(resolveChatType(message)).toBe("group");
  });

  it("classifies guild message as channel", () => {
    const message = mockMessage({
      channel: { isDM: () => false, name: "general" },
      guildId: "123",
    });

    expect(resolveChatType(message)).toBe("channel");
  });

  it("classifies uncached DM as direct when guildId is null", () => {
    const message = mockMessage({
      channel: null,
      guildId: null,
    });

    expect(resolveChatType(message)).toBe("direct");
  });
});

describe("collectMediaUrls", () => {
  it("returns empty array for message with no media", () => {
    const message = mockMessage({});
    expect(collectMediaUrls(message)).toEqual([]);
  });

  it("extracts attachment URLs", () => {
    const message = mockMessage({
      attachments: new Map([
        ["1", { url: "https://cdn.example.com/file.png" }],
        ["2", { url: "https://cdn.example.com/image.jpg" }],
      ]),
    });

    expect(collectMediaUrls(message)).toEqual([
      "https://cdn.example.com/file.png",
      "https://cdn.example.com/image.jpg",
    ]);
  });

  it("extracts GIF attachment URLs", () => {
    const message = mockMessage({
      attachments: new Map([
        ["1", { url: "https://cdn.example.com/animation.gif" }],
      ]),
    });

    expect(collectMediaUrls(message)).toEqual(["https://cdn.example.com/animation.gif"]);
  });

  it("extracts sticker URLs with correct CDN pattern for static sticker", () => {
    const message = mockMessage({
      stickers: [{ id: "123456", name: "cool_sticker", animated: false }],
    });

    expect(collectMediaUrls(message)).toEqual([
      "https://fluxerusercontent.com/stickers/123456.png",
    ]);
  });

  it("extracts sticker URLs with correct CDN pattern for animated sticker", () => {
    const message = mockMessage({
      stickers: [{ id: "789", name: "animated_sticker", animated: true }],
    });

    expect(collectMediaUrls(message)).toEqual([
      "https://fluxerusercontent.com/stickers/789.gif",
    ]);
  });

  it("handles sticker-only message (no text, no attachments)", () => {
    const message = mockMessage({
      stickers: [
        { id: "111", name: "sticker1", animated: false },
        { id: "222", name: "sticker2", animated: true },
      ],
    });

    expect(collectMediaUrls(message)).toEqual([
      "https://fluxerusercontent.com/stickers/111.png",
      "https://fluxerusercontent.com/stickers/222.gif",
    ]);
  });

  it("combines attachments and stickers, attachments first", () => {
    const message = mockMessage({
      attachments: new Map([["1", { url: "https://cdn.example.com/photo.jpg" }]]),
      stickers: [{ id: "999", name: "sticker", animated: false }],
    });

    expect(collectMediaUrls(message)).toEqual([
      "https://cdn.example.com/photo.jpg",
      "https://fluxerusercontent.com/stickers/999.png",
    ]);
  });

  it("deduplicates identical URLs", () => {
    const message = mockMessage({
      attachments: new Map([
        ["1", { url: "https://cdn.example.com/same.png" }],
        ["2", { url: "https://cdn.example.com/same.png" }],
      ]),
    });

    expect(collectMediaUrls(message)).toEqual(["https://cdn.example.com/same.png"]);
  });

  it("handles sticker with undefined animated property (defaults to static)", () => {
    const message = mockMessage({
      stickers: [{ id: "456", name: "maybe_static" }],
    });

    expect(collectMediaUrls(message)).toEqual([
      "https://fluxerusercontent.com/stickers/456.png",
    ]);
  });

  it("trims whitespace from attachment URLs", () => {
    const message = mockMessage({
      attachments: new Map([["1", { url: "  https://cdn.example.com/spaced.png  " }]]),
    });

    expect(collectMediaUrls(message)).toEqual(["https://cdn.example.com/spaced.png"]);
  });

  it("filters out empty attachment URLs", () => {
    const message = mockMessage({
      attachments: new Map([
        ["1", { url: "" }],
        ["2", { url: "https://cdn.example.com/valid.png" }],
        ["3", { url: "   " }],
      ]),
    });

    expect(collectMediaUrls(message)).toEqual(["https://cdn.example.com/valid.png"]);
  });

  it("extracts gif-like URLs from message content", () => {
    const message = mockMessage({
      content:
        "look https://media.example.com/clip.gif and https://tenor.com/view/cat-dance plus https://example.com/page",
    });

    expect(collectMediaUrls(message)).toEqual([
      "https://media.example.com/clip.gif",
      "https://tenor.com/view/cat-dance",
    ]);
  });

  it("dedupes gif URLs shared across attachment and content", () => {
    const message = mockMessage({
      content: "same gif https://cdn.example.com/reuse.gif",
      attachments: new Map([["1", { url: "https://cdn.example.com/reuse.gif" }]]),
    });

    expect(collectMediaUrls(message)).toEqual(["https://cdn.example.com/reuse.gif"]);
  });
});
