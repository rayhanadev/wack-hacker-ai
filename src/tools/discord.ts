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
  type NonThreadGuildBasedChannel,
  type Role,
  type ThreadChannel,
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
  skillNames: ["channels", "messages", "roles", "members", "webhooks", "events", "threads", "emojis"],
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
  [PermissionFlagsBits.ManageThreads.toString()]: "Manage Threads",
  [PermissionFlagsBits.ManageGuildExpressions.toString()]: "Manage Guild Expressions",
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
      position: z.number().optional().describe("Channel position within its category"),
      bitrate: z.number().optional().describe("Bitrate in bits/sec for voice channels (e.g. 64000)"),
      user_limit: z.number().optional().describe("Max users for voice channels (0 for unlimited)"),
      rtc_region: z.string().optional().describe("Voice region override for voice channels"),
      video_quality_mode: z.enum(["auto", "full"]).optional().describe("Video quality mode for voice channels"),
      default_auto_archive_duration: z.enum(["60", "1440", "4320", "10080"]).optional().describe("Default auto-archive duration for new threads (minutes)"),
      default_thread_slowmode: z.number().optional().describe("Default slowmode for new threads in seconds (0 to disable)"),
    }),
    execute: async ({ name, type, topic, parent_id, nsfw, slowmode, position, bitrate, user_limit, rtc_region, video_quality_mode, default_auto_archive_duration, default_thread_slowmode }) => {
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
        ...(position !== undefined && { position }),
        ...(bitrate !== undefined && { bitrate }),
        ...(user_limit !== undefined && { userLimit: user_limit }),
        ...(rtc_region && { rtcRegion: rtc_region }),
        ...(video_quality_mode && { videoQualityMode: video_quality_mode === "full" ? 2 : 1 }),
        ...(default_auto_archive_duration && { defaultAutoArchiveDuration: Number(default_auto_archive_duration) }),
        ...(default_thread_slowmode !== undefined && { defaultThreadRateLimitPerUser: default_thread_slowmode }),
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
      bitrate: z.number().optional().describe("Bitrate in bits/sec for voice channels (e.g. 64000)"),
      user_limit: z.number().optional().describe("Max users for voice channels (0 for unlimited)"),
      rtc_region: z.string().nullable().optional().describe("Voice region override for voice channels (null for automatic)"),
      video_quality_mode: z.enum(["auto", "full"]).optional().describe("Video quality mode for voice channels"),
      default_auto_archive_duration: z.enum(["60", "1440", "4320", "10080"]).optional().describe("Default auto-archive duration for new threads (minutes)"),
      default_thread_slowmode: z.number().optional().describe("Default slowmode for new threads in seconds (0 to disable)"),
    }),
    execute: async ({ channel_id, name, topic, parent_id, nsfw, slowmode, position, bitrate, user_limit, rtc_region, video_quality_mode, default_auto_archive_duration, default_thread_slowmode }) => {
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
        ...(bitrate !== undefined && { bitrate }),
        ...(user_limit !== undefined && { userLimit: user_limit }),
        ...(rtc_region !== undefined && { rtcRegion: rtc_region }),
        ...(video_quality_mode && { videoQualityMode: video_quality_mode === "full" ? 2 : 1 }),
        ...(default_auto_archive_duration && { defaultAutoArchiveDuration: Number(default_auto_archive_duration) }),
        ...(default_thread_slowmode !== undefined && { defaultThreadRateLimitPerUser: default_thread_slowmode }),
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
      icon: z.string().optional().describe("Role icon image URL (requires server boost level 2+)"),
      unicode_emoji: z.string().optional().describe("Unicode emoji for the role icon (alternative to image icon)"),
    }),
    execute: async ({ name, color, hoist, mentionable, position, icon, unicode_emoji }) => {
      const denied = perms.server(PermissionFlagsBits.ManageRoles);
      if (denied) return denied;
      const role = await guild.roles.create({
        name,
        ...(color && { colors: { primaryColor: color as ColorResolvable } }),
        ...(hoist !== undefined && { hoist }),
        ...(mentionable !== undefined && { mentionable }),
        ...(position !== undefined && { position }),
        ...(icon && { icon }),
        ...(unicode_emoji && { unicodeEmoji: unicode_emoji }),
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
      icon: z.string().nullable().optional().describe("Role icon image URL (requires server boost level 2+, null to remove)"),
      unicode_emoji: z.string().nullable().optional().describe("Unicode emoji for the role icon (alternative to image icon, null to remove)"),
    }),
    execute: async ({ role_id, name, color, hoist, mentionable, position, icon, unicode_emoji }) => {
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
        ...(icon !== undefined && { icon }),
        ...(unicode_emoji !== undefined && { unicodeEmoji: unicode_emoji }),
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
      status: z.enum(["scheduled", "active", "completed", "canceled"]).optional().describe("New event status (e.g. 'active' to start, 'completed' or 'canceled' to end)"),
      channel_id: z.string().nullable().optional().describe("Voice/stage channel ID (null to clear, for voice/stage events)"),
    }),
    execute: async ({ event_id, name, description, scheduled_start, scheduled_end, location, image, status, channel_id }) => {
      const denied = perms.server(PermissionFlagsBits.ManageEvents);
      if (denied) return denied;
      const event = await guild.scheduledEvents.fetch(event_id);
      if (!event) return json({ error: "Event not found" });
      const statusMap: Record<string, number> = { scheduled: 1, active: 2, completed: 3, canceled: 4 };
      const edited = await event.edit({
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(scheduled_start && { scheduledStartTime: scheduled_start }),
        ...(scheduled_end && { scheduledEndTime: scheduled_end }),
        ...(location && { entityMetadata: { location } }),
        ...(image && { image }),
        ...(status && { status: statusMap[status] }),
        ...(channel_id !== undefined && { channel: channel_id }),
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

// ---------------------------------------------------------------------------
// Skill: threads
// ---------------------------------------------------------------------------

function summarizeThread(thread: ThreadChannel) {
  return {
    id: thread.id,
    name: thread.name,
    parentId: thread.parentId,
    archived: thread.archived ?? false,
    locked: thread.locked ?? false,
    autoArchiveDuration: thread.autoArchiveDuration,
    messageCount: thread.messageCount ?? 0,
    memberCount: thread.memberCount ?? 0,
    createdAt: thread.createdAt?.toISOString() ?? null,
    type: channelTypeName(thread.type),
  };
}

export function createListThreadsTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "List active and/or archived threads in the server or a specific channel.",
    inputSchema: z.object({
      channel_id: z.string().optional().describe("Channel ID to list threads from (omit for all server threads)"),
      include_archived: z.boolean().default(false).describe("Include archived threads"),
    }),
    execute: async ({ channel_id, include_archived }) => {
      if (channel_id) {
        const channel = await guild.channels.fetch(channel_id);
        if (!channel) return json({ error: "Channel not found" });
        const denied = perms.channel(channel, PermissionFlagsBits.ViewChannel);
        if (denied) return denied;
        if (!("threads" in channel)) return json({ error: "This channel type does not support threads" });
        const cached = [...channel.threads.cache.values()];
        const threads = cached.filter((t) => !t.archived).map(summarizeThread);
        if (include_archived) {
          const fetched = await channel.threads.fetchArchived();
          threads.push(...[...fetched.threads.values()].map(summarizeThread));
        }
        return json(threads);
      }
      const active = await guild.channels.fetchActiveThreads();
      const threads = [...active.threads.values()].map(summarizeThread);
      return json(threads);
    },
  });
}

