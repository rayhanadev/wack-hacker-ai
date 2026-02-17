import { tool } from "ai";
import {
  ChannelType,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  PermissionFlagsBits,
  type ColorResolvable,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  type NonThreadGuildBasedChannel,
  type Role,
} from "discord.js";
import { join } from "node:path";
import { z } from "zod";
import { createSkillSystem } from "./skills";

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export const {
  getBaseToolNames,
  getSkillToolNames,
  createLoadSkillTool,
  resolveSystemPrompt,
} = createSkillSystem({
  skillsDir: join(import.meta.dir, "../prompts/discord/skills"),
  skillNames: ["channels", "messages", "roles", "members", "webhooks", "events"],
  baseToolNames: [
    "load_skill",
    "get_server_info",
    "list_channels",
    "list_roles",
    "search_members",
  ],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const json = JSON.stringify;

function channelTypeName(type: ChannelType): string {
  const map: Record<number, string> = {
    [ChannelType.GuildText]: "text",
    [ChannelType.GuildVoice]: "voice",
    [ChannelType.GuildCategory]: "category",
    [ChannelType.GuildAnnouncement]: "announcement",
    [ChannelType.GuildForum]: "forum",
    [ChannelType.GuildStageVoice]: "stage",
    [ChannelType.PublicThread]: "public_thread",
    [ChannelType.PrivateThread]: "private_thread",
    [ChannelType.AnnouncementThread]: "announcement_thread",
  };
  return map[type] ?? `unknown(${type})`;
}

type GuildChannelType =
  | ChannelType.GuildText
  | ChannelType.GuildVoice
  | ChannelType.GuildCategory
  | ChannelType.GuildAnnouncement
  | ChannelType.GuildForum
  | ChannelType.GuildStageVoice;

function parseChannelType(type: string): GuildChannelType {
  const map: Record<string, GuildChannelType> = {
    text: ChannelType.GuildText,
    voice: ChannelType.GuildVoice,
    category: ChannelType.GuildCategory,
    announcement: ChannelType.GuildAnnouncement,
    forum: ChannelType.GuildForum,
    stage: ChannelType.GuildStageVoice,
  };
  return map[type] ?? ChannelType.GuildText;
}

function summarizeChannel(ch: NonThreadGuildBasedChannel) {
  return {
    id: ch.id,
    name: ch.name,
    type: channelTypeName(ch.type),
    ...("topic" in ch && ch.topic ? { topic: ch.topic } : {}),
    ...(ch.parentId ? { parentId: ch.parentId } : {}),
    position: ch.position,
  };
}

function summarizeMember(m: GuildMember) {
  return {
    id: m.id,
    username: m.user.username,
    displayName: m.displayName,
    nickname: m.nickname,
    roles: m.roles.cache
      .filter((r) => r.id !== m.guild.id)
      .map((r) => ({ id: r.id, name: r.name })),
    joinedAt: m.joinedAt?.toISOString() ?? null,
    isBot: m.user.bot,
  };
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

const PERMISSION_NAMES: Record<string, string> = {
  [PermissionFlagsBits.ViewChannel.toString()]: "View Channel",
  [PermissionFlagsBits.ManageChannels.toString()]: "Manage Channels",
  [PermissionFlagsBits.ManageRoles.toString()]: "Manage Roles",
  [PermissionFlagsBits.ManageMessages.toString()]: "Manage Messages",
  [PermissionFlagsBits.ManageWebhooks.toString()]: "Manage Webhooks",
  [PermissionFlagsBits.ManageEvents.toString()]: "Manage Events",
  [PermissionFlagsBits.ManageNicknames.toString()]: "Manage Nicknames",
  [PermissionFlagsBits.SendMessages.toString()]: "Send Messages",
  [PermissionFlagsBits.AddReactions.toString()]: "Add Reactions",
};

function permissionError(permission: bigint, channelId?: string): string {
  const name = PERMISSION_NAMES[permission.toString()] ?? "Unknown";
  const where = channelId
    ? `in <#${channelId}>. Let them know they need this permission in that channel`
    : `required to perform this action. Let them know they need this permission`;
  return json({ error: `The user does not have the "${name}" permission ${where} or should ask a server admin.` });
}

/** Permission checker scoped to a guild member. Each method returns an error string if denied, null if allowed. */
export class Permissions {
  constructor(private member: GuildMember) {}

  /** Check a server-level permission. */
  server(permission: bigint): string | null {
    if (!this.member.permissions.has(permission)) return permissionError(permission);
    return null;
  }

  /** Check a channel-level permission. For threads, checks the parent channel. */
  channel(channel: GuildBasedChannel, permission: bigint): string | null {
    if (channel.isThread()) {
      const parent = channel.parent;
      if (parent) {
        if (!parent.permissionsFor(this.member)?.has(permission)) return permissionError(permission, parent.id);
      } else {
        if (!this.member.permissions.has(permission)) return permissionError(permission, channel.id);
      }
    } else if (!channel.permissionsFor(this.member)?.has(permission)) {
      return permissionError(permission, channel.id);
    }
    return null;
  }

  /** Check that the member's highest role is above the target role. */
  aboveRole(role: Role): string | null {
    if (this.member.roles.highest.position <= role.position) {
      return json({ error: `Cannot manage the "${role.name}" role — it is at or above your highest role in the hierarchy.` });
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main agent tool: discord history (used directly, not via subagent)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Base tools (always available)
// ---------------------------------------------------------------------------

export function createGetServerInfoTool(guild: Guild) {
  return tool({
    description: "Get Discord server overview: name, member count, channel count, role count, and basic settings.",
    inputSchema: z.object({}),
    execute: async () => {
      const fetched = await guild.fetch();
      return json({
        id: fetched.id,
        name: fetched.name,
        memberCount: fetched.memberCount,
        channelCount: fetched.channels.cache.size,
        roleCount: fetched.roles.cache.size,
        ownerId: fetched.ownerId,
        description: fetched.description,
        icon: fetched.iconURL(),
        banner: fetched.bannerURL(),
        boostLevel: fetched.premiumTier,
        boostCount: fetched.premiumSubscriptionCount,
        verificationLevel: fetched.verificationLevel,
        createdAt: fetched.createdAt.toISOString(),
      });
    },
  });
}

export function createListChannelsTool(guild: Guild) {
  return tool({
    description: "List all channels in the Discord server, organized by category.",
    inputSchema: z.object({}),
    execute: async () => {
      const channels = await guild.channels.fetch();
      const all = [...channels.values()].filter(
        (ch): ch is NonThreadGuildBasedChannel => ch !== null,
      );
      const categories = all
        .filter((ch) => ch.type === ChannelType.GuildCategory)
        .sort((a, b) => a.position - b.position);
      const uncategorized = all
        .filter((ch) => ch.type !== ChannelType.GuildCategory && !ch.parentId)
        .sort((a, b) => a.position - b.position);

      const result: any[] = [];
      for (const cat of categories) {
        const children = all
          .filter((ch) => ch.parentId === cat.id)
          .sort((a, b) => a.position - b.position);
        result.push({
          category: { id: cat.id, name: cat.name, position: cat.position },
          channels: children.map(summarizeChannel),
        });
      }
      if (uncategorized.length > 0) {
        result.push({
          category: null,
          channels: uncategorized.map(summarizeChannel),
        });
      }
      return json(result);
    },
  });
}

export function createListRolesTool(guild: Guild) {
  return tool({
    description: "List all roles in the Discord server with their colors and member counts.",
    inputSchema: z.object({}),
    execute: async () => {
      const roles = await guild.roles.fetch();
      const sorted = [...roles.values()].sort((a, b) => b.position - a.position);
      return json(
        sorted.map((r) => ({
          id: r.id,
          name: r.name,
          color: r.hexColor,
          position: r.position,
          memberCount: r.members.size,
          mentionable: r.mentionable,
          hoist: r.hoist,
          managed: r.managed,
          isEveryone: r.id === guild.id,
        })),
      );
    },
  });
}

export function createSearchMembersTool(guild: Guild) {
  return tool({
    description: "Search for server members by name, nickname, or user ID.",
    inputSchema: z.object({
      query: z.string().describe("Search query (matches username, display name, nickname, or a user ID)"),
      limit: z.number().max(100).default(10).describe("Max results (max 100)"),
    }),
    execute: async ({ query, limit }) => {
      // If the query looks like a Discord user ID, fetch directly
      if (/^\d{17,20}$/.test(query)) {
        try {
          const member = await guild.members.fetch(query);
          return json([summarizeMember(member)]);
        } catch {
          return json([]);
        }
      }
      const members = await guild.members.search({ query, limit });
      return json([...members.values()].map(summarizeMember));
    },
  });
}

// ---------------------------------------------------------------------------
// Skill: channels
// ---------------------------------------------------------------------------

export function createCreateChannelTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Create a new channel in the Discord server.",
    inputSchema: z.object({
      name: z.string().describe("Channel name"),
      type: z.enum(["text", "voice", "category", "announcement", "forum", "stage"]).default("text").describe("Channel type"),
      topic: z.string().optional().describe("Channel topic (text channels only)"),
      parent_id: z.string().optional().describe("Parent category ID"),
      nsfw: z.boolean().optional().describe("Whether the channel is NSFW"),
      slowmode: z.number().optional().describe("Slowmode delay in seconds (0 to disable)"),
    }),
    execute: async ({ name, type, topic, parent_id, nsfw, slowmode }) => {
      if (parent_id) {
        const category = await guild.channels.fetch(parent_id);
        if (!category) return json({ error: "Parent category not found" });
        const denied = perms.channel(category, PermissionFlagsBits.ManageChannels);
        if (denied) return denied;
      } else {
        const denied = perms.server(PermissionFlagsBits.ManageChannels);
        if (denied) return denied;
      }
      const channel = await guild.channels.create({
        name,
        type: parseChannelType(type),
        ...(topic && { topic }),
        ...(parent_id && { parent: parent_id }),
        ...(nsfw !== undefined && { nsfw }),
        ...(slowmode !== undefined && { rateLimitPerUser: slowmode }),
      });
      return json(summarizeChannel(channel));
    },
  });
}

export function createEditChannelTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Edit an existing channel's settings.",
    inputSchema: z.object({
      channel_id: z.string().describe("Channel ID"),
      name: z.string().optional().describe("New channel name"),
      topic: z.string().optional().describe("New channel topic"),
      parent_id: z.string().nullable().optional().describe("New parent category ID (null to remove from category)"),
      nsfw: z.boolean().optional().describe("Whether the channel is NSFW"),
      slowmode: z.number().optional().describe("Slowmode delay in seconds (0 to disable)"),
      position: z.number().optional().describe("New position"),
    }),
    execute: async ({ channel_id, name, topic, parent_id, nsfw, slowmode, position }) => {
      const channel = await guild.channels.fetch(channel_id);
      if (!channel) return json({ error: "Channel not found" });
      const denied = perms.channel(channel, PermissionFlagsBits.ManageChannels);
      if (denied) return denied;
      const edited = await channel.edit({
        ...(name && { name }),
        ...(topic !== undefined && { topic }),
        ...(parent_id !== undefined && { parent: parent_id }),
        ...(nsfw !== undefined && { nsfw }),
        ...(slowmode !== undefined && { rateLimitPerUser: slowmode }),
        ...(position !== undefined && { position }),
      });
      return json(summarizeChannel(edited as NonThreadGuildBasedChannel));
    },
  });
}

