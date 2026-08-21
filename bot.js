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
  EmbedBuilder,
} from "discord.js";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "verify-state.json");
const CONFIG_FILE = path.join(__dirname, "saved-configs.json");
const ANTINUKE_FILE = path.join(__dirname, "antinuke-state.json");
const HONEYPOT_FILE = path.join(__dirname, "honeypot-state.json");
const VERIFY_ROLE_NAME = "verify";
const VERIFY_CHANNEL_NAME = "verify";
const VERIFY_EMOJI = "✅";
const ANTINUKE_LOG_CHANNEL_NAME = "wxz-log";
const HONEYPOT_CHANNEL_NAME = "honeypot";
const MAX_MUTE_MINUTES = 40320; // 28 ngày — tối đa Discord cho phép

const PROTECTED_CHANNEL_NAMES = new Set([ANTINUKE_LOG_CHANNEL_NAME, HONEYPOT_CHANNEL_NAME]);
function isProtectedChannelName(name) {
  return PROTECTED_CHANNEL_NAMES.has(name);
}

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
const loadHoneypot = () => loadJSON(HONEYPOT_FILE);
const saveHoneypot = (h) => saveJSON(HONEYPOT_FILE, h);

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
    .setDescription("Lưu cấu trúc server hiện tại để phục hồi sau này")
    .addStringOption((opt) =>
      opt.setName("ten").setDescription("Đặt tên cho bản lưu này").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("setconfig")
    .setDescription("Đồng bộ server theo cấu hình đã lưu — kênh giống thì giữ, khác thì xoá và tạo lại")
    .addStringOption((opt) =>
      opt.setName("ten").setDescription("Tên bản lưu muốn phục hồi").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("antinuke")
    .setDescription("Kích hoạt bẫy chống nuke")
    .addStringOption((opt) =>
      opt.setName("hanhdong")
        .setDescription("Xử lý người xoá kênh log")
        .setRequired(true)
        .addChoices(
          { name: "Kick", value: "kick" },
          { name: "Ban", value: "ban" },
          { name: "Mute (Timeout)", value: "mute" },
        ),
    )
    .addStringOption((opt) =>
      opt.setName("config")
        .setDescription("Tên bản cấu hình đã lưu để tự động khôi phục")
        .setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt.setName("thoigian")
        .setDescription("Số phút mute — chỉ dùng khi chọn Mute (mặc định 40320 phút = 28 ngày)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(MAX_MUTE_MINUTES),
    ),
  new SlashCommandBuilder()
    .setName("honeypotsetup")
    .setDescription("Tạo kênh bẫy honeypot — ai nhắn tin vào sẽ bị xử lý tự động")
    .addStringOption((opt) =>
      opt.setName("hanhdong")
        .setDescription("Xử lý người nhắn vào kênh bẫy")
        .setRequired(true)
        .addChoices(
          { name: "Kick", value: "kick" },
          { name: "Ban", value: "ban" },
          { name: "Mute (Timeout)", value: "mute" },
        ),
    )
    .addIntegerOption((opt) =>
      opt.setName("thoigian")
        .setDescription("Số phút mute — chỉ dùng khi chọn Mute (mặc định 40320 phút = 28 ngày)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(MAX_MUTE_MINUTES),
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

function normalizeOverwrites(channel) {
  return [...channel.permissionOverwrites.cache.values()].map((ow) => ({
    id: ow.id,
    type: ow.type,
    allow: ow.allow.bitfield.toString(),
    deny: ow.deny.bitfield.toString(),
  }));
}

function overwritesEqual(a, b) {
  if (a.length !== b.length) return false;
  const byId = (x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  const sa = [...a].sort(byId);
  const sb = [...b].sort(byId);
  return sa.every((ow, i) => ow.id === sb[i].id && ow.type === sb[i].type && ow.allow === sb[i].allow && ow.deny === sb[i].deny);
}

function captureGuildConfig(guild) {
  const sorted = [...guild.channels.cache.values()]
    .filter((c) => !isProtectedChannelName(c.name))
    .sort((a, b) => a.position - b.position);
  const categories = [];
  const channels = [];

  for (const channel of sorted) {
    const overwrites = normalizeOverwrites(channel);
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

const MAX_DELETE_RETRIES = 3;
const MAX_CREATE_RETRIES = 3;
const OP_DELAY_MS = 350;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteChannelWithRetry(channel, log) {
  for (let attempt = 1; attempt <= MAX_DELETE_RETRIES; attempt++) {
    try {
      await channel.delete("Đồng bộ cấu hình");
      return true;
    } catch (err) {
      log.errors.push(`Xoá "${channel.name}" lỗi (lần ${attempt}): ${err.message}`);
      if (attempt === MAX_DELETE_RETRIES) return false;
      await sleep(OP_DELAY_MS * attempt);
    }
  }
  return false;
}

async function createChannelWithRetry(guild, options, log) {
  for (let attempt = 1; attempt <= MAX_CREATE_RETRIES; attempt++) {
    try {
      return await guild.channels.create(options);
    } catch (err) {
      log.errors.push(`Tạo "${options.name}" lỗi (lần ${attempt}): ${err.message}`);
      if (attempt === MAX_CREATE_RETRIES) return null;
      await sleep(OP_DELAY_MS * attempt);
    }
  }
  return null;
}

async function restoreGuildConfig(guild, config) {
  isRestoring = true;
  const log = { kept: 0, deleted: 0, created: 0, errors: [] };
  try {
    const currentChannels = [...(await guild.channels.fetch()).values()]
      .filter((c) => !isProtectedChannelName(c.name));
    const currentCategories = currentChannels.filter((c) => c.type === ChannelType.GuildCategory);
    const currentOthers = currentChannels.filter((c) => c.type !== ChannelType.GuildCategory);

    const keptIds = new Set();

    const usedCategoryIdx = new Set();
    const keptCategoryByConfigName = new Map();
    const categoriesToDelete = [];
    for (const cat of currentCategories) {
      let matched = -1;
      for (let i = 0; i < config.categories.length; i++) {
        if (usedCategoryIdx.has(i)) continue;
        const cfg = config.categories[i];
        if (cat.name === cfg.name && overwritesEqual(normalizeOverwrites(cat), cfg.overwrites)) {
          matched = i;
          break;
        }
      }
      if (matched !== -1) {
        usedCategoryIdx.add(matched);
        keptCategoryByConfigName.set(config.categories[matched].name, cat);
        keptIds.add(cat.id);
        log.kept++;
      } else {
        categoriesToDelete.push(cat);
      }
    }

    const usedChannelIdx = new Set();
    const channelsToDelete = [];
    for (const ch of currentOthers) {
      const chParentName = ch.parent?.name ?? null;
      const chTopic = "topic" in ch ? (ch.topic ?? null) : null;
      let matched = -1;
      for (let i = 0; i < config.channels.length; i++) {
        if (usedChannelIdx.has(i)) continue;
        const cfg = config.channels[i];
        if (
          ch.type === cfg.type &&
          ch.name === cfg.name &&
          chParentName === cfg.parentName &&
          chTopic === (cfg.topic ?? null) &&
          overwritesEqual(normalizeOverwrites(ch), cfg.overwrites)
        ) {
          matched = i;
          break;
        }
      }
      if (matched !== -1) {
        usedChannelIdx.add(matched);
        keptIds.add(ch.id);
        log.kept++;
      } else {
        channelsToDelete.push(ch);
      }
    }

    for (const channel of channelsToDelete) {
      const ok = await deleteChannelWithRetry(channel, log);
      if (ok) log.deleted++;
      await sleep(OP_DELAY_MS);
    }
    for (const channel of categoriesToDelete) {
      const ok = await deleteChannelWithRetry(channel, log);
      if (ok) log.deleted++;
      await sleep(OP_DELAY_MS);
    }

    if (config.guildName && config.guildName !== guild.name) {
      await guild.setName(config.guildName).catch((err) => log.errors.push(`Đổi tên server lỗi: ${err.message}`));
    }

    const categoryIdByName = new Map();
    for (const [name, ch] of keptCategoryByConfigName) categoryIdByName.set(name, ch.id);
    for (let i = 0; i < config.categories.length; i++) {
      if (usedCategoryIdx.has(i)) continue;
      const cat = config.categories[i];
      const created = await createChannelWithRetry(guild, { name: cat.name, type: ChannelType.GuildCategory }, log);
      if (!created) continue;
      log.created++;
      keptIds.add(created.id);
      categoryIdByName.set(cat.name, created.id);
      for (const ow of cat.overwrites) {
        await created.permissionOverwrites.create(ow.id, buildPermissionOptions(ow.allow, ow.deny))
          .catch((err) => log.errors.push(`Set quyền danh mục "${cat.name}" lỗi: ${err.message}`));
      }
      await sleep(OP_DELAY_MS);
    }

    for (let i = 0; i < config.channels.length; i++) {
      if (usedChannelIdx.has(i)) continue;
      const ch = config.channels[i];
      const created = await createChannelWithRetry(guild, {
        name: ch.name, type: ch.type,
        parent: ch.parentName ? categoryIdByName.get(ch.parentName) : undefined,
        topic: ch.topic ?? undefined,
      }, log);
      if (!created) continue;
      log.created++;
      keptIds.add(created.id);
      for (const ow of ch.overwrites) {
        await created.permissionOverwrites.create(ow.id, buildPermissionOptions(ow.allow, ow.deny))
          .catch((err) => log.errors.push(`Set quyền kênh "${ch.name}" lỗi: ${err.message}`));
      }
      await sleep(OP_DELAY_MS);
    }

    for (const ch of currentOthers) {
      if (!keptIds.has(ch.id)) continue;
      const chParentName = ch.parent?.name ?? null;
      if (!chParentName) continue;
      const desiredParentId = categoryIdByName.get(chParentName);
      if (desiredParentId && ch.parentId !== desiredParentId) {
        await ch.setParent(desiredParentId, { lockPermissions: false })
          .catch((err) => log.errors.push(`Gắn lại danh mục cho "${ch.name}" lỗi: ${err.message}`));
        await sleep(OP_DELAY_MS);
      }
    }

    for (let pass = 0; pass < 2; pass++) {
      const remaining = [...(await guild.channels.fetch()).values()]
        .filter((c) => !keptIds.has(c.id) && !isProtectedChannelName(c.name));
      if (remaining.length === 0) break;
      for (const channel of remaining) {
        const ok = await deleteChannelWithRetry(channel, log);
        if (ok) log.deleted++;
        await sleep(OP_DELAY_MS);
      }
    }
  } finally {
    isRestoring = false;
  }
  if (log.errors.length) console.error("Restore errors:", log.errors);
  return log;
}

async function createAntinukeLogChannel(guild) {
  const existing = guild.channels.cache.find((c) => c.name === ANTINUKE_LOG_CHANNEL_NAME);
  if (existing) return existing;
  return guild.channels.create({
    name: ANTINUKE_LOG_CHANNEL_NAME,
    type: ChannelType.GuildText,
    reason: "Thiết lập / tái lập bẫy chống nuke",
    permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
  });
}

function formatMuteDuration(minutes) {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts = [];
  if (days) parts.push(`${days} ngày`);
  if (hours) parts.push(`${hours} giờ`);
  if (mins) parts.push(`${mins} phút`);
  return parts.length ? parts.join(" ") : "0 phút";
}

// ── Gửi thông báo kick/ban/mute vào kênh log: avatar, tên, id, lý do ────
// Dùng chung cho cả anti-nuke lẫn honeypot.
async function sendModerationLog(channel, { user, action, reason, muteMinutes }) {
  const titleByAction = {
    ban: "🔨 Đã BAN thành viên",
    kick: "👢 Đã KICK thành viên",
    mute: "🔇 Đã MUTE thành viên",
  };
  const colorByAction = { ban: 0xe74c3c, kick: 0xe67e22, mute: 0xf1c40f };
  const embed = new EmbedBuilder()
    .setColor(colorByAction[action] ?? 0x95a5a6)
    .setTitle(titleByAction[action] ?? "⚠️ Đã xử lý thành viên")
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: "Tên", value: user.tag ?? user.username, inline: true },
      { name: "ID", value: user.id, inline: true },
    );
  if (action === "mute" && muteMinutes) {
    embed.addFields({ name: "Thời gian mute", value: formatMuteDuration(muteMinutes), inline: true });
  }
  embed.addFields({ name: "Lý do", value: reason });
  embed.setTimestamp();
  await channel.send({ embeds: [embed] });
}

// ── Honeypot: nội dung cảnh báo + số người đã bị bẫy ─────────────────────
function buildHoneypotEmbed(trapCount, action, muteMinutes) {
  const actionLabel =
    action === "ban" ? "BAN" : action === "mute" ? `MUTE (${formatMuteDuration(muteMinutes)})` : "KICK";
  return new EmbedBuilder()
    .setColor(0xff0000)
    .setTitle("⚠️ KHÔNG NHẮN VÀO KÊNH NÀY")
    .setDescription(
      `Kênh này dùng để bẫy tài khoản scam, bot spam tin nhắn, và kẻ nuke server.\n` +
      `**Bất kỳ ai nhắn tin vào đây sẽ bị ${actionLabel} ngay lập tức.**`,
    )
    .addFields({ name: "Đã bẫy được", value: `${trapCount} người`, inline: true })
    .setTimestamp();
}

// ── Tạo (hoặc tái sử dụng) kênh honeypot, cập nhật quyền + embed đếm ────
async function createOrUpdateHoneypotChannel(guild, action, muteMinutes) {
  let honeypot = loadHoneypot() ?? {};
  const allChannels = await guild.channels.fetch();
  let channel = allChannels.find((c) => c.name === HONEYPOT_CHANNEL_NAME);

  if (!channel) {
    channel = await guild.channels.create({
      name: HONEYPOT_CHANNEL_NAME,
      type: ChannelType.GuildText,
      reason: "Thiết lập kênh bẫy honeypot",
    });
    await channel.setPosition(0).catch(() => {});
  }

  // Luôn đảm bảo @everyone nhìn thấy và nhắn được — kể cả người chưa verify —
  // vì mục tiêu là dụ chính những tài khoản đáng ngờ nhất.
  await channel.permissionOverwrites
    .edit(guild.roles.everyone, { ViewChannel: true, SendMessages: true })
    .catch(() => {});

  const trapCount = honeypot.trapCount ?? 0;
  const embed = buildHoneypotEmbed(trapCount, action, muteMinutes);

  let infoMessage = honeypot.messageId
    ? await channel.messages.fetch(honeypot.messageId).catch(() => null)
    : null;
  if (infoMessage) {
    await infoMessage.edit({ embeds: [embed] }).catch(() => {});
  } else {
    infoMessage = await channel.send({ embeds: [embed] });
  }

  honeypot = { channelId: channel.id, messageId: infoMessage.id, action, muteMinutes, trapCount };
  saveHoneypot(honeypot);

  return { channel, message: infoMessage };
}

// ── Có người nhắn vào kênh honeypot → xử lý + cập nhật đếm + log ────────
async function handleHoneypotTrigger(message, honeypot) {
  const guild = message.guild;
  const member = message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));

  // Bỏ qua chủ server / người có Role cao hơn bot — tránh tự khoá nhầm admin
  if (member && hasPermission(guild, member, message.author.id)) {
    await message.delete().catch(() => {});
    return;
  }

  await message.delete().catch(() => {});

  const reason = `Đã nhắn tin vào kênh bẫy honeypot (#${HONEYPOT_CHANNEL_NAME})`;
  let actionTaken = false;
  if (member) {
    try {
      if (honeypot.action === "ban") {
        await member.ban({ reason });
      } else if (honeypot.action === "mute") {
        const ms = (honeypot.muteMinutes ?? MAX_MUTE_MINUTES) * 60 * 1000;
        await member.timeout(ms, reason);
      } else {
        await member.kick(reason);
      }
      actionTaken = true;
    } catch (err) {
      console.error("Honeypot action lỗi:", err);
    }
  }

  honeypot.trapCount = (honeypot.trapCount ?? 0) + 1;
  saveHoneypot(honeypot);

  const channel = guild.channels.cache.get(honeypot.channelId);
  if (channel && honeypot.messageId) {
    const embed = buildHoneypotEmbed(honeypot.trapCount, honeypot.action, honeypot.muteMinutes);
    const infoMessage = await channel.messages.fetch(honeypot.messageId).catch(() => null);
    if (infoMessage) await infoMessage.edit({ embeds: [embed] }).catch(() => {});
  }

  if (actionTaken) {
    const logChannel = guild.channels.cache.find((c) => c.name === ANTINUKE_LOG_CHANNEL_NAME);
    if (logChannel) {
      await sendModerationLog(logChannel, {
        user: message.author,
        action: honeypot.action,
        reason,
        muteMinutes: honeypot.muteMinutes,
      }).catch(() => {});
    }
  }
}

const HOW_TEXT = [
  "**📖 Danh sách lệnh của bot**",
  "",
  "**!verifysetup**",
  "Thiết lập hệ thống xác minh thành viên mới — tạo role + kênh verify, ẩn hết các kênh khác cho tới khi thành viên ấn ✅.",
  "",
  "**/saveconfig <ten>**",
  "Lưu lại toàn bộ cấu trúc server hiện tại (kênh, danh mục, quyền, thứ tự) thành 1 bản có tên riêng.",
  "",
  "**/setconfig <ten>**",
  "Đồng bộ server theo 1 bản đã lưu. Kênh nào giống hệt bản lưu sẽ được **giữ nguyên**. Kênh khác sẽ bị xoá và tạo lại.",
  "",
  "**/antinuke <hanhdong> <config> [thoigian]**",
  "Kích hoạt bẫy chống nuke: tạo kênh ẩn #wxz-log. Nếu bị xoá, bot Kick/Ban/Mute người đó, đồng bộ theo config, tự tái lập bẫy và báo vào #wxz-log — rồi 3 giây sau kiểm tra lại lần 2.",
  "",
  "**/honeypotsetup <hanhdong> [thoigian]**",
  "Tạo kênh #honeypot luôn hiển thị với mọi người (kể cả chưa verify). Bất kỳ ai nhắn tin vào đó sẽ bị Kick/Ban/Mute ngay, kênh hiện sẵn số người đã bị bẫy.",
  "",
  "**?how**",
  "Hiện danh sách này.",
  "",
  "⚠️ Các lệnh !verifysetup, /saveconfig, /setconfig, /antinuke, /honeypotsetup chỉ dùng được nếu bạn có Role cao hơn Bot hoặc là chủ server.",
].join("\n");

const TEXT_COMMANDS = ["!verifysetup"];

client.on("messageCreate", async (message) => {
  if (message.author.id === client.user.id) return; // kh