export function createCreateThreadTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Create a new thread in a channel, optionally starting from an existing message.",
    inputSchema: z.object({
      channel_id: z.string().describe("Channel ID to create the thread in"),
      name: z.string().describe("Thread name"),
      message_id: z.string().optional().describe("Message ID to start the thread from (omit for standalone thread)"),
      auto_archive_duration: z.enum(["60", "1440", "4320", "10080"]).optional().describe("Auto-archive after minutes of inactivity: 60 (1h), 1440 (1d), 4320 (3d), 10080 (7d)"),
      type: z.enum(["public", "private"]).default("public").describe("Thread type (public or private)"),
      slowmode: z.number().optional().describe("Slowmode delay in seconds (0 to disable)"),
      invitable: z.boolean().optional().describe("Whether non-moderators can invite others (private threads only)"),
    }),
    execute: async ({ channel_id, name, message_id, auto_archive_duration, type, slowmode, invitable }) => {
      const channel = await guild.channels.fetch(channel_id);
      if (!channel) return json({ error: "Channel not found" });
      const denied = perms.channel(channel, PermissionFlagsBits.ManageThreads)
        ?? perms.channel(channel, PermissionFlagsBits.SendMessages);
      if (denied) return denied;
      if (!channel.isTextBased() || channel.isThread()) return json({ error: "Cannot create a thread in this channel type" });
      if (!("threads" in channel)) return json({ error: "This channel type does not support threads" });
      const archiveDuration = auto_archive_duration ? (Number(auto_archive_duration) as 60 | 1440 | 4320 | 10080) : undefined;
      const commonOpts = {
        ...(archiveDuration && { autoArchiveDuration: archiveDuration }),
        ...(slowmode !== undefined && { rateLimitPerUser: slowmode }),
      };
      let thread: ThreadChannel;
      if (message_id) {
        thread = await channel.threads.create({
          name,
          startMessage: message_id,
          ...commonOpts,
        });
      } else {
        const threadType = type === "private" ? ChannelType.PrivateThread : ChannelType.PublicThread;
        thread = await (channel.threads as any).create({
          name,
          type: threadType,
          ...commonOpts,
          ...(invitable !== undefined && type === "private" && { invitable }),
        });
      }
      return json(summarizeThread(thread));
    },
  });
}

