import type { Collection, Message } from "discord.js";
import { createAgent } from "../agents/index";
import { buildPromptWithAttachments, type AttachmentInfo } from "../utils/attachments";
import { isOrganizer } from "../utils/roles";

const EDIT_INTERVAL_MS = 1500;
const MAX_LENGTH = 2000;
const CONTEXT_MESSAGE_COUNT = 5;

/** Format a single message as an XML element. */
function formatMessage(m: Message, botMention: RegExp | null, tag = "message"): string {
  const name = m.author.displayName ?? m.author.username;
  const content = botMention ? m.content.replace(botMention, "").trim() : m.content.trim();
  const attachments =
    m.attachments.size > 0
      ? `\n${[...m.attachments.values()].map((a) => `    <attachment name="${a.name}" url="${a.url}" type="${a.contentType ?? "unknown"}" />`).join("\n")}`
      : "";
  return `  <${tag} author="${name}" bot="${m.author.bot}">${content}${attachments}</${tag}>`;
}

/** Fetch recent messages and format as XML context. */
async function buildContext(message: Message): Promise<string> {
  const recent: Collection<string, Message> = await message.channel.messages.fetch({
    limit: CONTEXT_MESSAGE_COUNT + 1,
    before: message.id,
  });

  const messages = [...recent.values()].reverse().slice(-CONTEXT_MESSAGE_COUNT);

  const botMention = message.client.user ? new RegExp(`<@!?${message.client.user.id}>`) : null;

  const parts: string[] = [];

  // If the user replied to a specific message, include it as explicit context.
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

/** Handle incoming messages. Responds when the bot is mentioned. */
export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;

  const botUser = message.client.user;
  if (!botUser || !message.mentions.has(botUser)) return;

  const prompt = message.content.replace(new RegExp(`<@!?${botUser.id}>`), "").trim();
  const attachments: AttachmentInfo[] = [...message.attachments.values()].map((a) => ({
    url: a.url,
    name: a.name,
    contentType: a.contentType ?? "application/octet-stream",
  }));
  if (!prompt && attachments.length === 0) return;

  const member = message.member ?? (await message.guild?.members.fetch(message.author.id));
  if (!member) return;

  const organizerMode = isOrganizer(member);

  await message.react("👀");

  const thread = message.channel.isThread()
    ? message.channel
    : await message.startThread({
        name: (prompt || `${attachments.length} attachment(s)`).slice(0, 100),
      });

  try {
    const recentMessages = await buildContext(message);
    const agent = await createAgent(message, thread, recentMessages || undefined, organizerMode);
    const promptInput = buildPromptWithAttachments(prompt, attachments);
    const result = await agent.stream({ prompt: promptInput });

    let text = "";
    let reply: Message | null = null;
    let lastEdit = Date.now();

    for await (const chunk of result.textStream) {
      text += chunk;
      if (!reply) {
        reply = await thread.send(text.slice(0, MAX_LENGTH));
        await message.reactions.removeAll();
        lastEdit = Date.now();
      } else if (Date.now() - lastEdit >= EDIT_INTERVAL_MS) {
        await reply.edit(text.slice(0, MAX_LENGTH));
        lastEdit = Date.now();
      }
    }

    if (reply) {
      await reply.edit(text.slice(0, MAX_LENGTH) || "No response.");
    } else {
      await thread.send("No response.");
      await message.reactions.removeAll();
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : "An error occurred";
    await thread.send(`Error: ${msg}`);
    await message.reactions.removeAll();
  }
}
