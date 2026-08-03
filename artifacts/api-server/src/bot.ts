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
      // 1. Kiểm tra xem có đang nhắn trong Server không
      if (!message.guild) {
        await message.reply("Lệnh này chỉ có thể sử dụng trong Server!");
        return;
      }

      const member = message.member;
      const me = message.guild.members.me;

      if (!member || !me) return;

      const userHighestRole = member.roles.highest;
      const botHighestRole = me.roles.highest;

      // 2. Kiểm tra nếu Role người dùng thấp hơn hoặc bằng Role của Bot (và không phải Chủ Server)
      const isServerOwner = message.author.id === message.guild.ownerId;

      if (userHighestRole.position <= botHighestRole.position && !isServerOwner) {
        await message.reply(
          "❌ Bạn phải có Role nằm cao hơn Role của Bot mới được dùng lệnh!",
        );
        return;
      }

      // 3. Đủ điều kiện — chạy lệnh spam
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
        if (count >= 50) {
          clearInterval(interval);
          return;
        }
        message.channel
          .send(`con tuat chui vào bụng mẹ trốn à 😂 ${mentionedUser}`)
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
