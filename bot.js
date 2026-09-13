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
  AttachmentBuilder,
} from "discord.js";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import "dotenv/config";

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
const BACKUP_CHANNEL_NAME = "wxz-backup";
const MAX_MUTE_MINUTES = 40320; // 28 ngày — tối đa Discord cho phép

const PROTECTED_CHANNEL_NAMES = new Set([
  ANTINUKE_LOG_CHANNEL_NAME,
  HONEYPOT_CHANNEL_NAME,
  VERIFY_CHANNEL_NAME,
  BACKUP_CHANNEL_NAME,
]);
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
        .setDescription("Số phút mute (mặc định 40320 = 28 ngày)")
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
        .setDescription("Số phút mute (mặc định 40320 = 28 ngày)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(MAX_MUTE_MINUTES),
    ),
  new SlashCommandBuilder()
    .setName("verifysetup")
    .setDescription("Tạo/cập nhật kênh xác thực thành viên bằng nút bấm"),
  new SlashCommandBuilder()
    .setName("anti-external")
    .setDescription("Tắt quyền 'Dùng ứng dụng mở rộng' của @everyone trên tất cả kênh (giữ nguyên các quyền khác)"),
  new SlashCommandBuilder()
    .setName("backupnow")
    .setDescription("Sao lưu ngay các cấu hình đã lưu (config/antinuke/honeypot/verify) lên kênh backup riêng"),
  new SlashCommandBuilder()
    .setName("showconfig")
    .setDescription("Xem danh sách cấu hình đã lưu, hoặc xem chi tiết danh mục/kênh của 1 cấu hình")
    .addStringOption((opt) =>
      opt.setName("ten").setDescription("Tên cấu hình muốn xem chi tiết (bỏ trống để xem danh sách)").setRequired(false),
    ),
].map((cmd) => cmd.toJSON());

// ── Đăng ký lệnh RIÊNG CHO TỪNG SERVER thay vì đăng ký global ───────────
// Lệnh global mất tới 1 tiếng mới đồng bộ mỗi khi thay đổi; lệnh theo
// từng server (guild command) có hiệu lực NGAY LẬP TỨC.
async function registerCommandsForGuild(rest, guild) {
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: slashCommands });
    console.log(`Đã đăng ký lệnh cho server: ${guild.name}`);
  } catch (err) {
    console.error(`Đăng ký lệnh cho server ${guild.name} thất bại:`, err);
  }
}

client.on("clientReady", async (readyClient) => {
  console.log(`Bot online: ${readyClient.user.tag}`);
  const rest = new REST().setToken(token);

  // Xoá lệnh GLOBAL cũ nếu có — bot chỉ dùng lệnh theo từng server, còn lệnh
  // global sót lại từ trước sẽ khiến Discord hiện TRÙNG lệnh trong danh sách.
  await rest
    .put(Routes.applicationCommands(readyClient.user.id), { body: [] })
    .catch((err) => console.error("Xoá lệnh global cũ lỗi:", err.message));

  for (const guild of readyClient.guilds.cache.values()) {
    await registerCommandsForGuild(rest, guild);

    // saved-configs.json không còn → dấu hiệu Termux vừa bị xoá/cài lại.
    // Tự tải bản backup gần nhất trong #wxz-backup về để khôi phục.
    if (!fs.existsSync(CONFIG_FILE)) {
      await restoreConfigsFromDiscord(guild);
    }
  }
});

