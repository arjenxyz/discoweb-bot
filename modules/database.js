// modules/database.js
const { createClient } = require('@supabase/supabase-js');
const { supabaseUrl, supabaseKey } = require('./config');

const supabase = createClient(supabaseUrl, supabaseKey);

const getGuild = async (client, guildId) => {
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
    return guild;
};

const getLocalDateStartIso = (timezoneOffsetMinutes) => {
    const now = new Date();
    const localMs = now.getTime() + timezoneOffsetMinutes * 60 * 1000;
    const local = new Date(localMs);
    const start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
    return start.toISOString();
};

const getLocalDate = (timezoneOffsetMinutes) => {
    const now = new Date();
    const localMs = now.getTime() + timezoneOffsetMinutes * 60 * 1000;
    const local = new Date(localMs);
    return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
};

const getMaintenanceStatus = async (guildId) => {
    try {
        const { data: server } = await supabase
            .from('servers')
            .select('id')
            .eq('discord_id', guildId)
            .maybeSingle();

        if (!server) return { isMaintenance: false, reason: null };

        const { data } = await supabase
            .from('maintenance_flags')
            .select('is_active, reason')
            .eq('server_id', server.id)
            .eq('key', 'bot')
            .maybeSingle();

        return {
            isMaintenance: data?.is_active || false,
            reason: data?.reason || null
        };
    } catch (error) {
        console.error('Maintenance status check error:', error);
        return { isMaintenance: false, reason: null };
    }
};

module.exports = {
    supabase,
    getGuild,
    getLocalDateStartIso,
    getLocalDate,
    getMaintenanceStatus
};