// modules/earnings.js
const { supabase, getGuild, getLocalDate } = require('../core/database');
const { EmbedBuilder } = require('discord.js');
const { isVoiceEligible } = require('./antiSpam');
const { sendSystemMail } = require('../utils/notifications');
const { renderEarningsAutoSettledHTML } = require('../utils/mailTemplates');

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
    if (!client?.isReady?.()) return;

    try {
        const { isIncidentActive } = require('./incidentGate');
        if (await isIncidentActive()) return;
    } catch {
        /* non-fatal */
    }

    let guild;
    try {
        guild = await getGuild(client, guildId);
    } catch (e) {
        console.error(`[earnings] processVoiceEarnings getGuild failed guild:${guildId}`, e.message);
        return;
    }
    if (!guild) return;

    const serverCfg = await getVoiceServerConfig(guildId);
    if (!serverCfg) {
        console.warn(`[earnings] voice skip guild:${guildId} — servers kaydı yok / config okunamadı`);
        return;
    }

    const cfgVerifyRole = serverCfg.verify_role_id ?? null;
    const voiceEnabled = serverCfg.voice_earn_enabled ?? true;
    if (!cfgVerifyRole) {
        console.warn(`[earnings] voice skip guild:${guildId} — verify_role_id yok`);
        return;
    }
    if (!voiceEnabled) {
        console.warn(`[earnings] voice skip guild:${guildId} — voice_earn_enabled=false`);
        return;
    }

    const perMinute = Number(
        serverCfg.earn_per_voice_minute ?? earnPerVoiceMinute ?? process.env.PAPEL_PER_VOICE_MINUTE ?? 0.2
    );
    if (!(perMinute > 0)) return;

    const now = Date.now();
    let awardedUsers = 0;
    let skipped = 0;

    // Ensure sessions exist for everyone currently in voice, then award elapsed full minutes
    for (const [, voiceState] of guild.voiceStates.cache) {
        try {
            if (!voiceState?.channelId) continue;
            const member = voiceState.member;
            // Tick'te fetch yapma — cache'de yoksa join handler session açacak
            if (!member || member.user?.bot) continue;

            // Early eligibility (no DB): verify role + alone/mute
            if (!member.roles?.cache?.has(cfgVerifyRole)) {
                skipped += 1;
                continue;
            }
            const earlyCheck = isVoiceEligible(voiceState, {
                spam_voice_block_alone: serverCfg?.spam_voice_block_alone,
                spam_voice_block_mute_deaf: serverCfg?.spam_voice_block_mute_deaf,
            });
            if (!earlyCheck.allowed) {
                const keySkip = voiceKey(guildId, member.id);
                const sess = voiceSessions.get(keySkip);
                if (sess) sess.lastAwardAt = now;
                skipped += 1;
                continue;
            }

            const key = voiceKey(guildId, member.id);
            if (!voiceSessions.has(key)) {
                voiceSessions.set(key, {
                    joinedAt: now,
                    lastAwardAt: now,
                    channelId: voiceState.channelId,
                });
                continue;
            }

            const session = voiceSessions.get(key);
            if (session.channelId !== voiceState.channelId) {
                session.channelId = voiceState.channelId;
            }

            const elapsedMs = now - session.lastAwardAt;
            const minutes = Math.floor(elapsedMs / 60_000);
            if (minutes <= 0) continue;

            const result = await awardVoiceMinutes({
                client,
                guild,
                guildId,
                member,
                voiceState,
                serverCfg,
                minutes,
                perMinute,
                channelId: voiceState.channelId,
            });

            if (result.awarded) {
                session.lastAwardAt += minutes * 60_000;
                awardedUsers += 1;
            } else {
                if (result.reason === 'alone_in_channel' || result.reason === 'self_mute_deaf') {
                    session.lastAwardAt = now;
                }
                skipped += 1;
            }
        } catch (err) {
            console.error(`[earnings] voice tick user error guild:${guildId}`, err.message);
        }
    }

    // Ayrılmış ama map'te kalan oturumları temizle
    for (const [key, session] of voiceSessions) {
        if (!key.startsWith(`${guildId}:`)) continue;
        const userId = key.slice(guildId.length + 1);
        const vs = guild.voiceStates.cache.get(userId);
        if (!vs?.channelId) {
            voiceSessions.delete(key);
        }
    }

    if (awardedUsers > 0 || skipped > 0) {
        console.log(`[earnings] voice tick guild:${guildId} awarded:${awardedUsers} skipped:${skipped} sessions:${[...voiceSessions.keys()].filter(k => k.startsWith(`${guildId}:`)).length}`);
    }
};