export function createDeleteChannelTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Delete a channel from the server. This is irreversible.",
    inputSchema: z.object({
      channel_id: z.string().describe("Channel ID"),
    }),
    execute: async ({ channel_id }) => {
      const channel = await guild.channels.fetch(channel_id);
      if (!channel) return json({ error: "Channel not found" });
      const denied = perms.channel(channel, PermissionFlagsBits.ManageChannels);
      if (denied) return denied;
      const name = channel.name;
      await channel.delete();
      return json({ success: true, deleted: name });
    },
  });
}

// ---------------------------------------------------------------------------
// Skill: messages
// ---------------------------------------------------------------------------

export function createSendMessageTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Send a message to a channel.",
    inputSchema: z.object({
      channel_id: z.string().describe("Channel ID to send the message to"),
      content: z.string().describe("Message content (supports Discord markdown)"),
    }),
    execute: async ({ channel_id, content }) => {
      const channel = await guild.channels.fetch(channel_id);
      if (!channel || !channel.isTextBased()) return json({ error: "Text channel not found" });
      const denied = perms.channel(channel, PermissionFlagsBits.SendMessages);
      if (denied) return denied;
      const msg = await channel.send(content);
      return json({ id: msg.id, channelId: msg.channelId, content: msg.content });
    },
  });
}