export function createEditThreadTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Edit a thread's settings (name, archived, locked, auto-archive duration, slowmode, invitable).",
    inputSchema: z.object({
      thread_id: z.string().describe("Thread ID"),
      name: z.string().optional().describe("New thread name"),
      archived: z.boolean().optional().describe("Archive or unarchive the thread"),
      locked: z.boolean().optional().describe("Lock or unlock the thread (prevents non-moderators from unarchiving)"),
      auto_archive_duration: z.enum(["60", "1440", "4320", "10080"]).optional().describe("Auto-archive after minutes of inactivity"),
      slowmode: z.number().optional().describe("Slowmode delay in seconds (0 to disable)"),
      invitable: z.boolean().optional().describe("Whether non-moderators can invite others to the thread (private threads only)"),
    }),
    execute: async ({ thread_id, name, archived, locked, auto_archive_duration, slowmode, invitable }) => {
      const thread = await guild.channels.fetch(thread_id);
      if (!thread || !thread.isThread()) return json({ error: "Thread not found" });
      const denied = perms.channel(thread, PermissionFlagsBits.ManageThreads);
      if (denied) return denied;
      const edited = await thread.edit({
        ...(name && { name }),
        ...(archived !== undefined && { archived }),
        ...(locked !== undefined && { locked }),
        ...(auto_archive_duration && { autoArchiveDuration: Number(auto_archive_duration) as 60 | 1440 | 4320 | 10080 }),
        ...(slowmode !== undefined && { rateLimitPerUser: slowmode }),
        ...(invitable !== undefined && { invitable }),
      });
      return json(summarizeThread(edited));
    },
  });
}

export function createDeleteThreadTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Delete a thread. This is irreversible.",
    inputSchema: z.object({
      thread_id: z.string().describe("Thread ID to delete"),
    }),
    execute: async ({ thread_id }) => {
      const thread = await guild.channels.fetch(thread_id);
      if (!thread || !thread.isThread()) return json({ error: "Thread not found" });
      const denied = perms.channel(thread, PermissionFlagsBits.ManageThreads);
      if (denied) return denied;
      const name = thread.name;
      await thread.delete();
      return json({ success: true, deleted: name });
    },
  });
}

// ---------------------------------------------------------------------------
// Skill: emojis (emojis + stickers)
// ---------------------------------------------------------------------------

export function createListEmojisTool(guild: Guild) {
  return tool({
    description: "List all custom emojis in the server.",
    inputSchema: z.object({}),
    execute: async () => {
      const emojis = await guild.emojis.fetch();
      return json(
        [...emojis.values()].map((e) => ({
          id: e.id,
          name: e.name,
          animated: e.animated ?? false,
          url: e.imageURL(),
          roles: e.roles.cache.map((r) => ({ id: r.id, name: r.name })),
          createdAt: e.createdAt?.toISOString() ?? null,
        })),
      );
    },
  });
}

export function createCreateEmojiTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Create a custom emoji from an image URL.",
    inputSchema: z.object({
      name: z.string().describe("Emoji name (2-32 characters, alphanumeric and underscores only)"),
      url: z.string().describe("Image URL for the emoji (PNG, JPG, or GIF; max 256KB)"),
      roles: z.array(z.string()).optional().describe("Role IDs that can use this emoji (omit for everyone)"),
    }),
    execute: async ({ name, url, roles }) => {
      const denied = perms.server(PermissionFlagsBits.ManageGuildExpressions);
      if (denied) return denied;
      const emoji = await guild.emojis.create({
        name,
        attachment: url,
        ...(roles && { roles }),
      });
      return json({
        id: emoji.id,
        name: emoji.name,
        animated: emoji.animated ?? false,
        url: emoji.imageURL(),
      });
    },
  });
}

