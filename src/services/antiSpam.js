// modules/antiSpam.js - Anti-spam / anti-abuse koruması (in-memory, DB'ye dokunmaz)

// Per-user tracking: guildId:userId -> { lastEarnTs, floodTimestamps[], floodBlockUntil }
const userMap = new Map();

const DEFAULTS = {
    cooldownMs: 5000,
    minLength: 3,
    floodCount: 5,
    floodWindowMs: 15000,
    blockStickerOnly: true,
    blockAttachmentOnly: true,
    blockEmojiOnly: true,
    voiceBlockAlone: true,
    voiceBlockMuteDeaf: true,
};

const bool = (value, fallback) => {
    if (value === undefined || value === null) return fallback;
    return !(value === false || value === 0 || value === 'false' || value === '0');
};

// Emoji-only regex: unicode emoji blocks + Discord custom emoji (<:name:id> or <a:name:id>)
const EMOJI_ONLY_RE = /^[\s\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{231A}-\u{23F3}\u{2934}-\u{2935}\u{25AA}-\u{25FE}\u{2B05}-\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]+$|^(<a?:\w+:\d+>\s*)+$/u;

function getEntry(guildId, userId) {
    const key = `${guildId}:${userId}`;
    if (!userMap.has(key)) {
        userMap.set(key, {
            lastEarnTs: 0,
            floodTimestamps: [],
            floodBlockUntil: 0,
        });
    }
    return userMap.get(key);
}

/**
 * Returns true if the message should earn coins, false if blocked by anti-spam.
 * @param {string} guildId
 * @param {string} userId
 * @param {object} message - Discord.js Message object
 * @param {object} spamCfg - server-level spam config overrides
 * @returns {{ allowed: boolean, reason: string|null }}
 */
function shouldEarnMessage(guildId, userId, message, spamCfg = {}) {
    const content = message.content || '';
    const now = Date.now();
    const entry = getEntry(guildId, userId);

    const cooldownMs = Number(spamCfg.spam_message_cooldown_ms ?? DEFAULTS.cooldownMs);
    const minLength = Number(spamCfg.spam_min_message_length ?? DEFAULTS.minLength);
    const floodCount = Number(spamCfg.spam_flood_count ?? DEFAULTS.floodCount);
    const floodWindowMs = Number(spamCfg.spam_flood_window_ms ?? DEFAULTS.floodWindowMs);
    const blockStickerOnly = bool(spamCfg.spam_block_sticker_only, DEFAULTS.blockStickerOnly);
    const blockAttachmentOnly = bool(spamCfg.spam_block_attachment_only, DEFAULTS.blockAttachmentOnly);
    const blockEmojiOnly = bool(spamCfg.spam_block_emoji_only, DEFAULTS.blockEmojiOnly);

    // 1. Flood block active?
    if (entry.floodBlockUntil > now) {
        return { allowed: false, reason: 'flood_blocked' };
    }

    // 2. Cooldown
    if ((now - entry.lastEarnTs) < cooldownMs) {
        return { allowed: false, reason: 'cooldown' };
    }

    // 3. Sticker-only messages
    if (blockStickerOnly && message.stickers && message.stickers.size > 0 && content.trim().length === 0) {
        return { allowed: false, reason: 'sticker_only' };
    }

    // 4. Attachment/GIF-only (no text)
    if (blockAttachmentOnly && message.attachments && message.attachments.size > 0 && content.trim().length === 0) {
        return { allowed: false, reason: 'attachment_only' };
    }

    // 5. Minimum length (strip whitespace)
    const stripped = content.replace(/\s+/g, '');
    if (stripped.length < minLength) {
        return { allowed: false, reason: 'too_short' };
    }

    // 6. Emoji-only
    if (blockEmojiOnly && EMOJI_ONLY_RE.test(stripped)) {
        return { allowed: false, reason: 'emoji_only' };
    }

    // 7. Flood detection: too many messages in window
    entry.floodTimestamps = entry.floodTimestamps.filter(ts => (now - ts) < floodWindowMs);
    entry.floodTimestamps.push(now);
    if (entry.floodTimestamps.length >= floodCount) {
        entry.floodBlockUntil = now + floodWindowMs;
        entry.floodTimestamps = [];
        return { allowed: false, reason: 'flood' };
    }

    // All checks passed - update tracking
    entry.lastEarnTs = now;

    return { allowed: true, reason: null };
}

/**
 * Check if a voice state is eligible for earning.
 * @param {import('discord.js').VoiceState} voiceState
 * @param {object} spamCfg - server-level voice spam overrides
 * @returns {{ allowed: boolean, reason: string|null }}
 */
function isVoiceEligible(voiceState, spamCfg = {}) {
    if (!voiceState) return { allowed: false, reason: 'no_state' };

    const blockMuteDeaf = bool(spamCfg.spam_voice_block_mute_deaf, DEFAULTS.voiceBlockMuteDeaf);
    const blockAlone = bool(spamCfg.spam_voice_block_alone, DEFAULTS.voiceBlockAlone);

    // Self-mute AND self-deaf = AFK behavior
    if (blockMuteDeaf && voiceState.selfMute && voiceState.selfDeaf) {
        return { allowed: false, reason: 'self_mute_deaf' };
    }

    // Alone in channel (exclude bots)
    if (blockAlone) {
        const channel = voiceState.channel;
        if (channel) {
            const humanMembers = channel.members.filter(m => !m.user.bot);
            if (humanMembers.size <= 1) {
                return { allowed: false, reason: 'alone_in_channel' };
            }
        }
    }

    return { allowed: true, reason: null };
}

/**
 * Cleanup old entries to prevent memory leaks. Call every 5 minutes.
 */
function cleanup() {
    const now = Date.now();
    const staleThreshold = 10 * 60 * 1000; // 10 minutes inactive
    let cleaned = 0;
    for (const [key, entry] of userMap) {
        if ((now - entry.lastEarnTs) > staleThreshold && entry.floodBlockUntil < now) {
            userMap.delete(key);
            cleaned++;
        }
    }
    if (cleaned > 0) {
        console.log(`[antiSpam] cleanup: removed ${cleaned} stale entries, ${userMap.size} remaining`);
    }
}

module.exports = { shouldEarnMessage, isVoiceEligible, cleanup, DEFAULTS };