export function createDeleteMessageTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Delete a message from a channel.",
    inputSchema: z.object({
      channel_id: z.string().describe("Channel ID"),
      message_id: z.string().describe("Message ID to delete"),
    }),
    execute: async ({ channel_id, message_id }) => {
      const channel = await guild.channels.fetch(channel_id);
      if (!channel || !channel.isTextBased()) return json({ error: "Text channel not found" });
      const denied = perms.channel(channel, PermissionFlagsBits.ManageMessages);
      if (denied) return denied;
      const msg = await channel.messages.fetch(message_id);
      await msg.delete();
      return json({ success: true, deleted: message_id });
    },
  });
}

export function createPinMessageTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Pin a message in a channel.",
    inputSchema: z.object({
      channel_id: z.string().describe("Channel ID"),
      message_id: z.string().describe("Message ID to pin"),
    }),
    execute: async ({ channel_id, message_id }) => {
      const channel = await guild.channels.fetch(channel_id);
      if (!channel || !channel.isTextBased()) return json({ error: "Text channel not found" });
      const denied = perms.channel(channel, PermissionFlagsBits.ManageMessages);
      if (denied) return denied;
      const msg = await channel.messages.fetch(message_id);
      await msg.pin();
      return json({ success: true, pinned: message_id });
    },
  });
}

