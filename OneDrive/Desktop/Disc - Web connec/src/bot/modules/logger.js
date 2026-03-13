// Log sending module for Discord webhooks
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

const DEVELOPER_GUILD_ID = '1467155388024754260';

// Renk paleti
const COLORS = {
    SUCCESS:        0x57F287, // Yeşil
    ERROR:          0xED4245, // Kırmızı
    WARNING:        0xFEE75C, // Sarı
    INFO:           0x5865F2, // Discord Blurple
    AUTH_JOIN:      0x57F287, // Yeşil
    AUTH_LEAVE:     0xED4245, // Kırmızı
    BAN:            0xED4245, // Kırmızı
    UNBAN:          0x57F287, // Yeşil
    ROLE_ADD:       0x5865F2, // Blurple
    ROLE_REMOVE:    0xFFA500, // Turuncu
    MESSAGE_DELETE: 0xED4245, // Kırmızı
    MESSAGE_EDIT:   0xFEE75C, // Sarı
    STORE:          0x9B59B6, // Mor
    WALLET_PLUS:    0x57F287, // Yeşil
    WALLET_MINUS:   0xED4245, // Kırmızı
    ADMIN:          0xE74C3C, // Kırmızı
    SYSTEM:         0x95A5A6, // Gri
    VOICE:          0x00BCD4, // Cam göbeği
};

/**
 * Metni Discord alan değer limitine (1024 karakter) kırp
 */
function truncate(text, limit = 1024) {
    if (!text) return '*Yok*';
    return text.length > limit ? text.slice(0, limit - 3) + '...' : text;
}

/**
 * Kullanıcı etiketini formatla (yeni Discord kullanıcı adı sistemiyle uyumlu)
 */
function formatUser(user) {
    return user.discriminator && user.discriminator !== '0'
        ? `${user.username}#${user.discriminator}`
        : `@${user.username}`;
}

/**
 * URL buton satırı (ActionRow) oluştur — webhooklar yalnızca link buton destekler
 */
function createButtonRow(buttons) {
    const validButtons = buttons.filter(b => b.url);
    if (validButtons.length === 0) return null;
    return {
        type: 1, // ACTION_ROW
        components: validButtons.slice(0, 5).map(btn => ({
            type: 2, // BUTTON
            style: 5, // LINK
            label: btn.label,
            url: btn.url,
            ...(btn.emoji ? { emoji: { name: btn.emoji } } : {}),
        })),
    };
}

/**
 * Belirli bir guild ve kanal tipine log gönder (opsiyonel buton desteğiyle)
 * @param {string} guildId
 * @param {string} channelType
 * @param {object} embed - Ham Discord embed nesnesi
 * @param {Array|null} rows - ActionRow bileşen dizisi (isteğe bağlı)
 */
