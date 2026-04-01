import { ToolLoopAgent, stepCountIs } from "ai";
import type { Message } from "discord.js";
import { join } from "node:path";

const promptPath = join(import.meta.dir, "../prompts/lord-wackus/SYSTEM.md");

const HIGH_PRIEST_ID = "636701123620634653";
const JESTER_ROLE_ID = "1012751663322382438";

/** Organizer specialization roles, checked in order. */
const JESTER_SPECIALIZATIONS: ReadonlyArray<{ roleId: string; title: string }> = [
  { roleId: "1323455653011787898", title: "designer" },
  { roleId: "1323455823183085568", title: "engineer" },
  { roleId: "1323455865147101385", title: "comms" },
  { roleId: "1323455948752289874", title: "events" },
  { roleId: "1331451307659362384", title: "finances" },
];

let promptCache: string | null = null;

async function loadPrompt(): Promise<string> {
  if (!promptCache) {
    promptCache = await Bun.file(promptPath).text();
  }
  return promptCache;
}

function resolveRole(message: Message): string {
  if (message.author.id === HIGH_PRIEST_ID) return "high_priest";
  const roles = message.member?.roles.cache;
  if (roles?.has(JESTER_ROLE_ID)) {
    const spec = JESTER_SPECIALIZATIONS.find((s) => roles.has(s.roleId));
    return spec ? `jester_${spec.title}` : "jester";
  }
  return "commoner";
}

/** Create the Lord Wackus agent — the Supreme Frog Deity of Purdue Hackers. */
export async function createLordWackusAgent(
  message: Message,
  recentMessages?: string,
  mode: "mentioned" | "shitpost" = "mentioned",
) {
  const baseInstructions = await loadPrompt();

  const userId = message.author.id;
  const userName = message.author.displayName ?? message.author.username;
  const relevance = Math.floor(Math.random() * 101);
  const role = resolveRole(message);

  const executionContext = [
    "```yaml",
    "user:",
    `  name: ${JSON.stringify(userName)}`,
    `  id: "${userId}"`,
    `  role: ${role}`,
    "channel:",
    `  id: "${message.channel.id}"`,
    "```",
  ].join("\n");

  const parts = [
    baseInstructions,
    `<mode>${mode}</mode>`,
    `<relevance>${relevance}</relevance>`,
    `<execution_context>\n${executionContext}\n</execution_context>`,
  ];
  if (recentMessages) parts.push(recentMessages);
  const instructions = parts.join("\n\n");

  return new ToolLoopAgent({
    model: "anthropic/claude-sonnet-4",
    instructions,
    tools: {},
    stopWhen: stepCountIs(1),
  });
}
