import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Guild,
  GuildMember,
} from "discord.js";
import { logger } from "./lib/logger";
import {
  getSpamMessage,
  setSpamMessage,
  getSpamCount,
  setSpamCount,
} from "./bot-config";

// ── Slash command definitions ──────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("caidat")
    .setDescription("Xem hoặc cập nhật cấu hình spam của bot")
    .addStringOption((opt) =>
      opt
        .setName("noidung")
        .setDescription("Nội dung tin nhắn mà bot sẽ spam")
        .setRequired(false),
    )
    .addIntegerOption((opt) =>
      opt
        .setName("solan")
        .setDescription("Số lần bot sẽ spam (tối đa 5000)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(5000),
    ),
].map((cmd) => cmd.toJSON());

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
  function hasPermission(guild: Guild, member: GuildMember, authorId: string) {
    const me = guild.members.me;
    if (!me) return false;
    const isServerOwner = authorId === guild.ownerId;
    return (
      isServerOwner ||
      member.roles.highest.position > me.roles.highest.position
    );
  }

  // ── Ready: register slash commands globally ──────────────────────────────
  client.on("clientReady", async (readyClient) => {
    logger.info({ tag: readyClient.user.tag }, "Discord bot is online");

    try {
      const rest = new REST().setToken(token);
      await rest.put(Routes.applicationCommands(readyClient.user.id), {
        body: commands,
      });
      logger.info("Slash commands registered successfully");
    } catch (err) {
      logger.error({ err }, "Failed to register slash commands");
    }
  });

  // ── Slash command interactions ───────────────────────────────────────────
  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild, member } = interaction as ChatInputCommandInteraction & {
      guild: Guild | null;
      member: GuildMember | null;
    };

    if (commandName === "caidat") {
      if (!guild || !member) {
        await interaction.reply({
          content: "Lệnh này chỉ có thể sử dụng trong Server!",
          ephemeral: true,
        });
        return;
      }

      // member from interaction may be APIInteractionGuildMember; fetch the full GuildMember
      const guildMember =
        member instanceof GuildMember
          ? member
          : await guild.members.fetch(interaction.user.id).catch(() => null);

      if (!guildMember) {
        await interaction.reply({ content: "Không thể xác minh quyền hạn.", ephemeral: true });
        return;
      }

      if (!hasPermission(guild, guildMember, interaction.user.id)) {
        await interaction.reply({
          content: "❌ Bạn phải có Role nằm cao hơn Role của Bot mới được dùng lệnh này!",
          ephemeral: true,
        });
        return;
      }

      const noidung = interaction.options.getString("noidung");
      const solan = interaction.options.getInteger("solan");

      // If no options provided — show current settings
      if (!noidung && solan === null) {
        await interaction.reply({
          content:
            `ℹ️ **Cấu hình spam hiện tại:**\n` +
            `• Nội dung: \`${getSpamMessage()}\`\n` +
            `• Số lần: \`${getSpamCount()}\`\n\n` +
            `Dùng \`/caidat noidung:[nội dung]\` hoặc \`/caidat solan:[số]\` để cập nhật.`,
          ephemeral: true,
        });
        return;
      }

      const updates: string[] = [];

      if (noidung) {
        setSpamMessage(noidung);
        updates.push(`Nội dung = \`${noidung}\``);
      }

      if (solan !== null) {
        if (solan > 5000) {
          await interaction.reply({
            content: "❌ Số lần spam tối đa là 5000 lần!",
            ephemeral: true,
          });
          return;
        }
        setSpamCount(solan);
        updates.push(`Số lần = \`${solan}\``);
      }

      await interaction.reply({
        content: `✅ Đã cập nhật: ${updates.join(" | ")}`,
        ephemeral: true,
      });
    }
  });

  // ── Text commands ────────────────────────────────────────────────────────
  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    const content = message.content.trim();

    // ── !spam ────────────────────────────────────────────────────────────
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
      const limit = getSpamCount();
      const interval = setInterval(() => {
        if (!activeSpams.has(mentionedUser.id) || count >= limit) {
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

    // ── !unspam ──────────────────────────────────────────────────────────
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

    // ── !caidat (text fallback) ──────────────────────────────────────────
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
          `ℹ️ Nội dung spam hiện tại: \`${getSpamMessage()}\` | Số lần: \`${getSpamCount()}\`\n` +
          `Dùng \`/caidat\` để cập nhật chi tiết hơn.`,
        );
        return;
      }

      setSpamMessage(newMessage);
      await message.reply(`✅ Đã cập nhật nội dung spam thành: \`${newMessage}\``);
    }
  });

  client.login(token).catch((err: unknown) => {
    logger.error({ err }, "Failed to log in to Discord");
  });
}
