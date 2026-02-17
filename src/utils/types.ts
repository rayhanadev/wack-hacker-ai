import type { GuildTextBasedChannel } from "discord.js";

export type AttachmentInfo = {
  url: string;
  name: string;
  contentType: string;
};

export interface ApprovalContext {
  /** Channel where the approval prompt will be sent. */
  channel: GuildTextBasedChannel;
  /** Restrict who can click the buttons (omit = anyone). */
  userId?: string;
  /** Timeout in ms before auto-deny (default 60 000). */
  timeout?: number;
}

export interface ApprovalResult {
  approved: boolean;
  userId?: string;
}
