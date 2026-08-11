const { queueMessageEarn } = require('./earnBuffer');
const { shouldEarnMessage } = require('./antiSpam');
const { supabase } = require('../core/database');

// Server settings cache — longer TTL; web invalidate-config clears it
const serverConfigCache = new Map(); // guildId -> { ts, data }
const SERVER_CONFIG_TTL = Number(process.env.SERVER_CONFIG_TTL_MS || 5 * 60 * 1000);

const getServerConfig = async (guildId) => {
    const cached = serverConfigCache.get(guildId);
    const now = Date.now();
    if (cached && now - cached.ts < SERVER_CONFIG_TTL) return cached.data;

    try {
        // select('*') avoids failing entirely when optional spam columns are missing
        const { data, error } = await supabase
            .from('servers')
            .select('*')
            .eq('discord_id', guildId)
            .maybeSingle();

        if (error) {
            console.error('getServerConfig error', error.message);
            return cached?.data ?? null;
        }

        const cfg = data || null;
        serverConfigCache.set(guildId, { ts: now, data: cfg });
        return cfg;
    } catch (err) {
        console.error('getServerConfig error', err);
        return cached?.data ?? null;
    }
};

const handleMessage = async (message, config) => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const serverCfg = await getServerConfig(message.guild.id);
    if (!serverCfg) return;

    const requiredRoleId = serverCfg?.verify_role_id ?? null;
    const earnPerMessage = Number(serverCfg?.earn_per_message ?? config.earnPerMessage) || 0;
    const messageEarnEnabled = serverCfg?.message_earn_enabled ?? true;
    const tagId = serverCfg?.tag_id ?? null;
    const tagBonusMessage = Number(serverCfg?.tag_bonus_message ?? 0) || 0;
    const boosterBonusMessage = Number(serverCfg?.booster_bonus_message ?? 0) || 0;
    const earnChannels = serverCfg?.earn_channels ?? null;

    if (!messageEarnEnabled || !requiredRoleId || !(earnPerMessage > 0)) return;

    if (earnChannels && typeof earnChannels === 'object') {
        const mode = earnChannels.mode;
        const msgChannels = earnChannels.message_channels || [];
        const msgCategories = earnChannels.message_categories || [];
        const channelId = message.channel.id;
        const categoryId = message.channel.parentId || message.channel.parent_id || null;
        const isInList = msgChannels.includes(channelId) || (categoryId && msgCategories.includes(categoryId));

        if (mode === 'whitelist' && !isInList) return;
        if (mode === 'blacklist' && isInList) return;
    }

    let member = message.member;
    try {
        if (!member && message.guild) {
            member = await message.guild.members.fetch(message.author.id).catch(() => null);
        }
    } catch {
        member = message.member;
    }

    const isApproved = Boolean(member?.roles?.cache?.has(requiredRoleId));
    if (!isApproved) return;

    const spamResult = shouldEarnMessage(message.guild.id, message.author.id, message, serverCfg);
    if (!spamResult.allowed) return;

    try {
        const permissionCache = require('./permissionCache');
        let bonus = 0;
        let hasTag = false;
        let isBooster = false;
        let memberTagId = null;

        try {
            const entry = await permissionCache.get(message.client, message.guild.id, message.author.id);
            if (entry) {
                hasTag = Boolean(entry.hasTag);
                isBooster = Boolean(entry.isBooster);
            } else {
                const { getMemberServerTagId, getMemberPrimaryGuildId } = require('../utils/memberTag');
                memberTagId = getMemberServerTagId(member || {});
                const memberPrimaryGuildId = getMemberPrimaryGuildId(member || {});
                hasTag = Boolean(
                    tagId &&
                        (String(memberPrimaryGuildId) === String(tagId) ||
                            String(memberTagId) === String(tagId))
                );
                isBooster = Boolean(member?.premiumSinceTimestamp || member?.premiumSince);
                permissionCache.updateForMember(message.client, message.guild.id, member).catch(() => null);
            }
        } catch {
            const { getMemberServerTagId, getMemberPrimaryGuildId } = require('../utils/memberTag');
            memberTagId = getMemberServerTagId(member || {});
            const memberPrimaryGuildId = getMemberPrimaryGuildId(member || {});
            hasTag = Boolean(
                tagId &&
                    (String(memberPrimaryGuildId) === String(tagId) || String(memberTagId) === String(tagId))
            );
            isBooster = Boolean(member?.premiumSinceTimestamp || member?.premiumSince);
        }

        if (hasTag) bonus += tagBonusMessage;
        if (isBooster) bonus += boosterBonusMessage;

        const totalRaw = Number((earnPerMessage + bonus).toFixed(2));
        const result = await queueMessageEarn({
            guildId: message.guild.id,
            userId: message.author.id,
            amount: totalRaw,
            username: message.author.username,
            hasTag,
            dailyCap: serverCfg?.daily_message_earn_cap,
            meta: {
                channelId: message.channel.id,
                base: earnPerMessage,
                bonus,
                hasTag,
                isBooster,
                memberTagId: memberTagId ?? null,
            },
        });

        if (!result.queued) return;
    } catch (e) {
        console.error('[messageProcessor] queue error', e.message);
    }
};

module.exports = {
    handleMessage,
};

module.exports.invalidateServerConfig = (guildId) => {
    try {
        serverConfigCache.delete(String(guildId));
        try {
            const earnings = require('./earnings');
            if (typeof earnings.invalidateVoiceConfig === 'function') {
                earnings.invalidateVoiceConfig(guildId);
            }
        } catch {
            /* optional */
        }
        console.log('invalidateServerConfig: cache cleared for', guildId);
        return true;
    } catch (e) {
        console.error('invalidateServerConfig error', e);
        return false;
    }
};
