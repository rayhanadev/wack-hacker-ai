import { ToolLoopAgent, stepCountIs, tool } from "ai";
import type { GuildTextBasedChannel, Message } from "discord.js";
import { join } from "node:path";
import { z } from "zod";
import {
  createAddReactionTool,
  createAssignRoleTool,
  createCreateChannelTool,
  createCreateEmojiTool,
  createCreateEventTool,
  createCreateRoleTool,
  createCreateStickerTool,
  createCreateThreadTool,
  createCreateWebhookTool,
  createDeleteChannelTool,
  createDeleteEmojiTool,
  createDeleteEventTool,
  createDeleteMessageTool,
  createDeleteRoleTool,
  createDeleteStickerTool,
  createDeleteThreadTool,
  createEditStickerTool,
  createDeleteWebhookTool,
  createEditChannelTool,
  createEditEmojiTool,
  createEditEventTool,
  createEditRoleTool,
  createEditThreadTool,
  createEditWebhookTool,
  createFetchMessagesTool,
  createGetMemberTool,
  createGetServerInfoTool,
  createListChannelsTool,
  createListEmojisTool,
  createListEventsTool,
  createListRolesTool,
  createListStickersTool,
  createListThreadsTool,
  createListWebhooksTool,
  createLoadSkillTool,
  createPinMessageTool,
  createRemoveRoleTool,
  createSearchMembersTool,
  createSendMessageTool,
  createSetNicknameTool,
  createUnpinMessageTool,
  getBaseToolNames,
  getSkillToolNames,
  Permissions,
  resolveSystemPrompt,
} from "../tools/discord";
import { withApproval, type ApprovalContext } from "../utils/approval";
import { createModel } from "../utils/model";

const systemPromptPath = join(import.meta.dir, "../prompts/discord/SYSTEM.md");

/** Cached system prompt, loaded once on first access. */
let systemPromptCache: string | null = null;
async function loadSystemPrompt(): Promise<string> {
  if (!systemPromptCache) {
    systemPromptCache = await resolveSystemPrompt(systemPromptPath);
  }
  return systemPromptCache;
}

/** Create a subagent tool for Discord server management, scoped to a Discord message. */
export function createDiscordTool(message: Message, approvalChannel: GuildTextBasedChannel, recentMessages?: string) {
  return tool({
    description:
      "Manage the Discord server: channels, roles, members, messages, webhooks, scheduled events, threads, and emojis/stickers. Use for any server administration or Discord-related request.",
    inputSchema: z.object({
      task: z.string().describe("The user's original message, forwarded verbatim"),
    }),
    execute: async ({ task }, { abortSignal }) => {
      const guild = message.guild;
      if (!guild) return "This command can only be used in a server.";

      const member = message.member;
      if (!member) return "Could not resolve your server membership.";

      const perms = new Permissions(member);
      const loadedSkills = new Set<string>();
      const baseInstructions = await loadSystemPrompt();
      const userName = message.author.displayName ?? message.author.username;
      const executionContext = [
        "```yaml",
        "user:",
        `  name: ${JSON.stringify(userName)}`,
        `  id: "${message.author.id}"`,
        "channel:",
        `  id: "${message.channel.id}"`,
        "```",
      ].join("\n");
      const contextParts = [baseInstructions, `<execution_context>\n${executionContext}\n</execution_context>`];
      if (recentMessages) contextParts.push(recentMessages);
      const instructions = contextParts.join("\n\n");

      const approvalCtx: ApprovalContext = {
        channel: approvalChannel,
        userId: message.author.id,
      };

      const tools = {
        // Meta
        load_skill: createLoadSkillTool((skill) => loadedSkills.add(skill)),
        // Base read tools
        get_server_info: createGetServerInfoTool(guild),
        list_channels: createListChannelsTool(guild),
        list_roles: createListRolesTool(guild),
        search_members: createSearchMembersTool(guild),
        // Channel tools
        create_channel: createCreateChannelTool(guild, perms),
        edit_channel: createEditChannelTool(guild, perms),
        delete_channel: withApproval(createDeleteChannelTool(guild, perms), approvalCtx, (input) => `Delete Channel <#${input.channel_id}>`),
        // Message tools
        send_message: createSendMessageTool(guild, perms),
        delete_message: withApproval(createDeleteMessageTool(guild, perms), approvalCtx, (input) => `Delete Message ${input.message_id} in <#${input.channel_id}>`),
        pin_message: createPinMessageTool(guild, perms),
        unpin_message: createUnpinMessageTool(guild, perms),
        add_reaction: createAddReactionTool(guild, perms),
        fetch_messages: createFetchMessagesTool(guild, perms),
        // Role tools
        create_role: createCreateRoleTool(guild, perms),
        edit_role: createEditRoleTool(guild, perms),
        delete_role: withApproval(createDeleteRoleTool(guild, perms), approvalCtx, (input) => `Delete Role <@&${input.role_id}>`),
        assign_role: createAssignRoleTool(guild, perms),
        remove_role: createRemoveRoleTool(guild, perms),
        // Member tools
        get_member: createGetMemberTool(guild),
        set_nickname: createSetNicknameTool(guild, perms),
        // Webhook tools
        list_webhooks: createListWebhooksTool(guild, perms),
        create_webhook: createCreateWebhookTool(guild, perms),
        delete_webhook: withApproval(createDeleteWebhookTool(guild, perms), approvalCtx, (input) => `Delete Webhook ${input.webhook_id}`),
        edit_webhook: createEditWebhookTool(guild, perms),
        // Event tools
        list_events: createListEventsTool(guild),
        create_event: createCreateEventTool(guild, perms),
        edit_event: createEditEventTool(guild, perms),
        delete_event: withApproval(createDeleteEventTool(guild, perms), approvalCtx, (input) => `Delete Event ${input.event_id}`),
        // Thread tools
        list_threads: createListThreadsTool(guild, perms),
        create_thread: createCreateThreadTool(guild, perms),
        edit_thread: createEditThreadTool(guild, perms),
        delete_thread: withApproval(createDeleteThreadTool(guild, perms), approvalCtx, (input) => `Delete Thread ${input.thread_id}`),
        // Emoji tools
        list_emojis: createListEmojisTool(guild),
        create_emoji: createCreateEmojiTool(guild, perms),
        edit_emoji: createEditEmojiTool(guild, perms),
        delete_emoji: withApproval(createDeleteEmojiTool(guild, perms), approvalCtx, (input) => `Delete Emoji ${input.emoji_id}`),
        // Sticker tools
        list_stickers: createListStickersTool(guild),
        create_sticker: createCreateStickerTool(guild, perms),
        edit_sticker: createEditStickerTool(guild, perms),
        delete_sticker: withApproval(createDeleteStickerTool(guild, perms), approvalCtx, (input) => `Delete Sticker ${input.sticker_id}`),
      };

      const subagent = new ToolLoopAgent({
        model: createModel(message.author.id),
        instructions,
        tools,
        prepareStep: async () => {
          // Base tools are always active; skill tools unlock after load_skill
          const active = new Set<string>(getBaseToolNames());
          for (const skill of loadedSkills) {
            for (const name of await getSkillToolNames(skill)) {
              active.add(name);
            }
          }
          return { activeTools: [...active] as (keyof typeof tools)[] };
        },
        stopWhen: stepCountIs(15),
      });
      const fullPrompt = task;
      const result = await subagent.generate({ prompt: fullPrompt, abortSignal });
      return result.text;
    },
  });
}
