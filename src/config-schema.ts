import { DmPolicySchema, GroupPolicySchema, requireOpenAllowFrom } from "openclaw/plugin-sdk";
import { z } from "zod";

const FluxerReconnectSchema = z
  .object({
    baseDelayMs: z.number().int().nonnegative().optional(),
    maxDelayMs: z.number().int().positive().optional(),
    maxAttempts: z.number().int().nonnegative().optional(),
    jitterRatio: z.number().nonnegative().max(1).optional(),
  })
  .strict();

const FluxerAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    apiToken: z.string().optional(),
    baseUrl: z.string().url().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    responsePrefix: z.string().optional(),
    reconnect: FluxerReconnectSchema.optional(),
    authScheme: z.enum(["bearer", "token", "bot"]).optional(),
    slashCommandPrefixes: z.array(z.string().min(1)).optional(),
    voice: z
      .object({
        enabled: z.boolean().optional(),
        autoJoin: z
          .array(
            z
              .object({
                guildId: z.string().min(1),
                channelId: z.string().min(1),
              })
              .strict(),
          )
          .optional(),
        autoSubscribeUsers: z.array(z.string().min(1)).optional(),
        minUtteranceMs: z.number().int().nonnegative().max(60_000).optional(),
        minUtteranceFallbackMs: z.number().int().nonnegative().max(60_000).optional(),
        tts: z
          .object({
            provider: z.string().optional(),
            openai: z
              .object({
                voice: z.string().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    streaming: z
      .object({
        enabled: z.boolean().optional(),
        mode: z.enum(["partial", "block"]).optional(),
        minCharsDelta: z.number().int().nonnegative().max(2_000).optional(),
        idleMs: z.number().int().nonnegative().max(60_000).optional(),
        maxEdits: z.number().int().positive().max(2_000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const FluxerAccountSchema = FluxerAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.fluxer.dmPolicy="open" requires channels.fluxer.allowFrom to include "*"',
  });
});

export const FluxerConfigSchema = FluxerAccountSchemaBase.extend({
  accounts: z.record(z.string(), FluxerAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.fluxer.dmPolicy="open" requires channels.fluxer.allowFrom to include "*"',
  });
});
