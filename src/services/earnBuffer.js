/**
 * In-memory earn buffer — aggregates message/voice earnings and flushes to DB
 * in batches to reduce Supabase write load on large guilds.
 */
const { supabase } = require('../core/database');
const {
  addDailyEarning,
  clampToDailyCap,
  upsertMemberDailyStats,
  upsertServerDailyStats,
} = require('./earnings');

const FLUSH_INTERVAL_MS = Number(process.env.EARN_BUFFER_FLUSH_MS || 8_000);
const MAX_BUFFER_ENTRIES = Number(process.env.EARN_BUFFER_MAX_ENTRIES || 2_000);

/** @type {Map<string, { guildId: string, userId: string, source: 'message'|'voice', amount: number, messageCount: number, voiceMinutes: number, username?: string|null, hasTag?: boolean, meta?: object }>} */
const buffer = new Map();

let flushTimer = null;
let flushing = false;

function entryKey(guildId, userId, source) {
  return `${guildId}:${userId}:${source}`;
}

function getPendingAmount(guildId, userId, source) {
  return Number(buffer.get(entryKey(guildId, userId, source))?.amount || 0);
}

function ensureTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushEarnBuffer('interval');
  }, FLUSH_INTERVAL_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/**
 * Queue a message earning. Caps account for already-buffered amount.
 */
async function queueMessageEarn({
  guildId,
  userId,
  amount,
  username = null,
  hasTag = false,
  dailyCap = 0,
  meta = {},
}) {
  if (!guildId || !userId || !(amount > 0)) return { queued: 0 };

  const pending = getPendingAmount(guildId, userId, 'message');
  const allowedTotal = await clampToDailyCap(guildId, userId, 'message', pending + amount, dailyCap);
  const add = Number((allowedTotal - pending).toFixed(2));
  if (!(add > 0)) return { queued: 0, reason: 'daily_cap' };

  const key = entryKey(guildId, userId, 'message');
  const existing = buffer.get(key);
  if (existing) {
    existing.amount = Number((existing.amount + add).toFixed(2));
    existing.messageCount += 1;
    if (username) existing.username = username;
    if (hasTag) existing.hasTag = true;
    existing.meta = { ...existing.meta, ...meta };
  } else {
    buffer.set(key, {
      guildId,
      userId,
      source: 'message',
      amount: add,
      messageCount: 1,
      voiceMinutes: 0,
      username,
      hasTag,
      meta,
    });
  }

  if (buffer.size >= MAX_BUFFER_ENTRIES) {
    void flushEarnBuffer('max_entries');
  } else {
    ensureTimer();
  }

  return { queued: add };
}

/**
 * Queue voice earning minutes/amount.
 */
async function queueVoiceEarn({
  guildId,
  userId,
  amount,
  minutes = 0,
  dailyCap = 0,
  meta = {},
}) {
  if (!guildId || !userId || !(amount > 0)) return { queued: 0 };

  const pending = getPendingAmount(guildId, userId, 'voice');
  const allowedTotal = await clampToDailyCap(guildId, userId, 'voice', pending + amount, dailyCap);
  const add = Number((allowedTotal - pending).toFixed(2));
  if (!(add > 0)) return { queued: 0, reason: 'daily_cap' };

  const key = entryKey(guildId, userId, 'voice');
  const existing = buffer.get(key);
  if (existing) {
    existing.amount = Number((existing.amount + add).toFixed(2));
    existing.voiceMinutes += minutes;
    existing.meta = { ...existing.meta, ...meta };
  } else {
    buffer.set(key, {
      guildId,
      userId,
      source: 'voice',
      amount: add,
      messageCount: 0,
      voiceMinutes: minutes,
      meta,
    });
  }

  if (buffer.size >= MAX_BUFFER_ENTRIES) {
    void flushEarnBuffer('max_entries');
  } else {
    ensureTimer();
  }

  return { queued: add };
}