/**
 * Track join/leave so short sessions and channel switches are accounted for.
 */
const handleVoiceStateForEarnings = async (oldState, newState) => {
    try {
        const member = newState.member ?? oldState.member;
        if (!member || member.user?.bot) return;

        const guild = newState.guild ?? oldState.guild;
        if (!guild) return;

        const guildId = guild.id;
        const userId = member.id;
        const key = voiceKey(guildId, userId);
        const oldChannel = oldState?.channelId || null;
        const newChannel = newState?.channelId || null;
        const now = Date.now();

        // Join
        if (!oldChannel && newChannel) {
            voiceSessions.set(key, {
                joinedAt: now,
                lastAwardAt: now,
                channelId: newChannel,
            });
            console.log(`[earnings] voice join guild:${guildId} user:${userId} channel:${newChannel}`);
            return;
        }

        // Leave
        if (oldChannel && !newChannel) {
            const session = voiceSessions.get(key);
            voiceSessions.delete(key);
            if (!session) return;

            const minutes = Math.floor((now - session.lastAwardAt) / 60_000);
            console.log(`[earnings] voice leave guild:${guildId} user:${userId} minutesPending:${minutes}`);
            if (minutes <= 0) return;

            const serverCfg = await getVoiceServerConfig(guildId);
            if (!serverCfg) return;
            const perMinute = Number(
                serverCfg.earn_per_voice_minute ?? process.env.PAPEL_PER_VOICE_MINUTE ?? 0.2
            );
            if (!(perMinute > 0)) return;

            // Use oldState for eligibility (channel membership at leave)
            await awardVoiceMinutes({
                client: guild.client,
                guild,
                guildId,
                member,
                voiceState: oldState,
                serverCfg,
                minutes,
                perMinute,
                channelId: oldChannel,
            });
            return;
        }

        // Channel switch
        if (oldChannel && newChannel && oldChannel !== newChannel) {
            const session = voiceSessions.get(key);
            if (session) {
                const minutes = Math.floor((now - session.lastAwardAt) / 60_000);
                if (minutes > 0) {
                    const serverCfg = await getVoiceServerConfig(guildId);
                    if (serverCfg) {
                        const perMinute = Number(
                            serverCfg.earn_per_voice_minute ?? process.env.PAPEL_PER_VOICE_MINUTE ?? 0.2
                        );
                        if (perMinute > 0) {
                            await awardVoiceMinutes({
                                client: guild.client,
                                guild,
                                guildId,
                                member,
                                voiceState: oldState,
                                serverCfg,
                                minutes,
                                perMinute,
                                channelId: oldChannel,
                            });
                        }
                    }
                }
            }
            voiceSessions.set(key, {
                joinedAt: now,
                lastAwardAt: now,
                channelId: newChannel,
            });
            console.log(`[earnings] voice switch guild:${guildId} user:${userId} ${oldChannel} -> ${newChannel}`);
        }
    } catch (err) {
        console.error('[earnings] handleVoiceStateForEarnings error:', err);
    }
};

const voiceConfigCache = new Map(); // guildId -> { ts, data }
const VOICE_CONFIG_TTL = Number(process.env.VOICE_CONFIG_TTL_MS || 5 * 60 * 1000);
const voiceSessions = new Map(); // guildId:userId -> { joinedAt, lastAwardAt, channelId }

function voiceKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

