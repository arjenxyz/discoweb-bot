// Log sending module for Discord webhooks
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

/**
 * Send log to specific guild's log channel
 * @param {string} guildId - Discord guild ID
 * @param {string} channelType - Type of log channel (main, auth, roles, etc.)
 * @param {object} embed - Discord embed object
 */
async function sendLog(guildId, channelType, embed) {
    try {
        // Get webhook URL for this guild and channel type
        const { data: logChannel, error } = await supabase
            .from('bot_log_channels')
            .select('webhook_url')
            .eq('guild_id', guildId)
            .eq('channel_type', channelType)
            .eq('is_active', true)
            .single();

        if (error || !logChannel?.webhook_url) {
            console.log(`No webhook found for guild ${guildId}, type ${channelType}`);
            return false;
        }

        // Send to Discord webhook
        const response = await fetch(logChannel.webhook_url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                embeds: [embed],
            }),
        });

        if (!response.ok) {
            console.error(`Failed to send log to ${channelType}:`, response.status, response.statusText);
            return false;
        }

        return true;
    } catch (error) {
        console.error(`Error sending log to ${channelType}:`, error);
        return false;
    }
}

/**
 * Send main/general log
 */
async function sendMainLog(guildId, title, description, color = 0x00ff00, fields = []) {
    const embed = {
        title,
        description,
        color,
        fields,
        timestamp: new Date().toISOString(),
    };

    return await sendLog(guildId, 'main', embed);
}

/**
 * Send auth log
 */
async function sendAuthLog(guildId, userId, action, details = {}) {
    const embed = {
        title: '🔐 Authentication Event',
        description: `User: <@${userId}>`,
        color: 0x3498db,
        fields: [
            { name: 'Action', value: action, inline: true },
            { name: 'User ID', value: userId, inline: true },
            ...Object.entries(details).map(([key, value]) => ({
                name: key,
                value: String(value),
                inline: true
            }))
        ],
        timestamp: new Date().toISOString(),
    };

    return await sendLog(guildId, 'auth', embed);
}

/**
 * Send role log
 */
async function sendRoleLog(guildId, userId, action, roleName, roleId) {
    const embed = {
        title: '👤 Role Event',
        description: `User: <@${userId}>`,
        color: 0xe67e22,
        fields: [
            { name: 'Action', value: action, inline: true },
            { name: 'Role', value: `${roleName} (${roleId})`, inline: true },
            { name: 'User ID', value: userId, inline: true },
        ],
        timestamp: new Date().toISOString(),
    };

    return await sendLog(guildId, 'roles', embed);
}

/**
 * Send store log
 */
async function sendStoreLog(guildId, userId, action, itemName, amount) {
    const embed = {
        title: '🛒 Store Event',
        description: `User: <@${userId}>`,
        color: 0x9b59b6,
        fields: [
            { name: 'Action', value: action, inline: true },
            { name: 'Item', value: itemName, inline: true },
            { name: 'Amount', value: `${amount} coins`, inline: true },
        ],
        timestamp: new Date().toISOString(),
    };

    return await sendLog(guildId, 'store', embed);
}

/**
 * Send wallet log
 */
async function sendWalletLog(guildId, userId, action, amount, balance) {
    const embed = {
        title: '💰 Wallet Event',
        description: `User: <@${userId}>`,
        color: 0xf1c40f,
        fields: [
            { name: 'Action', value: action, inline: true },
            { name: 'Amount', value: `${amount} coins`, inline: true },
            { name: 'New Balance', value: `${balance} coins`, inline: true },
        ],
        timestamp: new Date().toISOString(),
    };

    return await sendLog(guildId, 'wallet', embed);
}

/**
 * Send admin log
 */
async function sendAdminLog(guildId, adminId, action, details = {}) {
    const embed = {
        title: '⚡ Admin Action',
        description: `Admin: <@${adminId}>`,
        color: 0xe74c3c,
        fields: [
            { name: 'Action', value: action, inline: false },
            ...Object.entries(details).map(([key, value]) => ({
                name: key,
                value: String(value),
                inline: true
            }))
        ],
        timestamp: new Date().toISOString(),
    };

    return await sendLog(guildId, 'admin', embed);
}

/**
 * Send error log (only for developer server)
 */
async function sendErrorLog(guildId, error, context = {}) {
    const DEVELOPER_GUILD_ID = '1467155388024754260'; // Only send to developer server
    
    if (guildId !== DEVELOPER_GUILD_ID) {
        return false; // Don't send error logs to other servers
    }

    const embed = {
        title: '❌ Error Occurred',
        description: 'An error occurred in the system',
        color: 0xe74c3c,
        fields: [
            { name: 'Error', value: String(error), inline: false },
            ...Object.entries(context).map(([key, value]) => ({
                name: key,
                value: String(value),
                inline: true
            }))
        ],
        timestamp: new Date().toISOString(),
    };

    return await sendLog(guildId, 'error', embed);
}

/**
 * Send system log (only for developer server)
 */
async function sendSystemLog(guildId, title, description, details = {}) {
    const DEVELOPER_GUILD_ID = '1467155388024754260'; // Only send to developer server
    
    if (guildId !== DEVELOPER_GUILD_ID) {
        return false; // Don't send system logs to other servers
    }

    const embed = {
        title: '⚙️ System Event',
        description,
        color: 0x95a5a6,
        fields: [
            { name: 'Title', value: title, inline: false },
            ...Object.entries(details).map(([key, value]) => ({
                name: key,
                value: String(value),
                inline: true
            }))
        ],
        timestamp: new Date().toISOString(),
    };

    return await sendLog(guildId, 'system', embed);
}

module.exports = {
    sendLog,
    sendMainLog,
    sendAuthLog,
    sendRoleLog,
    sendStoreLog,
    sendWalletLog,
    sendAdminLog,
    sendSystemLog,
    sendErrorLog,
};