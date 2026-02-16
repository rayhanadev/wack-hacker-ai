import { Client, GatewayIntentBits } from "discord.js";

/** Create a Discord client with the required intents. */
export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
}
