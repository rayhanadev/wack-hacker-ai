import { tool } from "ai";
import type { Message } from "discord.js";
import { z } from "zod";

/** Creates a tool that reads recent messages from the Discord channel/thread for conversational context. */
export function createDiscordHistoryTool(message: Message) {
  return tool({
    description:
      "Read recent messages from the current Discord thread or channel. Use this to understand conversational context before responding.",
    inputSchema: z.object({
      limit: z.number().max(50).default(20).describe("Number of messages to fetch (max 50)"),
    }),
    execute: async ({ limit }) => {
      const messages = await message.channel.messages.fetch({ limit });
      const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      return JSON.stringify(
        sorted.map((m) => ({
          author: m.author.displayName,
          isBot: m.author.bot,
          content: m.content,
          timestamp: m.createdAt.toISOString(),
        })),
      );
    },
  });
}
