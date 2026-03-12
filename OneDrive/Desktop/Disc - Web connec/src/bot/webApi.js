const express = require('express');
const { EmbedBuilder } = require('discord.js');

function startBotApi({ supabase, client, port = 3000 }) {
  const app = express();
  app.use(express.json());

  const configuredOrigins = [
    process.env.BOT_API_ORIGINS,
    process.env.WEB_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  const allowedOrigins = new Set(configuredOrigins);

  // CORS
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
    } else {
      next();
    }
  });

  const ensureBotApiKey = (req, res) => {
    const botApiKey = process.env.BOT_API_KEY;
    if (!botApiKey) {
      console.warn('BOT_API_KEY is not configured; bot API endpoints are unsecured.');
      return true;
    }
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${botApiKey}`) {
      res.status(403).json({ error: 'forbidden' });
      return false;
    }
    return true;
  };

  app.get('/api/test', (req, res) => {
    res.json({ message: 'Bot API çalışıyor', timestamp: new Date().toISOString() });
  });

  app.post('/api/log', async (req, res) => {
    try {
      if (!ensureBotApiKey(req, res)) {
        return;
      }
      console.log('📨 Bot API received log request:', req.body);
      const { guildId, channelType, embed, content } = req.body;

      if (!guildId || !channelType || (!embed && !content)) {
        console.log('❌ Missing required fields');
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const { data: logChannel } = await supabase
        .from('bot_log_channels')
        .select('channel_id, webhook_url')
        .eq('guild_id', guildId)
        .eq('channel_type', channelType)
        .eq('is_active', true)
        .maybeSingle();

      if (!logChannel) {
        console.log('❌ Log channel not found for:', guildId, channelType);
        return res.status(404).json({ error: 'Log channel not found' });
      }

      if (logChannel.webhook_url) {
        console.log('🔗 Sending via stored webhook for', guildId, channelType);
        try {
          const webhookResp = await fetch(logChannel.webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: content || undefined, embeds: embed ? [embed] : [] }),
          });
          console.log('🔗 Webhook response status:', webhookResp.status, 'text:', await webhookResp.text());
          if (webhookResp.ok) {
            return res.json({ success: true, via: 'webhook' });
          }
          console.warn('⚠️ Webhook returned non-OK, falling back to channel send');
        } catch (err) {
          console.error('❌ Webhook send failed:', err.message);
        }
      }

      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        console.log('❌ Guild not found:', guildId);
        return res.status(404).json({ error: 'Guild not found' });
      }

      const channel = guild.channels.cache.get(logChannel.channel_id);
      if (!channel) {
        console.log('❌ Channel not found:', logChannel.channel_id);
        return res.status(404).json({ error: 'Channel not found' });
      }

      const logEmbed = embed
        ? new EmbedBuilder()
            .setColor(embed.color || '#4caf50')
            .setTitle(embed.title || 'Web Log')
            .setDescription(embed.description || "Web'den gelen log")
        : null;

      if (logEmbed && embed.author?.name) {
        logEmbed.setAuthor({
          name: embed.author.name,
          iconURL: embed.author.icon_url || undefined,
        });
      }

      if (logEmbed && embed.thumbnail?.url) {
        logEmbed.setThumbnail(embed.thumbnail.url);
      }

      if (logEmbed && embed.image && embed.image.url) {
        logEmbed.setImage(embed.image.url);
      }

      if (logEmbed && embed.fields) {
        logEmbed.addFields(embed.fields);
      }

      if (logEmbed && embed.footer?.text) {
        logEmbed.setFooter({ text: embed.footer.text });
      }

      if (logEmbed) {
        if (embed.timestamp) {
          logEmbed.setTimestamp(new Date(embed.timestamp));
        } else {
          logEmbed.setTimestamp();
        }
      }

      await channel.send({ content: content || undefined, embeds: logEmbed ? [logEmbed] : [] });

      res.json({ success: true });
    } catch (error) {
      console.error('Web log error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Invalidate server config cache endpoint
  // Expects { guildId: string } in body. If BOT_API_KEY is set, requires Authorization: Bearer <key>
  app.post('/api/invalidate-config', async (req, res) => {
    try {
      const botApiKey = process.env.BOT_API_KEY;
      if (botApiKey) {
        const auth = (req.headers.authorization || '');
        if (auth !== `Bearer ${botApiKey}`) {
          return res.status(403).json({ error: 'forbidden' });
        }
      }

      const { guildId } = req.body || {};
      if (!guildId) return res.status(400).json({ error: 'missing_guildId' });

      // try to clear cache via commands module
      try {
        const commands = require('./modules/commands');
        if (typeof commands.invalidateServerConfig === 'function') {
          commands.invalidateServerConfig(guildId);
        }
      } catch (e) {
        console.warn('Could not call commands.invalidateServerConfig:', e.message);
      }

      return res.json({ status: 'ok' });
    } catch (error) {
      console.error('invalidate-config error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.listen(port, '0.0.0.0', () => {
    console.log(`🌐 Bot API server listening on port ${port}`);
  });

  return app;
}

module.exports = { startBotApi };
