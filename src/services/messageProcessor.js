// modules/commands/index.js - Ana komut yönlendirici
// imports removed
const { supabase } = require('../core/database');
const { addDailyEarning, upsertMemberDailyStats, upsertServerDailyStats } = require('./earnings');
const { shouldEarnMessage } = require('./antiSpam');

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
                        .select('verify_role_id,admin_role_id,discord_id,earn_per_message,message_earn_enabled,earn_per_voice_minute,voice_earn_enabled,tag_id,tag_bonus_message,tag_bonus_voice,booster_bonus_message,booster_bonus_voice,earn_channels,spam_message_cooldown_ms,spam_min_message_length,spam_flood_count,spam_flood_window_ms,spam_duplicate_count,daily_message_earn_cap,daily_voice_earn_cap')
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
const handleMessage = async (message, config) => {
    // Kendi mesajına cevap vermesin
    if (message.author.bot) return;

    if (!message.guild) return;

    // Fetch server-level configuration (may override env config)
    const serverCfg = await getServerConfig(message.guild.id);
    if (!serverCfg) {
        console.warn(`[messageEarning] Server config not found for guild:${message.guild.id} — servers tablosunda discord_id eşleşmiyor, kazanç verilemiyor.`);
        return;
    }
    // Require a server-level verify role to be set. If not set, no one is eligible.
    const requiredRoleId = serverCfg?.verify_role_id ?? null;
    const earnPerMessage = Number(serverCfg?.earn_per_message ?? config.earnPerMessage) || 0;
    const messageEarnEnabled = serverCfg?.message_earn_enabled ?? true;
    const tagId = serverCfg?.tag_id ?? null;
    const tagBonusMessage = Number(serverCfg?.tag_bonus_message ?? 0) || 0;
    const boosterBonusMessage = Number(serverCfg?.booster_bonus_message ?? 0) || 0;
    const earnChannels = serverCfg?.earn_channels ?? null;

    // Channel-based earning filter: check if this channel or its category is allowed
    if (earnChannels && typeof earnChannels === 'object') {
        const mode = earnChannels.mode; // 'whitelist' or 'blacklist'
        const msgChannels = earnChannels.message_channels || [];
        const msgCategories = earnChannels.message_categories || [];
        const channelId = message.channel.id;
        const categoryId = message.channel.parentId || message.channel.parent_id || null;

        const isInList = msgChannels.includes(channelId) || (categoryId && msgCategories.includes(categoryId));

        if (mode === 'whitelist' && !isInList) {
            // Not in whitelist, skip earning
            return;
        }
        if (mode === 'blacklist' && isInList) {
            // In blacklist, skip earning
            return;
        }
    }

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
        // Anti-spam kontrolü
        const spamResult = shouldEarnMessage(message.guild.id, message.author.id, message, serverCfg);
        if (!spamResult.allowed) {
            console.log(`[antiSpam] message blocked guild:${message.guild.id} user:${message.author.id} reason:${spamResult.reason}`);
        } else {
        const { autoRegisterIfNeeded } = require('../core/database'); // Or wherever it belongs. Wait, autoRegisterIfNeeded was in user.js! We deleted user.js.
        // Let's implement a simple autoRegisterIfNeeded or ignore it if not needed, but wait, the database module has an upsert for member_profiles.
        // The user.js autoRegisterIfNeeded basically just upserted user_id, guild_id, and username. We can just do that here.
        try {
            await supabase.from('member_profiles').upsert({
                user_id: message.author.id,
                guild_id: message.guild.id,
                username: message.author.username,
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id,guild_id' });
        } catch (e) {
            console.error('autoRegister failed:', e);
        }
        try {
            // compute tag/booster bonuses via permission cache when available
            const permissionCache = require('./permissionCache');
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
                    const { getMemberServerTagId, getMemberPrimaryGuildId } = require('../utils/memberTag');
                    memberTagId = getMemberServerTagId(message.member || {});
                    memberPrimaryGuildId = getMemberPrimaryGuildId(message.member || {});
                    hasTag = Boolean(tagId && (String(memberPrimaryGuildId) === String(tagId) || String(memberTagId) === String(tagId)));
                    isBooster = Boolean(message.member?.premiumSinceTimestamp || message.member?.premiumSince);
                    permissionCache.updateForMember(message.client, message.guild.id, message.member).catch(() => null);
                }
            } catch (e) {
                const { getMemberServerTagId, getMemberPrimaryGuildId } = require('../utils/memberTag');
                memberTagId = getMemberServerTagId(message.member || {});
                memberPrimaryGuildId = getMemberPrimaryGuildId(message.member || {});
                hasTag = Boolean(tagId && (String(memberPrimaryGuildId) === String(tagId) || String(memberTagId) === String(tagId)));
                isBooster = Boolean(message.member?.premiumSinceTimestamp || message.member?.premiumSince);
            }

            if (hasTag) bonus += tagBonusMessage;
            if (isBooster) bonus += boosterBonusMessage;

            const total = Number((earnPerMessage + bonus).toFixed(2));

            // If user has the tag, record tag_granted_at in member_profiles if not already set
            // Use Discord guild ID (not internal server UUID) to match permissionCache and web API
            if (hasTag) {
                try {
                    const { data: prof } = await supabase.from('member_profiles').select('tag_granted_at').eq('guild_id', message.guild.id).eq('user_id', message.author.id).maybeSingle();
                    if (!prof || !prof.tag_granted_at) {
                        await supabase.from('member_profiles').upsert({ guild_id: message.guild.id, user_id: message.author.id, tag_granted_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'guild_id,user_id' });
                    }
                } catch (e) {
                    console.warn('Failed to upsert tag_granted_at', e);
                }
            }

            await addDailyEarning(message.guild.id, message.author.id, 'message', total, {
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
        } // else (anti-spam passed)
    }

    // Komut yönlendirme (Kaldırıldı)
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