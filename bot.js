import {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AuditLogEvent,
} from "discord.js";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "verify-state.json");
const CONFIG_FILE = path.join(__dirname, "saved-configs.json");
const ANTINUKE_FILE = path.join(__dirname, "antinuke-state.json");
const VERIFY_ROLE_NAME = "verify";
const VERIFY_CHANNEL_NAME = "verify";
const VERIFY_EMOJI = "✅";
const ANTINUKE_LOG_CHANNEL_NAME = "wxz-log";

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")); } catch { return null; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
const loadState = () => loadJSON(STATE_FILE) ?? {};
const saveState = (s) => saveJSON(STATE_FILE, s);
const loadConfigs = () => loadJSON(CONFIG_FILE) ?? {};
const saveConfigs = (c) => saveJSON(CONFIG_FILE, c);
const loadAntinuke = () => loadJSON(ANTINUKE_FILE);
const saveAntinuke = (a) => saveJSON(ANTINUKE_FILE, a);

const token = process.env["DISCORD_TOKEN"];
if (!token) {
  console.error("DISCORD_TOKEN not set");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

let isRestoring = false;

/** Kiểm tra quyền: user phải là chủ server HOẶC có role cao hơn bot. */
function hasPermission(guild, member, authorId) {
  const me = guild.members.me;
  if (!me) return false;
  return (
    authorId === guild.ownerId ||
    member.roles.highest.position > me.roles.highest.position
  );
}

const slashCommands = [
  new SlashCommandBuilder()
    .setName("saveconfig")
    .setDescription("Lưu cấu trúc server hiện tại (kênh, quyền, thứ tự...) để phục hồi sau này")
    .addStringOption((opt) =>
      opt.setName("ten").setDescription("Đặt tên cho bản lưu này").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("setconfig")
    .setDescription("Phục hồi server theo cấu hình đã lưu — XOÁ hết kênh hiện tại")
    .addStringOption((opt) =>
      opt.setName("ten").setDescription("Tên bản lưu muốn phục hồi").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("antinuke")
    .setDescription("Kích hoạt bẫy chống nuke: tạo kênh log, tự xử lý khi kênh đó bị xoá")
    .addStringOption((opt) =>
      opt.setName("hanhdong")
        .setDescription("Xử lý người xoá kênh log")
        .setRequired(true)
        .addChoices({ name: "Kick", value: "kick" }, { name: "Ban", value: "ban" }),
    )
    .addStringOption((opt) =>
      opt.setName("config")
        .setDescription("Tên bản cấu hình đã lưu (từ /saveconfig) để tự động khôi phục")
        .setRequired(true),
    ),
].map((cmd) => cmd.toJSON());

client.on("clientReady", async (readyClient) => {
  console.log(`Bot online: ${readyClient.user.tag}`);
  try {
    const rest = new REST().setToken(token);
    await rest.put(Routes.applicationCommands(readyClient.user.id), { body: slashCommands });
    console.log("Slash commands registered");
  } catch (err) {
    console.error("Failed to register slash commands", err);
  }
});

// ── Chụp lại toàn bộ cấu trúc server thành object ────────────────────────
function captureGuildConfig(guild) {
  const sorted = [...guild.channels.cache.values()]
    .filter((c) => c.name !== ANTINUKE_LOG_CHANNEL_NAME) // không lưu kênh bẫy
    .sort((a, b) => a.position - b.position);
  const categories = [];
  const channels = [];

  for (const channel of sorted) {
    const overwrites = [...channel.permissionOverwrites.cache.values()].map((ow) => ({
      id: ow.id, type: ow.type,
      allow: ow.allow.bitfield.toString(),
      deny: ow.deny.bitfield.toString(),
    }));

    if (channel.type === ChannelType.GuildCategory) {
      categories.push({ name: channel.name, overwrites });
    } else {
      channels.push({
        name: channel.name, type: channel.type,
        parentName: channel.parent?.name ?? null,
        topic: "topic" in channel ? (channel.topic ?? null) : null,
        overwrites,
      });
    }
  }
  return { guildName: guild.name, categories, channels, savedAt: new Date().toISOString(), savedBy: null };
}

function buildPermissionOptions(allowStr, denyStr) {
  const allow = BigInt(allowStr);
  const deny = BigInt(denyStr);
  const options = {};
  for (const [name, flag] of Object.entries(PermissionFlagsBits)) {
    const bit = BigInt(flag);
    if ((allow & bit) === bit) options[name] = true;
    else if ((deny & bit) === bit) options[name] = false;
  }
  return options;
}

// ── Xoá hết kênh hiện tại và dựng lại theo cấu hình đã lưu ──────────────
async function restoreGuildConfig(guild, config) {
  isRestoring = true;
  try {
    const existing = [...guild.channels.cache.values()];
    for (const channel of existing) {
      await channel.delete("Restore config").catch(() => {});
    }
    if (config.guildName && config.guildName !== guild.name) {
      await guild.setName(config.guildName).catch(() => {});
    }
    const categoryIdByName = new Map();
    for (const cat of config.categories) {
      const created = await guild.channels.create({ name: cat.name, type: ChannelType.GuildCategory });
      categoryIdByName.set(cat.name, created.id);
      for (const ow of cat.overwrites) {
        await created.permissionOverwrites.create(ow.id, buildPermissionOptions(ow.allow, ow.deny)).catch(() => {});
      }
    }
    for (const ch of config.channels) {
      const created = await guild.channels.create({
        name: ch.name, type: ch.type,
        parent: ch.parentName ? categoryIdByName.get(ch.parentName) : undefined,
        topic: ch.topic ?? undefined,
      });
      for (const ow of ch.overwrites) {
        await created.permissionOverwrites.create(ow.id, buildPermissionOptions(ow.allow, ow.deny)).catch(() => {});
      }
    }
  } finally {
    isRestoring = false;
  }
}

// ── Danh sách lệnh text ───────────────────────────────────────────────
const TEXT_COMMANDS = ["!verifysetup"];

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();
  const isKnownCommand = TEXT_COMMANDS.some((cmd) => content === cmd || content.startsWith(cmd + " "));
  if (!isKnownCommand) return;

  if (!message.guild || !message.member) {
    await message.reply("Lệnh này chỉ dùng được trong Server!");
    return;
  }
  if (!hasPermission(message.guild, message.member, message.author.id)) {
    await message.reply("❌ Bạn phải có Role cao hơn Bot mới được dùng lệnh này!");
    return;
  }

  if (content === "!verifysetup") {
    const guild = message.guild;
    await message.reply("⏳ Đang thiết lập hệ thống verify, chờ chút...");
    try {
      let verifyRole = guild.roles.cache.find((r) => r.name === VERIFY_ROLE_NAME);
      if (!verifyRole) {
        verifyRole = await guild.roles.create({ name: VERIFY_ROLE_NAME, reason: "Thiết lập verify" });
      }
      let verifyChannel = guild.channels.cache.find(
        (c) => c.name === VERIFY_CHANNEL_NAME && c.type === ChannelType.GuildText,
      );
      if (!verifyChannel) {
        verifyChannel = await guild.channels.create({
          name: VERIFY_CHANNEL_NAME, type: ChannelType.GuildText, reason: "Thiết lập verify",
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: verifyRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          ],
        });
      }
      for (const [, channel] of guild.channels.cache) {
        if (channel.id === verifyChannel.id) continue;
        try { await channel.permissionOverwrites.edit(verifyRole, { ViewChannel: false }); } catch {}
      }
      const verifyMessage = await verifyChannel.send(
        `👋 Chào mừng! Vui lòng ấn vào ${VERIFY_EMOJI} bên dưới để xác minh và mở khoá toàn bộ server.`,
      );
      await verifyMessage.react(VERIFY_EMOJI);
      saveState({ channelId: verifyChannel.id, messageId: verifyMessage.id });
      await message.channel.send("✅ Đã thiết lập xong hệ thống verify!");
    } catch (err) {
      console.error(err);
      await message.channel.send("❌ Lỗi — kiểm tra bot có quyền Manage Roles & Manage Channels không.");
    }
  }
});

