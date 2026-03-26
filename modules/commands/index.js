// modules/commands/index.js - Artık sadece exports için kullanılıyor (komutlar kaldırıldı)
const { supabase } = require('../../modules/database');

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
                        .select('verify_role_id,admin_role_id,discord_id,earn_per_message,message_earn_enabled,earn_per_voice_minute,voice_earn_enabled,tag_id,tag_bonus_message,tag_bonus_voice,booster_bonus_message,booster_bonus_voice,earn_channels')
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

// Ana mesaj işleme fonksiyonu - artık boş (mesaj kazancı index.js'e taşındı)
const handleMessage = async (message, config, addDailyEarning) => {
    // Tüm komutlar kaldırıldı - mesaj kazancı artık doğrudan index.js'de
    return;
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