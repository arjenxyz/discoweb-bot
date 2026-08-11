const { supabase } = require('../core/database');

/**
 * Discord Activity session join/leave tracking only.
 * Earnings come exclusively from classic voice (earnings.js / earnBuffer).
 * No addBalance / daily_earnings awards here.
 */
async function handleVoiceStateUpdate(oldState, newState) {
    try {
        const oldChannel = oldState?.channelId || null;
        const newChannel = newState?.channelId || null;

        // Join — record participation if an activity session is active on this channel
        if (!oldChannel && newChannel) {
            const { data: session } = await supabase
                .from('activity_sessions')
                .select('*')
                .eq('channel_id', newChannel)
                .gt('expires_at', new Date().toISOString())
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (!session) return;

            await supabase.from('activity_participation').insert({
                session_id: session.id,
                guild_id: session.guild_id || (newState.guild ? newState.guild.id : null),
                user_id: newState.member.id,
                join_at: new Date().toISOString(),
                awarded: false,
                metadata: { via: 'activity_invite', invite_code: session.invite_code, earn: false },
            });
            return;
        }

        // Leave or move out — close participation row, do not award
        if (oldChannel && (!newChannel || newChannel !== oldChannel)) {
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
                duration_seconds: durationSeconds,
                awarded: false,
                award_amount: 0,
            }).eq('id', participation.id);
        }
    } catch (error) {
        console.error('activity.handleVoiceStateUpdate error:', error);
    }
}

module.exports = {
    handleVoiceStateUpdate,
};
