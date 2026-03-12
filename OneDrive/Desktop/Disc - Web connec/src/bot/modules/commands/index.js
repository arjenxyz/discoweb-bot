// modules/commands/index.js - Ana komut yönlendirici
const { autoRegisterIfNeeded, handleKayitCommand, handleProfilCommand, handleParaCommand, handleTopCommand } = require('./user');
const { handleMagazaEkleCommand, handlePromoKodCommand, handleMagazaSilCommand, handleBakimCommand, handleKurulumKaldirCommand } = require('./admin');
const { supabase } = require('../../modules/database');
const { addBalance, upsertMemberDailyStats, upsertServerDailyStats } = require('../../modules/earnings');

// Simple in-memory cache for server settings to avoid DB hit on every message
const serverConfigCache = new Map(); // guildId -> { ts, data }
const SERVER_CONFIG_TTL = 60 * 1000; // 60s

const getServerConfig = async (guildId) => {
    const cached = serverConfigCache.get(guildId);
    const now = Date.now();
    if (cached && (now - cached.ts) < SERVER_CONFIG_TTL) return cached.data;

    try {
            const { data } = await supabase
                        .from('servers')
                        .select('verify_role_id,admin_role_id,discord_id,earn_per_message,message_earn_enabled,earn_per_voice_minute,voice_earn_enabled,tag_id,tag_bonus_message,tag_bonus_voice,booster_bonus_message,booster_bonus_voice')
                .eq('discord_id', guildId)
                .maybeSingle();

        const cfg = data || null;
        serverConfigCache.set(guildId, { ts: now, data: cfg });
        return cfg;
    } catch (err) {
        console.error('getServerConfig error', err);
        return null;
    }
};

