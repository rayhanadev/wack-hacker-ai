import { gateway } from "ai";
import { withSupermemory } from "@supermemory/tools/ai-sdk";
import { env } from "./env";

/** Create a memory-aware model scoped to a Discord user. */
export function createModel(userId: string) {
  return withSupermemory(gateway("anthropic/claude-sonnet-4"), userId, {
    apiKey: env.SUPERMEMORY_API_KEY,
    mode: "full",
    addMemory: "always",
    promptTemplate: (data) =>
      `<user_profile>\n${data.userMemories}\n</user_profile>\n<relevant_memories>\n${data.generalSearchMemories}\n</relevant_memories>`,
  });
}