function invalidateVoiceConfig(guildId) {
    if (guildId) voiceConfigCache.delete(String(guildId));
    else voiceConfigCache.clear();
}

async function getVoiceServerConfig(guildId) {
    const cached = voiceConfigCache.get(guildId);
    const now = Date.now();
    if (cached && now - cached.ts < VOICE_CONFIG_TTL) return cached.data;

    try {
        // select('*') — eksik kolon yüzünden tüm sorgunun düşmesini engeller
        const { data, error } = await supabase
            .from('servers')
            .select('*')
            .eq('discord_id', guildId)
            .maybeSingle();

        if (error) {
            console.error(`[earnings] getVoiceServerConfig error guild:${guildId}`, error.message);
            voiceConfigCache.set(guildId, { ts: now, data: null });
            return null;
        }

        voiceConfigCache.set(guildId, { ts: now, data: data || null });
        return data || null;
    } catch (e) {
        console.error(`[earnings] getVoiceServerConfig unexpected guild:${guildId}`, e.message);
        return null;
    }
}

function passesVoiceChannelFilter(serverCfg, channelId, categoryId) {
    const earnChannels = serverCfg?.earn_channels ?? null;
    if (!earnChannels || typeof earnChannels !== 'object') return true;

    const mode = earnChannels.mode;
    if (!mode || mode === 'all') return true;

    const voiceChList = earnChannels.voice_channels || [];
    const voiceCatList = earnChannels.voice_categories || [];
    const isInList = voiceChList.includes(channelId) || (categoryId && voiceCatList.includes(categoryId));

    if (mode === 'whitelist') return isInList;
    if (mode === 'blacklist') return !isInList;
    return true;
}

async function awardVoiceMinutes({
    client,
    guild,
    guildId,
    member,
    voiceState,
    serverCfg,
    minutes,
    perMinute,
    channelId,
}) {
    if (!minutes || minutes <= 0) return { awarded: false, reason: 'no_minutes' };

    const cfgVerifyRole = serverCfg?.verify_role_id ?? null;
    const voiceEnabled = serverCfg?.voice_earn_enabled ?? true;
    if (!cfgVerifyRole) return { awarded: false, reason: 'no_verify_role' };
    if (!voiceEnabled) return { awarded: false, reason: 'voice_disabled' };

    const categoryId = voiceState?.channel?.parentId || voiceState?.channel?.parent_id || null;
    if (!passesVoiceChannelFilter(serverCfg, channelId, categoryId)) {
        return { awarded: false, reason: 'channel_filtered' };
    }

    // Roller cache'de eksikse (nadiren) bir kez fetch
    let resolvedMember = member;
    if (!resolvedMember?.roles?.cache?.has?.(cfgVerifyRole)) {
        try {
            resolvedMember = await guild.members.fetch(member.id).catch(() => member);
        } catch {
            resolvedMember = member;
        }
    }

    const isApproved = Boolean(resolvedMember?.roles?.cache?.has(cfgVerifyRole));
    if (!isApproved) return { awarded: false, reason: 'missing_verify_role' };

    const voiceCheck = isVoiceEligible(voiceState, {
        spam_voice_block_alone: serverCfg?.spam_voice_block_alone,
        spam_voice_block_mute_deaf: serverCfg?.spam_voice_block_mute_deaf,
    });
    if (!voiceCheck.allowed) {
        return { awarded: false, reason: voiceCheck.reason };
    }

    const permissionCache = require('./permissionCache');
    let hasTag = false;
    let isBooster = false;
    let memberTagId = null;
    const tagId = serverCfg?.tag_id ?? null;
    const tagBonusVoice = Number(serverCfg?.tag_bonus_voice ?? 0) || 0;
    const boosterBonusVoice = Number(serverCfg?.booster_bonus_voice ?? 0) || 0;

    try {
        const peeked = permissionCache.peek(guildId, member.id);
        const entry = peeked || (await permissionCache.get(client, guildId, member.id));
        if (entry) {
            hasTag = Boolean(entry.hasTag);
            isBooster = Boolean(entry.isBooster);
            if (entry.memberTagId) memberTagId = entry.memberTagId;
        } else {
            isBooster = Boolean(resolvedMember?.premiumSinceTimestamp || resolvedMember?.premiumSince);
        }
    } catch {
        isBooster = Boolean(resolvedMember?.premiumSinceTimestamp || resolvedMember?.premiumSince);
    }

    let bonusPerMinute = 0;
    if (hasTag) bonusPerMinute += tagBonusVoice;
    if (isBooster) bonusPerMinute += boosterBonusVoice;

    const totalRaw = Number(((perMinute + bonusPerMinute) * minutes).toFixed(2));
    if (!(totalRaw > 0)) return { awarded: false, reason: 'zero_amount' };

    // Buffer'a yaz — anlık DB yok
    const { queueVoiceEarn } = require('./earnBuffer');
    const queued = await queueVoiceEarn({
        guildId,
        userId: member.id,
        amount: totalRaw,
        minutes,
        dailyCap: serverCfg?.daily_voice_earn_cap,
        meta: {
            channelId,
            base: perMinute,
            bonus: bonusPerMinute,
            minutes,
            hasTag,
            isBooster,
            memberTagId: memberTagId ?? null,
        },
    });

    if (!queued.queued) {
        return { awarded: false, reason: queued.reason || 'not_queued' };
    }

    return { awarded: true, amount: queued.queued };
}