// Ana mesaj işleme fonksiyonu
const handleMessage = async (message, config, addDailyEarning) => {
    // Kendi mesajına cevap vermesin
    if (message.author.bot) return;

    if (!message.guild) return;

    // Fetch server-level configuration (may override env config)
    const serverCfg = await getServerConfig(message.guild.id);
    // Require a server-level verify role to be set. If not set, no one is eligible.
    const requiredRoleId = serverCfg?.verify_role_id ?? null;
    const earnPerMessage = Number(serverCfg?.earn_per_message ?? config.earnPerMessage) || 0;
    const messageEarnEnabled = serverCfg?.message_earn_enabled ?? true;
    const tagId = serverCfg?.tag_id ?? null;
    const tagBonusMessage = Number(serverCfg?.tag_bonus_message ?? 0) || 0;
    const boosterBonusMessage = Number(serverCfg?.booster_bonus_message ?? 0) || 0;

    // Ensure we have a GuildMember object (cache may be empty)
    let member = message.member;
    try {
        if (!member && message.guild) member = await message.guild.members.fetch(message.author.id).catch(() => null);
    } catch (e) {
        member = message.member;
    }

    const isApproved = requiredRoleId ? Boolean(member?.roles?.cache?.has(requiredRoleId)) : false;

    console.log(`[commands] messageDebug guild:${message.guild?.id} user:${message.author.id} earnPerMessage:${earnPerMessage} messageEarnEnabled:${messageEarnEnabled} requiredRole:${requiredRoleId} isApproved:${isApproved} content:${message.content.slice(0,80)}`);

    // Eğer onaylı üye ise otomatik kayıt et ve anlık bakiye ekle
    if (messageEarnEnabled && isApproved && earnPerMessage > 0) {
        await autoRegisterIfNeeded(message.author.id, message.author.username);
        try {
            // compute tag/booster bonuses via permission cache when available
            const permissionCache = require('../permissionCache');
            let bonus = 0;
            let hasTag = false;
            let isBooster = false;
            // Prepare variables for member tag lookup (ensure scoped outside try blocks)
            let memberTagId = null;
            let memberPrimaryGuildId = null;
            try {
                const entry = await permissionCache.get(message.client, message.guild.id, message.author.id);
                if (entry) {
                    hasTag = Boolean(entry.hasTag);
                    isBooster = Boolean(entry.isBooster);
                } else {
                    const { getMemberServerTagId, getMemberPrimaryGuildId } = require('../memberTag');
                    memberTagId = getMemberServerTagId(message.member || {});
                    memberPrimaryGuildId = getMemberPrimaryGuildId(message.member || {});
                    hasTag = Boolean(tagId && (String(memberPrimaryGuildId) === String(tagId) || String(memberTagId) === String(tagId)));
                    isBooster = Boolean(message.member?.premiumSinceTimestamp || message.member?.premiumSince);
                    permissionCache.updateForMember(message.client, message.guild.id, message.member).catch(() => null);
                }
            } catch (e) {
                const { getMemberServerTagId, getMemberPrimaryGuildId } = require('../memberTag');
                memberTagId = getMemberServerTagId(message.member || {});
                memberPrimaryGuildId = getMemberPrimaryGuildId(message.member || {});
                hasTag = Boolean(tagId && (String(memberPrimaryGuildId) === String(tagId) || String(memberTagId) === String(tagId)));
                isBooster = Boolean(message.member?.premiumSinceTimestamp || message.member?.premiumSince);
            }

            if (hasTag) bonus += tagBonusMessage;
            if (isBooster) bonus += boosterBonusMessage;

            const total = Number((earnPerMessage + bonus).toFixed(2));

            // If user has the tag, record tag_granted_at in member_profiles if not already set
            if (hasTag) {
                try {
                    const serverIdResp = await supabase.from('servers').select('id').eq('discord_id', message.guild.id).maybeSingle();
                    const serverId = serverIdResp.data?.id ?? message.guild.id;
                    const { data: prof } = await supabase.from('member_profiles').select('tag_granted_at').eq('guild_id', serverId).eq('user_id', message.author.id).maybeSingle();
                    if (!prof || !prof.tag_granted_at) {
                        await supabase.from('member_profiles').upsert({ guild_id: serverId, user_id: message.author.id, tag_granted_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'guild_id,user_id' });
                    }
                } catch (e) {
                    console.warn('Failed to upsert tag_granted_at', e);
                }
            }

            await addBalance(message.guild.id, message.author.id, total, 'earn_message', {
                channelId: message.channel.id,
                base: earnPerMessage,
                bonus: bonus,
                hasTag,
                isBooster,
                memberTagId: memberTagId ?? null,
            });
            try {
                const statDate = new Date().toISOString().slice(0,10);
                // increment member and server daily stats for messages
                await upsertMemberDailyStats(message.guild.id, message.author.id, statDate, 1, 0);
                await upsertServerDailyStats(message.guild.id, statDate, 1, 0);
            } catch (e) {
                console.warn('Failed to upsert message stats', e);
            }
        } catch (e) {
            console.error('Error adding immediate message earnings', e);
        }
    }

    const isAdmin = config.adminRoleId ? message.member?.roles?.cache?.has(config.adminRoleId) : false;

    // Komut yönlendirme
    const content = message.content.toLowerCase();

    // Kullanıcı komutları
    if (content === '!kayit') {
        await handleKayitCommand(message);
    } else if (content === '!profil') {
        await handleProfilCommand(message);
    } else if (content === '!para') {
        await handleParaCommand(message);
    } else if (content === '!top') {
        await handleTopCommand(message);
    }

    // Admin komutları
    else if (content.startsWith('!magazaekle')) {
        if (!isAdmin) {
            message.reply('❌ Bu komut için admin yetkiniz yok!');
            return;
        }
        await handleMagazaEkleCommand(message, config.guildId);
    } else if (content.startsWith('!promokod')) {
        if (!isAdmin) {
            message.reply('❌ Bu komut için admin yetkiniz yok!');
            return;
        }
        await handlePromoKodCommand(message, config.guildId);
    } else if (content.startsWith('!magazasil')) {
        if (!isAdmin) {
            message.reply('❌ Bu komut için admin yetkiniz yok!');
            return;
        }
        await handleMagazaSilCommand(message, config.guildId);
    } else if (content.startsWith('!bakim')) {
        if (!isAdmin) {
            message.reply('❌ Bu komut için admin yetkiniz yok!');
            return;
        }
        await handleBakimCommand(message, config.guildId);
    } else if (content.startsWith('!kurumukaldir')) {
        if (!isAdmin) {
            message.reply('❌ Bu komut için admin yetkiniz yok!');
            return;
        }
        await handleKurulumKaldirCommand(message, config.guildId);
    }

    // Yardım komutu
    else if (content === '!yardim' || content === '!help') {
        const helpText = generateHelpText(isAdmin);
        message.reply(helpText);
    }
    // Debug: check server tag of a mentioned user
    else if (content.startsWith('!checktag')) {
        // usage: !checktag @user OR !checktag <id>
        try {
            let targetMember = null;
            if (message.mentions && message.mentions.members && message.mentions.members.size) {
                targetMember = message.mentions.members.first();
            } else {
                const parts = message.content.split(/\s+/);
                if (parts[1]) {
                    const id = parts[1].replace(/[<@!>]/g, '');
                    try {
                        targetMember = await message.guild.members.fetch(id).catch(() => null);
                    } catch (e) {
                        targetMember = null;
                    }
                }
            }

            if (!targetMember) {
                await message.reply('Kullanıcı bulunamadı. Lütfen @mention veya kullanıcı IDsi girin.');
                return;
            }

            // Dump raw member object to bot console for debugging (avoid JSON.stringify which can fail)
            try {
                const util = require('util');
                console.log('===== !checktag RAW GUILD MEMBER START =====');
                console.log(util.inspect(targetMember, { depth: 6, colors: false }));
                // also dump the nested user object if present
                if (targetMember.user) console.log('--- user object ---', util.inspect(targetMember.user, { depth: 6, colors: false }));
                // try to log potential tag-related fields explicitly
                try {
                    const maybeProfile = targetMember?.user?.public_flags ?? targetMember?.user?.flags ?? null;
                    if (maybeProfile) console.log('user.flags/public_flags:', util.inspect(maybeProfile, { depth: 4 }));
                } catch (e) {}
                console.log('===== !checktag RAW GUILD MEMBER END =====');
            } catch (e) {
                console.error('Failed to dump raw member object for !checktag', e);
            }
            await message.reply('Raw member data printed to bot console. Check logs for avatar_decoration_data, clan, guild_profile, metadata, etc.');
        } catch (e) {
            console.error('!checktag handler error', e);
            await message.reply('!checktag çalıştırılırken hata oluştu. Konsolu kontrol et.');
        }
    }
};