export function createUnpinMessageTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Unpin a message in a channel.",
    inputSchema: z.object({
      channel_id: z.string().describe("Channel ID"),
      message_id: z.string().describe("Message ID to unpin"),
    }),
    execute: async ({ channel_id, message_id }) => {
      const channel = await guild.channels.fetch(channel_id);
      if (!channel || !channel.isTextBased()) return json({ error: "Text channel not found" });
      const denied = perms.channel(channel, PermissionFlagsBits.ManageMessages);
      if (denied) return denied;
      const msg = await channel.messages.fetch(message_id);
      await msg.unpin();
      return json({ success: true, unpinned: message_id });
    },
  });
}

export function createAddReactionTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Add a reaction emoji to a message.",
    inputSchema: z.object({
      channel_id: z.string().describe("Channel ID"),
      message_id: z.string().describe("Message ID"),
      emoji: z.string().describe("Emoji to react with (Unicode emoji or custom emoji ID)"),
    }),
    execute: async ({ channel_id, message_id, emoji }) => {
      const channel = await guild.channels.fetch(channel_id);
      if (!channel || !channel.isTextBased()) return json({ error: "Text channel not found" });
      const denied = perms.channel(channel, PermissionFlagsBits.AddReactions);
      if (denied) return denied;
      const msg = await channel.messages.fetch(message_id);
      await msg.react(emoji);
      return json({ success: true, reacted: emoji });
    },
  });
}

export function createFetchMessagesTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Fetch recent messages from a channel.",
    inputSchema: z.object({
      channel_id: z.string().describe("Channel ID"),
      limit: z.number().max(100).default(25).describe("Number of messages to fetch (max 100)"),
      before: z.string().optional().describe("Fetch messages before this message ID (for pagination)"),
      after: z.string().optional().describe("Fetch messages after this message ID"),
    }),
    execute: async ({ channel_id, limit, before, after }) => {
      const channel = await guild.channels.fetch(channel_id);
      if (!channel || !channel.isTextBased()) return json({ error: "Text channel not found" });
      const denied = perms.channel(channel, PermissionFlagsBits.ViewChannel);
      if (denied) return denied;
      const messages = await channel.messages.fetch({
        limit,
        ...(before && { before }),
        ...(after && { after }),
      });
      const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      return json(
        sorted.map((m) => ({
          id: m.id,
          author: m.author.displayName,
          authorId: m.author.id,
          isBot: m.author.bot,
          content: m.content,
          timestamp: m.createdAt.toISOString(),
          pinned: m.pinned,
          attachments: m.attachments.map((a) => ({ name: a.name, url: a.url })),
          embeds: m.embeds.length,
        })),
      );
    },
  });
}

// ---------------------------------------------------------------------------
// Skill: roles
// ---------------------------------------------------------------------------

export function createCreateRoleTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Create a new role in the server.",
    inputSchema: z.object({
      name: z.string().describe("Role name"),
      color: z.string().optional().describe("Hex color (e.g. '#FF0000')"),
      hoist: z.boolean().optional().describe("Display role members separately in the sidebar"),
      mentionable: z.boolean().optional().describe("Allow anyone to mention this role"),
      position: z.number().optional().describe("Role position (higher = more authority)"),
    }),
    execute: async ({ name, color, hoist, mentionable, position }) => {
      const denied = perms.server(PermissionFlagsBits.ManageRoles);
      if (denied) return denied;
      const role = await guild.roles.create({
        name,
        ...(color && { colors: { primaryColor: color as ColorResolvable } }),
        ...(hoist !== undefined && { hoist }),
        ...(mentionable !== undefined && { mentionable }),
        ...(position !== undefined && { position }),
      });
      return json({ id: role.id, name: role.name, color: role.hexColor, position: role.position });
    },
  });
}

