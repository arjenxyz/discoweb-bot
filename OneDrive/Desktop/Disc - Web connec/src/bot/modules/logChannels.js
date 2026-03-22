/**
 * Merkezi log kanal yöneticisi
 * Tüm sistem event'lerini ilgili Discord kanalına gönderir.
 *
 * Kanal ID'leri Supabase app_config tablosunda saklanır:
 *   key: log_channel_<key>  →  value: <channel_id>
 */

const { supabase } = require('./database');

// Cache: DB'ye her seferinde gitmemek için (5 dk TTL)
let channelCache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getLogChannels() {
    if (channelCache && Date.now() - cacheTime < CACHE_TTL) return channelCache;

    const { data } = await supabase
        .from('app_config')
        .select('key, value')
        .like('key', 'log_channel_%');

    channelCache = {};
    for (const row of data ?? []) {
        const key = row.key.replace('log_channel_', '');
        channelCache[key] = row.value;
    }
    cacheTime = Date.now();
    return channelCache;
}

/** Cache'i temizle (kanallar yeniden oluşturulunca çağır) */
function clearCache() {
    channelCache = null;
}

/**
 * @param {import('discord.js').Client} client
 * @param {string} channelKey  — örn. 'basvuru_ekonomi', 'borsa_trades'
 * @param {object|object[]} embeds — Discord embed objesi veya dizisi
 */
async function logToChannel(client, channelKey, embeds) {
    try {
        const channels = await getLogChannels();
        const channelId = channels[channelKey];
        if (!channelId) return; // Kanal ayarlanmamış, sessizce atla

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) return;

        const embedArray = Array.isArray(embeds) ? embeds : [embeds];
        await channel.send({ embeds: embedArray });
    } catch (err) {
        console.error(`logToChannel hatası (${channelKey}):`, err?.message);
    }
}

// ─── Hazır embed yardımcıları ────────────────────────────────────────────────

/** Yüksek Ekonomi başvurusu geldi */
function embedEkonomiBasvuru({ guildId, applicantId, starterPackage, applicationId }) {
    return {
        title: '🔵 Yüksek Ekonomi Başvurusu',
        color: 0x5865F2,
        fields: [
            { name: 'Sunucu', value: `\`${guildId}\``, inline: true },
            { name: 'Başvuran', value: `<@${applicantId}>`, inline: true },
            { name: 'Başlangıç Paketi', value: `${Number(starterPackage ?? 0).toLocaleString('tr-TR')} Papel`, inline: true },
        ],
        footer: { text: `Başvuru ID: ${applicationId}` },
        timestamp: new Date().toISOString(),
    };
}

/** IPO başvurusu geldi */
function embedIpoBasvuru({ guildId, applicantId, price, founderRatio, applicationId }) {
    const founderPct = Math.round(founderRatio * 100);
    return {
        title: '📈 IPO Başvurusu',
        color: 0x5865F2,
        fields: [
            { name: 'Sunucu', value: `\`${guildId}\``, inline: true },
            { name: 'Başvuran', value: `<@${applicantId}>`, inline: true },
            { name: 'Önerilen Fiyat', value: `${Number(price).toLocaleString()} Papel`, inline: true },
            { name: 'Founder Oranı', value: `%${founderPct}`, inline: true },
        ],
        footer: { text: `Başvuru ID: ${applicationId}` },
        timestamp: new Date().toISOString(),
    };
}

/** Başvuru onaylandı */
function embedOnay({ type, guildId, reviewerId, detail }) {
    return {
        title: `✅ ${type} Onaylandı`,
        color: 0x57F287,
        fields: [
            { name: 'Sunucu', value: `\`${guildId}\``, inline: true },
            { name: 'Onaylayan', value: `<@${reviewerId}>`, inline: true },
            ...(detail ? [{ name: 'Detay', value: detail, inline: false }] : []),
        ],
        timestamp: new Date().toISOString(),
    };
}

/** Başvuru reddedildi */
function embedRed({ type, guildId, reviewerId, reason }) {
    return {
        title: `❌ ${type} Reddedildi`,
        color: 0xED4245,
        fields: [
            { name: 'Sunucu', value: `\`${guildId}\``, inline: true },
            { name: 'Reddeden', value: `<@${reviewerId}>`, inline: true },
            ...(reason ? [{ name: 'Gerekçe', value: reason, inline: false }] : []),
        ],
        timestamp: new Date().toISOString(),
    };
}