// Yardım metni oluşturma fonksiyonu
const generateHelpText = (isAdmin) => {
    let helpText = `🤖 **Disc Nexus Bot Komutları**\n\n`;

    // Genel komutlar
    helpText += `👤 **Genel Komutlar:**\n`;
    helpText += `• \`!kayit\` - Sisteme kayıt ol\n`;
    helpText += `• \`!profil\` - Profil bilgilerini göster\n`;
    helpText += `• \`!para\` - Cüzdan bakiyesini göster\n`;
    helpText += `• \`!top\` - En zengin kullanıcıları listele\n`;
    helpText += `• \`!yardim\` - Bu yardım mesajını göster\n\n`;

    // Admin komutları
    if (isAdmin) {
        helpText += `🔧 **Admin Komutları:**\n`;
        helpText += `• \`!magazaekle\` - Mağaza ürünü ekle\n`;
        helpText += `• \`!magazasil\` - Mağaza ürünü kaldır\n`;
        helpText += `• \`!promokod\` - Promosyon kodu oluştur\n`;
        helpText += `• \`!bakim\` - Bakım modunu kontrol et\n`;
        helpText += `• \`!kurumukaldir\` - Kurulum kaldırma işlemi\n\n`;
    }

    helpText += `💡 **İpucu:** İlk mesajınızda otomatik kayıt olursunuz!\n`;
    helpText += `🌐 **Web Panel:** ${process.env.WEB_URL || 'http://localhost:3000'}`;

    return helpText;
};

module.exports = {
    handleMessage
};

// Cache invalidation helper (web API calls this after admin updates settings)
module.exports.invalidateServerConfig = (guildId) => {
    try {
        serverConfigCache.delete(String(guildId));
        console.log('invalidateServerConfig: cache cleared for', guildId);
        return true;
    } catch (e) {
        console.error('invalidateServerConfig error', e);
        return false;
    }
};