export function createEditRoleTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Edit an existing role's settings.",
    inputSchema: z.object({
      role_id: z.string().describe("Role ID"),
      name: z.string().optional().describe("New role name"),
      color: z.string().optional().describe("New hex color"),
      hoist: z.boolean().optional().describe("Display separately in sidebar"),
      mentionable: z.boolean().optional().describe("Allow mentioning"),
      position: z.number().optional().describe("New position"),
    }),
    execute: async ({ role_id, name, color, hoist, mentionable, position }) => {
      const denied = perms.server(PermissionFlagsBits.ManageRoles);
      if (denied) return denied;
      const role = await guild.roles.fetch(role_id);
      if (!role) return json({ error: "Role not found" });
      const hierarchyDenied = perms.aboveRole(role);
      if (hierarchyDenied) return hierarchyDenied;
      const edited = await role.edit({
        ...(name && { name }),
        ...(color && { colors: { primaryColor: color as ColorResolvable } }),
        ...(hoist !== undefined && { hoist }),
        ...(mentionable !== undefined && { mentionable }),
        ...(position !== undefined && { position }),
      });
      return json({ id: edited.id, name: edited.name, color: edited.hexColor, position: edited.position });
    },
  });
}

export function createDeleteRoleTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Delete a role from the server. This is irreversible.",
    inputSchema: z.object({
      role_id: z.string().describe("Role ID"),
    }),
    execute: async ({ role_id }) => {
      const denied = perms.server(PermissionFlagsBits.ManageRoles);
      if (denied) return denied;
      const role = await guild.roles.fetch(role_id);
      if (!role) return json({ error: "Role not found" });
      const hierarchyDenied = perms.aboveRole(role);
      if (hierarchyDenied) return hierarchyDenied;
      const name = role.name;
      await role.delete();
      return json({ success: true, deleted: name });
    },
  });
}

export function createAssignRoleTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Assign a role to a server member.",
    inputSchema: z.object({
      member_id: z.string().describe("Member (user) ID"),
      role_id: z.string().describe("Role ID to assign"),
    }),
    execute: async ({ member_id, role_id }) => {
      const denied = perms.server(PermissionFlagsBits.ManageRoles);
      if (denied) return denied;
      const role = await guild.roles.fetch(role_id);
      if (!role) return json({ error: "Role not found" });
      const hierarchyDenied = perms.aboveRole(role);
      if (hierarchyDenied) return hierarchyDenied;
      const target = await guild.members.fetch(member_id);
      await target.roles.add(role_id);
      return json({ success: true, member: target.displayName, role: role.name });
    },
  });
}

export function createRemoveRoleTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Remove a role from a server member.",
    inputSchema: z.object({
      member_id: z.string().describe("Member (user) ID"),
      role_id: z.string().describe("Role ID to remove"),
    }),
    execute: async ({ member_id, role_id }) => {
      const denied = perms.server(PermissionFlagsBits.ManageRoles);
      if (denied) return denied;
      const role = await guild.roles.fetch(role_id);
      if (!role) return json({ error: "Role not found" });
      const hierarchyDenied = perms.aboveRole(role);
      if (hierarchyDenied) return hierarchyDenied;
      const target = await guild.members.fetch(member_id);
      await target.roles.remove(role_id);
      return json({ success: true, member: target.displayName, role: role.name });
    },
  });
}

// ---------------------------------------------------------------------------
// Skill: members
// ---------------------------------------------------------------------------

export function createGetMemberTool(guild: Guild) {
  return tool({
    description: "Get detailed information about a server member.",
    inputSchema: z.object({
      member_id: z.string().describe("Member (user) ID"),
    }),
    execute: async ({ member_id }) => {
      const member = await guild.members.fetch(member_id);
      return json({
        ...summarizeMember(member),
        premiumSince: member.premiumSince?.toISOString() ?? null,
        avatar: member.displayAvatarURL(),
      });
    },
  });
}