async function sendLog(guildId, channelType, embed, rows = null) {
    try {
        const { data: logChannel, error } = await supabase
            .from('bot_log_channels')
            .select('webhook_url')
            .eq('guild_id', guildId)
            .eq('channel_type', channelType)
            .eq('is_active', true)
            .single();

        if (error || !logChannel?.webhook_url) {
            return false;
        }

        const body = { embeds: [embed] };
        if (rows?.length) body.components = rows.filter(Boolean);

        const response = await fetch(logChannel.webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            console.error(`[Logger] ${channelType} kanalına log gönderilemedi: ${response.status} ${response.statusText}`);
            return false;
        }

        return true;
    } catch (error) {
        console.error(`[Logger] ${channelType} kanalına log gönderilirken hata:`, error);
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ÜYE GİRİŞ / ÇIKIŞ / BAN
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sunucuya üye katılımı
 */
async function sendMemberJoinLog(guildId, member) {
    const user = member.user;
    const accountAgeDays = Math.floor((Date.now() - user.createdTimestamp) / 86_400_000);
    const isNewAccount = accountAgeDays < 7;

    const embed = {
        author: {
            name: `${formatUser(user)} sunucuya katıldı`,
            icon_url: user.displayAvatarURL({ dynamic: true, size: 128 }),
        },
        color: isNewAccount ? COLORS.WARNING : COLORS.AUTH_JOIN,
        description: isNewAccount
            ? `> ⚠️ **Şüpheli hesap!** Bu hesap yalnızca **${accountAgeDays}** gün önce oluşturuldu.\n\n<@${user.id}> sunucuya katıldı.`
            : `<@${user.id}> aramıza katıldı! Hoş geldin 🎉`,
        fields: [
            { name: '👤 Kullanıcı',        value: `<@${user.id}>\n\`${formatUser(user)}\``,                         inline: true },
            { name: '🆔 ID',               value: `\`${user.id}\``,                                                  inline: true },
            { name: '📅 Hesap Yaşı',       value: `${accountAgeDays} gün`,                                           inline: true },
            { name: '🗓️ Hesap Açılış',    value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>`,               inline: true },
            { name: '🏠 Sunucu Üye Sayısı', value: `**${member.guild.memberCount}** üye`,                            inline: true },
        ],
        thumbnail: { url: user.displayAvatarURL({ dynamic: true, size: 256 }) },
        footer: { text: '📥 Üye Girişi', icon_url: member.guild.iconURL() },
        timestamp: new Date().toISOString(),
    };

    const row = createButtonRow([
        { label: 'Profili Görüntüle', emoji: '👤', url: `https://discord.com/users/${user.id}` },
    ]);

    return sendLog(guildId, 'auth', embed, [row]);
}

/**
 * Sunucudan üye ayrılması
 */
async function sendMemberLeaveLog(guildId, member) {
    const user = member.user;
    const timeInServer = member.joinedAt
        ? Math.floor((Date.now() - member.joinedAt.getTime()) / 86_400_000)
        : null;

    const roles = member.roles?.cache
        ?.filter(r => r.id !== member.guild.id)
        ?.map(r => `<@&${r.id}>`)
        ?.join(' ') || '*Rol yok*';

    const embed = {
        author: {
            name: `${formatUser(user)} sunucudan ayrıldı`,
            icon_url: user.displayAvatarURL({ dynamic: true, size: 128 }),
        },
        color: COLORS.AUTH_LEAVE,
        description: `<@${user.id}> sunucudan ayrıldı.`,
        fields: [
            { name: '👤 Kullanıcı',        value: `\`${formatUser(user)}\``,   inline: true },
            { name: '🆔 ID',               value: `\`${user.id}\``,             inline: true },
            ...(timeInServer !== null
                ? [{ name: '⏱️ Sunucuda Kalış', value: `${timeInServer} gün`, inline: true }]
                : []),
            { name: '🎭 Sahip Olduğu Roller', value: truncate(roles, 512),     inline: false },
        ],
        thumbnail: { url: user.displayAvatarURL({ dynamic: true, size: 256 }) },
        footer: { text: '📤 Üye Çıkışı', icon_url: member.guild.iconURL() },
        timestamp: new Date().toISOString(),
    };

    const row = createButtonRow([
        { label: 'Profili Görüntüle', emoji: '👤', url: `https://discord.com/users/${user.id}` },
    ]);

    return sendLog(guildId, 'auth', embed, [row]);
}

/**
 * Üye banı
 */
async function sendBanLog(guildId, ban) {
    const user = ban.user;

    const embed = {
        author: {
            name: `${formatUser(user)} banlandı`,
            icon_url: user.displayAvatarURL({ dynamic: true, size: 128 }),
        },
        color: COLORS.BAN,
        description: `🔨 <@${user.id}> sunucudan **kalıcı olarak banlandı**.`,
        fields: [
            { name: '👤 Kullanıcı', value: `\`${formatUser(user)}\``,       inline: true },
            { name: '🆔 ID',        value: `\`${user.id}\``,                 inline: true },
            { name: '📋 Sebep',     value: ban.reason || '*Sebep belirtilmedi*', inline: false },
        ],
        thumbnail: { url: user.displayAvatarURL({ dynamic: true, size: 256 }) },
        footer: { text: '🔨 Ban İşlemi', icon_url: ban.guild?.iconURL?.() },
        timestamp: new Date().toISOString(),
    };

    return sendLog(guildId, 'auth', embed);
}

/**
 * Üye banının kaldırılması
 */
async function sendUnbanLog(guildId, ban) {
    const user = ban.user;

    const embed = {
        author: {
            name: `${formatUser(user)} kullanıcısının banı kaldırıldı`,
            icon_url: user.displayAvatarURL({ dynamic: true, size: 128 }),
        },
        color: COLORS.UNBAN,
        description: `✅ <@${user.id}> kullanıcısının **banı kaldırıldı**.`,
        fields: [
            { name: '👤 Kullanıcı', value: `\`${formatUser(user)}\``, inline: true },
            { name: '🆔 ID',        value: `\`${user.id}\``,           inline: true },
        ],
        thumbnail: { url: user.displayAvatarURL({ dynamic: true, size: 256 }) },
        footer: { text: '✅ Ban Kaldırma', icon_url: ban.guild?.iconURL?.() },
        timestamp: new Date().toISOString(),
    };

    return sendLog(guildId, 'auth', embed);
}

// ─────────────────────────────────────────────────────────────────────────────
// ROL LOGLARI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rol ekleme logu
 */
async function sendRoleAddLog(guildId, member, addedRoles) {
    const user = member.user;
    const roleList = addedRoles.map(r => `<@&${r.id}> — \`${r.name}\``).join('\n');

    const embed = {
        author: {
            name: `${formatUser(user)} — Rol Eklendi`,
            icon_url: user.displayAvatarURL({ dynamic: true, size: 128 }),
        },
        color: COLORS.ROLE_ADD,
        description: `<@${user.id}> kullanıcısına **${addedRoles.length}** yeni rol eklendi.`,
        fields: [
            { name: '👤 Kullanıcı',    value: `<@${user.id}>`,          inline: true },
            { name: '🆔 ID',           value: `\`${user.id}\``,          inline: true },
            { name: '➕ Eklenen Roller', value: truncate(roleList, 512), inline: false },
        ],
        thumbnail: { url: user.displayAvatarURL({ dynamic: true, size: 256 }) },
        footer: { text: '🎭 Rol Yönetimi', icon_url: member.guild.iconURL() },
        timestamp: new Date().toISOString(),
    };

    return sendLog(guildId, 'roles', embed);
}

/**
 * Rol çıkarma logu
 */
async function sendRoleRemoveLog(guildId, member, removedRoles) {
    const user = member.user;
    const roleList = removedRoles.map(r => `<@&${r.id}> — \`${r.name}\``).join('\n');

    const embed = {
        author: {
            name: `${formatUser(user)} — Rol Çıkarıldı`,
            icon_url: user.displayAvatarURL({ dynamic: true, size: 128 }),
        },
        color: COLORS.ROLE_REMOVE,
        description: `<@${user.id}> kullanıcısından **${removedRoles.length}** rol çıkarıldı.`,
        fields: [
            { name: '👤 Kullanıcı',       value: `<@${user.id}>`,          inline: true },
            { name: '🆔 ID',              value: `\`${user.id}\``,          inline: true },
            { name: '➖ Çıkarılan Roller', value: truncate(roleList, 512), inline: false },
        ],
        thumbnail: { url: user.displayAvatarURL({ dynamic: true, size: 256 }) },
        footer: { text: '🎭 Rol Yönetimi', icon_url: member.guild.iconURL() },
        timestamp: new Date().toISOString(),
    };

    return sendLog(guildId, 'roles', embed);
}

/**
 * Takma ad değişikliği logu
 */
async function sendNicknameChangeLog(guildId, member, oldNick, newNick) {
    const user = member.user;

    const embed = {
        author: {
            name: `${formatUser(user)} — Takma Ad Değişti`,
            icon_url: user.displayAvatarURL({ dynamic: true, size: 128 }),
        },
        color: COLORS.INFO,
        description: `<@${user.id}> kullanıcısının sunucu takma adı değiştirildi.`,
        fields: [
            { name: '👤 Kullanıcı',  value: `<@${user.id}>`,   inline: true },
            { name: '🆔 ID',         value: `\`${user.id}\``,   inline: true },
            { name: '📝 Önceki Ad',  value: oldNick || '*Yok*', inline: true },
            { name: '✏️ Yeni Ad',   value: newNick || '*Yok*', inline: true },
        ],
        thumbnail: { url: user.displayAvatarURL({ dynamic: true, size: 256 }) },
        footer: { text: '✏️ Takma Ad Değişikliği', icon_url: member.guild.iconURL() },
        timestamp: new Date().toISOString(),
    };

    return sendLog(guildId, 'roles', embed);
}

// ─────────────────────────────────────────────────────────────────────────────
// MESAJ LOGLARI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mesaj silme logu
 */
async function sendMessageDeleteLog(guildId, message) {
    const user = message.author;
    const content = truncate(message.content || '*İçerik önbellekte yok*', 900);
    const attachmentCount = message.attachments?.size || 0;

    const embed = {
        author: {
            name: `${formatUser(user)} — Mesaj Silindi`,
            icon_url: user.displayAvatarURL({ dynamic: true, size: 128 }),
        },
        color: COLORS.MESSAGE_DELETE,
        description: `📍 <#${message.channel.id}> kanalında bir mesaj silindi.`,
        fields: [
            { name: '👤 Yazar',       value: `<@${user.id}> — \`${formatUser(user)}\``, inline: true },
            { name: '📺 Kanal',       value: `<#${message.channel.id}>`,                 inline: true },
            { name: '🆔 Mesaj ID',    value: `\`${message.id}\``,                         inline: true },
            { name: '🗑️ İçerik',    value: `\`\`\`${content}\`\`\``,                    inline: false },
            ...(attachmentCount > 0
                ? [{ name: '📎 Ekler', value: `${attachmentCount} dosya silindi`, inline: true }]
                : []),
        ],
        thumbnail: { url: user.displayAvatarURL({ dynamic: true, size: 256 }) },
        footer: { text: '🗑️ Mesaj Silindi', icon_url: message.guild?.iconURL?.() },
        timestamp: new Date().toISOString(),
    };

    return sendLog(guildId, 'suspicious', embed);
}

/**
 * Mesaj düzenleme logu
 */
async function sendMessageEditLog(guildId, oldMessage, newMessage) {
    const user = newMessage.author;
    const before = truncate(oldMessage.content || '*Önceki içerik önbellekte yok*', 450);
    const after  = truncate(newMessage.content || '*İçerik yok*', 450);

    const embed = {
        author: {
            name: `${formatUser(user)} — Mesaj Düzenlendi`,
            icon_url: user.displayAvatarURL({ dynamic: true, size: 128 }),
        },
        color: COLORS.MESSAGE_EDIT,
        description: `📍 <#${newMessage.channel.id}> kanalında bir mesaj düzenlendi.`,
        fields: [
            { name: '👤 Yazar',            value: `<@${user.id}> — \`${formatUser(user)}\``, inline: true },
            { name: '📺 Kanal',            value: `<#${newMessage.channel.id}>`,               inline: true },
            { name: '🆔 Mesaj ID',         value: `\`${newMessage.id}\``,                       inline: true },
            { name: '📄 Önceki İçerik',   value: `\`\`\`${before}\`\`\``,                      inline: false },
            { name: '✏️ Güncel İçerik',  value: `\`\`\`${after}\`\`\``,                       inline: false },
        ],
        thumbnail: { url: user.displayAvatarURL({ dynamic: true, size: 256 }) },
        footer: { text: '✏️ Mesaj Düzenlendi', icon_url: newMessage.guild?.iconURL?.() },
        timestamp: new Date().toISOString(),
    };

    const row = createButtonRow([
        { label: 'Mesaja Git', emoji: '🔗', url: newMessage.url },
    ]);

    return sendLog(guildId, 'suspicious', embed, [row]);
}

// ─────────────────────────────────────────────────────────────────────────────
// SES KANALI LOGLARI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ses kanalına giriş logu
 */
async function sendVoiceJoinLog(guildId, member, channel) {
    const user = member.user;
    const memberCount = channel.members?.size ?? 0;

    const embed = {
        author: {
            name: `${formatUser(user)} — Ses Kanalına Katıldı`,
            icon_url: user.displayAvatarURL({ dynamic: true, size: 128 }),
        },
        color: COLORS.VOICE,
        description: `🔊 <@${user.id}> **${channel.name}** kanalına bağlandı.`,
        fields: [
            { name: '👤 Kullanıcı',       value: `<@${user.id}>`,           inline: true },
            { name: '🔊 Kanal',           value: `**${channel.name}**`,      inline: true },
            { name: '👥 Kanalda Bulunan', value: `${memberCount} kişi`,       inline: true },
        ],
        footer: { text: '🔊 Ses Kanalı Girişi', icon_url: member.guild.iconURL() },
        timestamp: new Date().toISOString(),
    };

    return sendLog(guildId, 'main', embed);
}

/**
 * Ses kanalından çıkış logu
 */
async function sendVoiceLeaveLog(guildId, member, channel) {
    const user = member.user;

    const embed = {
        author: {
            name: `${formatUser(user)} — Ses Kanalından Ayrıldı`,
            icon_url: user.displayAvatarURL({ dynamic: true, size: 128 }),
        },
        color: 0x607D8B,
        description: `🔇 <@${user.id}> **${channel.name}** kanalından ayrıldı.`,
        fields: [
            { name: '👤 Kullanıcı', value: `<@${user.id}>`,      inline: true },
            { name: '🔊 Kanal',     value: `**${channel.name}**`, inline: true },
        ],
        footer: { text: '🔇 Ses Kanalı Çıkışı', icon_url: member.guild.iconURL() },
        timestamp: new Date().toISOString(),
    };

    return sendLog(guildId, 'main', embed);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAĞAZA / CÜZDAN LOGLARI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mağaza işlemi logu
 */
async function sendStoreLog(guildId, userId, action, itemName, amount, extraFields = []) {
    const embed = {
        author: { name: `🛒 Mağaza — ${action}` },
        color: COLORS.STORE,
        description: `<@${userId}> bir mağaza işlemi gerçekleştirdi.`,
        fields: [
            { name: '👤 Kullanıcı', value: `<@${userId}>`,    inline: true },
            { name: '📦 Ürün',      value: itemName,            inline: true },
            { name: '💰 Tutar',     value: `**${amount}** coin`, inline: true },
            { name: '🔖 İşlem',     value: action,              inline: true },
            ...extraFields,
        ],
        footer: { text: '🛒 Mağaza İşlemi' },
        timestamp: new Date().toISOString(),
    };

    const row = createButtonRow([
        { label: 'Kullanıcı Profili', emoji: '👤', url: `https://discord.com/users/${userId}` },
    ]);

    return sendLog(guildId, 'store', embed, [row]);
}

/**
 * Cüzdan işlemi logu
 */
async function sendWalletLog(guildId, userId, action, amount, balance, extraFields = []) {
    const isGain = amount >= 0;

    const embed = {
        author: { name: `💰 Cüzdan — ${action}` },
        color: isGain ? COLORS.WALLET_PLUS : COLORS.WALLET_MINUS,
        description: `<@${userId}> kullanıcısının cüzdanında değişiklik oldu.`,
        fields: [
            { name: '👤 Kullanıcı',                         value: `<@${userId}>`,            inline: true },
            { name: isGain ? '📈 Kazanılan' : '📉 Harcanan', value: `**${Math.abs(amount)}** coin`, inline: true },
            { name: '💼 Yeni Bakiye',                        value: `**${balance}** coin`,      inline: true },
            { name: '🔖 İşlem Türü',                         value: action,                     inline: true },
            ...extraFields,
        ],
        footer: { text: '💰 Cüzdan İşlemi' },
        timestamp: new Date().toISOString(),
    };

    const row = createButtonRow([
        { label: 'Kullanıcı Profili', emoji: '👤', url: `https://discord.com/users/${userId}` },
    ]);

    return sendLog(guildId, 'wallet', embed, [row]);
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMİN LOGLARI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Admin işlemi logu
 */
async function sendAdminLog(guildId, adminId, action, details = {}, adminAvatarURL = null) {
    const embed = {
        author: {
            name: `⚡ Admin — ${action}`,
            ...(adminAvatarURL ? { icon_url: adminAvatarURL } : {}),
        },
        color: COLORS.ADMIN,
        description: `<@${adminId}> bir yönetici işlemi gerçekleştirdi.`,
        fields: [
            { name: '👑 Yönetici', value: `<@${adminId}>`, inline: true },
            { name: '🔖 İşlem',   value: action,           inline: true },
            ...Object.entries(details).map(([key, value]) => ({
                name: key,
                value: truncate(String(value), 512),
                inline: true,
            })),
        ],
        footer: { text: '⚡ Admin Paneli' },
        timestamp: new Date().toISOString(),
    };

    return sendLog(guildId, 'admin', embed);
}

/**
 * Admin komut kullanımı logu
 */
async function sendAdminCommandLog(guildId, interaction) {
    const user = interaction.user;
    const commandName = interaction.commandName;

    const options = [];
    interaction.options?.data?.forEach(opt => {
        options.push(`\`${opt.name}\`: ${opt.value ?? '*-*'}`);
    });

    const embed = {
        author: {
            name: `${formatUser(user)} — Admin Komutu`,
            icon_url: user.displayAvatarURL({ dynamic: true, size: 128 }),
        },
        color: COLORS.ADMIN,
        description: `\`/${commandName}\` komutu kullanıldı.`,
        fields: [
            { name: '👑 Kullanıcı',  value: `<@${user.id}>`,                                      inline: true },
            { name: '📺 Kanal',      value: `<#${interaction.channel?.id ?? '0'}>`,                inline: true },
            { name: '📋 Komut',      value: `\`/${commandName}\``,                                 inline: true },
            ...(options.length ? [{ name: '⚙️ Parametreler', value: options.join('\n'), inline: false }] : []),
        ],
        thumbnail: { url: user.displayAvatarURL({ dynamic: true, size: 256 }) },
        footer: { text: '⚡ Admin Komutu', icon_url: interaction.guild?.iconURL?.() },
        timestamp: new Date().toISOString(),
    };

    return sendLog(guildId, 'admin', embed);
}

// ─────────────────────────────────────────────────────────────────────────────
// SİSTEM / HATA LOGLARI (Yalnızca geliştirici sunucusuna)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sistem logu (yalnızca geliştirici sunucusu)
 */
async function sendSystemLog(guildId, title, description, details = {}) {
    if (guildId !== DEVELOPER_GUILD_ID) return false;

    const embed = {
        author: { name: `⚙️ Sistem — ${title}` },
        color: COLORS.SYSTEM,
        description,
        fields: Object.entries(details).map(([key, value]) => ({
            name: key,
            value: truncate(String(value), 512),
            inline: true,
        })),
        footer: { text: '⚙️ Sistem Logu' },
        timestamp: new Date().toISOString(),
    };

    return sendLog(guildId, 'system', embed);
}

/**
 * Hata logu (yalnızca geliştirici sunucusu)
 */
async function sendErrorLog(guildId, error, context = {}) {
    if (guildId !== DEVELOPER_GUILD_ID) return false;

    const stack = error?.stack ? truncate(error.stack, 500) : 'Yok';

    const embed = {
        author: { name: '🚨 Hata Raporu' },
        color: COLORS.ERROR,
        description: `\`\`\`${truncate(String(error), 500)}\`\`\``,
        fields: [
            { name: '📍 Stack Trace', value: `\`\`\`${stack}\`\`\``, inline: false },
            ...Object.entries(context).map(([key, value]) => ({
                name: key,
                value: truncate(String(value), 256),
                inline: true,
            })),
        ],
        footer: { text: '🚨 Hata Logu' },
        timestamp: new Date().toISOString(),
    };

    return sendLog(guildId, 'error', embed);
}

// ─────────────────────────────────────────────────────────────────────────────
// GERIYE DÖNÜK UYUMLULUK (eski çağrılar için)
// ─────────────────────────────────────────────────────────────────────────────

async function sendMainLog(guildId, title, description, color = COLORS.INFO, fields = []) {
    const embed = {
        title,
        description,
        color,
        fields,
        footer: { text: '📋 Genel Log' },
        timestamp: new Date().toISOString(),
    };
    return sendLog(guildId, 'main', embed);
}

async function sendAuthLog(guildId, userId, action, details = {}) {
    const embed = {
        author: { name: `🔐 Auth — ${action}` },
        color: COLORS.INFO,
        description: `<@${userId}>`,
        fields: [
            { name: 'İşlem',       value: action,             inline: true },
            { name: 'Kullanıcı ID', value: `\`${userId}\``,   inline: true },
            ...Object.entries(details).map(([key, value]) => ({
                name: key,
                value: truncate(String(value), 512),
                inline: true,
            })),
        ],
        footer: { text: '🔐 Auth Logu' },
        timestamp: new Date().toISOString(),
    };
    return sendLog(guildId, 'auth', embed);
}

async function sendRoleLog(guildId, userId, action, roleName, roleId) {
    return sendAdminLog(guildId, userId, action, { Rol: `${roleName} (\`${roleId}\`)` });
}

module.exports = {
    sendLog,
    // Yardımcı fonksiyonlar (index.js gibi dosyalar tekrar tanımlamamak için kullanabilir)
    formatUser,
    truncate,
    createButtonRow,
    // Zengin log fonksiyonları
    sendMemberJoinLog,
    sendMemberLeaveLog,
    sendBanLog,
    sendUnbanLog,
    sendRoleAddLog,
    sendRoleRemoveLog,
    sendNicknameChangeLog,
    sendMessageDeleteLog,
    sendMessageEditLog,
    sendVoiceJoinLog,
    sendVoiceLeaveLog,
    sendStoreLog,
    sendWalletLog,
    sendAdminLog,
    sendAdminCommandLog,
    sendSystemLog,
    sendErrorLog,
    // Geriye dönük uyumluluk
    sendMainLog,
    sendAuthLog,
    sendRoleLog,
};