/** Borsa trade gerçekleşti */
function embedTrade({ guildId, buyerUserId, sellerUserId, lotCount, pricePerLot, totalAmount, platformFee }) {
    return {
        title: '🔄 Trade Gerçekleşti',
        color: 0x00B0F4,
        fields: [
            { name: 'Sunucu', value: `\`${guildId}\``, inline: true },
            { name: 'Lot', value: lotCount.toLocaleString(), inline: true },
            { name: 'Fiyat', value: `${pricePerLot.toLocaleString()} Papel/lot`, inline: true },
            { name: 'Toplam', value: `${totalAmount.toLocaleString()} Papel`, inline: true },
            { name: 'Komisyon', value: `${platformFee.toLocaleString()} Papel`, inline: true },
            { name: 'Alıcı', value: `<@${buyerUserId}>`, inline: true },
            { name: 'Satıcı', value: `<@${sellerUserId}>`, inline: true },
        ],
        timestamp: new Date().toISOString(),
    };
}

/** Circuit breaker tetiklendi */
function embedCircuitBreaker({ guildId, marketPrice, dropPct, until }) {
    return {
        title: '⚡ Circuit Breaker Tetiklendi',
        color: 0xFFA500,
        fields: [
            { name: 'Sunucu', value: `\`${guildId}\``, inline: true },
            { name: 'Güncel Fiyat', value: `${marketPrice.toLocaleString()} Papel`, inline: true },
            { name: '24s Düşüş', value: `%${dropPct.toFixed(1)}`, inline: true },
            { name: 'Trading Durdu', value: `<t:${Math.floor(new Date(until).getTime() / 1000)}:R> kadar`, inline: false },
        ],
        timestamp: new Date().toISOString(),
    };
}

/** Büyük işlem */
function embedBuyukIslem({ guildId, userId, type, lotCount, totalAmount }) {
    return {
        title: `🐋 Büyük ${type === 'buy' ? 'Alış' : 'Satış'} Emri`,
        color: 0xFEE75C,
        fields: [
            { name: 'Sunucu', value: `\`${guildId}\``, inline: true },
            { name: 'Kullanıcı', value: `<@${userId}>`, inline: true },
            { name: 'Lot', value: lotCount.toLocaleString(), inline: true },
            { name: 'Toplam', value: `${totalAmount.toLocaleString()} Papel`, inline: true },
        ],
        timestamp: new Date().toISOString(),
    };
}

/** Wash trading girişimi engellendi */
function embedSuphe({ guildId, buyerUserId, sellerUserId, blockedCount }) {
    return {
        title: '🚨 Wash Trading Engellendi',
        color: 0xED4245,
        fields: [
            { name: 'Sunucu', value: `\`${guildId}\``, inline: true },
            { name: 'Alıcı', value: `<@${buyerUserId}>`, inline: true },
            { name: 'Satıcı', value: `<@${sellerUserId}>`, inline: true },
            { name: 'Son 1 saatte', value: `${blockedCount} işlem engellendi`, inline: true },
        ],
        timestamp: new Date().toISOString(),
    };
}

/** Hazineye para girdi */
function embedHazineGiris({ guildId, burnAmount, treasuryAmount, totalSpent, userId }) {
    return {
        title: '💰 Hazineye Kesinti',
        color: 0x57F287,
        fields: [
            { name: 'Sunucu', value: `\`${guildId}\``, inline: true },
            { name: 'Harcayan', value: `<@${userId}>`, inline: true },
            { name: 'Toplam Harcama', value: `${totalSpent.toLocaleString()} Papel`, inline: true },
            { name: 'Hazineye', value: `+${treasuryAmount.toLocaleString()} Papel`, inline: true },
            { name: 'Yakılan', value: `🔥 ${burnAmount.toLocaleString()} Papel`, inline: true },
        ],
        timestamp: new Date().toISOString(),
    };
}

