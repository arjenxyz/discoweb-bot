const { supabase } = require('./database');
const { addBalance } = require('./earnings');

// Minimum seconds required to count participation
const MIN_SECONDS = Number(process.env.ACTIVITY_MIN_SECONDS || 60);
const REWARD_PER_MIN = Number(process.env.PAPEL_PER_VOICE_MINUTE || process.env.ACTIVITY_REWARD_PER_MIN || 0.2);

async function handleVoiceStateUpdate(oldState, newState) {
    try {
        const oldChannel = oldState?.channelId || null;
        const newChannel = newState?.channelId || null;

        // Join
        if (!oldChannel && newChannel) {
            // find active session on this channel
            const { data: session } = await supabase
                .from('activity_sessions')
                .select('*')
                .eq('channel_id', newChannel)
                .gt('expires_at', new Date().toISOString())
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (!session) return;

            // insert participation
            await supabase.from('activity_participation').insert({
                session_id: session.id,
                guild_id: session.guild_id || (newState.guild ? newState.guild.id : null),
                user_id: newState.member.id,
                join_at: new Date().toISOString(),
                metadata: { via: 'activity_invite', invite_code: session.invite_code }
            });
            return;
        }

        // Leave or move out
        if (oldChannel && (!newChannel || newChannel !== oldChannel)) {
            // find most recent participation without leave_at
            const { data: participation } = await supabase
                .from('activity_participation')
                .select('*')
                .eq('user_id', oldState.member.id)
                .is('leave_at', null)
                .order('join_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (!participation) return;

            const leaveAt = new Date().toISOString();
            const joinAt = new Date(participation.join_at).getTime();
            const durationSeconds = Math.max(0, Math.floor((Date.now() - joinAt) / 1000));

            await supabase.from('activity_participation').update({
                leave_at: leaveAt,
                duration_seconds: durationSeconds
            }).eq('id', participation.id);

            // Award if duration meets minimum
            if (durationSeconds >= MIN_SECONDS && REWARD_PER_MIN > 0) {
                const minutes = Math.floor(durationSeconds / 60);
                const amount = Number((minutes * REWARD_PER_MIN).toFixed(2));
                if (amount > 0) {
                    const guildId = participation.guild_id || (oldState.guild ? oldState.guild.id : null);
                    // Check per-server verify_role and voice earning toggle
                    try {
                        const { data: server } = await supabase
                            .from('servers')
                            .select('verify_role_id,voice_earn_enabled,earn_per_voice_minute')
                            .or(`discord_id.eq.${guildId},id.eq.${guildId}`)
                            .maybeSingle();

                        const voiceEnabled = server?.voice_earn_enabled ?? true;
                        const verifyRole = server?.verify_role_id ?? null;
                        if (!voiceEnabled) {
                            // skip awarding if server disabled voice earnings
                            await supabase.from('activity_participation').update({ awarded: false }).eq('id', participation.id);
                            continue;
                        }

                        // If server hasn't set a verify role, do not award anyone
                        if (!verifyRole) {
                            await supabase.from('activity_participation').update({ awarded: false }).eq('id', participation.id);
                            continue;
                        }

                        // Verify member has role
                        const member = oldState?.member ?? null;
                        const isApproved = Boolean(member?.roles?.cache?.has(verifyRole));
                        if (!isApproved) {
                            await supabase.from('activity_participation').update({ awarded: false }).eq('id', participation.id);
                            continue;
                        }

                        // Award immediately
                        await addBalance(guildId, participation.user_id, amount, 'earn_voice', { session_id: participation.session_id });
                        await supabase.from('activity_participation').update({ awarded: true, award_amount: amount }).eq('id', participation.id);
                    } catch (err) {
                        console.error('activity award error:', err);
                    }
                }
            }
        }
    } catch (error) {
        console.error('activity.handleVoiceStateUpdate error:', error);
    }
}

module.exports = {
    handleVoiceStateUpdate
};
