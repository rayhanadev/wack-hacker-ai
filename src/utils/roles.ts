import type { GuildMember } from "discord.js";

/** Discord role ID for Purdue Hackers organizers. */
export const ORGANIZER_ROLE_ID = "1012751663322382438";

/** Check if a GuildMember has the organizer role. */
export function isOrganizer(member: GuildMember): boolean {
  return member.roles.cache.has(ORGANIZER_ROLE_ID);
}
