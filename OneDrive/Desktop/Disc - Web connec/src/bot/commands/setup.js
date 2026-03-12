const { EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const config = require('../modules/config');

module.exports.handleSetupCommand = async (interaction) => {
  await interaction.editReply({ content: '❌ `/setup` interaktif akışı devre dışı bırakıldı. Lütfen kurulum için **web panelini** kullanın: ' + (process.env.WEB_URL || 'https://discowebtr.vercel.app'), components: [] });
};

// Remove interactive buttons and return a clear message in case this handler is called directly
module.exports.handleSetupButton = async (customId, interaction) => {
  try {
    await interaction.deferUpdate();
    await interaction.editReply({ content: '⚠️ Kurulum artık web panelinden yapılmaktadır. Lütfen web panelini kullanın: ' + (process.env.WEB_URL || 'https://discowebtr.vercel.app'), components: [] });
  } catch (err) {
    console.error('Setup button fallback error:', err);
    try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '❌ Buton etkileşimi sırasında bir hata oluştu.', ephemeral: true }); } catch (e) { console.error('Reply failed:', e); }
  }
};

// Interactive setup handlers removed - use web panel
module.exports.handleSetupButton = async () => {
  // This file used to contain many interactive flows. Those were intentionally removed.
  // The main button handler in index.js now short-circuits any 'setup_' customId.
  return;
};