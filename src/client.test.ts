import { describe, expect, it } from "vitest";
import type { Message } from "@fluxerjs/core";
import { resolveChatType } from "./client.js";

function mockMessage(input: {
  channel: { isDM: () => boolean; name: string | null } | null;
  guildId: string | null;
}): Message {
  return input as unknown as Message;
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
