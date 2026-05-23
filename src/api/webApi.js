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

  // IPO başvurusu bildirimi — approve/reject butonlarıyla
  app.post('/api/notify-ipo', async (req, res) => {
    try {
      if (!ensureBotApiKey(req, res)) return;

      const { applicationId, guildId, guildName, applicantUserId, proposedPrice, proposedFounderRatio, statsSnapshot } = req.body;
      if (!applicationId || !guildId) return res.status(400).json({ error: 'missing_fields' });

      // basvuru_ipo kanalını bul
      const { data: logChannel } = await supabase
        .from('bot_log_channels')
        .select('channel_id')
        .eq('guild_id', process.env.DEVELOPER_GUILD_ID || guildId)
        .eq('channel_type', 'basvuru_ipo')
        .eq('is_active', true)
        .maybeSingle();

      if (!logChannel) return res.status(404).json({ error: 'basvuru_ipo channel not found' });

      const devGuildId = process.env.DEVELOPER_GUILD_ID || guildId;
      const devGuild = client.guilds.cache.get(devGuildId);
      if (!devGuild) return res.status(404).json({ error: 'developer guild not found' });

      const channel = devGuild.channels.cache.get(logChannel.channel_id);
      if (!channel) return res.status(404).json({ error: 'channel not found' });

      const founderPct = Math.round((proposedFounderRatio ?? 0.55) * 100);
      const statsLines = statsSnapshot
        ? [
            statsSnapshot.member_count   != null ? `👥 Üye: **${statsSnapshot.member_count}**` : null,
            statsSnapshot.active_members  != null ? `🟢 Aktif üye (30g): **${statsSnapshot.active_members}**` : null,
            statsSnapshot.treasury_balance != null ? `🏦 Hazine: **${Number(statsSnapshot.treasury_balance).toLocaleString('tr-TR')}** Papel` : null,
          ].filter(Boolean).join('\n')
        : '';

      const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

      const embed = new EmbedBuilder()
        .setTitle('📈 Yeni IPO Başvurusu')
        .setColor(0x5865F2)
        .setDescription(`**${guildName || guildId}** sunucusu borsaya girmek istiyor.`)
        .addFields(
          { name: '🏠 Guild ID',        value: `\`${guildId}\``,         inline: true },
          { name: '👤 Başvuran',         value: `<@${applicantUserId}>`,  inline: true },
          { name: '💰 Önerilen Fiyat',   value: `${(proposedPrice ?? 100).toLocaleString('tr-TR')} Papel/lot`, inline: true },
          { name: '🎯 Founder Oranı',    value: `%${founderPct}`,         inline: true },
          { name: '📊 Halka Açık',       value: `%${100 - founderPct}`,   inline: true },
          ...(statsLines ? [{ name: '📋 Sunucu İstatistikleri', value: statsLines, inline: false }] : []),
        )
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`ipo_approve_${applicationId}`).setLabel('✅ Onayla').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`ipo_reject_${applicationId}`).setLabel('❌ Reddet').setStyle(ButtonStyle.Danger),
      );

      await channel.send({ embeds: [embed], components: [row] });
      res.json({ success: true });
    } catch (err) {
      console.error('notify-ipo error:', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  // Activity SDK ve Web Panel için Log Sunucusu Kurulumu
  app.post('/api/setup-server-logs', async (req, res) => {
    try {
      if (!ensureBotApiKey(req, res)) return;

      const { guildId, targetGuildId } = req.body;
      if (!guildId) return res.status(400).json({ error: 'missing_guildId' });
      
      const targetId = targetGuildId || guildId;
      const targetGuild = client.guilds.cache.get(targetId);
      
      if (!targetGuild) {
        return res.status(404).json({ error: 'Bot hedef sunucuda bulunamadı. Lütfen botu o sunucuya ekleyin.' });
      }

      const { supabase } = require('../core/database');

      // Eski kanalları bul ve temizle
      const { data: oldChannels } = await supabase
        .from('bot_log_channels')
        .select('channel_id')
        .eq('guild_id', guildId)
        .eq('channel_type', 'admin_log');
        
      if (oldChannels && oldChannels.length > 0) {
        for (const old of oldChannels) {
           const oldCh = client.channels.cache.get(old.channel_id);
           if (oldCh) await oldCh.delete('Log sunucusu veya kanalı değiştirildi').catch(()=>null);
        }
        await supabase.from('bot_log_channels').delete().eq('guild_id', guildId).eq('channel_type', 'admin_log');
      }

      // Yeni kategori ve kanal aç
      const category = await targetGuild.channels.create({
          name: '💠 DiscoWeb Logs',
          type: 4 // Category
      }).catch(err => {
         console.error('Kategori acma hatasi:', err);
         return null;
      });

      const adminLogChannel = await targetGuild.channels.create({
          name: 'admin-log',
          type: 0, // Text
          parent: category ? category.id : undefined
      }).catch(err => null);

      if (!adminLogChannel) {
        return res.status(500).json({ error: 'Kanal oluşturulamadı. Botun "Kanal Yönetimi" yetkisine sahip olduğundan emin olun.' });
      }

      // Veritabanına kaydet
      await supabase.from('bot_log_channels').insert({
          guild_id: guildId,
          channel_type: 'admin_log',
          channel_id: adminLogChannel.id,
          is_active: true
      });

      const { clearCache } = require('../utils/logChannels');
      clearCache();

      res.json({ success: true, channelId: adminLogChannel.id });
    } catch (err) {
      console.error('setup-server-logs error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Activity SDK Kritik İşlem Loglaması
  app.post('/api/log-sdk-activity', async (req, res) => {
    try {
      if (!ensureBotApiKey(req, res)) return;

      const { guildId, type, userId, metadata } = req.body;
      if (!guildId || !type) return res.status(400).json({ error: 'missing_fields' });

      const { supabase } = require('../core/database');

      const { data: logChannel } = await supabase
        .from('bot_log_channels')
        .select('channel_id')
        .eq('guild_id', guildId)
        .eq('channel_type', 'admin_log')
        .eq('is_active', true)
        .maybeSingle();

      if (!logChannel) return res.status(404).json({ error: 'admin_log channel not found' });

      const channel = client.channels.cache.get(logChannel.channel_id);
      if (!channel) return res.status(404).json({ error: 'discord channel not found' });

      const { EmbedBuilder } = require('discord.js');
      const embed = new EmbedBuilder().setTimestamp();
      let color = '#2b2d31';
      let title = 'Sistem İşlemi';
      let desc = userId ? `<@${userId}> bir işlem yaptı.` : 'Sistem tarafından bir işlem gerçekleştirildi.';

      switch (type) {
          case 'registration':
              color = '#43b581'; // Green
              title = '✅ Yeni Activity Kaydı';
              desc = `<@${userId}> activity sözleşmesini onaylayarak sisteme kayıt oldu.`;
              break;
          case 'transfer':
              color = '#faa61a'; // Yellow
              title = '💸 Para Transferi';
              desc = `<@${userId}> adlı kullanıcı <@${metadata?.targetId}> kullanıcısına **${metadata?.amount} Papel** gönderdi.`;
              break;
          case 'purchase':
              color = '#f04747'; // Red
              title = '🛒 Mağaza Satın Alımı';
              desc = `<@${userId}> mağazadan **${metadata?.itemName}** adlı ürünü **${metadata?.price} Papel** karşılığında satın aldı.`;
              break;
          case 'tag_claim':
              color = '#7289da'; // Blurple
              title = '🏷️ Tag Alındı';
              desc = `<@${userId}> sunucu tag'ini adına ekledi ve bonus kazanımları aktif oldu.`;
              break;
          case 'boost_start':
              color = '#f47fff'; // Pink
              title = '🚀 Sunucu Takviyesi';
              desc = `<@${userId}> sunucuya takviye (boost) bastı!`;
              break;
      }

      embed.setColor(color).setTitle(title).setDescription(desc);
      await channel.send({ embeds: [embed] });
      
      res.json({ success: true });
    } catch (err) {
      console.error('log-sdk-activity error:', err);
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
        const commands = require('../services/messageProcessor');
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
