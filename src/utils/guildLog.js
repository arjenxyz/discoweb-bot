const { supabase } = require('../core/database');

/**
 * Resolve a log channel row. Tries exact type first, then common aliases
 * so bot (`store`/`wallet`/`admin`) and web (`user_store`/`admin_wallet`/`admin_main`)
 * share the same Discord channels.
 */
const CHANNEL_ALIASES = {
  store: ['store', 'user_store', 'admin_store'],
  user_store: ['user_store', 'store', 'admin_store'],
  admin_store: ['admin_store', 'store', 'user_store'],
  wallet: ['wallet', 'admin_wallet'],
  admin_wallet: ['admin_wallet', 'wallet'],
  admin: ['admin', 'admin_main'],
  admin_main: ['admin_main', 'admin'],
  admin_log: ['admin', 'admin_main'],
  system: ['admin_main', 'admin'],
};

async function resolveLogChannel(guildId, channelType) {
  const candidates = CHANNEL_ALIASES[channelType] || [channelType];
  for (const type of candidates) {
    const { data, error } = await supabase
      .from('bot_log_channels')
      .select('channel_id, webhook_url, channel_type')
      .eq('guild_id', guildId)
      .eq('channel_type', type)
      .eq('is_active', true)
      .maybeSingle();
    if (!error && data?.channel_id) return data;
  }
  return null;
}

/**
 * Send an embed (or content) to a guild log channel.
 * Prefers webhook_url; falls back to Discord.js client channel send.
 */
async function sendGuildLog({ client = null, guildId, channelType, embed = null, content = null }) {
  if (!guildId || !channelType) return false;
  if (!embed && !content) return false;

  const logChannel = await resolveLogChannel(guildId, channelType);
  if (!logChannel) {
    console.warn(`[guildLog] channel missing guild=${guildId} type=${channelType}`);
    return false;
  }

  if (logChannel.webhook_url) {
    try {
      const body = {
        content: content || undefined,
        embeds: embed
          ? [typeof embed.toJSON === 'function' ? embed.toJSON() : embed]
          : undefined,
      };
      const resp = await fetch(logChannel.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (resp.ok) return true;
      console.warn(`[guildLog] webhook failed ${resp.status} guild=${guildId} type=${channelType}`);
    } catch (err) {
      console.warn(`[guildLog] webhook error guild=${guildId} type=${channelType}`, err?.message || err);
    }
  }

  if (!client) {
    console.warn(`[guildLog] no client/webhook for guild=${guildId} type=${channelType}`);
    return false;
  }

  try {
    const channel =
      client.channels.cache.get(logChannel.channel_id) ||
      (await client.channels.fetch(logChannel.channel_id).catch(() => null));
    if (!channel || typeof channel.send !== 'function') {
      console.warn(`[guildLog] channel unreachable ${logChannel.channel_id}`);
      return false;
    }
    await channel.send({
      content: content || undefined,
      embeds: embed ? [embed] : undefined,
    });
    return true;
  } catch (err) {
    console.error(`[guildLog] channel send failed guild=${guildId} type=${channelType}`, err?.message || err);
    return false;
  }
}

module.exports = {
  CHANNEL_ALIASES,
  resolveLogChannel,
  sendGuildLog,
};