export function createSetNicknameTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Set or clear a member's server nickname.",
    inputSchema: z.object({
      member_id: z.string().describe("Member (user) ID"),
      nickname: z.string().nullable().describe("New nickname (null to clear)"),
    }),
    execute: async ({ member_id, nickname }) => {
      const denied = perms.server(PermissionFlagsBits.ManageNicknames);
      if (denied) return denied;
      const target = await guild.members.fetch(member_id);
      await target.setNickname(nickname);
      return json({ success: true, member: target.user.username, nickname });
    },
  });
}

// ---------------------------------------------------------------------------
// Skill: webhooks
// ---------------------------------------------------------------------------

export function createListWebhooksTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "List all webhooks in the server or a specific channel.",
    inputSchema: z.object({
      channel_id: z.string().optional().describe("Channel ID to filter by (omit for all server webhooks)"),
    }),
    execute: async ({ channel_id }) => {
      if (channel_id) {
        const channel = await guild.channels.fetch(channel_id);
        if (!channel || !("fetchWebhooks" in channel)) return json({ error: "Channel not found or does not support webhooks" });
        const denied = perms.channel(channel, PermissionFlagsBits.ManageWebhooks);
        if (denied) return denied;
        const webhooks = await (channel as any).fetchWebhooks();
        return json(
          [...webhooks.values()].map((w: any) => ({
            id: w.id,
            name: w.name,
            channelId: w.channelId,
            url: w.url,
            avatar: w.avatarURL(),
            createdAt: w.createdAt?.toISOString(),
          })),
        );
      }
      const denied = perms.server(PermissionFlagsBits.ManageWebhooks);
      if (denied) return denied;
      const webhooks = await guild.fetchWebhooks();
      return json(
        [...webhooks.values()].map((w) => ({
          id: w.id,
          name: w.name,
          channelId: w.channelId,
          url: w.url,
          avatar: w.avatarURL(),
          createdAt: w.createdAt?.toISOString(),
        })),
      );
    },
  });
}

export function createCreateWebhookTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Create a webhook in a channel.",
    inputSchema: z.object({
      channel_id: z.string().describe("Channel ID to create the webhook in"),
      name: z.string().describe("Webhook name"),
      avatar: z.string().optional().describe("Avatar URL for the webhook"),
    }),
    execute: async ({ channel_id, name, avatar }) => {
      const channel = await guild.channels.fetch(channel_id);
      if (!channel || !("createWebhook" in channel)) return json({ error: "Channel not found or does not support webhooks" });
      const denied = perms.channel(channel, PermissionFlagsBits.ManageWebhooks);
      if (denied) return denied;
      const webhook = await (channel as any).createWebhook({ name, ...(avatar && { avatar }) });
      return json({
        id: webhook.id,
        name: webhook.name,
        channelId: webhook.channelId,
        url: webhook.url,
      });
    },
  });
}

export function createDeleteWebhookTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Delete a webhook.",
    inputSchema: z.object({
      webhook_id: z.string().describe("Webhook ID to delete"),
    }),
    execute: async ({ webhook_id }) => {
      const denied = perms.server(PermissionFlagsBits.ManageWebhooks);
      if (denied) return denied;
      const webhooks = await guild.fetchWebhooks();
      const webhook = webhooks.get(webhook_id);
      if (!webhook) return json({ error: "Webhook not found" });
      const name = webhook.name;
      await webhook.delete();
      return json({ success: true, deleted: name });
    },
  });
}

