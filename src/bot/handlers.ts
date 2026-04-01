import type { Collection, Message } from "discord.js";
import { createLordWackusAgent } from "../agents/lord-wackus";

const EDIT_INTERVAL_MS = 1500;
const MAX_LENGTH = 2000;
const CONTEXT_MESSAGE_COUNT = 5;
/** Maximum age (ms) for a message to be included in context. 30 minutes. */
const CONTEXT_MAX_AGE_MS = 30 * 60 * 1000;

/** Chance (0-1) that Lord Wackus randomly responds to a message. ~1 in 50. */
const SHITPOST_CHANCE = 0.02;
/** Minimum delay (ms) before a shitpost response to seem organic. */
const SHITPOST_DELAY_MIN = 3000;
/** Maximum delay (ms) before a shitpost response. */
const SHITPOST_DELAY_MAX = 15000;

/** Channels where Lord Wackus will not shitpost. */
const SHITPOST_BLACKLIST = new Set([
  "1052236377338683514",
  "904896819165814794",
  "1105173506242642020",
  "1285816997636079706",
  "809620069751586856",
]);

/** Format a single message as an XML element with timestamp. */
function formatMessage(m: Message, botMention: RegExp | null, tag = "message"): string {
  const name = m.author.displayName ?? m.author.username;
  const content = botMention ? m.content.replace(botMention, "").trim() : m.content.trim();
  const timestamp = m.createdAt.toISOString();
  const attachments =
    m.attachments.size > 0
      ? `\n${[...m.attachments.values()].map((a) => `    <attachment name="${a.name}" url="${a.url}" type="${a.contentType ?? "unknown"}" />`).join("\n")}`
      : "";
  return `  <${tag} author="${name}" bot="${m.author.bot}" timestamp="${timestamp}">${content}${attachments}</${tag}>`;
}

/** Fetch recent messages and format as XML context. */
async function buildContext(message: Message): Promise<string> {
  const recent: Collection<string, Message> = await message.channel.messages.fetch({
    limit: CONTEXT_MESSAGE_COUNT + 1,
    before: message.id,
  });

  const now = Date.now();
  const messages = [...recent.values()]
    .reverse()
    .slice(-CONTEXT_MESSAGE_COUNT)
    .filter((m) => now - m.createdTimestamp < CONTEXT_MAX_AGE_MS);

  const botMention = message.client.user ? new RegExp(`<@!?${message.client.user.id}>`) : null;

  const parts: string[] = [];

  if (message.reference?.messageId) {
    try {
      const referenced =
        messages.find((m) => m.id === message.reference!.messageId) ??
        (await message.channel.messages.fetch(message.reference.messageId));
      parts.push(
        `<replied_to_message>\n${formatMessage(referenced, botMention, "message")}\n</replied_to_message>`,
      );
    } catch {
      // Referenced message may have been deleted; ignore.
    }
  }

  if (messages.length > 0) {
    const lines = messages.map((m) => formatMessage(m, botMention));
    parts.push(`<recent_messages>\n${lines.join("\n")}\n</recent_messages>`);
  }

  return parts.join("\n");
}

/** Stream a Lord Wackus response into a Discord message, editing periodically. */
async function streamResponse(
  agent: Awaited<ReturnType<typeof createLordWackusAgent>>,
  prompt: string,
  sendMessage: (content: string) => Promise<Message>,
): Promise<void> {
  const result = await agent.stream({ prompt });

  let text = "";
  let reply: Message | null = null;
  let lastEdit = Date.now();
  let editing = false;
  let editPromise: Promise<unknown> = Promise.resolve();

  for await (const part of result.fullStream) {
    if (part.type !== "text-delta") continue;
    text += part.text;

    const displayText = text.slice(0, MAX_LENGTH);

    if (!reply) {
      reply = await sendMessage(displayText);
      lastEdit = Date.now();
    } else if (Date.now() - lastEdit >= EDIT_INTERVAL_MS && !editing) {
      editing = true;
      lastEdit = Date.now();
      editPromise = reply
        .edit(displayText)
        .catch(() => {})
        .finally(() => {
          editing = false;
        });
    }
  }

  await editPromise;

  if (reply) {
    await reply.edit(text.slice(0, MAX_LENGTH) || "...ribbit.");
  }
}

/** Randomly interject as Lord Wackus. */
async function maybeShitpost(message: Message): Promise<void> {
  if (Math.random() > SHITPOST_CHANCE) return;
  if (message.channel.isThread()) return;
  if (SHITPOST_BLACKLIST.has(message.channel.id)) return;

  const delay =
    SHITPOST_DELAY_MIN + Math.random() * (SHITPOST_DELAY_MAX - SHITPOST_DELAY_MIN);
  await new Promise((resolve) => setTimeout(resolve, delay));

  const recentMessages = await buildContext(message);
  const agent = await createLordWackusAgent(message, recentMessages || undefined, "shitpost");

  await streamResponse(agent, message.content, (content) => {
    if ("send" in message.channel) return message.channel.send(content);
    return message.reply(content);
  });
}

/** Handle incoming messages. */
export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  const botUser = message.client.user;
  if (!botUser || !message.mentions.has(botUser)) {
    maybeShitpost(message).catch(console.error);
    return;
  }

  const prompt = message.content.replace(new RegExp(`<@!?${botUser.id}>`), "").trim();
  if (!prompt) return;

  try {
    const recentMessages = await buildContext(message);
    const agent = await createLordWackusAgent(message, recentMessages || undefined, "mentioned");

    await streamResponse(agent, prompt, (content) => message.reply(content));
  } catch (error) {
    const msg = error instanceof Error ? error.message : "An error occurred";
    await message.reply(`Error: ${msg}`);
  }
}