async function flushEarnBuffer(reason = 'manual') {
  if (flushing) return { flushed: 0, reason: 'busy' };
  if (buffer.size === 0) return { flushed: 0 };

  flushing = true;
  const entries = [...buffer.values()];
  buffer.clear();

  let flushed = 0;
  const profileSeen = new Set();
  const tagSeen = new Set();
  const serverMsgStats = new Map();
  const serverVoiceStats = new Map();

  try {
    for (const entry of entries) {
      // Critical write only — requeue ONLY if this fails.
      // Side-effect failures must NOT requeue: that double-credits earnings/message counts.
      try {
        await addDailyEarning(entry.guildId, entry.userId, entry.source, entry.amount, {
          ...(entry.meta || {}),
          buffered: true,
          flushReason: reason,
        });
      } catch (err) {
        console.error('[earnBuffer] entry earn failed (requeued)', err.message);
        const key = entryKey(entry.guildId, entry.userId, entry.source);
        const existing = buffer.get(key);
        if (existing) {
          existing.amount = Number((existing.amount + entry.amount).toFixed(2));
          existing.messageCount += entry.messageCount;
          existing.voiceMinutes += entry.voiceMinutes;
        } else {
          buffer.set(key, entry);
        }
        continue;
      }

      try {
        const statDate = new Date().toISOString().slice(0, 10);
        if (entry.messageCount > 0) {
          await upsertMemberDailyStats(entry.guildId, entry.userId, statDate, entry.messageCount, 0);
          serverMsgStats.set(
            entry.guildId,
            (serverMsgStats.get(entry.guildId) || 0) + entry.messageCount
          );
        }
        if (entry.voiceMinutes > 0) {
          await upsertMemberDailyStats(entry.guildId, entry.userId, statDate, 0, entry.voiceMinutes);
          serverVoiceStats.set(
            entry.guildId,
            (serverVoiceStats.get(entry.guildId) || 0) + entry.voiceMinutes
          );
        }

        const profileKey = `${entry.guildId}:${entry.userId}`;
        if (entry.username && !profileSeen.has(profileKey)) {
          profileSeen.add(profileKey);
          const { error: profileErr } = await supabase
            .from('member_profiles')
            .upsert(
              {
                user_id: entry.userId,
                guild_id: entry.guildId,
                username: entry.username,
                updated_at: new Date().toISOString(),
              },
              { onConflict: 'user_id,guild_id' }
            );
          if (profileErr) {
            console.warn('[earnBuffer] profile upsert skipped', profileErr.message);
          }
        }

        if (entry.hasTag && !tagSeen.has(profileKey)) {
          tagSeen.add(profileKey);
          const { data: prof } = await supabase
            .from('member_profiles')
            .select('tag_granted_at')
            .eq('guild_id', entry.guildId)
            .eq('user_id', entry.userId)
            .maybeSingle();
          if (!prof?.tag_granted_at) {
            const { error: tagErr } = await supabase.from('member_profiles').upsert(
              {
                guild_id: entry.guildId,
                user_id: entry.userId,
                tag_granted_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
              { onConflict: 'guild_id,user_id' }
            );
            if (tagErr) {
              console.warn('[earnBuffer] tag upsert skipped', tagErr.message);
            }
          }
        }
      } catch (err) {
        console.error('[earnBuffer] entry side-effects failed (not requeued)', err.message);
      }

      flushed += 1;
    }

    const statDate = new Date().toISOString().slice(0, 10);
    for (const [guildId, count] of serverMsgStats) {
      try {
        await upsertServerDailyStats(guildId, statDate, count, 0);
      } catch (err) {
        console.warn('[earnBuffer] server msg stats skipped', err.message);
      }
    }
    for (const [guildId, minutes] of serverVoiceStats) {
      try {
        await upsertServerDailyStats(guildId, statDate, 0, minutes);
      } catch (err) {
        console.warn('[earnBuffer] server voice stats skipped', err.message);
      }
    }

    if (flushed > 0) {
      console.log(`[earnBuffer] flushed ${flushed} entries (reason=${reason}, remaining=${buffer.size})`);
    }
  } finally {
    flushing = false;
    if (buffer.size > 0) ensureTimer();
  }

  return { flushed };
}

function startEarnBuffer() {
  ensureTimer();
  console.log(`[earnBuffer] started (flush=${FLUSH_INTERVAL_MS}ms, maxEntries=${MAX_BUFFER_ENTRIES})`);
}

async function stopEarnBuffer() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  await flushEarnBuffer('shutdown');
}

module.exports = {
  queueMessageEarn,
  queueVoiceEarn,
  flushEarnBuffer,
  startEarnBuffer,
  stopEarnBuffer,
  getPendingAmount,
};
