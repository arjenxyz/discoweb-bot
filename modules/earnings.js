// modules/earnings.js
const { supabase, getGuild, getLocalDate } = require('./database');
const { EmbedBuilder } = require('discord.js');

// Log gönderme fonksiyonu
async function sendWalletLog(guildId, embed) {
    try {
        const { data: logChannel } = await supabase
            .from('bot_log_channels')
            .select('channel_id')
            .eq('guild_id', guildId)
            .eq('channel_type', 'wallet')
            .eq('is_active', true)
            .maybeSingle();

        if (!logChannel) return;

        const guild = await getGuild(null, guildId);
        if (!guild) return;

        const channel = guild.channels.cache.get(logChannel.channel_id);
        if (!channel) return;

        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('Wallet log gönderme hatası:', error);
    }
}

const addBalance = async (guildId, userId, amount, type, metadata = {}) => {
    if (!amount || amount <= 0) return;
    try {
        console.log(`[earnings] addBalance called - guild:${guildId} user:${userId} amount:${amount} type:${type} metadata:${JSON.stringify(metadata)}`);
    } catch (e) {
        console.log('[earnings] addBalance - error stringifying metadata', e);
    }

    try {
        const { data: wallet, error: selErr } = await supabase
            .from('member_wallets')
            .select('balance')
            .eq('guild_id', guildId)
            .eq('user_id', userId)
            .maybeSingle();

        if (selErr) console.error('[earnings] addBalance - select wallet error', selErr);

        const current = Number(wallet?.balance || 0);
        const next = Number((current + amount).toFixed(2));

        const { error: upsertErr } = await supabase.from('member_wallets').upsert({
            guild_id: guildId,
            user_id: userId,
            balance: next,
            updated_at: new Date().toISOString()
        }, { onConflict: 'guild_id,user_id' });
        if (upsertErr) console.error('[earnings] addBalance - upsert wallet error', upsertErr);

        const { error: ledgerErr } = await supabase.from('wallet_ledger').insert({
            guild_id: guildId,
            user_id: userId,
            amount,
            type,
            balance_after: next,
            metadata
        });
        if (ledgerErr) console.error('[earnings] addBalance - insert wallet_ledger error', ledgerErr);

        console.log(`[earnings] addBalance applied - guild:${guildId} user:${userId} amount:${amount} type:${type} balance_after:${next}`);
    } catch (e) {
        console.error('[earnings] addBalance unexpected error', e);
    }

    // Para harcama logu
    if (type === 'purchase') {
        const embed = new EmbedBuilder()
            .setColor('#f44336')
            .setTitle('💸 Para Harcandı')
            .setDescription(`<@${userId}> para harcadı`)
            .addFields(
                { name: 'Kullanıcı', value: `<@${userId}>`, inline: true },
                { name: 'Miktar', value: `${Math.abs(amount)} coin`, inline: true },
                { name: 'İşlem', value: 'Mağaza Satın Alma', inline: true },
                { name: 'Yeni Bakiye', value: `${next} coin`, inline: true }
            )
            .setTimestamp();

        await sendWalletLog(guildId, embed);
    }
};

