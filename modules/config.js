// modules/config.js
require('dotenv').config();
require('dotenv').config({ path: '.env.local' }); // Yerel ayarları yükle

module.exports = {
    discordToken: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID, // Slash komutları için gerekli
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY,
    guildId: process.env.GUILD_ID || '1465698764453838882',
    requiredRoleId: process.env.REQUIRED_ROLE_ID || process.env.DISCORD_REQUIRED_ROLE_ID || '1465999952940498975',
    adminRoleId: process.env.DISCORD_ADMIN_ROLE_ID,
    systemLogChannelId: process.env.SYSTEM_LOG_CHANNEL_ID, // Sistem hataları için özel kanal
    earnPerMessage: Number(process.env.PAPEL_PER_MESSAGE || 0.2),
    earnPerVoiceMinute: Number(process.env.PAPEL_PER_VOICE_MINUTE || 0.2),
    timezoneOffsetMinutes: Number(process.env.PAPEL_TIMEZONE_OFFSET || 180),
    orderPollIntervalMs: Number(process.env.ORDER_POLL_INTERVAL_MS || 300000)
};