/** Ceza verildi */
function embedCeza({ guildId, type, reason, fineAmount, issuedBy }) {
    const typeLabels = { warning: '⚠️ Uyarı', fine: '💸 Para Cezası', suspension: '🔒 Askıya Alma', delist: '❌ Delist' };
    const colors = { warning: 0xFEE75C, fine: 0xFFA500, suspension: 0xED4245, delist: 0x2C2F33 };
    return {
        title: `${typeLabels[type] ?? type} Uygulandı`,
        color: colors[type] ?? 0xED4245,
        fields: [
            { name: 'Sunucu', value: `\`${guildId}\``, inline: true },
            { name: 'Veren', value: `<@${issuedBy}>`, inline: true },
            { name: 'Gerekçe', value: reason ?? 'Belirtilmedi', inline: false },
            ...(fineAmount ? [{ name: 'Yakılan', value: `${fineAmount.toLocaleString()} Papel`, inline: true }] : []),
        ],
        timestamp: new Date().toISOString(),
    };
}

/** Temettü dağıtıldı */
function embedTemetu({ guildId, weekId, totalAmount, perLotAmount, holderCount }) {
    return {
        title: '💎 Haftalık Temettü Dağıtıldı',
        color: 0x57F287,
        fields: [
            { name: 'Sunucu', value: `\`${guildId}\``, inline: true },
            { name: 'Hafta', value: weekId, inline: true },
            { name: 'Toplam', value: `${Number(totalAmount).toLocaleString()} Papel`, inline: true },
            { name: 'Lot Başına', value: `${Number(perLotAmount).toFixed(4)} Papel`, inline: true },
            { name: 'Yatırımcı', value: `${holderCount} kişi`, inline: true },
        ],
        timestamp: new Date().toISOString(),
    };
}

/** Halving gerçekleşti */
function embedHalving({ globalSupply, newMultiplier, oldMultiplier }) {
    return {
        title: '⛏️ Halving Güncellendi',
        color: 0xFFA500,
        fields: [
            { name: 'Global Supply', value: `${Number(globalSupply).toLocaleString()} Papel`, inline: true },
            { name: 'Eski Çarpan', value: `×${oldMultiplier}`, inline: true },
            { name: 'Yeni Çarpan', value: `×${newMultiplier}`, inline: true },
        ],
        timestamp: new Date().toISOString(),
    };
}

/** Referral aktivasyonu */
function embedReferralAktivasyon({ guildId, referrerId, referredId, code }) {
    return {
        title: '🔗 Referral Aktive Edildi',
        color: 0x00B0F4,
        fields: [
            { name: 'Sunucu', value: `\`${guildId}\``, inline: true },
            { name: 'Davet Eden', value: `<@${referrerId}>`, inline: true },
            { name: 'Davet Edilen', value: `<@${referredId}>`, inline: true },
            { name: 'Kod', value: `\`${code}\``, inline: true },
        ],
        timestamp: new Date().toISOString(),
    };
}

/** Cron sonucu */
function embedCronSonuc({ jobName, details }) {
    return {
        title: `🕐 Cron: ${jobName}`,
        color: 0x5865F2,
        description: details,
        timestamp: new Date().toISOString(),
    };
}

/** Global freeze durumu */
function embedFreeze({ active, triggeredBy }) {
    return {
        title: active ? '🧊 Global Freeze Aktive Edildi' : '✅ Global Freeze Kaldırıldı',
        color: active ? 0xED4245 : 0x57F287,
        fields: triggeredBy ? [{ name: 'İşlemi Yapan', value: `<@${triggeredBy}>`, inline: true }] : [],
        timestamp: new Date().toISOString(),
    };
}

module.exports = {
    logToChannel,
    clearCache,
    embeds: {
        ekonomiBasvuru: embedEkonomiBasvuru,
        ipoBasvuru: embedIpoBasvuru,
        onay: embedOnay,
        red: embedRed,
        trade: embedTrade,
        circuitBreaker: embedCircuitBreaker,
        buyukIslem: embedBuyukIslem,
        suphe: embedSuphe,
        hazineGiris: embedHazineGiris,
        ceza: embedCeza,
        temetu: embedTemetu,
        halving: embedHalving,
        referralAktivasyon: embedReferralAktivasyon,
        cronSonuc: embedCronSonuc,
        freeze: embedFreeze,
    },
};
