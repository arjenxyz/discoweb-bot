// Migration: add notifications-log channel for existing setups
require('dotenv').config();
require('dotenv').config({ path: '.env.local' });

const { createClient } = require('@supabase/supabase-js');

const DISCORD_API = 'https://discord.com/api/v10';
const botToken = process.env.DISCORD_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!botToken || !supabaseUrl || !supabaseKey) {
  console.error('Missing required env vars: DISCORD_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getTargetGuilds = async () => {
  const arg = process.argv.find((value) => value.startsWith('--guild='));
  const singleGuildId = arg ? arg.split('=')[1] : null;

  if (singleGuildId) {
    const { data, error } = await supabase
      .from('servers')
      .select('discord_id, admin_role_id')
      .eq('discord_id', singleGuildId)
      .maybeSingle();

    if (error || !data) {
      throw new Error('Guild not found in servers table');
    }

    return [data];
  }

  const { data, error } = await supabase
    .from('servers')
    .select('discord_id, admin_role_id')
    .eq('is_setup', true);

  if (error) {
    throw new Error(error.message);
  }

  return data || [];
};

const fetchGuildChannels = async (guildId) => {
  const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${botToken}` },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to fetch channels: ${resp.status} ${text}`);
  }

  return resp.json();
};

const createChannel = async ({ guildId, categoryId, adminRoleId }) => {
  const payload = {
    name: 'notifications-log',
    type: 0,
    parent_id: categoryId,
    topic: 'Automated log channel (notifications) — created by migration',
    permission_overwrites: [
      { id: guildId, type: 0, deny: '1024' },
      { id: adminRoleId, type: 0, allow: '1024' },
    ],
  };

  const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to create channel: ${resp.status} ${text}`);
  }

  return resp.json();
};

const createWebhook = async (channelId) => {
  const resp = await fetch(`${DISCORD_API}/channels/${channelId}/webhooks`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: 'notifications-webhook' }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to create webhook: ${resp.status} ${text}`);
  }

  const webhook = await resp.json();
  return `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;
};

const upsertDb = async ({ guildId, channelId, categoryId, webhookUrl }) => {
  const { error: botLogError } = await supabase
    .from('bot_log_channels')
    .upsert({
      guild_id: guildId,
      channel_type: 'notifications',
      channel_id: channelId,
      category_id: categoryId,
      webhook_url: webhookUrl,
      is_active: true,
    }, { onConflict: 'guild_id,channel_type' });

  if (botLogError) {
    throw new Error(`bot_log_channels upsert failed: ${botLogError.message}`);
  }

  const { error: configError } = await supabase
    .from('log_channel_configs')
    .upsert({
      guild_id: guildId,
      channel_type: 'notifications',
      webhook_url: webhookUrl,
      is_active: true,
    }, { onConflict: 'guild_id,channel_type' });

  if (configError) {
    throw new Error(`log_channel_configs upsert failed: ${configError.message}`);
  }
};

const run = async () => {
  const guilds = await getTargetGuilds();
  console.log(`🔧 Notifications migration: ${guilds.length} guild(s) found.`);

  for (const guild of guilds) {
    const guildId = guild.discord_id;
    const adminRoleId = guild.admin_role_id;

    if (!guildId || !adminRoleId) {
      console.warn(`⚠️ Skipping guild ${guildId || 'unknown'} (missing admin_role_id)`);
      continue;
    }

    console.log(`
➡️ Processing guild ${guildId}`);

    const { data: existing } = await supabase
      .from('bot_log_channels')
      .select('channel_id')
      .eq('guild_id', guildId)
      .eq('channel_type', 'notifications')
      .maybeSingle();

    if (existing?.channel_id) {
      console.log('✅ notifications-log already exists, skipping.');
      continue;
    }

    const channels = await fetchGuildChannels(guildId);
    const category = channels.find((ch) => ch.type === 4 && ch.name === '💠Web Logs');

    if (!category) {
      console.warn('⚠️ Category "💠Web Logs" not found. Skipping guild.');
      continue;
    }

    const createdChannel = await createChannel({
      guildId,
      categoryId: category.id,
      adminRoleId,
    });

    console.log(`✅ Created channel ${createdChannel.id}`);

    const webhookUrl = await createWebhook(createdChannel.id);
    console.log('✅ Webhook created');

    await upsertDb({
      guildId,
      channelId: createdChannel.id,
      categoryId: category.id,
      webhookUrl,
    });

    console.log('✅ Database updated');

    await sleep(1000);
  }

  console.log('\n🎉 Migration complete.');
};

run().catch((error) => {
  console.error('❌ Migration failed:', error);
  process.exit(1);
});