// ── Slash commands + nút xác nhận ───────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    if (!interaction.customId.startsWith("setconfig_confirm_")) return;
    const name = interaction.customId.replace("setconfig_confirm_", "");
    const configs = loadConfigs();
    const config = configs[name];
    if (!config) {
      await interaction.update({ content: "❌ Không tìm thấy bản lưu này nữa.", components: [] });
      return;
    }
    await interaction.update({ content: `⏳ Đang phục hồi cấu hình "${name}"...`, components: [] });
    try {
      await restoreGuildConfig(interaction.guild, config);
      await interaction.followUp(`✅ Đã phục hồi xong cấu hình "${name}"!`);
    } catch (err) {
      console.error(err);
      await interaction.followUp("❌ Có lỗi khi phục hồi — kiểm tra quyền bot.");
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) {
    await interaction.reply({ content: "Lệnh này chỉ dùng được trong Server!", ephemeral: true });
    return;
  }
  const guildMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!guildMember || !hasPermission(interaction.guild, guildMember, interaction.user.id)) {
    await interaction.reply({ content: "❌ Bạn phải có Role cao hơn Bot mới được dùng lệnh này!", ephemeral: true });
    return;
  }

  const { commandName } = interaction;

  if (commandName === "saveconfig") {
    const name = interaction.options.getString("ten");
    await interaction.deferReply();
    try {
      const config = captureGuildConfig(interaction.guild);
      config.savedBy = interaction.user.tag;
      const configs = loadConfigs();
      configs[name] = config;
      saveConfigs(configs);
      await interaction.editReply(
        `✅ Đã lưu cấu hình **${name}** (${config.channels.length} kênh, ${config.categories.length} danh mục).`,
      );
    } catch (err) {
      console.error(err);
      await interaction.editReply("❌ Có lỗi khi lưu cấu hình.");
    }
  }

  if (commandName === "setconfig") {
    const name = interaction.options.getString("ten");
    const configs = loadConfigs();
    const config = configs[name];
    if (!config) {
      await interaction.reply({
        content: `❌ Không tìm thấy bản lưu "${name}". Các bản đã lưu: ${Object.keys(configs).join(", ") || "(chưa có)"}`,
        ephemeral: true,
      });
      return;
    }
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`setconfig_confirm_${name}`)
        .setLabel("⚠️ Xác nhận XOÁ hết kênh và phục hồi")
        .setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({
      content: `⚠️ **Cảnh báo:** Sẽ xoá toàn bộ kênh hiện tại và tạo lại theo "${name}". Không thể hoàn tác.`,
      components: [row],
    });
  }

  if (commandName === "antinuke") {
    const action = interaction.options.getString("hanhdong");
    const configName = interaction.options.getString("config");
    const configs = loadConfigs();
    if (!configs[configName]) {
      await interaction.reply({
        content: `❌ Không tìm thấy bản lưu "${configName}". Chạy /saveconfig trước.`,
        ephemeral: true,
      });
      return;
    }
    await interaction.deferReply();
    try {
      const guild = interaction.guild;
      let logChannel = guild.channels.cache.find((c) => c.name === ANTINUKE_LOG_CHANNEL_NAME);
      if (!logChannel) {
        logChannel = await guild.channels.create({
          name: ANTINUKE_LOG_CHANNEL_NAME, type: ChannelType.GuildText, reason: "Kích hoạt anti-nuke",
          permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
        });
      }
      saveAntinuke({ channelId: logChannel.id, action, configName });
      await interaction.editReply(
        `✅ Đã kích hoạt anti-nuke. Kênh bẫy: #${ANTINUKE_LOG_CHANNEL_NAME}. Nếu bị xoá, người xoá bị **${action}**, server tự khôi phục theo "${configName}".`,
      );
    } catch (err) {
      console.error(err);
      await interaction.editReply("❌ Có lỗi khi kích hoạt anti-nuke.");
    }
  }
});

