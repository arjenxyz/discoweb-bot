const { supabase } = require('./database');

async function sendSystemMail({ guildId, userId, title, bodyHtml, authorName = 'Foxord' }) {
  try {
    await supabase.from('system_mails').insert({
      guild_id: guildId,
      user_id: userId,
      title,
      body: bodyHtml,
      category: 'system',
      status: 'published',
      author_name: authorName
    });
  } catch (e) {
    console.warn('sendSystemMail failed', e);
  }
}

module.exports = { sendSystemMail };