const addDailyEarning = async (guildId, userId, source, amount, metadata = {}) => {
    if (!amount || amount <= 0) return;

    const earningDate = getLocalDate(180); // Default timezone offset
    const dateIso = earningDate.toISOString().slice(0, 10);

    const { data: existing, error: selErr } = await supabase
        .from('daily_earnings')
        .select('id,amount,settled_at')
        .eq('guild_id', guildId)
        .eq('user_id', userId)
        .eq('source', source)
        .eq('earning_date', dateIso)
        .maybeSingle();

    if (selErr) {
        console.error(`[earnings] addDailyEarning select FAILED - guild:${guildId} user:${userId}`, selErr.message);
    }

    if (existing?.id) {
        if (existing.settled_at) {
            // Kullanıcı bugünkü kazancını zaten aldı: sıfırdan yeni biriken oluştur.
            // settled_at temizlenerek miktar sadece claim sonrası kazanılan kadar olur.
            const { error: updErr } = await supabase
                .from('daily_earnings')
                .update({
                    amount: Number(amount.toFixed(2)),
                    settled_at: null,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', existing.id);
            if (updErr) {
                console.error(`[earnings] addDailyEarning reopen FAILED - guild:${guildId} user:${userId}`, updErr.message);
            } else {
                console.log(`[earnings] addDailyEarning reopened (post-claim) - guild:${guildId} user:${userId} source:${source} amount:${amount} date:${dateIso}`);
            }
        } else {
            // Normal biriktirme: mevcut unsettled satıra ekle
            const nextAmount = Number(existing.amount || 0) + amount;
            const { error: updErr } = await supabase
                .from('daily_earnings')
                .update({ amount: Number(nextAmount.toFixed(2)), updated_at: new Date().toISOString() })
                .eq('id', existing.id);
            if (updErr) {
                console.error(`[earnings] addDailyEarning update FAILED - guild:${guildId} user:${userId}`, updErr.message);
            } else {
                console.log(`[earnings] addDailyEarning updated - guild:${guildId} user:${userId} source:${source} amount:${nextAmount} date:${dateIso}`);
            }
        }
    } else {
        const { error: insErr } = await supabase.from('daily_earnings').insert({
            guild_id: guildId,
            user_id: userId,
            source,
            earning_date: dateIso,
            amount: Number(amount.toFixed(2)),
        });
        if (insErr) {
            console.error(`[earnings] addDailyEarning insert FAILED - guild:${guildId} user:${userId} source:${source} error:`, insErr.message);
        } else {
            console.log(`[earnings] addDailyEarning inserted - guild:${guildId} user:${userId} source:${source} amount:${amount} date:${dateIso}`);
        }
    }
};

/**
 * Returns how much of `amount` can still be awarded today under an optional daily cap.
 * Cap 0 / null / undefined = unlimited. Settled rows still count toward the day total.
 */
const clampToDailyCap = async (guildId, userId, source, amount, dailyCap) => {
    const cap = Number(dailyCap ?? 0);
    if (!cap || cap <= 0 || !amount || amount <= 0) return amount;

    const earningDate = getLocalDate(180);
    const dateIso = earningDate.toISOString().slice(0, 10);

    const { data: row } = await supabase
        .from('daily_earnings')
        .select('amount')
        .eq('guild_id', guildId)
        .eq('user_id', userId)
        .eq('source', source)
        .eq('earning_date', dateIso)
        .maybeSingle();

    const current = Number(row?.amount || 0);
    const remaining = Number((cap - current).toFixed(2));
    if (remaining <= 0) return 0;
    return Math.min(amount, remaining);
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

/**
 * Auto-settle all pending daily_earnings for a guild.
 * Called at 00:00 TR time (21:00 UTC) — transfers unclaimed earnings to wallets.
 */
const processDailySettlement = async (guildId) => {
    try {
        // Fetch all unsettled daily_earnings for this guild
        const { data: rows, error: fetchErr } = await supabase
            .from('daily_earnings')
            .select('id,user_id,amount,source,metadata')
            .eq('guild_id', guildId)
            .is('settled_at', null)
            .is('deleted_at', null);

        if (fetchErr) {
            console.error(`[settlement] fetch error guild:${guildId}`, fetchErr);
            return;
        }
        if (!rows || rows.length === 0) return;

        // Group by user
        const byUser = {};
        for (const row of rows) {
            if (!byUser[row.user_id]) byUser[row.user_id] = [];
            byUser[row.user_id].push(row);
        }

        let settledCount = 0;
        for (const [userId, userRows] of Object.entries(byUser)) {
            const total = Number(userRows.reduce((s, r) => s + Number(r.amount ?? 0), 0).toFixed(2));
            if (total <= 0) continue;

            // Add to wallet
            await addBalance(guildId, userId, total, 'daily_settlement', {
                rowCount: userRows.length,
                autoSettlement: true,
            });

            // Mark as settled
            const ids = userRows.map(r => r.id);
            await supabase.from('daily_earnings')
                .update({ settled_at: new Date().toISOString() })
                .in('id', ids);

            // Send settlement mail
            try {
                const msgTotal = Number(userRows.filter(r => r.source === 'message').reduce((s, r) => s + Number(r.amount ?? 0), 0).toFixed(2));
                const voiceTotal = Number(userRows.filter(r => r.source === 'voice').reduce((s, r) => s + Number(r.amount ?? 0), 0).toFixed(2));
                const now = new Date();
                const trTime = new Date(now.getTime() + 3 * 60 * 60 * 1000);
                const timeStr = trTime.toLocaleString('tr-TR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
                const bodyHtml = renderEarningsAutoSettledHTML(total, msgTotal, voiceTotal, userRows.length, timeStr);
                await sendSystemMail({
                    guildId,
                    userId,
                    title: 'Kazançlarınız Otomatik Olarak Tanımlandı',
                    bodyHtml,
                });
            } catch (mailErr) {
                console.warn(`[settlement] mail send failed guild:${guildId} user:${userId}`, mailErr);
            }

            settledCount += userRows.length;
        }

        if (settledCount > 0) {
            console.log(`[settlement] guild:${guildId} settled ${settledCount} rows for ${Object.keys(byUser).length} users`);
        }
    } catch (e) {
        console.error(`[settlement] unexpected error guild:${guildId}`, e);
    }
};

module.exports = {
    addBalance,
    processVoiceEarnings,
    handleVoiceStateForEarnings,
    invalidateVoiceConfig,
    addDailyEarning,
    clampToDailyCap,
    processDailySettlement,
    upsertMemberDailyStats,
    upsertServerDailyStats
};