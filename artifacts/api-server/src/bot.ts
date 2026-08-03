import { Client, GatewayIntentBits } from "discord.js";
import { logger } from "./lib/logger";

export function startBot() {
  const token = process.env["DISCORD_TOKEN"];
  if (!token) {
    logger.warn("DISCORD_TOKEN not set — skipping Discord bot startup");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on("ready", () => {
    logger.info({ tag: client.user?.tag }, "Discord bot is online");
  });

  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    if (message.content.startsWith("!spam")) {
      const mentionedUser = message.mentions.users.first();

      if (!mentionedUser) {
        await message.reply(
          "Vui lòng @tag một người dùng! Cú pháp: `!spam @user`",
        );
        return;
      }

      await message.channel.send(
        `Đã kích hoạt spam nhắc nhở ${mentionedUser}!`,
      );

      let count = 0;
      const interval = setInterval(() => {
        if (count >= 5) {
          clearInterval(interval);
          return;
        }
        message.channel
          .send(`Dậy đi ${mentionedUser} ơi!`)
          .catch((err: unknown) =>
            logger.error({ err }, "Failed to send spam message"),
          );
        count++;
      }, 2000);
    }
  });

  client.login(token).catch((err: unknown) => {
    logger.error({ err }, "Failed to log in to Discord");
  });
}
