const { EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('./modules/database');

const resetStates = new Map();

async function updateProgressEmbed(interaction, message, step) {
  const embed = EmbedBuilder.from(interaction.message.embeds[0]);
  embed.spliceFields(0, 1, { name: '📊 İlerleme', value: message, inline: false });
  embed.setTitle(`🗑️ ${step}/4 - Temizlik Devam Ediyor`);

  await interaction.editReply({ embeds: [embed] });
}

async function startResetProcess(interaction) {
  const guildId = interaction.guild.id;
  const resetKey = `${guildId}_${Date.now()}`;

  resetStates.set(resetKey, {
    step: 1,
    totalSteps: 4,
    guildId,
    interaction,
    startTime: Date.now()
  });

  await executeResetStep(resetKey);
}

async function executeResetStep(resetKey) {
  const state = resetStates.get(resetKey);
  if (!state) return;

  const { step } = state;

  try {
    switch (step) {
      case 1:
        await executeStep1_DiscordCleanup(resetKey);
        break;
      case 2:
        await executeStep2_DatabaseCleanup(resetKey);
        break;
      case 3:
        await executeStep3_ServerSettingsCleanup(resetKey);
        break;
      case 4:
        await executeStep4_Completion(resetKey);
        break;
    }
  } catch (error) {
    console.error(`Reset Step ${step} error:`, error);
    const { interaction } = state;
    await interaction.editReply({
      content: `❌ ${step}. adımda hata oluştu: ${error.message}\n\nLütfen tekrar deneyin veya destek alın.`,
      embeds: [],
      components: []
    });
    resetStates.delete(resetKey);
  }
}

async function executeStep1_DiscordCleanup(resetKey) {
  const state = resetStates.get(resetKey);
  const { guildId, interaction } = state;

  const progressEmbed = new EmbedBuilder()
    .setColor('#ff9800')
    .setTitle('🗑️ 1/4 - Discord Kaynakları Temizleniyor')
    .setDescription('Log kanalları ve kategoriler siliniyor...')
    .addFields({ name: '📊 İlerleme', value: '⏳ Başlatılıyor...', inline: false })
    .setFooter({ text: 'Bu işlem birkaç dakika sürebilir', iconURL: interaction.guild.iconURL() });

  await interaction.editReply({ embeds: [progressEmbed], components: [] });

  try {
    const { data: botLogChannels } = await supabase
      .from('bot_log_channels')
      .select('channel_id, category_id, channel_type, webhook_url')
      .eq('guild_id', guildId)
      .eq('is_active', true);

    const { data: logConfigs } = await supabase
      .from('log_channel_configs')
      .select('webhook_url, channel_type')
      .eq('guild_id', guildId)
      .eq('is_active', true);

    const botLogCount = botLogChannels?.length || 0;
    const configCount = logConfigs?.length || 0;
    const totalChannels = botLogCount + configCount;

    if (totalChannels === 0) {
      await updateProgressEmbed(interaction, 'ℹ️ Log kanalları ayarlanmamış, Discord temizliği atlanıyor...', 1);
      setTimeout(() => {
        state.step = 2;
        executeResetStep(resetKey);
      }, 1000);
      return;
    }

    await updateProgressEmbed(interaction, `📋 ${totalChannels} log kanalı ve yapılandırması bulundu`, 1);

    const channelsToDelete = new Set();
    const categoriesToDelete = new Set();
    const webhooksToDelete = [];

    if (botLogChannels) {
      for (const channel of botLogChannels) {
        channelsToDelete.add(channel.channel_id);
        if (channel.category_id) categoriesToDelete.add(channel.category_id);
        if (channel.webhook_url) webhooksToDelete.push({ url: channel.webhook_url, type: channel.channel_type });
      }
    }

    if (logConfigs) {
      for (const config of logConfigs) {
        if (config.webhook_url) webhooksToDelete.push({ url: config.webhook_url, type: config.channel_type });
      }
    }

    await updateProgressEmbed(interaction, `🔗 ${webhooksToDelete.length} webhook siliniyor...`, 1);
    for (const webhook of webhooksToDelete) {
      try {
        const webhookMatch = webhook.url.match(/\/webhooks\/(\d+)\/(.+)/);
        if (webhookMatch) {
          const webhookId = webhookMatch[1];
          const webhookToken = webhookMatch[2];
          await interaction.guild.client.rest.delete(`/webhooks/${webhookId}/${webhookToken}`);
        }
      } catch (err) {
        console.warn('Webhook delete failed:', err.message);
      }
    }

    await updateProgressEmbed(interaction, `📺 ${channelsToDelete.size} kanal siliniyor...`, 1);
    for (const channelId of channelsToDelete) {
      try {
        const channel = await interaction.guild.channels.fetch(channelId);
        if (channel) {
          if (channel.parentId && !categoriesToDelete.has(channel.parentId)) categoriesToDelete.add(channel.parentId);
          await channel.delete();
        }
      } catch (err) {
        console.warn('Channel delete failed:', err.message);
      }
    }

    await updateProgressEmbed(interaction, `✅ Kanallar ve webhooklar silindi`, 1);

    setTimeout(() => {
      state.step = 2;
      executeResetStep(resetKey);
    }, 1000);

  } catch (error) {
    throw new Error(`Discord cleanup error: ${error.message}`);
  }
}

async function executeStep2_DatabaseCleanup(resetKey) {
  const state = resetStates.get(resetKey);
  const { guildId, interaction } = state;

  try {
    await updateProgressEmbed(interaction, '🧹 Veritabanı kayıtları temizleniyor...', 2);

    const { error } = await supabase.from('web_audit_logs').delete().eq('guild_id', guildId);
    if (error) throw new Error(`Web audit logs delete failed: ${error.message}`);

    await updateProgressEmbed(interaction, '✅ Veritabanı temizliği tamamlandı', 2);

    setTimeout(() => {
      state.step = 3;
      executeResetStep(resetKey);
    }, 1000);

  } catch (error) {
    throw new Error(`Database cleanup error: ${error.message}`);
  }
}

module.exports = { startResetProcess };