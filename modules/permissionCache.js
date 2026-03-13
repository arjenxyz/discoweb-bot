const { supabase } = require('./database');
const { getMemberServerTagId, getMemberPrimaryGuildId } = require('./memberTag');

// Simple in-memory permission cache. Keyed by `${guildId}:${userId}`.
// Stores: { hasTag, isBooster, roles:Set, memberTagId, primaryGuildId, lastUpdatedMs }
const cache = new Map();

function _key(guildId, userId) {
  return `${guildId}:${userId}`;
}

async function updateForMember(client, guildId, member) {
  if (!member) return null;
  try {
    // Fetch server tag config to decide tag id
    const { data: serverCfg } = await supabase
      .from('servers')
      .select('tag_id')
      .eq('discord_id', guildId)
      .maybeSingle();

    const tagId = serverCfg?.tag_id ?? null;

    const memberTagId = getMemberServerTagId(member);
    const primaryGuildId = getMemberPrimaryGuildId(member);
    const hasTag = Boolean(tagId && (String(primaryGuildId) === String(tagId) || String(memberTagId) === String(tagId)));
    const isBooster = Boolean(member.premiumSinceTimestamp || member.premiumSince);
    const roles = new Set(member.roles ? Array.from(member.roles.cache.keys()) : []);

    const entry = {
      hasTag,
      isBooster,
      roles,
      memberTagId: memberTagId ?? null,
      primaryGuildId: primaryGuildId ?? null,
      lastUpdatedMs: Date.now()
    };

    cache.set(_key(guildId, member.id), entry);

    // Persist tag/boost status to member_profiles so the web panel can read it
    try {
      const now = new Date().toISOString();
      const upsertData = {
        guild_id: guildId,
        user_id: member.id,
        has_tag: hasTag,
        is_booster: isBooster,
        updated_at: now
      };
      if (hasTag && !entry.memberTagId) {
        upsertData.tag_granted_at = now;
      }
      if (isBooster) {
        upsertData.booster_since = member.premiumSince || member.premiumSinceTimestamp ? new Date(member.premiumSinceTimestamp || member.premiumSince).toISOString() : now;
      }
      await supabase.from('member_profiles').upsert(upsertData, { onConflict: 'guild_id,user_id' });
    } catch (e) {
      // non-critical, don't block
    }

    return entry;
  } catch (e) {
    console.warn('permissionCache.updateForMember failed', e);
    return null;
  }
}

async function get(client, guildId, userId) {
  const k = _key(guildId, userId);
  if (cache.has(k)) return cache.get(k);

  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return null;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return null;
    return await updateForMember(client, guildId, member);
  } catch (e) {
    console.warn('permissionCache.get failed', e);
    return null;
  }
}

function invalidate(guildId, userId) {
  cache.delete(_key(guildId, userId));
}

function peek(guildId, userId) {
  return cache.get(_key(guildId, userId)) || null;
}

function clearAll() {
  cache.clear();
}

module.exports = { updateForMember, get, invalidate, peek, clearAll };
