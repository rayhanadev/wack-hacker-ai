import { createClient } from "./bot/client";
import { handleMessage } from "./bot/handlers";
import { env } from "./env";

const client = createClient();

client.on("messageCreate", (message) => {
  handleMessage(message).catch(console.error);
});

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user?.tag}`);
});

void client.login(env.DISCORD_BOT_TOKEN);
