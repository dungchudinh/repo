import { Client, GatewayIntentBits } from "discord.js";
import { logger } from "./lib/logger";
import { getSpamMessage, setSpamMessage } from "./bot-config";

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

  // Map<targetUserId, intervalId> — tracks all active spam loops
  const activeSpams = new Map<string, ReturnType<typeof setInterval>>();

  /** Check role permission: user must be server owner OR have a role higher than the bot. */
  function hasPermission(
    guild: import("discord.js").Guild,
    member: import("discord.js").GuildMember,
    authorId: string,
  ) {
    const me = guild.members.me;
    if (!me) return false;
    const isServerOwner = authorId === guild.ownerId;
    return (
      isServerOwner ||
      member.roles.highest.position > me.roles.highest.position
    );
  }

  client.on("ready", () => {
    logger.info({ tag: client.user?.tag }, "Discord bot is online");
  });

  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    const content = message.content.trim();

    // ── !spam ──────────────────────────────────────────────────────────────
    if (content.startsWith("!spam") && !content.startsWith("!unspam")) {
      if (!message.guild) {
        await message.reply("Lệnh này chỉ có thể sử dụng trong Server!");
        return;
      }

      const member = message.member;
      if (!member) return;

      if (!hasPermission(message.guild, member, message.author.id)) {
        await message.reply(
          "❌ Bạn phải có Role nằm cao hơn Role của Bot mới được dùng lệnh!",
        );
        return;
      }

      const mentionedUser = message.mentions.users.first();
      if (!mentionedUser) {
        await message.reply(
          "Vui lòng @tag một người dùng! Cú pháp: `!spam @user`",
        );
        return;
      }

      // Cancel any existing spam loop for this target before starting a new one
      const existing = activeSpams.get(mentionedUser.id);
      if (existing !== undefined) {
        clearInterval(existing);
        activeSpams.delete(mentionedUser.id);
      }

      await message.channel.send(`Đã kích hoạt spam nhắc nhở ${mentionedUser}!`);

      let count = 0;
      const interval = setInterval(() => {
        // Stop if unspam was called or we hit 50 messages
        if (!activeSpams.has(mentionedUser.id) || count >= 50) {
          clearInterval(interval);
          activeSpams.delete(mentionedUser.id);
          return;
        }
        message.channel
          .send(`${getSpamMessage()} ${mentionedUser}`)
          .catch((err: unknown) =>
            logger.error({ err }, "Failed to send spam message"),
          );
        count++;
      }, 2000);

      activeSpams.set(mentionedUser.id, interval);
    }

    // ── !unspam ────────────────────────────────────────────────────────────
    else if (content.startsWith("!unspam")) {
      if (!message.guild) {
        await message.reply("Lệnh này chỉ có thể sử dụng trong Server!");
        return;
      }

      const member = message.member;
      if (!member) return;

      if (!hasPermission(message.guild, member, message.author.id)) {
        await message.reply(
          "❌ Bạn phải có Role nằm cao hơn Role của Bot mới được dùng lệnh!",
        );
        return;
      }

      const mentionedUser = message.mentions.users.first();

      if (mentionedUser) {
        const interval = activeSpams.get(mentionedUser.id);
        if (interval !== undefined) {
          clearInterval(interval);
          activeSpams.delete(mentionedUser.id);
          await message.channel.send(`còn gà lắm ${mentionedUser}`);
        } else {
          await message.reply(`Không có spam nào đang chạy cho ${mentionedUser}.`);
        }
      } else {
        if (activeSpams.size === 0) {
          await message.reply("Không có spam nào đang chạy.");
          return;
        }
        for (const [, interval] of activeSpams) {
          clearInterval(interval);
        }
        activeSpams.clear();
        await message.channel.send("còn gà lắm 😂");
      }
    }

    // ── !caidat ────────────────────────────────────────────────────────────
    else if (content.startsWith("!caidat")) {
      if (!message.guild) {
        await message.reply("Lệnh này chỉ có thể sử dụng trong Server!");
        return;
      }

      const member = message.member;
      if (!member) return;

      if (!hasPermission(message.guild, member, message.author.id)) {
        await message.reply(
          "❌ Bạn phải có Role nằm cao hơn Role của Bot mới được dùng lệnh!",
        );
        return;
      }

      const newMessage = content.slice("!caidat".length).trim();
      if (!newMessage) {
        await message.reply(
          `ℹ️ Nội dung spam hiện tại: \`${getSpamMessage()}\`\nCú pháp đổi: \`!caidat [nội dung mới]\``,
        );
        return;
      }

      setSpamMessage(newMessage);
      await message.reply(
        `✅ Đã cập nhật nội dung spam thành: \`${newMessage}\``,
      );
    }
  });

  client.login(token).catch((err: unknown) => {
    logger.error({ err }, "Failed to log in to Discord");
  });
}
