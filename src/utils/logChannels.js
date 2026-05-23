/**
 * Merkezi log kanal yöneticisi
 * Tüm sistem event'lerini ilgili Discord kanalına gönderir.
 *
 * Kanal ID'leri Supabase app_config tablosunda saklanır:
 *   key: log_channel_<key>  →  value: <channel_id>
 */

const { supabase } = require('../core/database');

// Cache: DB'ye her seferinde gitmemek için (5 dk TTL)
let channelCache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getLogChannels() {
    if (channelCache && Date.now() - cacheTime < CACHE_TTL) return channelCache;

    const { data } = await supabase
        .from('app_config')
        .select('key, value')
        .like('key', 'log_channel_%');

    channelCache = {};
    for (const row of data ?? []) {
        const key = row.key.replace('log_channel_', '');
        channelCache[key] = row.value;
    }
    cacheTime = Date.now();
    return channelCache;
}

/** Cache'i temizle (kanallar yeniden oluşturulunca çağır) */
function clearCache() {
    channelCache = null;
}

/**
 * @param {import('discord.js').Client} client
 * @param {string} channelKey  — örn. 'basvuru_ekonomi', 'borsa_trades'
 * @param {object|object[]} embeds — Discord embed objesi veya dizisi
 */
async function logToChannel(client, channelKey, embeds) {
    try {
        const channels = await getLogChannels();
        const channelId = channels[channelKey];
        if (!channelId) return; // Kanal ayarlanmamış, sessizce atla

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) return;

        const embedArray = Array.isArray(embeds) ? embeds : [embeds];
        await channel.send({ embeds: embedArray });
    } catch (err) {
        console.error(`logToChannel hatası (${channelKey}):`, err?.message);
    }
}

module.exports = {
    logToChannel,
    clearCache,
};