export function createEditWebhookTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Edit a webhook's name, avatar, or channel.",
    inputSchema: z.object({
      webhook_id: z.string().describe("Webhook ID"),
      name: z.string().optional().describe("New webhook name"),
      avatar: z.string().optional().describe("New avatar URL"),
      channel_id: z.string().optional().describe("Move webhook to a different channel"),
    }),
    execute: async ({ webhook_id, name, avatar, channel_id }) => {
      const denied = perms.server(PermissionFlagsBits.ManageWebhooks);
      if (denied) return denied;
      const webhooks = await guild.fetchWebhooks();
      const webhook = webhooks.get(webhook_id);
      if (!webhook) return json({ error: "Webhook not found" });
      const edited = await webhook.edit({
        ...(name && { name }),
        ...(avatar && { avatar }),
        ...(channel_id && { channel: channel_id }),
      });
      return json({
        id: edited.id,
        name: edited.name,
        channelId: edited.channelId,
        url: edited.url,
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Skill: events (scheduled events)
// ---------------------------------------------------------------------------

export function createListEventsTool(guild: Guild) {
  return tool({
    description: "List all scheduled events in the server.",
    inputSchema: z.object({}),
    execute: async () => {
      const events = await guild.scheduledEvents.fetch();
      return json(
        [...events.values()].map((e) => ({
          id: e.id,
          name: e.name,
          description: e.description,
          scheduledStartAt: e.scheduledStartAt?.toISOString(),
          scheduledEndAt: e.scheduledEndAt?.toISOString(),
          status: e.status,
          entityType: e.entityType,
          channelId: e.channelId,
          location: e.entityMetadata?.location,
          userCount: e.userCount,
          creatorId: e.creatorId,
          image: e.coverImageURL(),
        })),
      );
    },
  });
}

export function createCreateEventTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Create a scheduled event in the server.",
    inputSchema: z.object({
      name: z.string().describe("Event name"),
      description: z.string().optional().describe("Event description"),
      scheduled_start: z.string().describe("Start time (ISO 8601 string)"),
      scheduled_end: z.string().optional().describe("End time (ISO 8601 string, required for external events)"),
      type: z.enum(["voice", "stage", "external"]).default("external").describe("Event type"),
      channel_id: z.string().optional().describe("Voice/stage channel ID (required for voice/stage events)"),
      location: z.string().optional().describe("Location string (required for external events)"),
      image: z.string().optional().describe("Cover image URL"),
    }),
    execute: async ({ name, description, scheduled_start, scheduled_end, type, channel_id, location, image }) => {
      const denied = perms.server(PermissionFlagsBits.ManageEvents);
      if (denied) return denied;
      const entityTypeMap: Record<string, GuildScheduledEventEntityType> = {
        voice: GuildScheduledEventEntityType.Voice,
        stage: GuildScheduledEventEntityType.StageInstance,
        external: GuildScheduledEventEntityType.External,
      };
      const entityType = entityTypeMap[type] ?? GuildScheduledEventEntityType.External;
      const event = await guild.scheduledEvents.create({
        name,
        scheduledStartTime: scheduled_start,
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType,
        ...(description && { description }),
        ...(scheduled_end && { scheduledEndTime: scheduled_end }),
        ...(channel_id && { channel: channel_id }),
        ...(location && { entityMetadata: { location } }),
        ...(image && { image }),
      });
      return json({
        id: event.id,
        name: event.name,
        scheduledStartAt: event.scheduledStartAt?.toISOString(),
        scheduledEndAt: event.scheduledEndAt?.toISOString(),
        status: event.status,
      });
    },
  });
}

export function createEditEventTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Edit a scheduled event.",
    inputSchema: z.object({
      event_id: z.string().describe("Event ID"),
      name: z.string().optional().describe("New event name"),
      description: z.string().optional().describe("New description"),
      scheduled_start: z.string().optional().describe("New start time (ISO 8601)"),
      scheduled_end: z.string().optional().describe("New end time (ISO 8601)"),
      location: z.string().optional().describe("New location (external events only)"),
      image: z.string().optional().describe("New cover image URL"),
    }),
    execute: async ({ event_id, name, description, scheduled_start, scheduled_end, location, image }) => {
      const denied = perms.server(PermissionFlagsBits.ManageEvents);
      if (denied) return denied;
      const event = await guild.scheduledEvents.fetch(event_id);
      if (!event) return json({ error: "Event not found" });
      const edited = await event.edit({
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(scheduled_start && { scheduledStartTime: scheduled_start }),
        ...(scheduled_end && { scheduledEndTime: scheduled_end }),
        ...(location && { entityMetadata: { location } }),
        ...(image && { image }),
      });
      return json({
        id: edited.id,
        name: edited.name,
        scheduledStartAt: edited.scheduledStartAt?.toISOString(),
        scheduledEndAt: edited.scheduledEndAt?.toISOString(),
        status: edited.status,
      });
    },
  });
}

export function createDeleteEventTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Delete a scheduled event.",
    inputSchema: z.object({
      event_id: z.string().describe("Event ID to delete"),
    }),
    execute: async ({ event_id }) => {
      const denied = perms.server(PermissionFlagsBits.ManageEvents);
      if (denied) return denied;
      const event = await guild.scheduledEvents.fetch(event_id);
      if (!event) return json({ error: "Event not found" });
      const name = event.name;
      await event.delete();
      return json({ success: true, deleted: name });
    },
  });
}