// Bot vào server mới sau này cũng tự đăng ký lệnh ngay, không cần chờ
client.on("guildCreate", async (guild) => {
  const rest = new REST().setToken(token);
  await registerCommandsForGuild(rest, guild);
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
const RETRY_BACKOFF_MS = 200; // chỉ dùng khi 1 thao tác lỗi và cần thử lại

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
      await sleep(RETRY_BACKOFF_MS * attempt);
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
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  return null;
}

// Ghi chú tốc độ: các thao tác xoá/tạo/gắn quyền ĐỘC LẬP với nhau (khác kênh)
// được chạy SONG SONG bằng Promise.all thay vì xếp hàng chờ 350ms sau MỖI
// bước như bản trước — đó là lý do đồng bộ 1 server hay bị mất ~20 giây dù
// chỉ đổi vài kênh. discord.js tự đọc header rate-limit của Discord và tự
// giãn cách request nếu thật sự cần (kể cả 429), nên vẫn an toàn — chỉ là
// không còn phải đợi "cho chắc" khi Discord chưa hề giới hạn gì cả.
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

    // Xoá kênh + danh mục không khớp — không phụ thuộc lẫn nhau nên chạy song song.
    await Promise.all(
      [...channelsToDelete, ...categoriesToDelete].map(async (channel) => {
        const ok = await deleteChannelWithRetry(channel, log);
        if (ok) log.deleted++;
      }),
    );

    if (config.guildName && config.guildName !== guild.name) {
      await guild.setName(config.guildName).catch((err) => log.errors.push(`Đổi tên server lỗi: ${err.message}`));
    }

    // Tạo danh mục còn thiếu (song song với nhau); phải xong ở đây để có ID
    // thật thì bước tạo kênh bên dưới mới gắn đúng cha.
    const categoryIdByName = new Map();
    for (const [name, ch] of keptCategoryByConfigName) categoryIdByName.set(name, ch.id);
    const categoriesToCreate = config.categories.filter((_, i) => !usedCategoryIdx.has(i));
    await Promise.all(
      categoriesToCreate.map(async (cat) => {
        const created = await createChannelWithRetry(guild, { name: cat.name, type: ChannelType.GuildCategory }, log);
        if (!created) return;
        log.created++;
        keptIds.add(created.id);
        categoryIdByName.set(cat.name, created.id);
        await Promise.all(
          cat.overwrites.map((ow) =>
            created.permissionOverwrites
              .create(ow.id, buildPermissionOptions(ow.allow, ow.deny))
              .catch((err) => log.errors.push(`Set quyền danh mục "${cat.name}" lỗi: ${err.message}`)),
          ),
        );
      }),
    );

    // Tạo kênh còn thiếu — song song với nhau, danh mục cha đã có ID ở trên.
    const channelsToCreate = config.channels.filter((_, i) => !usedChannelIdx.has(i));
    await Promise.all(
      channelsToCreate.map(async (ch) => {
        const created = await createChannelWithRetry(
          guild,
          {
            name: ch.name, type: ch.type,
            parent: ch.parentName ? categoryIdByName.get(ch.parentName) : undefined,
            topic: ch.topic ?? undefined,
          },
          log,
        );
        if (!created) return;
        log.created++;
        keptIds.add(created.id);
        await Promise.all(
          ch.overwrites.map((ow) =>
            created.permissionOverwrites
              .create(ow.id, buildPermissionOptions(ow.allow, ow.deny))
              .catch((err) => log.errors.push(`Set quyền kênh "${ch.name}" lỗi: ${err.message}`)),
          ),
        );
      }),
    );

    // Gắn lại danh mục cho kênh được giữ nhưng sai cha — song song.
    await Promise.all(
      currentOthers.map(async (ch) => {
        if (!keptIds.has(ch.id)) return;
        const chParentName = ch.parent?.name ?? null;
        if (!chParentName) return;
        const desiredParentId = categoryIdByName.get(chParentName);
        if (desiredParentId && ch.parentId !== desiredParentId) {
          await ch
            .setParent(desiredParentId, { lockPermissions: false })
            .catch((err) => log.errors.push(`Gắn lại danh mục cho "${ch.name}" lỗi: ${err.message}`));
        }
      }),
    );

    for (let pass = 0; pass < 2; pass++) {
      const remaining = [...(await guild.channels.fetch()).values()]
        .filter((c) => !keptIds.has(c.id) && !isProtectedChannelName(c.name));
      if (remaining.length === 0) break;
      await Promise.all(
        remaining.map(async (channel) => {
          const ok = await deleteChannelWithRetry(channel, log);
          if (ok) log.deleted++;
        }),
      );
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

function buildAntinukeAlertEmbed({ user, action, muteMinutes, configName, restoreLog, verifyRestored, honeypotRestored }) {
  const actionLabel =
    action === "ban" ? "BAN" : action === "mute" ? `MUTE (${formatMuteDuration(muteMinutes)})` : "KICK";

  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("🛡️ PHÁT HIỆN NUKE — ĐÃ XỬ LÝ")
    .setThumbnail(user.displayAvatarURL({ size: 256 }))
    .addFields(
      { name: "Kẻ tấn công", value: `${user.tag ?? user.username}\n${user.id}` },
      { name: "Đã xử lý", value: actionLabel, inline: true },
      { name: "Cấu hình khôi phục", value: configName, inline: true },
    );

  if (restoreLog) {
    embed.addFields({
      name: "Đồng bộ lại kênh",
      value:
        `Giữ nguyên: ${restoreLog.kept} · Đã xoá: ${restoreLog.deleted} · Đã tạo: ${restoreLog.created}` +
        (restoreLog.errors.length ? `\n⚠️ ${restoreLog.errors.length} lỗi — xem console` : ""),
    });
  } else {
    embed.addFields({ name: "Đồng bộ lại kênh", value: "Không có bản cấu hình để khôi phục" });
  }

  const rebuilt = [];
  if (verifyRestored) rebuilt.push("verify");
  if (honeypotRestored) rebuilt.push("honeypot");
  embed.addFields({
    name: "Kênh hệ thống tái lập",
    value: rebuilt.length ? rebuilt.join(", ") : "Không có kênh nào cần tái lập",
  });

  embed.setTimestamp();
  return embed;
}

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

async function createOrUpdateVerifyChannel(guild) {
  const allChannels = await guild.channels.fetch();
  let channel = allChannels.find((c) => c.name === VERIFY_CHANNEL_NAME);

  if (!channel) {
    channel = await guild.channels.create({
      name: VERIFY_CHANNEL_NAME,
      type: ChannelType.GuildText,
      reason: "Thiết lập kênh xác thực thành viên",
    });
  }

  // Không cần gõ chữ hay thả reaction — chỉ bấm nút, nên khoá luôn 2 quyền này
  await channel.permissionOverwrites
    .edit(guild.roles.everyone, { ViewChannel: true, SendMessages: false, AddReactions: false })
    .catch(() => {});

  let role = guild.roles.cache.find((r) => r.name === VERIFY_ROLE_NAME);
  if (!role) {
    role = await guild.roles.create({ name: VERIFY_ROLE_NAME, reason: "Tự tạo role verify" });
  }

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle("🛡️ XÁC THỰC THÀNH VIÊN")
    .setDescription(
      `Bấm nút bên dưới để xác thực và nhận role **${VERIFY_ROLE_NAME}**, mở khoá toàn bộ server.`,
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("verify_button")
      .setLabel("VERIFY NOW")
      .setEmoji("🛡️")
      .setStyle(ButtonStyle.Success),
  );

  const state = loadState();
  let infoMessage = state.messageId
    ? await channel.messages.fetch(state.messageId).catch(() => null)
    : null;
  if (infoMessage) {
    await infoMessage.edit({ embeds: [embed], components: [row] }).catch(() => {});
  } else {
    infoMessage = await channel.send({ embeds: [embed], components: [row] });
  }

  saveState({ channelId: channel.id, messageId: infoMessage.id, roleId: role.id });

  return { channel, message: infoMessage, role };
}

// ─────────────────────────────────────────────────────────────────────────
// Backup / khôi phục: Termux có thể bị xoá nhầm bất cứ lúc nào, mà 4 file
// JSON (saved-configs, antinuke-state, honeypot-state, verify-state) chỉ
// nằm trên máy đó. Nên mỗi lần dữ liệu quan trọng thay đổi, bot gửi kèm
// 4 file này lên 1 kênh ẩn (#wxz-backup) — dữ liệu nằm trên Discord thì
// mất Termux cũng không sao. Lúc bot khởi động lại mà thấy saved-configs.json
// không còn (dấu hiệu Termux vừa bị xoá/cài lại), bot tự tải bản backup
// gần nhất về để khôi phục, không cần làm gì thêm.
// ─────────────────────────────────────────────────────────────────────────
async function ensureBackupChannel(guild) {
  const existing = guild.channels.cache.find((c) => c.name === BACKUP_CHANNEL_NAME);
  if (existing) return existing;
  return guild.channels.create({
    name: BACKUP_CHANNEL_NAME,
    type: ChannelType.GuildText,
    reason: "Kênh lưu backup cấu hình bot",
    permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
  });
}

const BACKUP_FILE_MAP = {
  "saved-configs.json": CONFIG_FILE,
  "antinuke-state.json": ANTINUKE_FILE,
  "honeypot-state.json": HONEYPOT_FILE,
  "verify-state.json": STATE_FILE,
};

async function backupAllToDiscord(guild) {
  const filesToBackup = Object.entries(BACKUP_FILE_MAP).filter(([, filePath]) => fs.existsSync(filePath));
  if (filesToBackup.length === 0) return null; // Chưa có gì để lưu thì không tạo kênh backup làm gì
  const channel = await ensureBackupChannel(guild);
  const files = filesToBackup.map(([name, filePath]) => new AttachmentBuilder(filePath, { name }));
  return channel.send({
    content: `🗄️ Backup cấu hình — ${new Date().toLocaleString("vi-VN")}`,
    files,
  });
}

async function restoreConfigsFromDiscord(guild) {
  try {
    const allChannels = await guild.channels.fetch();
    const channel = allChannels.find((c) => c.name === BACKUP_CHANNEL_NAME);
    if (!channel) return false;

    const messages = await channel.messages.fetch({ limit: 20 });
    const latest = [...messages.values()]
      .filter((m) => m.attachments.size > 0)
      .sort((a, b) => b.createdTimestamp - a.createdTimestamp)[0];
    if (!latest) return false;

    for (const att of latest.attachments.values()) {
      const destPath = BACKUP_FILE_MAP[att.name];
      if (!destPath) continue;
      const res = await fetch(att.url);
      const text = await res.text();
      fs.writeFileSync(destPath, text);
    }
    console.log(`Đã khôi phục cấu hình từ #${BACKUP_CHANNEL_NAME} (backup lúc ${latest.createdAt.toISOString()}).`);
    return true;
  } catch (err) {
    console.error("Khôi phục cấu hình từ Discord lỗi:", err.message);
    return false;
  }
}

async function disableExternalAppsEveryone(guild) {
  const result = { updated: 0, errors: [] };
  const channels = await guild.channels.fetch();
  const everyone = guild.roles.everyone;

  await Promise.all(
    [...channels.values()].map(async (channel) => {
      if (!channel || channel.isThread?.()) return;
      try {
        // .edit() chỉ đụng đúng 1 quyền này — mọi allow/deny khác trên kênh giữ nguyên
        await channel.permissionOverwrites.edit(everyone, { UseExternalApps: false });
        result.updated++;
      } catch (err) {
        result.errors.push(`"${channel.name}": ${err.message}`);
      }
    }),
  );

  return result;
}

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

async function handleHoneypotTrigger(message, honeypot) {
  const guild = message.guild;
  const member = message.member ?? (await guild.members.fetch(message.author.id).catch(() => null));

  if (member && hasPermission(guild, member, message.author.id)) {
    await message.delete().catch(() => {});
    return;
  }

  // Người không có quyền (không phải chủ server / role thấp hơn bot) nhắn vào
  // kênh bẫy → xoá tin nhắn và xử lý theo hành động đã cấu hình.
  await message.delete().catch(() => {});

  const { action, muteMinutes } = honeypot;
  const reason = "Nhắn tin vào kênh honeypot (bẫy chống spam/nuke)";

  try {
    if (action === "ban") {
      await guild.members.ban(message.author.id, { reason });
    } else if (action === "kick") {
      if (member) await member.kick(reason);
    } else if (action === "mute") {
      if (member) {
        const ms = (muteMinutes ?? MAX_MUTE_MINUTES) * 60 * 1000;
        await member.timeout(ms, reason);
      }
    }
  } catch (err) {
    console.error(`Xử lý honeypot cho ${message.author.tag ?? message.author.id} lỗi:`, err.message);
  }

  honeypot.trapCount = (honeypot.trapCount ?? 0) + 1;
  saveHoneypot(honeypot);

  // Cập nhật số đếm trên embed đã ghim trong kênh honeypot
  try {
    const channel = await guild.channels.fetch(honeypot.channelId).catch(() => null);
    const infoMessage = channel
      ? await channel.messages.fetch(honeypot.messageId).catch(() => null)
      : null;
    if (infoMessage) {
      await infoMessage
        .edit({ embeds: [buildHoneypotEmbed(honeypot.trapCount, action, muteMinutes)] })
        .catch(() => {});
    }
  } catch (err) {
    console.error("Cập nhật embed honeypot lỗi:", err.message);
  }

  // Ghi log vào kênh wxz-log (nếu đã được thiết lập)
  const logChannel = guild.channels.cache.find((c) => c.name === ANTINUKE_LOG_CHANNEL_NAME);
  if (logChannel) {
    await sendModerationLog(logChannel, { user: message.author, action, reason, muteMinutes }).catch((err) =>
      console.error("Gửi log honeypot lỗi:", err.message),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// messageCreate: kiểm tra xem tin nhắn có nằm trong kênh honeypot không
// ─────────────────────────────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  const honeypot = loadHoneypot();
  if (honeypot && message.channel.id === honeypot.channelId) {
    await handleHoneypotTrigger(message, honeypot).catch((err) =>
      console.error("handleHoneypotTrigger lỗi:", err.message),
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────
// channelDelete: bẫy chống nuke — phát hiện ai xoá kênh log #wxz-log
// (bot cần quyền "View Audit Log" để tra ra người xoá)
// ─────────────────────────────────────────────────────────────────────────
client.on("channelDelete", async (channel) => {
  if (isRestoring) return;
  if (channel.name !== ANTINUKE_LOG_CHANNEL_NAME) return;
  const guild = channel.guild;
  if (!guild) return;

  const antinuke = loadAntinuke();
  if (!antinuke) return;

  // Nuke thật thường xoá NHIỀU kênh gần như cùng lúc, không riêng gì kênh log.
  // limit:5 cũ dễ bị các lượt xoá khác "đẩy" mất đúng dòng mình cần tìm khỏi
  // cửa sổ audit log — đây nhiều khả năng là lý do lần thử thứ 2 trở đi bị im
  // lặng bỏ qua. Giờ dò cửa sổ rộng hơn (20) và thử lại vài lần vì audit log
  // của Discord đôi khi ghi trễ hơn sự kiện channelDelete vài trăm ms.
  let executor = null;
  for (let attempt = 0; attempt < 3 && !executor; attempt++) {
    if (attempt > 0) await sleep(500);
    try {
      const auditLogs = await guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 20 });
      const entry = auditLogs.entries.find((e) => e.target?.id === channel.id);
      if (entry) executor = entry.executor ?? null;
    } catch (err) {
      console.error("Đọc audit log lỗi (bot cần quyền 'View Audit Log'):", err.message);
      break; // lỗi quyền/API thì thử lại cũng vô ích
    }
  }
  if (!executor || executor.id === client.user.id) return;

  const member = await guild.members.fetch(executor.id).catch(() => null);
  if (member && hasPermission(guild, member, executor.id)) {
    // Chủ server / người có quyền cao hơn bot tự xoá kênh log — chỉ tạo lại, không xử lý
    await createAntinukeLogChannel(guild).catch(() => {});
    return;
  }

  const { action, muteMinutes, config: configName } = antinuke;
  const reason = "Xoá kênh log chống nuke";

  try {
    if (action === "ban") {
      await guild.members.ban(executor.id, { reason });
    } else if (action === "kick") {
      if (member) await member.kick(reason);
    } else if (action === "mute") {
      if (member) {
        const ms = (muteMinutes ?? MAX_MUTE_MINUTES) * 60 * 1000;
        await member.timeout(ms, reason);
      }
    }
  } catch (err) {
    console.error(`Xử lý kẻ nuke ${executor.tag ?? executor.id} lỗi:`, err.message);
  }

  const newLogChannel = await createAntinukeLogChannel(guild).catch(() => null);

  const configs = loadConfigs();
  const savedConfig = configs[configName];
  const restoreLog = savedConfig
    ? await restoreGuildConfig(guild, savedConfig).catch((err) => {
        console.error("Khôi phục cấu hình sau nuke lỗi:", err.message);
        return null;
      })
    : null;

  // Nuke thường xoá LUÔN cả #verify, #honeypot, #wxz-backup chứ không riêng
  // gì #wxz-log — nhưng restoreGuildConfig cố tình bỏ qua 3 kênh này (chúng
  // là kênh hệ thống, không nằm trong cấu hình đã lưu). Nên ở đây tái lập
  // riêng: kênh nào TRƯỚC ĐÓ đã từng /verifysetup hay /honeypotsetup thì
  // tạo lại y nguyên cài đặt cũ; chưa từng dùng lệnh đó thì thôi, không tự
  // tạo ra kênh mới không ai cần.
  const [verifyRestored, honeypotRestored] = await Promise.all([
    (async () => {
      const verifyState = loadState();
      if (!verifyState.channelId) return false; // chưa từng /verifysetup
      await createOrUpdateVerifyChannel(guild).catch((err) =>
        console.error("Tái lập kênh verify sau nuke lỗi:", err.message),
      );
      return true;
    })(),
    (async () => {
      const honeypot = loadHoneypot();
      if (!honeypot) return false; // chưa từng /honeypotsetup
      await createOrUpdateHoneypotChannel(guild, honeypot.action, honeypot.muteMinutes).catch((err) =>
        console.error("Tái lập kênh honeypot sau nuke lỗi:", err.message),
      );
      return true;
    })(),
  ]);

  // backupAllToDiscord tự bỏ qua nếu chưa có file nào để lưu, nên gọi thẳng
  // ở đây là an toàn — vừa tái tạo #wxz-backup nếu đã từng dùng, vừa lưu
  // luôn bản mới nhất (kể cả channelId/messageId vừa đổi ở bước trên).
  await backupAllToDiscord(guild).catch((err) => console.error("Backup sau nuke lỗi:", err.message));

  if (newLogChannel) {
    const embed = buildAntinukeAlertEmbed({
      user: executor,
      action,
      muteMinutes,
      configName,
      restoreLog,
      verifyRestored,
      honeypotRestored,
    });
    await newLogChannel.send({ embeds: [embed] }).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────
// interactionCreate: nút bấm verify + 8 slash command (chỉ Administrator)
// ─────────────────────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    if (interaction.customId !== "verify_button") return;
    const { guild, member } = interaction;
    if (!guild || !member) return;

    try {
      const state = loadState();
      let role = state.roleId ? await guild.roles.fetch(state.roleId).catch(() => null) : null;
      if (!role) role = guild.roles.cache.find((r) => r.name === VERIFY_ROLE_NAME);
      if (!role) role = await guild.roles.create({ name: VERIFY_ROLE_NAME, reason: "Tự tạo role verify" });

      if (member.roles.cache.has(role.id)) {
        await interaction.reply({ content: "Bạn đã xác thực rồi.", ephemeral: true });
        return;
      }
      await member.roles.add(role, "Xác thực qua nút bấm");
      await interaction.reply({ content: "✅ Xác thực thành công! Chúc bạn vui vẻ.", ephemeral: true });
    } catch (err) {
      console.error("Xử lý verify button lỗi:", err.message);
      await interaction.reply({ content: "Có lỗi xảy ra, thử lại sau.", ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  const { guild, member, commandName } = interaction;
  if (!guild || !member) {
    await interaction.reply({ content: "Lệnh này chỉ dùng được trong server.", ephemeral: true });
    return;
  }

  if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "Bạn cần quyền Administrator để dùng lệnh này.", ephemeral: true });
    return;
  }

  try {
    if (commandName === "saveconfig") {
      const ten = interaction.options.getString("ten", true);
      await interaction.deferReply();
      const config = captureGuildConfig(guild);
      config.savedBy = interaction.user.id;
      const configs = loadConfigs();
      configs[ten] = config;
      saveConfigs(configs);
      await backupAllToDiscord(guild).catch((err) => console.error("Backup lỗi:", err.message));

      const savedEmbed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle("💾 Đã lưu cấu hình")
        .addFields(
          { name: "Tên", value: ten, inline: true },
          { name: "Số danh mục", value: `${config.categories.length}`, inline: true },
          { name: "Số kênh", value: `${config.channels.length}`, inline: true },
        )
        .setFooter({ text: "Dùng /showconfig để xem lại, /setconfig để khôi phục" })
        .setTimestamp();
      await interaction.editReply({ embeds: [savedEmbed] });
      return;
    }

    if (commandName === "showconfig") {
      const ten = interaction.options.getString("ten");
      const configs = loadConfigs();
      const names = Object.keys(configs);
      await interaction.deferReply();

      if (!ten) {
        const listEmbed = new EmbedBuilder().setColor(0x3498db).setTitle("📋 Danh sách cấu hình đã lưu");
        if (names.length === 0) {
          listEmbed.setDescription("Chưa có cấu hình nào. Dùng /saveconfig để lưu cấu hình hiện tại.");
        } else {
          listEmbed
            .setDescription(
              names
                .map((name) => {
                  const cfg = configs[name];
                  const savedAt = cfg.savedAt ? new Date(cfg.savedAt).toLocaleString("vi-VN") : "?";
                  return `**${name}** — ${cfg.categories.length} danh mục, ${cfg.channels.length} kênh (lưu lúc ${savedAt})`;
                })
                .join("\n"),
            )
            .setFooter({ text: "Dùng /showconfig ten:<tên> để xem chi tiết từng kênh" });
        }
        await interaction.editReply({ embeds: [listEmbed] });
        return;
      }

      const config = configs[ten];
      if (!config) {
        await interaction.editReply(`Không tìm thấy bản lưu tên **${ten}**.`);
        return;
      }

      // Gom kênh theo danh mục để vẽ dạng cây giống hệt cấu trúc server
      const channelsByParent = new Map();
      const noParent = [];
      for (const ch of config.channels) {
        if (!ch.parentName) {
          noParent.push(ch);
          continue;
        }
        if (!channelsByParent.has(ch.parentName)) channelsByParent.set(ch.parentName, []);
        channelsByParent.get(ch.parentName).push(ch);
      }

      const lines = [];
      for (const cat of config.categories) {
        lines.push(`    ${cat.name}`);
        for (const ch of channelsByParent.get(cat.name) ?? []) lines.push(`#${ch.name}`);
        channelsByParent.delete(cat.name);
      }
      for (const [parentName, children] of channelsByParent) {
        lines.push(`    ${parentName}`);
        for (const ch of children) lines.push(`#${ch.name}`);
      }
      if (noParent.length) {
        lines.push(`    (không danh mục)`);
        for (const ch of noParent) lines.push(`#${ch.name}`);
      }

      let tree = lines.join("\n") || "(trống)";
      if (tree.length > 3800) tree = `${tree.slice(0, 3800)}\n... (còn nữa)`;

      const savedAt = config.savedAt ? new Date(config.savedAt).toLocaleString("vi-VN") : "?";
      const detailEmbed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(`📋 Cấu hình: ${ten}`)
        .setDescription(`\`\`\`\n${tree}\n\`\`\``)
        .addFields(
          { name: "Số danh mục", value: `${config.categories.length}`, inline: true },
          { name: "Số kênh", value: `${config.channels.length}`, inline: true },
        )
        .setFooter({ text: `Lưu lúc ${savedAt}` });
      await interaction.editReply({ embeds: [detailEmbed] });
      return;
    }

    if (commandName === "setconfig") {
      const ten = interaction.options.getString("ten", true);
      const configs = loadConfigs();
      const config = configs[ten];
      if (!config) {
        await interaction.reply({ content: `Không tìm thấy bản lưu tên **${ten}**.`, ephemeral: true });
        return;
      }
      await interaction.deferReply();
      const log = await restoreGuildConfig(guild, config);

      const syncEmbed = new EmbedBuilder()
        .setColor(log.errors.length ? 0xe67e22 : 0x2ecc71)
        .setTitle("🔄 Đã đồng bộ cấu hình")
        .addFields(
          { name: "Cấu hình", value: ten, inline: true },
          { name: "Giữ nguyên", value: `${log.kept}`, inline: true },
          { name: "Đã xoá", value: `${log.deleted}`, inline: true },
          { name: "Đã tạo", value: `${log.created}`, inline: true },
        );
      if (log.errors.length) {
        syncEmbed.addFields({ name: `⚠️ ${log.errors.length} lỗi`, value: "Xem console để biết chi tiết" });
      }
      syncEmbed.setTimestamp();
      await interaction.editReply({ embeds: [syncEmbed] });
      return;
    }

    if (commandName === "antinuke") {
      const hanhdong = interaction.options.getString("hanhdong", true);
      const configName = interaction.options.getString("config", true);
      const thoigian = interaction.options.getInteger("thoigian") ?? MAX_MUTE_MINUTES;

      const configs = loadConfigs();
      if (!configs[configName]) {
        await interaction.reply({
          content: `Không tìm thấy bản lưu cấu hình tên **${configName}**. Hãy dùng /saveconfig trước.`,
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply();
      await createAntinukeLogChannel(guild);
      saveAntinuke({ action: hanhdong, config: configName, muteMinutes: thoigian });
      await backupAllToDiscord(guild).catch((err) => console.error("Backup lỗi:", err.message));

      const setupEmbed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle("🛡️ Đã bật chống nuke")
        .setDescription(`Xoá kênh #${ANTINUKE_LOG_CHANNEL_NAME} sẽ bị coi là nuke và bị xử lý ngay.`)
        .addFields(
          { name: "Kênh giám sát", value: `#${ANTINUKE_LOG_CHANNEL_NAME}`, inline: true },
          { name: "Hành động với kẻ xoá", value: hanhdong.toUpperCase(), inline: true },
          { name: "Cấu hình khôi phục", value: configName, inline: true },
        );
      if (hanhdong === "mute") {
        setupEmbed.addFields({ name: "Thời gian mute", value: formatMuteDuration(thoigian), inline: true });
      }
      setupEmbed.setTimestamp();

      await interaction.editReply({ embeds: [setupEmbed] });
      return;
    }

    if (commandName === "honeypotsetup") {
      const hanhdong = interaction.options.getString("hanhdong", true);
      const thoigian = interaction.options.getInteger("thoigian") ?? MAX_MUTE_MINUTES;

      await interaction.deferReply();
      await createOrUpdateHoneypotChannel(guild, hanhdong, thoigian);
      await backupAllToDiscord(guild).catch((err) => console.error("Backup lỗi:", err.message));

      const honeypotEmbed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle("🍯 Đã thiết lập honeypot")
        .addFields(
          { name: "Kênh bẫy", value: `#${HONEYPOT_CHANNEL_NAME}`, inline: true },
          { name: "Hành động", value: hanhdong.toUpperCase(), inline: true },
        );
      if (hanhdong === "mute") {
        honeypotEmbed.addFields({ name: "Thời gian mute", value: formatMuteDuration(thoigian), inline: true });
      }
      honeypotEmbed.setTimestamp();
      await interaction.editReply({ embeds: [honeypotEmbed] });
      return;
    }

    if (commandName === "verifysetup") {
      await interaction.deferReply();
      await createOrUpdateVerifyChannel(guild);
      await backupAllToDiscord(guild).catch((err) => console.error("Backup lỗi:", err.message));

      const verifyEmbed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle("✅ Đã thiết lập xác thực")
        .addFields(
          { name: "Kênh", value: `#${VERIFY_CHANNEL_NAME}`, inline: true },
          { name: "Role khi xác thực", value: VERIFY_ROLE_NAME, inline: true },
          { name: "Cách xác thực", value: "Bấm nút VERIFY NOW", inline: true },
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [verifyEmbed] });
      return;
    }

    if (commandName === "anti-external") {
      await interaction.deferReply();
      const result = await disableExternalAppsEveryone(guild);

      const externalEmbed = new EmbedBuilder()
        .setColor(result.errors.length ? 0xe67e22 : 0x2ecc71)
        .setTitle("🔒 Đã tắt Dùng ứng dụng mở rộng")
        .addFields(
          { name: "Kênh đã áp dụng", value: `${result.updated}`, inline: true },
          { name: "Phạm vi", value: "@everyone, mọi kênh", inline: true },
        );
      if (result.errors.length) {
        externalEmbed.addFields({ name: `⚠️ ${result.errors.length} kênh lỗi`, value: "Xem console để biết chi tiết" });
      }
      externalEmbed.setTimestamp();
      await interaction.editReply({ embeds: [externalEmbed] });
      return;
    }

    if (commandName === "backupnow") {
      await interaction.deferReply();
      const sent = await backupAllToDiscord(guild).catch((err) => {
        console.error("Backup thủ công lỗi:", err.message);
        return null;
      });

      const backupEmbed = new EmbedBuilder()
        .setColor(sent ? 0x2ecc71 : 0xe67e22)
        .setTitle(sent ? "🗄️ Đã sao lưu" : "🗄️ Không có gì để sao lưu")
        .setDescription(
          sent
            ? `Đã gửi bản sao lưu mới nhất vào #${BACKUP_CHANNEL_NAME}.`
            : "Chưa có config/antinuke/honeypot/verify nào được thiết lập, hoặc backup thất bại (xem console).",
        )
        .setTimestamp();
      await interaction.editReply({ embeds: [backupEmbed] });
      return;
    }
  } catch (err) {
    console.error(`Lệnh ${commandName} lỗi:`, err);
    const payload = { content: "Có lỗi xảy ra khi xử lý lệnh, xem log console.", ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});

client.login(token);
