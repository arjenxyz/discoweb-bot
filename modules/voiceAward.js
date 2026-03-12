const { supabase } = require('./database');
const { addBalance, upsertMemberDailyStats } = require('./earnings');
const permissionCache = require('./permissionCache');

// In-memory join timestamps: key = `${guildId}:${userId}` -> { joinMs, dbId }
const joinTimestamps = new Map();

const MIN_SECONDS = Number(process.env.ACTIVITY_MIN_SECONDS ?? 5);

async function handleVoiceStateUpdate(oldState, newState) {
    try {
        const oldChannel = oldState?.channelId || null;
        const newChannel = newState?.channelId || null;
        const guildId = (newState?.guild?.id) || (oldState?.guild?.id) || null;
        const userId = (newState?.member?.id) || (oldState?.member?.id) || null;
        if (!guildId || !userId) return;

        // join
        if (!oldChannel && newChannel) {
            const joinMs = Date.now();
            // persist to DB so we can recover if bot restarts
            try {
                const insert = await supabase.from('voice_participation').insert({
                    guild_id: guildId,
                    user_id: userId,
                    channel_id: newChannel,
                    join_at: new Date(joinMs).toISOString(),
                    join_ms: joinMs,
                    created_at: new Date().toISOString()
                }).select('id').maybeSingle();
                const dbId = insert?.data?.id ?? null;
                joinTimestamps.set(`${guildId}:${userId}`, { joinMs, dbId });
                console.log(`[voiceAward] JOIN guild:${guildId} user:${userId} channel:${newChannel} dbId:${dbId}`);
            } catch (e) {
                // fallback to memory-only
                joinTimestamps.set(`${guildId}:${userId}`, { joinMs, dbId: null });
                console.log(`[voiceAward] JOIN (mem) guild:${guildId} user:${userId} channel:${newChannel} — DB persist failed`);
            }
            return;
        }

        // leave or move out
        if (oldChannel && (!newChannel || newChannel !== oldChannel)) {
            const key = `${guildId}:${userId}`;
            const stored = joinTimestamps.get(key) || null;
            joinTimestamps.delete(key);

            let joinMs = stored?.joinMs ?? null;
            let dbId = stored?.dbId ?? null;

            // If we don't have an in-memory join, try to recover from DB
            if (!joinMs) {
                try {
                    const { data: active } = await supabase
                        .from('voice_participation')
                        .select('*')
                        .eq('guild_id', guildId)
                        .eq('user_id', userId)
                        .is('leave_at', null)
                        .order('join_at', { ascending: false })
                        .limit(1)
                        .maybeSingle();
                    if (active) {
                        joinMs = Number(active.join_ms || new Date(active.join_at).getTime());
                        dbId = active.id;
                    }
                } catch (e) {
                    // ignore
                }
            }

            const now = Date.now();
            const durationSeconds = joinMs ? Math.max(0, Math.floor((now - joinMs) / 1000)) : 0;

            console.log(`[voiceAward] LEAVE guild:${guildId} user:${userId} fromChannel:${oldChannel} toChannel:${newChannel || 'NONE'} joinMs:${joinMs} dbId:${dbId} durationSec:${durationSeconds}`);

            if (durationSeconds < MIN_SECONDS) {
                console.log(`[voiceAward] SKIP short session guild:${guildId} user:${userId} durationSec:${durationSeconds} minRequired:${MIN_SECONDS}`);
                return;
            }

            // fetch server config (try discord_id first, fallback to id) - some Supabase setups may not like .or()
            let serverCfg = null;
            try {
                const byDiscord = await supabase
                    .from('servers')
                    .select('id,discord_id,verify_role_id,voice_earn_enabled,earn_per_voice_minute,tag_id,tag_bonus_voice,booster_bonus_voice')
                    .eq('discord_id', guildId)
                    .maybeSingle();
                console.log('[voiceAward] serverCfg byDiscord response', byDiscord);
                if (byDiscord?.data) {
                    serverCfg = byDiscord.data;
                } else {
                    const byId = await supabase
                        .from('servers')
                        .select('id,discord_id,verify_role_id,voice_earn_enabled,earn_per_voice_minute,tag_id,tag_bonus_voice,booster_bonus_voice')
                        .eq('id', guildId)
                        .maybeSingle();
                    console.log('[voiceAward] serverCfg byId response', byId);
                    serverCfg = byId?.data || null;
                }
                console.log(`[voiceAward] serverCfg for guild:${guildId}`, serverCfg);
            } catch (e) {
                serverCfg = null;
                console.error('[voiceAward] serverCfg fetch error', e);
            }

            const cfgVerifyRole = serverCfg?.verify_role_id ?? null;
            const voiceEnabled = serverCfg?.voice_earn_enabled ?? true;
            if (!voiceEnabled) {
                console.log(`[voiceAward] SKIP voice disabled guild:${guildId}`);
                return;
            }
            if (!cfgVerifyRole) {
                console.log(`[voiceAward] SKIP no verify role configured guild:${guildId}`);
                return;
            }

            // verify member has role
            const member = oldState?.member ?? newState?.member ?? null;
            const isApproved = Boolean(member?.roles?.cache?.has(cfgVerifyRole));
            if (!isApproved) {
                console.log(`[voiceAward] SKIP user not verified guild:${guildId} user:${userId}`);
                return;
            }

            const perMinute = Number(serverCfg?.earn_per_voice_minute ?? process.env.PAPEL_PER_VOICE_MINUTE ?? 0.2);
            const tagId = serverCfg?.tag_id ?? null;
            const tagBonusVoice = Number(serverCfg?.tag_bonus_voice ?? 0) || 0;
            const boosterBonusVoice = Number(serverCfg?.booster_bonus_voice ?? 0) || 0;

            // detect tag/booster via permission cache or fallback
            let hasTag = false;
            let isBooster = false;
            try {
                const clientForCache = newState?.client || oldState?.client || null;
                const entry = await permissionCache.get(clientForCache, guildId, userId);
                if (entry) {
                    hasTag = Boolean(entry.hasTag);
                    isBooster = Boolean(entry.isBooster);
                } else {
                    const { getMemberServerTagId, getMemberPrimaryGuildId } = require('./memberTag');
                    const memberTagId = getMemberServerTagId(member);
                    const memberPrimaryGuildId = getMemberPrimaryGuildId(member);
                    hasTag = Boolean(tagId && (String(memberPrimaryGuildId) === String(tagId) || String(memberTagId) === String(tagId)));
                    isBooster = Boolean(member.premiumSinceTimestamp || member.premiumSince);
                    permissionCache.updateForMember(clientForCache, guildId, member).catch(() => null);
                }
            } catch (e) {
                try {
                    const { getMemberServerTagId, getMemberPrimaryGuildId } = require('./memberTag');
                    const memberTagId = getMemberServerTagId(member);
                    const memberPrimaryGuildId = getMemberPrimaryGuildId(member);
                    hasTag = Boolean(tagId && (String(memberPrimaryGuildId) === String(tagId) || String(memberTagId) === String(tagId)));
                    isBooster = Boolean(member.premiumSinceTimestamp || member.premiumSince);
                } catch (ee) {
                    hasTag = false; isBooster = false;
                }
            }

            let bonus = 0;
            if (hasTag) bonus += tagBonusVoice;
            if (isBooster) bonus += boosterBonusVoice;

            const totalPerMinute = Number((perMinute + bonus).toFixed(4));
            const minutesFraction = Number((durationSeconds / 60).toFixed(4));
            const amount = Number((minutesFraction * totalPerMinute).toFixed(2));
            if (!amount || amount <= 0) {
                console.log(`[voiceAward] SKIP zero amount guild:${guildId} user:${userId} amount:${amount}`);
                return;
            }

                // award and mark DB row
            try {
                await addBalance(guildId, userId, amount, 'earn_voice', {
                    channelId: oldChannel,
                    durationSeconds,
                    base: perMinute,
                    bonus,
                    hasTag,
                    isBooster,
                });

                // compute voiceMinutes for logging and stats
                const voiceMinutes = Math.ceil(durationSeconds / 60);

                console.log(`[voiceAward] AWARDED guild:${guildId} user:${userId} amount:${amount} durationSec:${durationSeconds} minutes:${voiceMinutes} base:${perMinute} bonus:${bonus} hasTag:${hasTag} isBooster:${isBooster}`);

                // mark participation row as left/awarded
                if (dbId) {
                    try {
                        await supabase.from('voice_participation').update({
                            leave_at: new Date().toISOString(),
                            duration_seconds: durationSeconds,
                            awarded: true,
                            award_amount: amount,
                            updated_at: new Date().toISOString()
                        }).eq('id', dbId);
                        console.log(`[voiceAward] DB updated voice_participation id:${dbId} awarded:true`);
                    } catch (e) {
                        // ignore DB update failure
                    }
                }

                // update daily/member stats: add voice minutes (rounded down to nearest minute)
                // Record voice minutes for stats as rounded-up minutes so short joins are visible
                if (voiceMinutes > 0) {
                    try {
                        await upsertMemberDailyStats(guildId, userId, new Date().toISOString().slice(0,10), 0, voiceMinutes);
                    } catch (e) {
                        console.error('[voiceAward] failed upsertMemberDailyStats', e);
                    }
                }
            } catch (err) {
                console.error('voiceAward award error:', err);
                // still attempt to mark DB row as not awarded
                if (dbId) {
                    try {
                        await supabase.from('voice_participation').update({
                            leave_at: new Date().toISOString(),
                            duration_seconds: durationSeconds,
                            awarded: false,
                            award_amount: 0,
                            updated_at: new Date().toISOString()
                        }).eq('id', dbId);
                        console.log(`[voiceAward] DB updated voice_participation id:${dbId} awarded:false due to error`);
                    } catch (e) {
                        // ignore
                    }
                }
            }
        }
    } catch (error) {
        console.error('voiceAward.handleVoiceStateUpdate error:', error);
    }
}

module.exports = {
    handleVoiceStateUpdate,
};
