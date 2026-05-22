const { supabase } = require('./database');
const { addDailyEarning, upsertMemberDailyStats } = require('./earnings');
const permissionCache = require('./permissionCache');
const { isVoiceEligible } = require('./antiSpam');

// In-memory join timestamps: key = `${guildId}:${userId}` -> { joinMs, dbId }
const joinTimestamps = new Map();

const MIN_SECONDS = Number(process.env.ACTIVITY_MIN_SECONDS ?? 5);

async function startJoinSession(guildId, userId, channelId, reason = 'join') {
    const joinMs = Date.now();
    try {
        const insert = await supabase.from('voice_participation').insert({
            guild_id: guildId,
            user_id: userId,
            channel_id: channelId,
            join_at: new Date(joinMs).toISOString(),
            join_ms: joinMs,
            created_at: new Date().toISOString(),
            metadata: { reason }
        }).select('id').maybeSingle();
        const dbId = insert?.data?.id ?? null;
        joinTimestamps.set(`${guildId}:${userId}`, { joinMs, dbId });
        console.log(`[voiceAward] ${reason.toUpperCase()} guild:${guildId} user:${userId} channel:${channelId} dbId:${dbId}`);
    } catch (e) {
        joinTimestamps.set(`${guildId}:${userId}`, { joinMs, dbId: null });
        console.log(`[voiceAward] ${reason.toUpperCase()} (mem) guild:${guildId} user:${userId} channel:${channelId} — DB persist failed`);
    }
}

async function finishParticipation(dbId, durationSeconds, awarded, awardAmount, metadata = {}) {
    if (!dbId) return;
    try {
        await supabase.from('voice_participation').update({
            leave_at: new Date().toISOString(),
            duration_seconds: durationSeconds,
            awarded,
            award_amount: awardAmount,
            metadata,
            updated_at: new Date().toISOString()
        }).eq('id', dbId);
    } catch (e) {
        // ignore
    }
}

async function handleVoiceStateUpdate(oldState, newState) {
    try {
        const oldChannel = oldState?.channelId || null;
        const newChannel = newState?.channelId || null;
        const guildId = (newState?.guild?.id) || (oldState?.guild?.id) || null;
        const userId = (newState?.member?.id) || (oldState?.member?.id) || null;
        if (!guildId || !userId) return;
        if (newState?.member?.user?.bot || oldState?.member?.user?.bot) return;

        const switchedChannel = Boolean(oldChannel && newChannel && oldChannel !== newChannel);

        // join
        if (!oldChannel && newChannel) {
            await startJoinSession(guildId, userId, newChannel, 'join');
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
                await finishParticipation(dbId, durationSeconds, false, 0, { skip_reason: 'short_session', min_seconds: MIN_SECONDS });
                if (switchedChannel) await startJoinSession(guildId, userId, newChannel, 'switch_join');
                return;
            }

            // fetch server config (try discord_id first, fallback to id)
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
                await finishParticipation(dbId, durationSeconds, false, 0, { skip_reason: 'voice_disabled' });
                if (switchedChannel) await startJoinSession(guildId, userId, newChannel, 'switch_join');
                return;
            }
            if (!cfgVerifyRole) {
                console.log(`[voiceAward] SKIP no verify role configured guild:${guildId}`);
                await finishParticipation(dbId, durationSeconds, false, 0, { skip_reason: 'no_verify_role' });
                if (switchedChannel) await startJoinSession(guildId, userId, newChannel, 'switch_join');
                return;
            }

            // verify member has role
            let member = oldState?.member ?? newState?.member ?? null;
            if (!member) {
                try {
                    const guild = newState?.guild ?? oldState?.guild;
                    if (guild) member = await guild.members.fetch(userId);
                } catch (e) {
                    member = null;
                }
            }
            const isApproved = Boolean(member?.roles?.cache?.has(cfgVerifyRole));
            if (!isApproved) {
                console.log(`[voiceAward] SKIP user not verified guild:${guildId} user:${userId}`);
                await finishParticipation(dbId, durationSeconds, false, 0, { skip_reason: 'user_not_verified', verify_role_id: cfgVerifyRole });
                if (switchedChannel) await startJoinSession(guildId, userId, newChannel, 'switch_join');
                return;
            }

            // Anti-spam: check voice eligibility using the old state (before leaving)
            const voiceCheck = isVoiceEligible(oldState);
            if (!voiceCheck.allowed) {
                console.log(`[antiSpam] voice blocked guild:${guildId} user:${userId} reason:${voiceCheck.reason}`);
                await finishParticipation(dbId, durationSeconds, false, 0, { skip_reason: voiceCheck.reason || 'anti_spam_block' });
                if (switchedChannel) await startJoinSession(guildId, userId, newChannel, 'switch_join');
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
                await finishParticipation(dbId, durationSeconds, false, 0, { skip_reason: 'zero_amount', computed_amount: amount });
                if (switchedChannel) await startJoinSession(guildId, userId, newChannel, 'switch_join');
                return;
            }

            // award and mark DB row
            try {
                await addDailyEarning(guildId, userId, 'voice', amount, {
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

                await finishParticipation(dbId, durationSeconds, true, amount, { source: 'voice_award' });
                if (dbId) console.log(`[voiceAward] DB updated voice_participation id:${dbId} awarded:true`);

                // update daily/member stats
                if (voiceMinutes > 0) {
                    try {
                        await upsertMemberDailyStats(guildId, userId, new Date().toISOString().slice(0,10), 0, voiceMinutes);
                    } catch (e) {
                        console.error('[voiceAward] failed upsertMemberDailyStats', e);
                    }
                }
                if (switchedChannel) await startJoinSession(guildId, userId, newChannel, 'switch_join');
            } catch (err) {
                console.error('voiceAward award error:', err);
                await finishParticipation(dbId, durationSeconds, false, 0, { skip_reason: 'award_error' });
                if (dbId) console.log(`[voiceAward] DB updated voice_participation id:${dbId} awarded:false due to error`);
                if (switchedChannel) await startJoinSession(guildId, userId, newChannel, 'switch_join');
            }
        }
    } catch (error) {
        console.error('voiceAward.handleVoiceStateUpdate error:', error);
    }
}

module.exports = {
    handleVoiceStateUpdate,
};
