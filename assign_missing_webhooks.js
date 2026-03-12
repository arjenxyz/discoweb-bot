require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

const botToken = process.env.DISCORD_TOKEN;
if (!botToken) {
  console.error('No bot token');
  process.exit(1);
}

async function run() {
  console.log('🔧 Assigning missing webhooks...');
  const { data, error } = await supabase
    .from('bot_log_channels')
    .select('id,guild_id,channel_id,channel_type,webhook_url,is_active')
    .is('webhook_url', null)
    .eq('is_active', true);

  if (error) {
    console.error('DB error:', error);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log('✅ No missing webhooks to assign');
    return;
  }

  for (const row of data) {
    try {
      console.log(`📝 Creating webhook for ${row.channel_type} (${row.channel_id}) in guild ${row.guild_id}`);
      const resp = await fetch(`https://discord.com/api/channels/${row.channel_id}/webhooks`, {
        method: 'POST',
        headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `${row.channel_type}-webhook` }),
      });
      let webhookUrl = null;
      if (resp.ok) {
        const webhook = await resp.json();
        webhookUrl = `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;
      } else {
        // try to list existing
        const listResp = await fetch(`https://discord.com/api/channels/${row.channel_id}/webhooks`, {
          headers: { Authorization: `Bot ${botToken}` },
        });
        if (listResp.ok) {
          const list = await listResp.json();
          if (Array.isArray(list) && list.length > 0) {
            const wh = list[0];
            webhookUrl = `https://discord.com/api/webhooks/${wh.id}/${wh.token}`;
          }
        }
      }

      await supabase
        .from('bot_log_channels')
        .update({ webhook_url: webhookUrl })
        .eq('id', row.id);

      console.log(`✅ Updated webhook for ${row.channel_type}: ${webhookUrl ? '✅' : '❌'}`);
    } catch (err) {
      console.error('❌ Error creating webhook for', row.channel_id, err);
    }

    await new Promise(r => setTimeout(r, 400));
  }
}

run();