export function createEditEmojiTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Edit a custom emoji's name or role restrictions.",
    inputSchema: z.object({
      emoji_id: z.string().describe("Emoji ID"),
      name: z.string().optional().describe("New emoji name"),
      roles: z.array(z.string()).optional().describe("New role IDs that can use this emoji (empty array for everyone)"),
    }),
    execute: async ({ emoji_id, name, roles }) => {
      const denied = perms.server(PermissionFlagsBits.ManageGuildExpressions);
      if (denied) return denied;
      const emoji = await guild.emojis.fetch(emoji_id);
      if (!emoji) return json({ error: "Emoji not found" });
      const edited = await emoji.edit({
        ...(name && { name }),
        ...(roles && { roles }),
      });
      return json({
        id: edited.id,
        name: edited.name,
        animated: edited.animated ?? false,
        url: edited.imageURL(),
        roles: edited.roles.cache.map((r) => ({ id: r.id, name: r.name })),
      });
    },
  });
}

export function createDeleteEmojiTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Delete a custom emoji. This is irreversible.",
    inputSchema: z.object({
      emoji_id: z.string().describe("Emoji ID to delete"),
    }),
    execute: async ({ emoji_id }) => {
      const denied = perms.server(PermissionFlagsBits.ManageGuildExpressions);
      if (denied) return denied;
      const emoji = await guild.emojis.fetch(emoji_id);
      if (!emoji) return json({ error: "Emoji not found" });
      const name = emoji.name;
      await emoji.delete();
      return json({ success: true, deleted: name });
    },
  });
}

export function createListStickersTool(guild: Guild) {
  return tool({
    description: "List all custom stickers in the server.",
    inputSchema: z.object({}),
    execute: async () => {
      const stickers = await guild.stickers.fetch();
      return json(
        [...stickers.values()].map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          tags: s.tags,
          format: s.format,
          url: s.url,
          createdAt: s.createdAt?.toISOString() ?? null,
        })),
      );
    },
  });
}

export function createCreateStickerTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Create a custom sticker from an image URL.",
    inputSchema: z.object({
      name: z.string().describe("Sticker name (2-30 characters)"),
      description: z.string().optional().describe("Sticker description"),
      tags: z.string().describe("Autocomplete/suggestion tag for the sticker (related emoji name)"),
      url: z.string().describe("Image URL for the sticker (PNG, APNG, or Lottie JSON; max 512KB, 320x320 recommended)"),
    }),
    execute: async ({ name, description, tags, url }) => {
      const denied = perms.server(PermissionFlagsBits.ManageGuildExpressions);
      if (denied) return denied;
      const sticker = await guild.stickers.create({
        name,
        tags,
        file: url,
        ...(description && { description }),
      });
      return json({
        id: sticker.id,
        name: sticker.name,
        description: sticker.description,
        tags: sticker.tags,
        url: sticker.url,
      });
    },
  });
}

export function createEditStickerTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Edit a custom sticker's name, description, or tag.",
    inputSchema: z.object({
      sticker_id: z.string().describe("Sticker ID"),
      name: z.string().optional().describe("New sticker name"),
      description: z.string().nullable().optional().describe("New description (null to clear)"),
      tags: z.string().optional().describe("New autocomplete/suggestion tag"),
    }),
    execute: async ({ sticker_id, name, description, tags }) => {
      const denied = perms.server(PermissionFlagsBits.ManageGuildExpressions);
      if (denied) return denied;
      const sticker = await guild.stickers.fetch(sticker_id);
      if (!sticker) return json({ error: "Sticker not found" });
      const edited = await sticker.edit({
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(tags && { tags }),
      });
      return json({
        id: edited.id,
        name: edited.name,
        description: edited.description,
        tags: edited.tags,
        url: edited.url,
      });
    },
  });
}

export function createDeleteStickerTool(guild: Guild, perms: Permissions) {
  return tool({
    description: "Delete a custom sticker. This is irreversible.",
    inputSchema: z.object({
      sticker_id: z.string().describe("Sticker ID to delete"),
    }),
    execute: async ({ sticker_id }) => {
      const denied = perms.server(PermissionFlagsBits.ManageGuildExpressions);
      if (denied) return denied;
      const sticker = await guild.stickers.fetch(sticker_id);
      if (!sticker) return json({ error: "Sticker not found" });
      const name = sticker.name;
      await sticker.delete();
      return json({ success: true, deleted: name });
    },
  });
}