const processVoiceEarnings = async (client, guildId, requiredRoleId, earnPerVoiceMinute) => {
    if (!client.isReady()) return;
    const guild = await getGuild(client, guildId);

    const voiceStates = guild.voiceStates.cache;
    for (const [, voiceState] of voiceStates) {
        const member = voiceState.member;
        if (!member || member.user.bot) continue;
        if (!voiceState.channelId) continue;

        // Fetch per-server settings to enforce verify role and voice earning toggle
        let serverCfg = null;
        try {
            const { data } = await supabase
                .from('servers')
                .select('verify_role_id,voice_earn_enabled,earn_per_voice_minute,discord_id,id,tag_id,tag_bonus_voice,booster_bonus_voice')
                .or(`discord_id.eq.${guildId},id.eq.${guildId}`)
                .maybeSingle();
            serverCfg = data || null;
        } catch (e) {
            serverCfg = null;
        }

        const cfgVerifyRole = serverCfg?.verify_role_id ?? null;
        const voiceEnabled = serverCfg?.voice_earn_enabled ?? true;
        const perMinute = Number(serverCfg?.earn_per_voice_minute ?? earnPerVoiceMinute ?? process.env.PAPEL_PER_VOICE_MINUTE ?? 0.2);
        const tagId = serverCfg?.tag_id ?? null;
        const tagBonusVoice = Number(serverCfg?.tag_bonus_voice ?? 0) || 0;
        const boosterBonusVoice = Number(serverCfg?.booster_bonus_voice ?? 0) || 0;

        // If server has not configured a verify role, do not award anyone — they haven't accepted terms.
        if (!cfgVerifyRole) continue;
        if (!voiceEnabled) continue;

        const isApproved = Boolean(member.roles.cache.has(cfgVerifyRole));
        if (!isApproved) continue;

                // compute tag/booster bonuses using permission cache when available
                const permissionCache = require('./permissionCache');
                let hasTag = false;
                let isBooster = false;
                // ensure these are declared in outer scope so they exist regardless of branch
                let memberTagId = null;
                let memberPrimaryGuildId = null;
                try {
                    const entry = await permissionCache.get(client, guildId, member.id);
                    if (entry) {
                        hasTag = Boolean(entry.hasTag);
                        isBooster = Boolean(entry.isBooster);
                        // try to surface legacy ids if present on entry
                        if (entry.memberTagId) memberTagId = entry.memberTagId;
                        if (entry.primaryGuildId) memberPrimaryGuildId = entry.primaryGuildId;
                    } else {
                        // fallback to legacy detection and seed cache
                        const { getMemberServerTagId, getMemberPrimaryGuildId } = require('./memberTag');
                        memberTagId = getMemberServerTagId(member);
                        memberPrimaryGuildId = getMemberPrimaryGuildId(member);
                        hasTag = Boolean(tagId && (String(memberPrimaryGuildId) === String(tagId) || String(memberTagId) === String(tagId)));
                        isBooster = Boolean(member.premiumSinceTimestamp || member.premiumSince);
                        // attempt to update the cache asynchronously
                        permissionCache.updateForMember(client, guildId, member).catch(() => null);
                    }
                } catch (e) {
                    console.warn('permissionCache lookup failed, falling back', e);
                    const { getMemberServerTagId, getMemberPrimaryGuildId } = require('./memberTag');
                    memberTagId = getMemberServerTagId(member);
                    memberPrimaryGuildId = getMemberPrimaryGuildId(member);
                    hasTag = Boolean(tagId && (String(memberPrimaryGuildId) === String(tagId) || String(memberTagId) === String(tagId)));
                    isBooster = Boolean(member.premiumSinceTimestamp || member.premiumSince);
                }

                let bonus = 0;
                if (hasTag) bonus += tagBonusVoice;
                if (isBooster) bonus += boosterBonusVoice;
        const total = Number((perMinute + bonus).toFixed(2));

        console.log(`[earnings] processVoiceEarnings - guild:${guildId} member:${member.id} channel:${voiceState.channelId} base:${perMinute} bonus:${bonus} total:${total} (awarding immediately)`);

        // If user has the tag, record tag_granted_at in member_profiles if not already set
        if (hasTag) {
            try {
                const serverIdResp = await supabase.from('servers').select('id').eq('discord_id', guildId).maybeSingle();
                const serverId = serverIdResp.data?.id ?? guildId;
                const { data: prof } = await supabase.from('member_profiles').select('tag_granted_at').eq('guild_id', serverId).eq('user_id', member.id).maybeSingle();
                if (!prof || !prof.tag_granted_at) {
                    await supabase.from('member_profiles').upsert({ guild_id: serverId, user_id: member.id, tag_granted_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { onConflict: 'guild_id,user_id' });
                }
            } catch (e) {
                console.warn('Failed to upsert tag_granted_at', e);
            }
        }

        // Award immediately per-minute while in voice (no daily_earnings accumulation)
            await addBalance(guildId, member.id, total, 'earn_voice', {
            channelId: voiceState.channelId,
            base: perMinute,
            bonus,
            hasTag,
            isBooster,
                memberTagId: memberTagId ?? null,
        });
    }
};

const addDailyEarning = async (guildId, userId, source, amount, metadata = {}) => {
    if (!amount || amount <= 0) return;

    const earningDate = getLocalDate(180); // Default timezone offset
    const dateIso = earningDate.toISOString().slice(0, 10);

    const { data: existing } = await supabase
        .from('daily_earnings')
        .select('id,amount')
        .eq('guild_id', guildId)
        .eq('user_id', userId)
        .eq('source', source)
        .eq('earning_date', dateIso)
        .maybeSingle();

    if (existing?.id) {
        const nextAmount = Number(existing.amount || 0) + amount;
        await supabase
            .from('daily_earnings')
            .update({ amount: Number(nextAmount.toFixed(2)), updated_at: new Date().toISOString() })
            .eq('id', existing.id);
        console.log(`[earnings] addDailyEarning updated - guild:${guildId} user:${userId} source:${source} amount:${nextAmount} date:${dateIso}`);
    } else {
        await supabase.from('daily_earnings').insert({
            guild_id: guildId,
            user_id: userId,
            source,
            earning_date: dateIso,
            amount: Number(amount.toFixed(2)),
            metadata
        });
        console.log(`[earnings] addDailyEarning inserted - guild:${guildId} user:${userId} source:${source} amount:${amount} date:${dateIso}`);
    }
};

const upsertMemberDailyStats = async (guildId, userId, statDate, messageCount, voiceMinutes) => {
    const { data: existing } = await supabase
        .from('member_daily_stats')
        .select('id,message_count,voice_minutes')
        .eq('guild_id', guildId)
        .eq('user_id', userId)
        .eq('stat_date', statDate)
        .maybeSingle();

    if (existing?.id) {
        await supabase
            .from('member_daily_stats')
            .update({
                message_count: Number(existing.message_count || 0) + messageCount,
                voice_minutes: Number(existing.voice_minutes || 0) + voiceMinutes,
                updated_at: new Date().toISOString()
            })
            .eq('id', existing.id);
    } else {
        await supabase.from('member_daily_stats').insert({
            guild_id: guildId,
            user_id: userId,
            stat_date: statDate,
            message_count: messageCount,
            voice_minutes: voiceMinutes
        });
    }

    const { data: total } = await supabase
        .from('member_overview_stats')
        .select('id,total_messages,total_voice_minutes')
        .eq('guild_id', guildId)
        .eq('user_id', userId)
        .maybeSingle();

    if (total?.id) {
        await supabase
            .from('member_overview_stats')
            .update({
                total_messages: Number(total.total_messages || 0) + messageCount,
                total_voice_minutes: Number(total.total_voice_minutes || 0) + voiceMinutes,
                updated_at: new Date().toISOString()
            })
            .eq('id', total.id);
    } else {
        await supabase.from('member_overview_stats').insert({
            guild_id: guildId,
            user_id: userId,
            total_messages: messageCount,
            total_voice_minutes: voiceMinutes,
            updated_at: new Date().toISOString()
        });
    }
};

const upsertServerDailyStats = async (guildId, statDate, messageCount, voiceMinutes) => {
    const { data: existing } = await supabase
        .from('server_daily_stats')
        .select('id,message_count,voice_minutes')
        .eq('guild_id', guildId)
        .eq('stat_date', statDate)
        .maybeSingle();

    if (existing?.id) {
        await supabase
            .from('server_daily_stats')
            .update({
                message_count: Number(existing.message_count || 0) + messageCount,
                voice_minutes: Number(existing.voice_minutes || 0) + voiceMinutes,
                updated_at: new Date().toISOString()
            })
            .eq('id', existing.id);
    } else {
        await supabase.from('server_daily_stats').insert({
            guild_id: guildId,
            stat_date: statDate,
            message_count: messageCount,
            voice_minutes: voiceMinutes
        });
    }

    const { data: total } = await supabase
        .from('server_overview_stats')
        .select('id,total_messages,total_voice_minutes')
        .eq('guild_id', guildId)
        .maybeSingle();

    if (total?.id) {
        await supabase
            .from('server_overview_stats')
            .update({
                total_messages: Number(total.total_messages || 0) + messageCount,
                total_voice_minutes: Number(total.total_voice_minutes || 0) + voiceMinutes,
                updated_at: new Date().toISOString()
            })
            .eq('id', total.id);
    } else {
        await supabase.from('server_overview_stats').insert({
            guild_id: guildId,
            total_messages: messageCount,
            total_voice_minutes: voiceMinutes,
            updated_at: new Date().toISOString()
        });
    }
};

const processDailySettlement = async (guildId) => {
    // Daily accumulation/settlement disabled: earnings are awarded immediately per-message and per-voice-minute.
    return;
};

module.exports = {
    addBalance,
    processVoiceEarnings,
    addDailyEarning,
    processDailySettlement,
    upsertMemberDailyStats,
    upsertServerDailyStats
};