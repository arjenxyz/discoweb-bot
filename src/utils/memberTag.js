// Helper to extract server/clan tag id from a Discord GuildMember-like object
function getMemberServerTagId(member) {
  if (!member || typeof member !== 'object') return null;

  const tryExtract = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    // direct id fields: only treat `id` as a tag id when the object looks like a tag/clan/avatar decoration
    if (typeof obj.id === 'string') {
      if (obj.name || obj.label || obj.title || obj.tag_id || obj.tag || obj.clan || obj.guild_tag || obj.avatar_decoration_data) return obj.id;
    }
    // common shaped fields
    if (typeof obj.tag_id === 'string') return obj.tag_id;
    if (typeof obj.tag === 'string') return obj.tag;
    if (typeof obj.clan === 'string') return obj.clan;
    if (obj.clan && typeof obj.clan.id === 'string') return obj.clan.id;
    if (obj.guild_tag && typeof obj.guild_tag.id === 'string') return obj.guild_tag.id;
    if (obj.guild_tag && typeof obj.guild_tag === 'string') return obj.guild_tag;
    if (obj.avatar_decoration_data && typeof obj.avatar_decoration_data === 'object') {
      if (typeof obj.avatar_decoration_data.id === 'string') return obj.avatar_decoration_data.id;
      if (typeof obj.avatar_decoration_data.tag_id === 'string') return obj.avatar_decoration_data.tag_id;
    }
    return null;
  };

  // Check various likely places
  let found = tryExtract(member);
  if (found) return found;
  if (member.user) {
    found = tryExtract(member.user);
    if (found) return found;
  }
  // inspect known fields
  const keys = Object.keys(member);
  for (const k of keys) {
    const v = member[k];
    if (typeof v === 'object' && v) {
      const got = tryExtract(v);
      if (got) return got;
    } else if (typeof v === 'string' && (k.includes('tag') || k.includes('clan') || k.includes('guild'))) {
      return v;
    }
  }

  return null;
}

function getMemberPrimaryGuildId(member) {
  if (!member || typeof member !== 'object') return null;
  // common places where Discord might put primary guild or clan info
  const tryPaths = [
    'user.primaryGuild.identityGuildId',
    'user.primary_guild.identity_guild_id',
    'primaryGuild.identityGuildId',
    'primary_guild.identity_guild_id',
    'user.primaryGuild',
    'primaryGuild',
  ];

  for (const p of tryPaths) {
    const parts = p.split('.');
    let cur = member;
    let ok = true;
    for (const part of parts) {
      if (!cur || typeof cur !== 'object' || !(part in cur)) {
        ok = false;
        break;
      }
      cur = cur[part];
    }
    if (ok && (typeof cur === 'string' || typeof cur === 'number')) return String(cur);
  }

  // fallback: look for a nested object named primaryGuild or guild_profile
  if (member.user && member.user.primaryGuild && typeof member.user.primaryGuild.identityGuildId === 'string') return member.user.primaryGuild.identityGuildId;
  if (member.user && member.user.guild_profile && typeof member.user.guild_profile.identityGuildId === 'string') return member.user.guild_profile.identityGuildId;

  return null;
}

module.exports = { getMemberServerTagId, getMemberPrimaryGuildId };