client.on("guildMemberAdd", async (member) => {
  const verifyRole = member.guild.roles.cache.find((r) => r.name === VERIFY_ROLE_NAME);
  if (!verifyRole) return;
  await member.roles.add(verifyRole).catch(console.error);
});

client.on("channelCreate", async (channel) => {
  if (!channel.guild) return;
  const state = loadState();
  const verifyRole = channel.guild.roles.cache.find((r) => r.name === VERIFY_ROLE_NAME);
  if (!verifyRole || channel.id === state.channelId) return;
  await channel.permissionOverwrites.edit(verifyRole, { ViewChannel: false }).catch(() => {});
});

// ── Anti-nuke: kênh bẫy bị xoá ───────────────────────────────────────────
client.on("channelDelete", async (channel) => {
  if (isRestoring) return;
  const antinuke = loadAntinuke();
  if (!antinuke || channel.id !== antinuke.channelId) return;
  const guild = channel.guild;
  if (!guild) return;

  try {
    const auditLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 5 });
    const entry = auditLogs.entries.find(
      (e) => e.target?.id === channel.id && Date.now() - e.createdTimestamp < 10000,
    );
    if (!entry || entry.executor.id === client.user.id) return; // không rõ ai, hoặc chính bot đang restore

    const executorMember = await guild.members.fetch(entry.executor.id).catch(() => null);
    if (executorMember) {
      const reason = "Anti-nuke: xoá kênh log bảo vệ";
      if (antinuke.action === "ban") {
        await executorMember.ban({ reason }).catch((e) => console.error("Ban thất bại:", e));
      } else {
        await executorMember.kick(reason).catch((e) => console.error("Kick thất bại:", e));
      }
    }

    const configs = loadConfigs();
    const config = configs[antinuke.configName];
    if (config) await restoreGuildConfig(guild, config);
  } catch (err) {
    console.error("Anti-nuke error:", err);
  }
});

client.on("messageReactionAdd", async (reaction, user) => {
  if (user.bot) return;
  const state = loadState();
  if (reaction.message.id !== state.messageId || reaction.emoji.name !== VERIFY_EMOJI) return;
  if (reaction.partial) await reaction.fetch().catch(() => {});
  const guild = reaction.message.guild;
  if (!guild) return;
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;
  const verifyRole = guild.roles.cache.find((r) => r.name === VERIFY_ROLE_NAME);
  if (verifyRole && member.roles.cache.has(verifyRole.id)) {
    await member.roles.remove(verifyRole).catch(console.error);
  }
});

client.login(token).catch(console.error);
