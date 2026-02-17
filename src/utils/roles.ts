import type { GuildMember } from "discord.js";
import { ORGANIZER_ROLE_ID } from "./constants";

/** Check if a GuildMember has the organizer role. */
export function isOrganizer(member: GuildMember): boolean {
  return member.roles.cache.has(ORGANIZER_ROLE_ID);
}
