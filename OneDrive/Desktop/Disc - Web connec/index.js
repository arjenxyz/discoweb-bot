// 1. Modülleri Çağır
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const express = require('express');
const config = require('./modules/config');

if (!config.discordToken) {
    console.error('⚠️ DISCORD_TOKEN tanımlı değil! Lütfen .env veya .env.local dosyanıza geçerli bir token ekleyin.');
    process.exit(1);
}

if (!config.clientId) {
    console.warn('⚠️ DISCORD_CLIENT_ID tanımlı değil. Slash komut kaydı desteği kısıtlanmış olabilir.');
}

const { supabase, getGuild, getMaintenanceStatus } = require('./modules/database');
const { processStoreOrders, processPendingOrdersAtMidnight } = require('./modules/store');
const { processVoiceEarnings, addDailyEarning, processDailySettlement } = require('./modules/earnings');
const { logSystemError } = require('./modules/errorHandler');
const permissionCache = require('./modules/permissionCache');
const mailTemplates = require('./modules/mailTemplates');
const { sendSystemMail } = require('./modules/notifications');
const { formatUser, truncate } = require('./modules/logger');
const { logToChannel, embeds: logEmbeds, clearCache: clearLogCache } = require('./modules/logChannels');

// ── Market Event helper ──────────────────────────────────────────────────────
const ANON_ACTORS = ['Gizemli bir yatırımcı', 'Büyük bir aktör', 'Piyasanın demir eli', 'Stratejik bir isim', 'Cesur bir hamle yapan yatırımcı'];
const TEMPLATES = {
    ipo_launch:       [(m) => `🔔 Yeni halka arz: ${m.server_name} bugün borsaya açıldı — ${m.price?.toFixed(2)} MRI/lot`, (m) => `${m.server_name} yatırımcılarla buluşuyor! IPO fiyatı: ${m.price?.toFixed(2)} MRI`],
    treasury_support: [(m) => `🏦 ${m.server_name} hazinesi devreye girdi — ${m.lot_count?.toLocaleString()} lot alındı, fiyat desteklendi`, (m) => `${m.server_name} hazinesi ${m.lot_count?.toLocaleString()} lot alarak piyasaya güven verdi`],
    delist_warning:   [(m) => `⚠️ ${m.server_name} tehlike bölgesinde — fiyat eşik altında`, (m) => `Alarm: ${m.server_name} delist sınırına yaklaştı`],
    delist:           [(m) => `🔴 ${m.server_name} borsadan çıkarıldı — tüm yatırımcılara tazminat ödendi`],
    dividend_paid:    [(m) => `💰 Haftalık temettü dağıtıldı — ${m.server_name} lot sahipleri toplam ${m.mari?.toFixed(2)} MRI kazandı`, (m) => `${m.server_name} yatırımcıları bu hafta da kazandı: ${m.mari?.toFixed(2)} MRI temettü`],
    price_crash:      [(m) => `📉 ${m.server_name}'da sert satış: ${m.pct?.toFixed(1)}% günlük düşüş`],
    market_recovery:  [(m) => `💹 ${m.server_name} dipten döndü — ${m.pct?.toFixed(1)}% toparlanma kaydedildi`],
};
async function insertMarketEvent(eventType, guildId, actorId, meta, body) {
    try {
        const templates = TEMPLATES[eventType];
        const headline = templates ? templates[Math.floor(Math.random() * templates.length)](meta || {}) : eventType;
        await supabase.from('market_events').insert({ event_type: eventType, guild_id: guildId || null, actor_id: actorId || null, headline, body: body || null, metadata: meta || null });
    } catch (e) { /* sessizce geç */ }
}
// ── Market Event helper sonu ─────────────────────────────────────────────────

const isClientReady = (botClient) => {
    return botClient && typeof botClient.isReady === 'function' && botClient.isReady();
};

// Sistem hatalarını yakala ve sadece developer kanalına gönder
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    if (isClientReady(client)) {
        logSystemError(client, error, { location: 'uncaughtException' });
    } else {
        console.warn('Bot henüz hazır değil, sistem hatası Discord kanalına gönderilemedi.');
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    if (isClientReady(client)) {
        logSystemError(client, new Error(String(reason)), { location: 'unhandledRejection' });
    } else {
        console.warn('Bot henüz hazır değil, unhandledRejection Discord kanalına gönderilemedi.');
    }
});

// Extracted reset workflow into a separate module to reduce index.js size and improve testability
const { startResetProcess } = require('./reset');

// Reset adımını çalıştır
async function executeResetStep(resetKey) {
    const state = resetStates.get(resetKey);
    if (!state) return;

    const { step, totalSteps, guildId, interaction } = state;

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
        await interaction.editReply({
            content: `❌ ${step}. adımda hata oluştu: ${error.message}\n\nLütfen tekrar deneyin veya destek alın.`,
            embeds: [],
            components: []
        });
        resetStates.delete(resetKey);
    }
}

// Adım 1: Discord kaynaklarını temizle
async function executeStep1_DiscordCleanup(resetKey) {
    const state = resetStates.get(resetKey);
    const { guildId, interaction } = state;

    // İlerleme embed'i
    const progressEmbed = new EmbedBuilder()
        .setColor('#ff9800')
        .setTitle('🗑️ 1/4 - Discord Kaynakları Temizleniyor')
        .setDescription('Log kanalları ve kategoriler siliniyor...')
        .addFields(
            { name: '📊 İlerleme', value: '⏳ Başlatılıyor...', inline: false }
        )
        .setFooter({
            text: 'Bu işlem birkaç dakika sürebilir',
            iconURL: interaction.guild.iconURL()
        });

    await interaction.editReply({ embeds: [progressEmbed], components: [] });

    try {
        // Log kanallarını veritabanından çek (hem bot_log_channels hem log_channel_configs tablosundan)
        console.log(`Reset Step 1: Fetching log channels for guild: ${guildId}`);

        // bot_log_channels tablosundan kanal bilgilerini çek
        const { data: botLogChannels, error: botLogError } = await supabase
            .from('bot_log_channels')
            .select('channel_id, category_id, channel_type, webhook_url')
            .eq('guild_id', guildId)
            .eq('is_active', true);

        // log_channel_configs tablosundan webhook bilgilerini çek
        const { data: logConfigs, error: configError } = await supabase
            .from('log_channel_configs')
            .select('webhook_url, channel_type')
            .eq('guild_id', guildId)
            .eq('is_active', true);

        console.log(`Reset Step 1: Bot log channels - error:`, botLogError, `data:`, botLogChannels);
        console.log(`Reset Step 1: Log configs - error:`, configError, `data:`, logConfigs);

        const botLogCount = botLogChannels?.length || 0;
        const configCount = logConfigs?.length || 0;
        const totalChannels = botLogCount + configCount;

        console.log(`Reset Step 1: Found ${botLogCount} bot log channels and ${configCount} log configs`);

        if (totalChannels === 0) {
            console.log('Reset Step 1: No log channels found, skipping Discord cleanup but continuing with database cleanup');
            await updateProgressEmbed(interaction, 'ℹ️ Log kanalları ayarlanmamış, Discord temizliği atlanıyor...', 1);
            setTimeout(() => {
                state.step = 2;
                executeResetStep(resetKey);
            }, 1000);
            return;
        }

        await updateProgressEmbed(interaction, `📋 ${totalChannels} log kanalı ve yapılandırması bulundu`, 1);

        let completed = 0;
        const channelsToDelete = new Set();
        const categoriesToDelete = new Set();
        const webhooksToDelete = [];

        // bot_log_channels'dan kanal ve kategori ID'lerini topla
        if (botLogChannels) {
            for (const channel of botLogChannels) {
                channelsToDelete.add(channel.channel_id);
                if (channel.category_id) {
                    categoriesToDelete.add(channel.category_id);
                }
                if (channel.webhook_url) {
                    webhooksToDelete.push({
                        url: channel.webhook_url,
                        type: channel.channel_type,
                        source: 'bot_log_channels'
                    });
                }
            }
        }

        // log_channel_configs'den webhook'ları topla
        if (logConfigs) {
            for (const config of logConfigs) {
                if (config.webhook_url) {
                    webhooksToDelete.push({
                        url: config.webhook_url,
                        type: config.channel_type,
                        source: 'log_channel_configs'
                    });
                }
            }
        }

        console.log(`Reset Step 1: Channels to delete:`, Array.from(channelsToDelete));
        console.log(`Reset Step 1: Categories to delete:`, Array.from(categoriesToDelete));
        console.log(`Reset Step 1: Webhooks to delete:`, webhooksToDelete.length);

        let webhookCompleted = 0;
        let channelCompleted = 0;
        let categoryCompleted = 0;

        // Webhook'ları sil
        if (webhooksToDelete.length > 0) {
            await updateProgressEmbed(interaction, `🔗 ${webhooksToDelete.length} webhook siliniyor...`, 1);
            for (const webhook of webhooksToDelete) {
                try {
                    const webhookMatch = webhook.url.match(/\/webhooks\/(\d+)\/(.+)/);
                    if (webhookMatch) {
                        const webhookId = webhookMatch[1];
                        const webhookToken = webhookMatch[2];

                        await interaction.guild.client.rest.delete(`/webhooks/${webhookId}/${webhookToken}`);
                        console.log(`Reset Step 1: Deleted webhook for ${webhook.type} (${webhook.source})`);
                    }
                    webhookCompleted++;
                } catch (error) {
                    console.error(`Reset Step 1: Failed to delete webhook for ${webhook.type}:`, error.message);
                    webhookCompleted++;
                }
            }
            await updateProgressEmbed(interaction, `✅ ${webhookCompleted} webhook silindi`, 1);
        }

        // Kanalları sil
        if (channelsToDelete.size > 0) {
            await updateProgressEmbed(interaction, `📺 ${channelsToDelete.size} kanal siliniyor...`, 1);
            for (const channelId of channelsToDelete) {
                try {
                    const channel = await interaction.guild.channels.fetch(channelId);
                    if (channel) {
                        // Eğer bu kanalın parent category'si varsa ve henüz eklenmemişse, kategoriyi de silinecekler listesine ekle
                        if (channel.parentId && !categoriesToDelete.has(channel.parentId)) {
                            categoriesToDelete.add(channel.parentId);
                            console.log(`Reset Step 1: Added parent category ${channel.parentId} from channel ${channelId}`);
                        }
                        await channel.delete();
                        console.log(`Reset Step 1: Deleted channel ${channelId} (${channel.name})`);
                    }
                    channelCompleted++;
                } catch (error) {
                    console.error(`Reset Step 1: Failed to delete channel ${channelId}:`, error.message);
                    channelCompleted++;
                }
            }
            await updateProgressEmbed(interaction, `✅ ${channelCompleted} kanal silindi`, 1);
        }

        // Kategorileri sil (kanallar silindikten sonra)
        if (categoriesToDelete.size > 0) {
            await updateProgressEmbed(interaction, `📁 ${categoriesToDelete.size} kategori siliniyor...`, 1);
            for (const categoryId of categoriesToDelete) {
                try {
                    const category = await interaction.guild.channels.fetch(categoryId);
                    if (category) {
                        if (category.type === 4) { // CATEGORY type
                            // Kategorinin alt kanallarını kontrol et
                            const childChannels = category.children.cache.size;
                            console.log(`Reset Step 1: Category ${categoryId} (${category.name}) has ${childChannels} child channels`);

                            if (childChannels === 0) {
                                await category.delete();
                                console.log(`Reset Step 1: Deleted category ${categoryId} (${category.name})`);
                            } else {
                                console.log(`Reset Step 1: Skipping category ${categoryId} - still has ${childChannels} channels`);
                            }
                        } else {
                            console.log(`Reset Step 1: Channel ${categoryId} is not a category (type: ${category.type})`);
                        }
                    } else {
                        console.log(`Reset Step 1: Category ${categoryId} not found`);
                    }
                    categoryCompleted++;
                } catch (error) {
                    console.error(`Reset Step 1: Failed to delete category ${categoryId}:`, error.message);
                    categoryCompleted++;
                }
            }
            await updateProgressEmbed(interaction, `✅ ${categoryCompleted} kategori kontrol edildi`, 1);
        }

        // Veritabanından kayıtları sil
        await supabase
            .from('bot_log_channels')
            .delete()
            .eq('guild_id', guildId);

        await supabase
            .from('log_channel_configs')
            .delete()
            .eq('guild_id', guildId);

        await updateProgressEmbed(interaction, '✅ Discord kaynakları başarıyla temizlendi!', 1);

        // Bir sonraki adıma geç
        setTimeout(() => {
            state.step = 2;
            executeResetStep(resetKey);
        }, 2000);

    } catch (error) {
        throw new Error(`Discord temizleme hatası: ${error.message}`);
    }
}

// Adım 2: Veritabanı verilerini temizle
async function executeStep2_DatabaseCleanup(resetKey) {
    const state = resetStates.get(resetKey);
    const { guildId, interaction } = state;

    const progressEmbed = new EmbedBuilder()
        .setColor('#ff9800')
        .setTitle('🗑️ 2/4 - Veritabanı Verileri Temizleniyor')
        .setDescription('Üye verileri, mağaza kayıtları ve istatistikler siliniyor...')
        .addFields(
            { name: '📊 İlerleme', value: '⏳ Başlatılıyor...', inline: false }
        )
        .setFooter({
            text: 'Bu işlem geri alınamaz!',
            iconURL: interaction.guild.iconURL()
        });

    await interaction.editReply({ embeds: [progressEmbed], components: [] });

    try {
        // Önce server_id'yi al
        const { data: serverData } = await supabase
            .from('servers')
            .select('id')
            .eq('discord_id', guildId)
            .maybeSingle();

        const serverId = serverData?.id;
        console.log(`Reset Step 2: Guild ID: ${guildId}, Server ID: ${serverId}, Server Data:`, serverData);

        const tablesToClean = [
            'member_profiles',
            'member_wallets',
            'wallet_ledger',
            'daily_earnings',
            'member_daily_stats',
            'server_daily_stats',
            'member_overview_stats',
            'server_overview_stats',
            'store_items',
            'store_orders',
            'promotions',
            'store_discounts',
            'notifications'
            // 'web_audit_logs' // Şimdilik çıkarıldı, schema cache sorunu var
        ];

        let completed = 0;
        const totalTables = tablesToClean.length;

        for (const tableName of tablesToClean) {
            try {
                let query = supabase.from(tableName).delete();

                // Her tablo için doğru filtreleme
                if (['store_items', 'store_orders', 'promotions', 'store_discounts'].includes(tableName)) {
                    // Bu tablolar server_id kullanıyor (UUID)
                    if (serverId) {
                        console.log(`Reset Step 2: Deleting ${tableName} with server_id: ${serverId}`);
                        query = query.eq('server_id', serverId);
                    } else {
                        console.log(`Reset Step 2: No server_id found for ${tableName}, skipping`);
                        completed++;
                        continue;
                    }
                } else if (['maintenance_flags', 'log_channel_configs'].includes(tableName)) {
                    // Bu tablolar farklı alan adları kullanıyor
                    const fieldName = tableName === 'maintenance_flags' ? 'server_id' : 'guild_id';
                    if (fieldName === 'server_id' && serverId) {
                        query = query.eq(fieldName, serverId);
                    } else if (fieldName === 'guild_id') {
                        query = query.eq(fieldName, guildId);
                    } else {
                        console.log(`Reset Step 2: Cannot filter ${tableName}, skipping`);
                        completed++;
                        continue;
                    }
                } else {
                    // Diğer tablolar guild_id kullanıyor
                    query = query.eq('guild_id', guildId);
                }

                const { error } = await query;

                if (error) {
                    console.error(`Reset Step 2: Failed to delete from ${tableName}:`, error);
                } else {
                    console.log(`Reset Step 2: Cleared table ${tableName}`);
                }

                completed++;
                await updateProgressEmbed(interaction, `🗑️ ${tableName}: ${completed}/${totalTables}`, 2);

            } catch (error) {
                console.error(`Reset Step 2: Error deleting from ${tableName}:`, error);
                completed++;
            }
        }

        await updateProgressEmbed(interaction, '✅ Veritabanı verileri başarıyla temizlendi!', 2);

        // Bir sonraki adıma geç
        setTimeout(() => {
            state.step = 3;
            executeResetStep(resetKey);
        }, 2000);

    } catch (error) {
        throw new Error(`Veritabanı temizleme hatası: ${error.message}`);
    }
}

// Adım 3: Sunucu ayarlarını temizle
async function executeStep3_ServerSettingsCleanup(resetKey) {
    const state = resetStates.get(resetKey);
    const { guildId, interaction } = state;

    const progressEmbed = new EmbedBuilder()
        .setColor('#ff9800')
        .setTitle('🗑️ 3/4 - Sunucu Ayarları Temizleniyor')
        .setDescription('Son olarak sunucu ayarları siliniyor...')
        .addFields(
            { name: '📊 İlerleme', value: '⏳ Başlatılıyor...', inline: false }
        )
        .setFooter({
            text: 'Bu son adım!',
            iconURL: interaction.guild.iconURL()
        });

    await interaction.editReply({ embeds: [progressEmbed], components: [] });

    try {
        // Önce server_id'yi al
        const { data: serverData } = await supabase
            .from('servers')
            .select('id')
            .eq('discord_id', guildId)
            .maybeSingle();

        const serverId = serverData?.id;

        // Maintenance flags sil
        if (serverId) {
            await supabase
                .from('maintenance_flags')
                .delete()
                .eq('server_id', serverId);
        }

        // Log channel configs sil
        await supabase
            .from('log_channel_configs')
            .delete()
            .eq('guild_id', guildId);

        await updateProgressEmbed(interaction, '🧹 Yardımcı tablolar temizlendi', 3);

        // Son olarak servers tablosunu sil
        const { error } = await supabase
            .from('servers')
            .delete()
            .eq('discord_id', guildId);

        if (error) {
            throw new Error(`Sunucu ayarları silinemedi: ${error.message}`);
        }

        await updateProgressEmbed(interaction, '✅ Sunucu ayarları başarıyla temizlendi!', 3);

        // Bir sonraki adıma geç
        setTimeout(() => {
            state.step = 4;
            executeResetStep(resetKey);
        }, 2000);

    } catch (error) {
        throw new Error(`Sunucu ayarları temizleme hatası: ${error.message}`);
    }
}

// Adım 4: Tamamlandı
async function executeStep4_Completion(resetKey) {
    const state = resetStates.get(resetKey);
    const { interaction, startTime } = state;

    const duration = Math.round((Date.now() - startTime) / 1000);

    const completionEmbed = new EmbedBuilder()
        .setColor('#4caf50')
        .setTitle('✅ Temizlik Başarıyla Tamamlandı!')
        .setDescription('Tüm sunucu ayarları, log kanalları ve veritabanı kayıtları başarıyla silindi.')
        .addFields(
            {
                name: '🗑️ Silinen Öğeler',
                value: '• Discord log kanalları ve kategorileri\n• Veritabanı kayıtları (üyeler, mağaza, istatistikler)\n• Sunucu ayarları ve roller\n• Log konfigürasyonları',
                inline: false
            },
            {
                name: '⏱️ İşlem Süresi',
                value: `${duration} saniye`,
                inline: true
            },
            {
                name: '🔄 Yeniden Kurulum',
                value: 'Kurulum artık web panelinden yapılır — lütfen web panelini kullanın',
                inline: true
            },
            {
                name: '🌐 Web Paneli',
                value: 'Web paneline giderek sunucunuzu yeniden yapılandırın',
                inline: false
            }
        )
        .setFooter({
            text: 'Veri Merkezi - Güvenli Temizlik Sistemi',
            iconURL: interaction.guild.iconURL()
        });

    // Web paneline git butonu
    const webPanelButton = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setLabel('🌐 Web Paneline Git')
                .setStyle(ButtonStyle.Link)
                .setURL('https://discnexus.vercel.app'), // Web sitesi URL'i
            new ButtonBuilder()
                .setLabel('📚 Dokümantasyon')
                .setStyle(ButtonStyle.Link)
                .setURL('https://discnexus.vercel.app/docs'), // Dokümantasyon URL'i
            new ButtonBuilder()
                .setLabel('🆘 Destek Sunucusu')
                .setStyle(ButtonStyle.Link)
                .setURL('https://discord.gg/discnexus') // Destek sunucusu URL'i
        );

    await interaction.editReply({ embeds: [completionEmbed], components: [webPanelButton] });

    // Reset durumunu temizle
    resetStates.delete(resetKey);
}

// İlerleme embed'ini güncelle
async function updateProgressEmbed(interaction, message, step) {
    const embed = EmbedBuilder.from(interaction.message.embeds[0]);
    embed.spliceFields(0, 1, { name: '📊 İlerleme', value: message, inline: false });
    embed.setTitle(`🗑️ ${step}/4 - Temizlik Devam Ediyor`);

    await interaction.editReply({ embeds: [embed] });
}

// Slash komutları — boş (tüm komutlar kaldırıldı)
const commands = [].map(command => command.toJSON());

// Bot presence güncelleme fonksiyonu
async function updateBotPresence(client) {
    try {
        const maintenanceStatus = await getMaintenanceStatus(config.guildId);
        
        let activityName, status;
        if (maintenanceStatus.isMaintenance) {
            activityName = maintenanceStatus.reason || 'Web hizmeti bakımda';
            status = 'dnd'; // Do Not Disturb
        } else {
            activityName = 'Hello There | v.2.03';
            status = 'online';
        }

        client.user.setPresence({
            activities: [{ name: activityName, type: 3 }], // Watching
            status: status
        });

        console.log(`Bot presence updated: ${activityName} (${status})`);
    } catch (error) {
        console.error('Presence update error:', error);
        // Fallback to default
        client.user.setPresence({
            activities: [{ name: '/yardim ile komutları keşfet', type: 3 }],
            status: 'online'
        });
    }
}

// 2. Bot Ayarları (İzinler - Intents)
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates // Voice için gerekli
    ]
});

// Sistem hatalarını yakala ve sadece developer kanalına gönder
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    logSystemError(client, error, { location: 'uncaughtException' });
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    logSystemError(client, new Error(String(reason)), { location: 'unhandledRejection' });
});

// Bot API is moved to `webApi.js` to keep `index.js` focused on bot logic
const { startBotApi } = require('./webApi');
startBotApi({ supabase, client, port: process.env.BOT_API_PORT || 3000 });

const voiceAward = require('./modules/voiceAward');

// Mesaj kazancı için cooldown takibi (spam koruması)
const messageCooldowns = new Map();
const MESSAGE_COOLDOWN_MS = 3000; // 3 saniye cooldown

// Mesaj kazancı ekle
async function addMessageEarning(message) {
    try {
        if (!message.guild) return; // DM mesajları sayılmaz
        if (message.author.bot) return; // Bot mesajları sayılmaz

        const guildId = message.guild.id;
        const userId = message.author.id;
        const key = `${guildId}:${userId}`;

        // Cooldown kontrolü (spam koruması)
        const now = Date.now();
        const lastMessage = messageCooldowns.get(key);
        if (lastMessage && (now - lastMessage) < MESSAGE_COOLDOWN_MS) {
            return; // Cooldown aktif, kazanç ekleme
        }
        messageCooldowns.set(key, now);

        // Sunucu ayarlarını çek
        const { data: serverCfg } = await supabase
            .from('servers')
            .select('id,discord_id,verify_role_id,message_earn_enabled,earn_per_message,tag_id,tag_bonus_message,booster_bonus_message')
            .or(`discord_id.eq.${guildId},id.eq.${guildId}`)
            .maybeSingle();

        if (!serverCfg) {
            console.log(`[messageEarning] Server config not found for guild:${guildId}`);
            return;
        }

        const cfgVerifyRole = serverCfg?.verify_role_id ?? null;
        const messageEnabled = serverCfg?.message_earn_enabled ?? true;
        const perMessage = Number(serverCfg?.earn_per_message ?? process.env.PAPEL_PER_MESSAGE ?? 1);
        const tagId = serverCfg?.tag_id ?? null;
        const tagBonusMessage = Number(serverCfg?.tag_bonus_message ?? 0) || 0;
        const boosterBonusMessage = Number(serverCfg?.booster_bonus_message ?? 0) || 0;

        // Verify rolü ayarlanmamışsa veya mesaj kazancı devre dışıysa
        if (!cfgVerifyRole) {
            console.log(`[messageEarning] SKIP no verify role configured guild:${guildId}`);
            return;
        }
        if (!messageEnabled) {
            console.log(`[messageEarning] SKIP message earning disabled guild:${guildId}`);
            return;
        }

        // Kullanıcının verify rolü var mı kontrol et
        const member = await message.guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        const isApproved = Boolean(member.roles.cache.has(cfgVerifyRole));
        if (!isApproved) {
            console.log(`[messageEarning] SKIP user not verified guild:${guildId} user:${userId}`);
            return;
        }

        // Tag ve booster bonuslarını hesapla
        let hasTag = false;
        let isBooster = false;
        try {
            const entry = await permissionCache.get(client, guildId, userId);
            if (entry) {
                hasTag = Boolean(entry.hasTag);
                isBooster = Boolean(entry.isBooster);
            } else {
                const { getMemberServerTagId, getMemberPrimaryGuildId } = require('./memberTag');
                const memberTagId = getMemberServerTagId(member);
                const memberPrimaryGuildId = getMemberPrimaryGuildId(member);
                hasTag = Boolean(tagId && (String(memberPrimaryGuildId) === String(tagId) || String(memberTagId) === String(tagId)));
                isBooster = Boolean(member.premiumSinceTimestamp || member.premiumSince);
                permissionCache.updateForMember(client, guildId, member).catch(() => null);
            }
        } catch (e) {
            const { getMemberServerTagId, getMemberPrimaryGuildId } = require('./memberTag');
            const memberTagId = getMemberServerTagId(member);
            const memberPrimaryGuildId = getMemberPrimaryGuildId(member);
            hasTag = Boolean(tagId && (String(memberPrimaryGuildId) === String(tagId) || String(memberTagId) === String(tagId)));
            isBooster = Boolean(member.premiumSinceTimestamp || member.premiumSince);
        }

        let bonus = 0;
        if (hasTag) bonus += tagBonusMessage;
        if (isBooster) bonus += boosterBonusMessage;

        const totalAmount = Number((perMessage + bonus).toFixed(2));
        if (totalAmount <= 0) return;

        // Kazancı ekle
        const { addBalance, upsertMemberDailyStats } = require('./modules/earnings');
        await addBalance(guildId, userId, totalAmount, 'earn_message', {
            channelId: message.channelId,
            base: perMessage,
            bonus,
            hasTag,
            isBooster
        });

        // Günlük istatistikleri güncelle
        const today = new Date().toISOString().slice(0, 10);
        await upsertMemberDailyStats(guildId, userId, today, 1, 0);

        console.log(`[messageEarning] AWARDED guild:${guildId} user:${userId} amount:${totalAmount} base:${perMessage} bonus:${bonus} hasTag:${hasTag} isBooster:${isBooster}`);

    } catch (error) {
        console.error('[messageEarning] Error:', error);
    }
}

// Slash komutlarını kaydetme fonksiyonu (kaldırıldı)
const registerSlashCommands = async (guildId = null) => {
    // Slash komutlar kaldırıldı
    return;
};

// Bot Hazır Olduğunda
client.once('ready', async () => {
    console.log('------------------------------------');
    console.log(`🤖 Bot ${client.user.tag} olarak giriş yaptı!`);
    console.log('🌍 Supabase bağlantısı hazır.');
    console.log(`🧩 Guild sayısı: ${client.guilds.cache.size}`);
    console.log(`🎯 Rol kontrolü: ${config.requiredRoleId}`);
    console.log('------------------------------------');

    // Slash komutlar kaldırıldı

    client.guilds.fetch(config.guildId)
        .then((guild) => {
            const role = guild.roles.cache.get(config.requiredRoleId);
            if (role) {
                console.log(`✅ Rol doğrulandı: ${role.name}`);
            } else {
                console.warn('⚠️ Rol bulunamadı. Bot yetkileri ve rol ID kontrol edin.');
            }
        })
        .catch(() => {
            console.warn('⚠️ Guild bulunamadı. Bot sunucuda mı kontrol edin.');
        });

    // Bot durumunu ayarla
    await updateBotPresence(client);

        // Initialize a small permission cache warm-up for active guild members (lazy population is used elsewhere).
        try {
            client.guilds.cache.forEach((guild) => {
                // Only fetch a few active members (do not blast fetch all members). We'll update on events.
                guild.members.cache.forEach((m, id) => {
                    if (m && !m.user?.bot) permissionCache.updateForMember(client, guild.id, m).catch(() => null);
                });
            });
        } catch (e) {
            console.warn('permissionCache warmup skipped', e);
        }

    setInterval(() => {
        // Tüm sunucular için store orders'ı işle
        client.guilds.cache.forEach((guild) => {
            void processStoreOrders(client, guild.id);
        });
    }, 5 * 60 * 1000); // 5 dakika

    setInterval(() => {
        // Bot presence güncelle
        void updateBotPresence(client);
    }, 5 * 60 * 1000); // 5 dakika

    setInterval(() => {
        // Tüm sunucular için gece yarısı işlemleri
        client.guilds.cache.forEach((guild) => {
            void processPendingOrdersAtMidnight(client, guild.id, config.timezoneOffsetMinutes);
        });
    }, 60000);

    // Voice earnings are now awarded on disconnect; listen to voiceStateUpdate
    client.on('voiceStateUpdate', async (oldState, newState) => {
        try {
            await voiceAward.handleVoiceStateUpdate(oldState, newState);
        } catch (err) {
            console.error('voiceStateUpdate handler error:', err);
        }
    });

    setInterval(() => {
        // Tüm sunucular için daily settlement
        client.guilds.cache.forEach((guild) => {
            void processDailySettlement(guild.id);
        });
    }, 60000);

    // ── IPO Otomatik Onay ────────────────────────────────────────────────────
    let ipoAutoApproveCheckedDate = null; // günde bir kez çalışır

    setInterval(async () => {
        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        const currentHour = now.getHours();

        // Gece 01:00'de çalış (00:00 yoğun, biraz kaydır)
        if (currentHour !== 1 || ipoAutoApproveCheckedDate === todayStr) return;
        ipoAutoApproveCheckedDate = todayStr;

        try {
            // auto_approve_at <= bugün olan pending başvuruları çek
            const { data: apps, error } = await supabase
                .from('ipo_applications')
                .select('id, guild_id, applicant_user_id, proposed_price, proposed_founder_ratio, guild_stats_snapshot, estimated_date')
                .eq('status', 'pending')
                .lte('auto_approve_at', todayStr)
                .not('auto_approve_at', 'is', null);

            if (error || !apps || apps.length === 0) return;

            console.log(`[IPO AutoApprove] ${apps.length} başvuru otomatik onaylanıyor...`);

            for (const ipoApp of apps) {
                try {
                    const founderLots = Math.round(1_000_000 * ipoApp.proposed_founder_ratio);
                    const publicLots = 1_000_000 - founderLots;

                    // 1. Başvuruyu onayla
                    await supabase
                        .from('ipo_applications')
                        .update({
                            status: 'approved',
                            reviewer_user_id: null, // otomatik onay
                            reviewed_at: new Date().toISOString(),
                        })
                        .eq('id', ipoApp.id);

                    // 2. server_listings kaydı oluştur
                    await supabase
                        .from('server_listings')
                        .insert({
                            guild_id: ipoApp.guild_id,
                            status: 'approved',
                            total_lots: 1_000_000,
                            founder_lots: founderLots,
                            public_lots: publicLots,
                            founder_user_id: ipoApp.applicant_user_id,
                            founder_vesting_start: new Date().toISOString(),
                            founder_vested_lots: 0,
                            base_price: ipoApp.proposed_price,
                            market_price: ipoApp.proposed_price,
                            ipo_price: ipoApp.proposed_price,
                            listed_at: new Date().toISOString(),
                        });

                    // 3. Founder'a lotlarını ver
                    await supabase
                        .from('investor_holdings')
                        .upsert({
                            user_id: ipoApp.applicant_user_id,
                            guild_id: ipoApp.guild_id,
                            lot_count: founderLots,
                            avg_buy_price: ipoApp.proposed_price,
                            updated_at: new Date().toISOString(),
                        }, { onConflict: 'user_id,guild_id' });

                    // 4. Sunucuya bildirim gönder
                    const { data: logChannelRow } = await supabase
                        .from('bot_log_channels')
                        .select('channel_id')
                        .eq('guild_id', ipoApp.guild_id)
                        .maybeSingle();

                    if (logChannelRow?.channel_id) {
                        const serverName = ipoApp.guild_stats_snapshot?.server_name ?? ipoApp.guild_id;
                        await fetch(`https://discord.com/api/channels/${logChannelRow.channel_id}/messages`, {
                            method: 'POST',
                            headers: {
                                Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                embeds: [{
                                    title: '📈 IPO Otomatik Onaylandı — Borsaya Hoş Geldiniz!',
                                    description: [
                                        `**${serverName}** artık yatırım borsasında listelendi!`,
                                        '',
                                        `> Başlangıç fiyatı: **${ipoApp.proposed_price.toLocaleString('tr-TR')} Papel/lot**`,
                                        `> Founder hissesi: **%${Math.round(ipoApp.proposed_founder_ratio * 100)}** (${founderLots.toLocaleString()} lot)`,
                                        `> Halka açık: **${publicLots.toLocaleString()} lot**`,
                                        `> Tahmini tarih: **${ipoApp.estimated_date ?? '-'}**`,
                                        '',
                                        '🤖 Bu onay otomatik olarak gerçekleştirildi.',
                                    ].join('\n'),
                                    color: 0x57F287,
                                    timestamp: new Date().toISOString(),
                                }],
                            }),
                        });
                    }

                    // 5. IPO review kanalına da bilgi ver
                    const reviewChannelId = process.env.IPO_REVIEW_CHANNEL_ID ?? process.env.ECONOMY_REVIEW_CHANNEL_ID ?? '';
                    if (reviewChannelId) {
                        await fetch(`https://discord.com/api/v10/channels/${reviewChannelId}/messages`, {
                            method: 'POST',
                            headers: {
                                Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                embeds: [{
                                    title: '🤖 IPO Otomatik Onaylandı',
                                    description: `**${ipoApp.guild_stats_snapshot?.server_name ?? ipoApp.guild_id}** sunucusunun IPO başvurusu (ID: \`${ipoApp.id}\`) tahmini tarihe 2 gün kala otomatik onaylandı.`,
                                    color: 0x57F287,
                                    timestamp: new Date().toISOString(),
                                }],
                            }),
                        });
                    }

                    // 6. Dev log kanalına kaydet
                    logToChannel(client, 'basvuru_onay', logEmbeds.onay({
                        type: 'IPO (Otomatik)',
                        guildId: ipoApp.guild_id,
                        reviewerId: null,
                        detail: `Fiyat: ${ipoApp.proposed_price.toLocaleString()} Papel/lot · Founder: %${Math.round(ipoApp.proposed_founder_ratio * 100)} · Tahmini tarih: ${ipoApp.estimated_date ?? '-'}`,
                    }));

                    // Market event: IPO launch haberi
                    const serverName = ipoApp.guild_stats_snapshot?.server_name ?? ipoApp.guild_id;
                    await insertMarketEvent('ipo_launch', ipoApp.guild_id, null, { server_name: serverName, price: ipoApp.proposed_price });

                    console.log(`[IPO AutoApprove] ✅ ${ipoApp.guild_id} otomatik onaylandı`);
                } catch (appErr) {
                    console.error(`[IPO AutoApprove] ❌ ${ipoApp.guild_id} hatası:`, appErr);
                }
            }
        } catch (err) {
            console.error('[IPO AutoApprove] Genel hata:', err);
        }
    }, 60000); // her dakika kontrol et, saat 01:00'de çalışır

    // ── Borsa Günlük Cron'ları ────────────────────────────────────────────────
    let borsaCronDate = null; // günde bir kez çalışır (tüm borsa cron'ları için ortak guard)

    setInterval(async () => {
        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        const currentHour = now.getUTCHours();
        const currentMinute = now.getUTCMinutes();

        // ── 00:00 — Günlük fiyat güncelleme + price_history OHLCV kaydı ──────
        if (currentHour === 0 && currentMinute < 5 && borsaCronDate !== `${todayStr}-price`) {
            borsaCronDate = `${todayStr}-price`; // sadece bu sub-task için değil, ayrı guard lazım, ama 5dk pencere yeterli
            try {
                const { data: listings } = await supabase
                    .from('server_listings')
                    .select('guild_id, market_price, current_day_high, current_day_low, ipo_price, public_lots, circulating_lots, support_threshold')
                    .eq('status', 'approved');

                for (const listing of listings ?? []) {
                    const yesterdayDate = new Date(now);
                    yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
                    const yesterdayStr = yesterdayDate.toISOString().slice(0, 10);
                    // Önceki günün fiyatını al (kapanış fiyatı = bugünkü market_price)
                    const closePrice = Number(listing.market_price);
                    const dayHigh = listing.current_day_high ? Number(listing.current_day_high) : closePrice;
                    const dayLow = listing.current_day_low ? Number(listing.current_day_low) : closePrice;

                    // Dün için price_history upsert (bugün = yeni başlayacak)
                    await supabase.from('price_history').upsert(
                        {
                            guild_id: listing.guild_id,
                            date: yesterdayStr,
                            open_price: closePrice, // open bilinmiyor, kapanışı kullan (gün içinde trade'ler açılışı günceller)
                            close_price: closePrice,
                            high_price: dayHigh,
                            low_price: dayLow,
                            volume_lots: 0, // trade'ler zaten gün içinde volume ekliyor; bu sadece backfill
                        },
                        { onConflict: 'guild_id,date', ignoreDuplicates: true }
                    );

                    // Yeni gün için gün high/low sıfırla
                    await supabase
                        .from('server_listings')
                        .update({ current_day_high: null, current_day_low: null })
                        .eq('guild_id', listing.guild_id);

                    // support_threshold hesapla (market_price * 0.85)
                    const supportThreshold = Math.round(closePrice * 0.85 * 100) / 100;
                    await supabase
                        .from('server_listings')
                        .update({ support_threshold: supportThreshold })
                        .eq('guild_id', listing.guild_id)
                        .is('support_threshold', null);
                }
                console.log(`[Borsa 00:00] Günlük fiyat cron tamamlandı — ${(listings ?? []).length} listing.`);
            } catch (err) {
                console.error('[Borsa 00:00] Hata:', err);
            }
        }

        // ── 00:01 — Günlük satış limiti sıfırla ─────────────────────────────
        if (currentHour === 0 && currentMinute >= 1 && currentMinute < 6 && borsaCronDate !== `${todayStr}-sell-reset`) {
            borsaCronDate = `${todayStr}-sell-reset`;
            try {
                const { error } = await supabase
                    .from('investor_holdings')
                    .update({ daily_sell_used: 0, daily_sell_reset_date: todayStr })
                    .neq('daily_sell_used', 0);
                if (!error) console.log('[Borsa 00:01] Günlük satış limitleri sıfırlandı.');
            } catch (err) {
                console.error('[Borsa 00:01] Satış limit sıfırlama hatası:', err);
            }
        }

        // ── 00:05 — Founder vesting (gün 15 / 30 / 45) ───────────────────────
        if (currentHour === 0 && currentMinute >= 5 && currentMinute < 10 && borsaCronDate !== `${todayStr}-vesting`) {
            borsaCronDate = `${todayStr}-vesting`;
            try {
                const { data: listings } = await supabase
                    .from('server_listings')
                    .select('guild_id, founder_lots, founder_vested_lots, vesting_start_date, market_price')
                    .eq('status', 'approved')
                    .not('vesting_start_date', 'is', null);

                for (const listing of listings ?? []) {
                    const vestingStart = new Date(listing.vesting_start_date);
                    const daysSinceVesting = Math.floor((Date.now() - vestingStart.getTime()) / 86400000);
                    const founderLots = Number(listing.founder_lots ?? 0);
                    const alreadyVested = Number(listing.founder_vested_lots ?? 0);

                    // %33 her 15 günde bir (3 dilim)
                    const vestingSlice = Math.floor(founderLots * 0.33);
                    let expectedVested = 0;
                    if (daysSinceVesting >= 45) expectedVested = founderLots;
                    else if (daysSinceVesting >= 30) expectedVested = vestingSlice * 2;
                    else if (daysSinceVesting >= 15) expectedVested = vestingSlice;

                    if (expectedVested > alreadyVested) {
                        const newlyVested = expectedVested - alreadyVested;
                        await supabase
                            .from('server_listings')
                            .update({ founder_vested_lots: expectedVested })
                            .eq('guild_id', listing.guild_id);

                        // Founder'ın holdings'ini güncelle (founder_user_id lazım)
                        // server_listings'de founder_user_id yoksa ipo_applications'tan al
                        const { data: ipoApp } = await supabase
                            .from('ipo_applications')
                            .select('applicant_user_id')
                            .eq('guild_id', listing.guild_id)
                            .eq('status', 'approved')
                            .maybeSingle();

                        if (ipoApp) {
                            const { data: existingHolding } = await supabase
                                .from('investor_holdings')
                                .select('lot_count, avg_buy_price')
                                .eq('user_id', ipoApp.applicant_user_id)
                                .eq('guild_id', listing.guild_id)
                                .maybeSingle();

                            const prevLots = Number(existingHolding?.lot_count ?? 0);
                            const newLots = prevLots + newlyVested;
                            await supabase.from('investor_holdings').upsert(
                                {
                                    user_id: ipoApp.applicant_user_id,
                                    guild_id: listing.guild_id,
                                    lot_count: newLots,
                                    avg_buy_price: existingHolding?.avg_buy_price ?? listing.market_price,
                                    updated_at: now.toISOString(),
                                },
                                { onConflict: 'user_id,guild_id' }
                            );

                            console.log(`[Borsa Vesting] ${listing.guild_id}: ${newlyVested} lot açıldı (gün ${daysSinceVesting}).`);
                        }
                    }
                }
            } catch (err) {
                console.error('[Borsa 00:05] Vesting hatası:', err);
            }
        }

        // ── 02:00 — Hazine destek alımı kontrolü ─────────────────────────────
        if (currentHour === 2 && currentMinute < 5 && borsaCronDate !== `${todayStr}-treasury`) {
            borsaCronDate = `${todayStr}-treasury`;
            try {
                const { data: listings } = await supabase
                    .from('server_listings')
                    .select('guild_id, market_price, support_threshold, support_days_below, circulating_lots')
                    .eq('status', 'approved')
                    .not('support_threshold', 'is', null);

                for (const listing of listings ?? []) {
                    const marketPrice = Number(listing.market_price);
                    const threshold = Number(listing.support_threshold);
                    const daysBelow = Number(listing.support_days_below ?? 0);

                    if (marketPrice < threshold) {
                        const newDaysBelow = daysBelow + 1;
                        await supabase
                            .from('server_listings')
                            .update({ support_days_below: newDaysBelow })
                            .eq('guild_id', listing.guild_id);

                        // 3 gün eşik altındaysa hazine destek alımı yap
                        if (newDaysBelow >= 3) {
                            const { data: treasury } = await supabase
                                .from('server_mari_treasury')
                                .select('support_reserve')
                                .eq('guild_id', listing.guild_id)
                                .maybeSingle();

                            const reserve = Number(treasury?.support_reserve ?? 0);
                            if (reserve > 0 && marketPrice > 0) {
                                // Reserve'in %10'uyla lot al (max 100 lot)
                                const spendAmount = Math.min(reserve * 0.1, 10000);
                                const lotsToBuy = Math.min(100, Math.floor(spendAmount / marketPrice));

                                if (lotsToBuy > 0) {
                                    // treasury_holdings güncelle
                                    const { data: th } = await supabase
                                        .from('treasury_holdings')
                                        .select('lot_count, avg_buy_price')
                                        .eq('guild_id', listing.guild_id)
                                        .maybeSingle();

                                    const prevLots = Number(th?.lot_count ?? 0);
                                    const prevAvg = Number(th?.avg_buy_price ?? 0);
                                    const newLots = prevLots + lotsToBuy;
                                    const newAvg = prevLots === 0
                                        ? marketPrice
                                        : Math.round(((prevAvg * prevLots + marketPrice * lotsToBuy) / newLots) * 100) / 100;

                                    await supabase.from('treasury_holdings').upsert(
                                        { guild_id: listing.guild_id, lot_count: newLots, avg_buy_price: newAvg, last_updated: now.toISOString() },
                                        { onConflict: 'guild_id' }
                                    );

                                    const cost = Math.round(lotsToBuy * marketPrice * 100) / 100;
                                    await supabase
                                        .from('server_mari_treasury')
                                        .update({
                                            support_reserve: Math.max(0, reserve - cost),
                                            last_updated: now.toISOString(),
                                        })
                                        .eq('guild_id', listing.guild_id);

                                    // circulating_lots artır (hazine kendi lotunu tutuyor)
                                    await supabase
                                        .from('server_listings')
                                        .update({ circulating_lots: (Number(listing.circulating_lots ?? 0) + lotsToBuy) })
                                        .eq('guild_id', listing.guild_id);

                                    await insertMarketEvent('treasury_support', listing.guild_id, null, { server_name: listing.guild_id, lot_count: lotsToBuy });
                                    console.log(`[Borsa Treasury] ${listing.guild_id}: ${lotsToBuy} lot destek alımı, ${cost} Mari harcandı.`);
                                }
                            }
                            // Sayacı sıfırla
                            await supabase
                                .from('server_listings')
                                .update({ support_days_below: 0 })
                                .eq('guild_id', listing.guild_id);
                        }
                    } else {
                        // Eşik üstünde, sayacı sıfırla
                        if (daysBelow > 0) {
                            await supabase
                                .from('server_listings')
                                .update({ support_days_below: 0 })
                                .eq('guild_id', listing.guild_id);
                        }
                    }
                }
                console.log(`[Borsa 02:00] Hazine destek kontrolü tamamlandı.`);
            } catch (err) {
                console.error('[Borsa 02:00] Hazine hatası:', err);
            }
        }

        // ── 02:30 — Delist kontrolü ───────────────────────────────────────────
        if (currentHour === 2 && currentMinute >= 30 && currentMinute < 35 && borsaCronDate !== `${todayStr}-delist`) {
            borsaCronDate = `${todayStr}-delist`;
            try {
                const { data: listings } = await supabase
                    .from('server_listings')
                    .select('guild_id, market_price, ipo_price, delist_days_below')
                    .eq('status', 'approved');

                for (const listing of listings ?? []) {
                    const marketPrice = Number(listing.market_price);
                    const ipoPrice = Number(listing.ipo_price);
                    const delistThreshold = Math.round(ipoPrice * 0.5 * 100) / 100; // IPO fiyatının %50'si
                    const daysBelow = Number(listing.delist_days_below ?? 0);

                    if (marketPrice < delistThreshold) {
                        const newDaysBelow = daysBelow + 1;
                        await supabase
                            .from('server_listings')
                            .update({ delist_days_below: newDaysBelow })
                            .eq('guild_id', listing.guild_id);

                        if (newDaysBelow >= 5) {
                            // Otomatik delist: tüm yatırımcılara tazminat öde
                            const { data: holders } = await supabase
                                .from('investor_holdings')
                                .select('user_id, lot_count')
                                .eq('guild_id', listing.guild_id)
                                .gt('lot_count', 0);

                            for (const holder of holders ?? []) {
                                const compensation = Math.round(Number(holder.lot_count) * delistThreshold * 100) / 100;
                                // member_wallets'a tazminat ekle
                                const { data: wallet } = await supabase
                                    .from('member_wallets')
                                    .select('mari_balance')
                                    .eq('user_id', holder.user_id)
                                    .eq('guild_id', process.env.PLATFORM_GUILD_ID ?? 'platform')
                                    .maybeSingle();

                                const newBalance = Math.round((Number(wallet?.mari_balance ?? 0) + compensation) * 100) / 100;
                                await supabase.from('member_wallets').upsert(
                                    { user_id: holder.user_id, guild_id: process.env.PLATFORM_GUILD_ID ?? 'platform', mari_balance: newBalance, updated_at: now.toISOString() },
                                    { onConflict: 'user_id,guild_id' }
                                );

                                await supabase
                                    .from('investor_holdings')
                                    .update({ lot_count: 0, updated_at: now.toISOString() })
                                    .eq('user_id', holder.user_id)
                                    .eq('guild_id', listing.guild_id);
                            }

                            // Listing'i delist et
                            await supabase
                                .from('server_listings')
                                .update({ status: 'delisted', delist_days_below: newDaysBelow })
                                .eq('guild_id', listing.guild_id);

                            await insertMarketEvent('delist', listing.guild_id, null, { server_name: listing.guild_id });
                            console.log(`[Borsa Delist] ${listing.guild_id} delisted. ${(holders ?? []).length} yatırımcıya tazminat ödendi.`);
                        }
                    } else {
                        if (daysBelow > 0) {
                            await supabase
                                .from('server_listings')
                                .update({ delist_days_below: 0 })
                                .eq('guild_id', listing.guild_id);
                        }
                    }
                }
                console.log(`[Borsa 02:30] Delist kontrolü tamamlandı.`);
            } catch (err) {
                console.error('[Borsa 02:30] Delist hatası:', err);
            }
        }

        // ── Pazartesi 01:00 — Temettü dağıtımı ───────────────────────────────
        const isMonday = now.getUTCDay() === 1;
        if (isMonday && currentHour === 1 && currentMinute >= 5 && currentMinute < 10 && borsaCronDate !== `${todayStr}-dividend`) {
            borsaCronDate = `${todayStr}-dividend`;
            try {
                // Önceki haftanın başlangıcı (geçen Pazartesi)
                const lastMonday = new Date(now);
                lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
                const lastMondayStr = lastMonday.toISOString().slice(0, 10);

                const { data: pools } = await supabase
                    .from('dividend_pool')
                    .select('guild_id, total_mari')
                    .eq('week_start', lastMondayStr)
                    .eq('distributed', false)
                    .gt('total_mari', 0);

                for (const pool of pools ?? []) {
                    const poolTotal = Number(pool.total_mari);
                    const guildId = pool.guild_id;

                    const { data: listing } = await supabase
                        .from('server_listings')
                        .select('circulating_lots')
                        .eq('guild_id', guildId)
                        .maybeSingle();

                    const circulatingLots = Number(listing?.circulating_lots ?? 0);
                    if (circulatingLots === 0) continue;

                    const { data: holders } = await supabase
                        .from('investor_holdings')
                        .select('user_id, lot_count')
                        .eq('guild_id', guildId)
                        .gt('lot_count', 0);

                    for (const holder of holders ?? []) {
                        const lots = Number(holder.lot_count);
                        const share = lots / circulatingLots;
                        const payout = Math.round(poolTotal * share * 100) / 100;
                        if (payout <= 0) continue;

                        // Mari öde
                        const { data: wallet } = await supabase
                            .from('member_wallets')
                            .select('mari_balance')
                            .eq('user_id', holder.user_id)
                            .eq('guild_id', process.env.PLATFORM_GUILD_ID ?? 'platform')
                            .maybeSingle();

                        const newBalance = Math.round((Number(wallet?.mari_balance ?? 0) + payout) * 100) / 100;
                        await supabase.from('member_wallets').upsert(
                            { user_id: holder.user_id, guild_id: process.env.PLATFORM_GUILD_ID ?? 'platform', mari_balance: newBalance, updated_at: now.toISOString() },
                            { onConflict: 'user_id,guild_id' }
                        );

                        // dividend_history kaydı
                        await supabase.from('dividend_history').insert({
                            guild_id: guildId,
                            user_id: holder.user_id,
                            week_start: lastMondayStr,
                            lot_snapshot: lots,
                            mari_received: payout,
                            distributed_at: now.toISOString(),
                        });
                    }

                    // Havuzu dağıtıldı olarak işaretle
                    await supabase
                        .from('dividend_pool')
                        .update({ distributed: true, distributed_at: now.toISOString() })
                        .eq('guild_id', guildId)
                        .eq('week_start', lastMondayStr);

                    await insertMarketEvent('dividend_paid', guildId, null, { server_name: guildId, mari: poolTotal });
                    console.log(`[Borsa Temettü] ${guildId}: ${poolTotal} Mari, ${(holders ?? []).length} yatırımcıya dağıtıldı.`);
                }
            } catch (err) {
                console.error('[Borsa Temettü] Hata:', err);
            }
        }

    }, 60000); // her dakika kontrol et
    // ── Borsa Günlük Cron'ları Sonu ──────────────────────────────────────────

    // ── AI Günlük Piyasa Planı ────────────────────────────────────────────────
    let dailyPlanCreatedDate = null; // YYYY-MM-DD olarak tutulur
    let lastExecutedPlanHour = -1;

    setInterval(async () => {
        const now = new Date();
        const todayStr = now.toISOString().slice(0, 10);
        const currentHour = now.getHours();

        // Gece 00:00 – tüm approved listing'ler için plan oluştur
        if (currentHour === 0 && dailyPlanCreatedDate !== todayStr) {
            dailyPlanCreatedDate = todayStr;
            try {
                const webUrl = process.env.WEB_URL || 'https://discoweb.vercel.app';
                const internalSecret = process.env.INTERNAL_API_SECRET || '';
                const { data: listings } = await supabase
                    .from('server_listings')
                    .select('guild_id')
                    .eq('status', 'approved');
                for (const row of (listings ?? [])) {
                    try {
                        await fetch(`${webUrl}/api/developer/ai-daily-plan`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'x-internal-secret': internalSecret },
                            body: JSON.stringify({ guildId: row.guild_id }),
                        });
                    } catch (e) {
                        console.error(`[DailyPlan] Guild ${row.guild_id} plan oluşturma hatası:`, e);
                    }
                }
                console.log(`[DailyPlan] ${(listings ?? []).length} sunucu için plan oluşturuldu.`);
            } catch (e) {
                console.error('[DailyPlan] Midnight plan generator hatası:', e);
            }
        }

        // Her saat başı – o saatin planlı event'ini uygula
        if (currentHour !== lastExecutedPlanHour) {
            lastExecutedPlanHour = currentHour;
            try {
                const { data: plans } = await supabase
                    .from('market_daily_plans')
                    .select('*')
                    .eq('plan_date', todayStr);
                for (const plan of (plans ?? [])) {
                    const schedule = Array.isArray(plan.hourly_schedule) ? plan.hourly_schedule : [];
                    const entry = schedule.find(s => s.hour === currentHour && !s.executed && s.price_impact !== 0);
                    if (!entry) continue;

                    // market_events tablosuna ekle (1 saatlik geçerlilik)
                    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
                    await supabase.from('market_events').insert({
                        guild_id: plan.guild_id,
                        type: 'price_adjustment',
                        severity: Math.abs(entry.price_impact) >= 0.1 ? 'warning' : 'info',
                        title: entry.title || `Saat ${currentHour}:00 Hareketi`,
                        description: entry.description || '',
                        price_impact: entry.price_impact,
                        is_active: true,
                        expires_at: expiresAt,
                    });

                    // executed = true olarak işaretle
                    const updatedSchedule = schedule.map(s =>
                        s.hour === currentHour ? { ...s, executed: true } : s
                    );
                    await supabase.from('market_daily_plans')
                        .update({ hourly_schedule: updatedSchedule })
                        .eq('id', plan.id);
                }
            } catch (e) {
                console.error('[DailyPlan] Saatlik executor hatası:', e);
            }
        }
    }, 60000);
    // ── AI Günlük Piyasa Planı Sonu ──────────────────────────────────────────
});

// Mesaj Geldiğinde (Prefix komutları için)
client.on('messageCreate', async (message) => {
    // Bot etiketlendiğinde bilgilendirici embed gönder
    if (message.mentions.has(client.user) && !message.author.bot && !message.mentions.everyone) {
        try {
            const webUrl = process.env.WEB_URL || 'https://discoweb-test.vercel.app';
            const guild = message.guild;

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setAuthor({
                    name: 'DiscoWeb',
                    iconURL: client.user.displayAvatarURL({ size: 64 }),
                })
                .setThumbnail(guild?.iconURL({ size: 128, dynamic: true }) ?? client.user.displayAvatarURL({ size: 128 }))
                .setDescription(
                    `Merhaba ${message.author}! Ben bu sunucunun web mağaza botuyum.\n\n` +
                    `Mesaj yaz veya sesli sohbete katıl → **papel** kazan → mağazadan **rol satın al**.\n` +
                    `Her şeyi web panelden takip edebilirsin. Başlamaya ne dersin?`
                )
                .addFields(
                    {
                        name: '💰 Nasıl Çalışır?',
                        value: [
                            '> 💬 Mesaj at → papel kazan',
                            '> 🎙️ Sesli sohbete katıl → papel kazan',
                            '> 🛒 Mağazadan rol satın al',
                        ].join('\n'),
                        inline: true,
                    },
                    {
                        name: '⭐ Bonus Kazan',
                        value: [
                            '> 🏷️ Sunucu tagı tak → ekstra papel',
                            '> 💎 Sunucuyu boostla → ekstra papel',
                        ].join('\n'),
                        inline: true,
                    },
                )
                .setFooter({
                    text: `${guild?.name ?? 'DiscoWeb'} • Web Mağaza`,
                    iconURL: client.user.displayAvatarURL({ size: 64 }),
                })
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setLabel('Web Panele Git')
                    .setStyle(ButtonStyle.Link)
                    .setURL(webUrl)
                    .setEmoji('🌐'),
                new ButtonBuilder()
                    .setLabel('Mağazayı Gör')
                    .setStyle(ButtonStyle.Link)
                    .setURL(`${webUrl}/dashboard`)
                    .setEmoji('🛒'),
            );

            await message.reply({ embeds: [embed], components: [row] });
        } catch (err) {
            console.error('Bot mention embed error:', err);
        }
        return;
    }

    // Mesaj kazancı ekle (bot etiketlenmediğinde)
    try {
        await addMessageEarning(message);
    } catch (err) {
        console.error('Message earning error:', err);
    }
});

// Update permission cache when members change (roles, nicknames, boost status)
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    try {
        if (newMember.user?.bot) return;

        const guildId = newMember.guild.id;
        const userId = newMember.id;


        // previous cached entry (may be null)
        const prev = permissionCache.peek(guildId, userId);

        // fetch server config once for rate summaries
        let serverCfg = null;
        try {
            const resp = await supabase.from('servers').select('verify_role_id,tag_bonus_message,tag_bonus_voice,booster_bonus_message,booster_bonus_voice').eq('discord_id', guildId).maybeSingle();
            serverCfg = resp.data || null;
        } catch (e) {
            serverCfg = null;
        }

        // update and get fresh entry
        const fresh = await permissionCache.updateForMember(client, guildId, newMember).catch(() => null);

        // detect tag change
        if (prev && fresh && prev.hasTag !== fresh.hasTag) {
            if (fresh.hasTag) {
                const tbMsg = serverCfg?.tag_bonus_message ?? 0;
                const tbVoice = serverCfg?.tag_bonus_voice ?? 0;
                const ratesHtml = `<div>Mesaj: +${tbMsg}% | Ses: +${tbVoice}%</div>`;
                const body = mailTemplates.renderTagGained(newMember.user.username, ratesHtml);
                await sendSystemMail({ guildId, userId, title: 'Sancaktarlar Aramıza Katıldı!', bodyHtml: body });
            } else {
                const body = mailTemplates.renderTagLost(newMember.user.username);
                await sendSystemMail({ guildId, userId, title: 'Sancak Düştü!', bodyHtml: body });
            }
        }

        // detect booster change
        if (prev && fresh && prev.isBooster !== fresh.isBooster) {
            if (fresh.isBooster) {
                const boostHtml = `<div>Booster bonusları aktive oldu.</div>`;
                const body = mailTemplates.renderBoostStarted(newMember.user.username, boostHtml);
                await sendSystemMail({ guildId, userId, title: 'Sunucunun Kahramanı Sensin!', bodyHtml: body });
            } else {
                const body = mailTemplates.renderBoostEnded();
                await sendSystemMail({ guildId, userId, title: 'Takviye Sona Erdi', bodyHtml: body });
            }
        }

        // detect verify role gain/loss (best-effort)
        try {
            const { data: serverCfg } = await supabase.from('servers').select('verify_role_id,tag_bonus_message,tag_bonus_voice,booster_bonus_message,booster_bonus_voice').eq('discord_id', guildId).maybeSingle();
            const verifyRoleId = serverCfg?.verify_role_id ?? null;
            if (verifyRoleId) {
                const had = oldMember.roles ? Boolean(oldMember.roles.cache.has(verifyRoleId)) : false;
                const now = newMember.roles ? Boolean(newMember.roles.cache.has(verifyRoleId)) : false;
                if (had !== now) {
                    if (now) {
                        const body = mailTemplates.renderRoleGained('Doğrulanmış Üye');
                        await sendSystemMail({ guildId, userId, title: 'Yeni Rol Kazandın!', bodyHtml: body });
                    } else {
                        const body = mailTemplates.renderRoleLost('Doğrulanmış Üye');
                        await sendSystemMail({ guildId, userId, title: 'Rolü Kaybettin', bodyHtml: body });
                    }
                }
            }
        } catch (e) {
            // ignore
        }
    } catch (e) {
        console.warn('guildMemberUpdate permissionCache update failed', e);
    }
});

client.on('guildMemberAdd', async (member) => {
    try {
        if (member.user?.bot) return;
        await permissionCache.updateForMember(client, member.guild.id, member);
    } catch (e) {
        console.warn('guildMemberAdd permissionCache update failed', e);
    }
});

// When a user's global info changes, invalidate entries so next check refreshes
client.on('userUpdate', async (oldUser, newUser) => {
    try {
        if (oldUser.id !== newUser.id) return;

        // For each guild the bot shares, fetch the member and detect tag changes
        for (const [, guild] of client.guilds.cache) {
            try {
                const member = await guild.members.fetch(newUser.id).catch(() => null);
                if (!member || member.user?.bot) continue;

                const guildId = guild.id;
                const userId = newUser.id;

                const prev = permissionCache.peek(guildId, userId);
                const fresh = await permissionCache.updateForMember(client, guildId, member).catch(() => null);

                if (prev && fresh && prev.hasTag !== fresh.hasTag) {
                    if (fresh.hasTag) {
                        const resp = await supabase.from('servers').select('tag_bonus_message,tag_bonus_voice').eq('discord_id', guildId).maybeSingle();
                        const tbMsg = resp.data?.tag_bonus_message ?? 0;
                        const tbVoice = resp.data?.tag_bonus_voice ?? 0;
                        const ratesHtml = `<div>Mesaj: +${tbMsg}% | Ses: +${tbVoice}%</div>`;
                        const body = mailTemplates.renderTagGained(member.user.username, ratesHtml);
                        await sendSystemMail({ guildId, userId, title: 'Sancaktarlar Aramıza Katıldı!', bodyHtml: body });
                    } else {
                        const body = mailTemplates.renderTagLost(member.user.username);
                        await sendSystemMail({ guildId, userId, title: 'Sancak Düştü!', bodyHtml: body });
                    }
                }
            } catch (e) {
                // swallow per-guild errors
            }
        }
    } catch (e) {
        console.warn('userUpdate permissionCache handling failed', e);
    }
});

// Slash Komutları Geldiğinde
client.on('interactionCreate', async (interaction) => {
    // Button interaction'ları için
    if (interaction.isButton()) {
        try {
            const { customId } = interaction;
            const userId = interaction.user.id;
            const guildId = interaction.guildId;

            // Otomatik kayıt kontrolü
            const { autoRegisterIfNeeded } = require('./modules/commands/user');
            await autoRegisterIfNeeded(userId, interaction.user.username);

            // Any 'setup_' buttons are handled via the web panel now — short-circuit here
            if (customId && customId.startsWith('setup_')) {
                await interaction.deferUpdate();
                await interaction.editReply({ content: '⚠️ Kurulum etkileşimleri devre dışı bırakıldı. Lütfen web panelinden kurulum yapın.', components: [] });
                return;
            }

            // Button interaction handling continues below
            switch (customId) {
                case 'view_profile':
                    await interaction.deferUpdate();
                    const { handleProfilCommand } = require('./modules/commands/user');
                    await handleProfilCommand({
                        author: { id: userId, username: interaction.user.username, displayAvatarURL: () => interaction.user.displayAvatarURL() },
                        guild: { id: guildId, iconURL: interaction.guild.iconURL, members: { fetch: (id) => interaction.guild.members.fetch(id) } },
                        reply: async (content) => {
                            await interaction.editReply(content);
                        }
                    });
                    break;

                case 'view_store':
                    await interaction.reply({
                        content: '🛒 Mağaza özelliği yakında eklenecek!',
                        flags: 64 // Ephemeral flag
                    });
                    break;

                case 'edit_profile':
                    await interaction.reply({
                        content: '⚙️ Profil düzenleme özelliği yakında eklenecek!',
                        flags: 64 // Ephemeral flag
                    });
                    break;

                case 'earn_money':
                    await interaction.reply({
                        content: '💰 Para kazanmak için mesaj yazın veya ses kanalına katılın!',
                        flags: 64 // Ephemeral flag
                    });
                    break;

                case 'refresh_leaderboard':
                    await interaction.deferUpdate();
                    const { handleTopCommand } = require('./modules/commands/user');
                    await handleTopCommand({
                        author: { id: userId },
                        guild: { id: guildId, iconURL: interaction.guild.iconURL, members: { fetch: (id) => interaction.guild.members.fetch(id) } },
                        reply: async (content) => {
                            await interaction.editReply(content);
                        }
                    });
                    break;

                // setup-related interactive button flows removed — use web panel for setup
                // (Previously there were many `case 'setup_*'` handlers here; they were removed intentionally.)
                // Any `setup_` button will be short-circuited by the guard above.

            }

            // ─── Yüksek Ekonomi başvuru onay / ret butonları ───────────────
            if (customId.startsWith('economy_approve_') || customId.startsWith('economy_reject_')) {
                const isApprove = customId.startsWith('economy_approve_');
                const applicationId = isApprove
                    ? customId.replace('economy_approve_', '')
                    : customId.replace('economy_reject_', '');

                await interaction.deferUpdate();

                const { supabase } = require('./modules/database');

                // Başvuruyu çek
                const { data: application } = await supabase
                    .from('economy_tier_applications')
                    .select('id, guild_id, applicant_user_id, status, starter_package')
                    .eq('id', applicationId)
                    .maybeSingle();

                if (!application || application.status !== 'pending') {
                    await interaction.editReply({
                        content: '⚠️ Başvuru bulunamadı veya zaten işlenmiş.',
                        components: [],
                    });
                    return;
                }

                if (isApprove) {
                    // 1. Başvuruyu onayla
                    await supabase
                        .from('economy_tier_applications')
                        .update({
                            status: 'approved',
                            reviewed_by: interaction.user.id,
                            reviewed_at: new Date().toISOString(),
                        })
                        .eq('id', applicationId);

                    // 2. Sunucuyu advanced yap
                    await supabase
                        .from('servers')
                        .update({
                            economy_tier: 'advanced',
                            advanced_since: new Date().toISOString(),
                        })
                        .eq('discord_id', application.guild_id);

                    // 3. Tüm üyelerin bakiyelerini sıfırla
                    await supabase
                        .from('member_wallets')
                        .update({ balance: 0, updated_at: new Date().toISOString() })
                        .eq('guild_id', application.guild_id);

                    // 4. Hazine paketini yükle
                    const starterPackage = Number(application.starter_package ?? 0);
                    if (starterPackage > 0) {
                        const { data: existingTreasury } = await supabase
                            .from('server_treasury')
                            .select('balance, total_collected')
                            .eq('guild_id', application.guild_id)
                            .maybeSingle();

                        if (existingTreasury) {
                            await supabase
                                .from('server_treasury')
                                .update({
                                    balance: Number(existingTreasury.balance) + starterPackage,
                                    total_collected: Number(existingTreasury.total_collected) + starterPackage,
                                    updated_at: new Date().toISOString(),
                                })
                                .eq('guild_id', application.guild_id);
                        } else {
                            await supabase
                                .from('server_treasury')
                                .insert({
                                    guild_id: application.guild_id,
                                    balance: starterPackage,
                                    total_collected: starterPackage,
                                    updated_at: new Date().toISOString(),
                                });
                        }
                    }

                    // 5. Sunucuya bildirim gönder (sistem log kanalı)
                    try {
                        const { data: logChannelRow } = await supabase
                            .from('bot_log_channels')
                            .select('channel_id')
                            .eq('guild_id', application.guild_id)
                            .maybeSingle();

                        const notifyChannelId = logChannelRow?.channel_id;
                        if (notifyChannelId) {
                            await fetch(`https://discord.com/api/channels/${notifyChannelId}/messages`, {
                                method: 'POST',
                                headers: {
                                    Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                    embeds: [{
                                        title: '🔵 Yüksek Ekonomi Aktive Edildi',
                                        description: [
                                            'Sunucunuz **Yüksek Ekonomi** kademesine geçirildi.',
                                            '',
                                            '> Tüm üyelerin Papel bakiyeleri sıfırlandı.',
                                            starterPackage > 0
                                                ? `> Başlangıç hazine paketi yüklendi: **${starterPackage.toLocaleString('tr-TR')} Papel**`
                                                : '',
                                            '',
                                            'Artık her satın alımda belirlenen oranlarda hazineye ve yakma mekanizmasına katkı yapılacak.',
                                        ].filter(Boolean).join('\n'),
                                        color: 0x5865F2,
                                        timestamp: new Date().toISOString(),
                                    }],
                                }),
                            });
                        }
                    } catch (notifyErr) {
                        console.error('Economy tier notify failed:', notifyErr);
                    }

                    // Embed'i güncelle
                    // Log: onay
                    logToChannel(client, 'basvuru_onay', logEmbeds.onay({
                        type: 'Yüksek Ekonomi',
                        guildId: application.guild_id,
                        reviewerId: interaction.user.id,
                        detail: `Başlangıç paketi: ${starterPackage.toLocaleString('tr-TR')} Papel`,
                    }));

                    await interaction.editReply({
                        embeds: [{
                            title: '✅ Yüksek Ekonomi Onaylandı',
                            description: `Sunucu \`${application.guild_id}\` Yüksek Ekonomi kademesine geçirildi.\nBakiyeler sıfırlandı. Hazine paketi: **${starterPackage.toLocaleString('tr-TR')} Papel**`,
                            color: 0x57F287,
                            fields: [
                                { name: 'Onaylayan', value: `<@${interaction.user.id}>`, inline: true },
                                { name: 'Tarih', value: new Date().toLocaleDateString('tr-TR'), inline: true },
                            ],
                            timestamp: new Date().toISOString(),
                        }],
                        components: [],
                    });

                } else {
                    // Reddet
                    await supabase
                        .from('economy_tier_applications')
                        .update({
                            status: 'rejected',
                            reviewed_by: interaction.user.id,
                            reviewed_at: new Date().toISOString(),
                        })
                        .eq('id', applicationId);

                    // Log: ret
                    logToChannel(client, 'basvuru_red', logEmbeds.red({
                        type: 'Yüksek Ekonomi',
                        guildId: application.guild_id,
                        reviewerId: interaction.user.id,
                    }));

                    await interaction.editReply({
                        embeds: [{
                            title: '❌ Yüksek Ekonomi Başvurusu Reddedildi',
                            description: `Sunucu \`${application.guild_id}\` başvurusu reddedildi.`,
                            color: 0xED4245,
                            fields: [
                                { name: 'Reddeden', value: `<@${interaction.user.id}>`, inline: true },
                                { name: 'Tarih', value: new Date().toLocaleDateString('tr-TR'), inline: true },
                            ],
                            timestamp: new Date().toISOString(),
                        }],
                        components: [],
                    });
                }
                return;
            }
            // ────────────────────────────────────────────────────────────────

            // ─── IPO başvuru onay / ret butonları ────────────────────────────
            if (customId.startsWith('ipo_approve_') || customId.startsWith('ipo_reject_')) {
                const isApprove = customId.startsWith('ipo_approve_');
                const applicationId = isApprove
                    ? customId.replace('ipo_approve_', '')
                    : customId.replace('ipo_reject_', '');

                await interaction.deferUpdate();

                // Başvuruyu çek
                const { data: ipoApp } = await supabase
                    .from('ipo_applications')
                    .select('id, guild_id, applicant_user_id, status, proposed_price, proposed_founder_ratio, guild_stats_snapshot')
                    .eq('id', applicationId)
                    .maybeSingle();

                if (!ipoApp || ipoApp.status !== 'pending') {
                    await interaction.editReply({
                        content: '⚠️ IPO başvurusu bulunamadı veya zaten işlenmiş.',
                        components: [],
                    });
                    return;
                }

                if (isApprove) {
                    const founderLots = Math.round(1_000_000 * ipoApp.proposed_founder_ratio);
                    const publicLots = 1_000_000 - founderLots;

                    // 1. Başvuruyu onayla
                    await supabase
                        .from('ipo_applications')
                        .update({
                            status: 'approved',
                            reviewer_user_id: interaction.user.id,
                            reviewed_at: new Date().toISOString(),
                        })
                        .eq('id', applicationId);

                    // 2. server_listings kaydı oluştur
                    await supabase
                        .from('server_listings')
                        .insert({
                            guild_id: ipoApp.guild_id,
                            status: 'approved',
                            total_lots: 1_000_000,
                            founder_lots: founderLots,
                            public_lots: publicLots,
                            founder_user_id: ipoApp.applicant_user_id,
                            founder_vesting_start: new Date().toISOString(),
                            founder_vested_lots: 0,
                            base_price: ipoApp.proposed_price,
                            market_price: ipoApp.proposed_price,
                            ipo_price: ipoApp.proposed_price,
                            listed_at: new Date().toISOString(),
                        });

                    // 3. Founder'a lotlarını ver (investor_holdings)
                    await supabase
                        .from('investor_holdings')
                        .upsert({
                            user_id: ipoApp.applicant_user_id,
                            guild_id: ipoApp.guild_id,
                            lot_count: founderLots,
                            avg_buy_price: ipoApp.proposed_price,
                            updated_at: new Date().toISOString(),
                        }, { onConflict: 'user_id,guild_id' });

                    // 4. Sunucuya bildirim gönder
                    try {
                        const { data: logChannelRow } = await supabase
                            .from('bot_log_channels')
                            .select('channel_id')
                            .eq('guild_id', ipoApp.guild_id)
                            .maybeSingle();

                        if (logChannelRow?.channel_id) {
                            const serverName = ipoApp.guild_stats_snapshot?.server_name ?? ipoApp.guild_id;
                            await fetch(`https://discord.com/api/channels/${logChannelRow.channel_id}/messages`, {
                                method: 'POST',
                                headers: {
                                    Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                    embeds: [{
                                        title: '📈 IPO Onaylandı — Borsaya Hoş Geldiniz!',
                                        description: [
                                            `**${serverName}** artık yatırım borsasında listelendi!`,
                                            '',
                                            `> Başlangıç fiyatı: **${ipoApp.proposed_price.toLocaleString('tr-TR')} Papel/lot**`,
                                            `> Founder hissesi: **%${Math.round(ipoApp.proposed_founder_ratio * 100)}** (${founderLots.toLocaleString()} lot)`,
                                            `> Halka açık: **${publicLots.toLocaleString()} lot**`,
                                            '',
                                            'Web panelinden lotlarınızı alıp satabilirsiniz.',
                                        ].join('\n'),
                                        color: 0x57F287,
                                        timestamp: new Date().toISOString(),
                                    }],
                                }),
                            });
                        }
                    } catch (notifyErr) {
                        console.error('IPO notify failed:', notifyErr);
                    }

                    // Log: IPO onay
                    logToChannel(client, 'basvuru_onay', logEmbeds.onay({
                        type: 'IPO',
                        guildId: ipoApp.guild_id,
                        reviewerId: interaction.user.id,
                        detail: `Fiyat: ${ipoApp.proposed_price.toLocaleString()} Papel/lot · Founder: %${Math.round(ipoApp.proposed_founder_ratio * 100)}`,
                    }));

                    await interaction.editReply({
                        embeds: [{
                            title: '✅ IPO Onaylandı',
                            description: `Sunucu \`${ipoApp.guild_id}\` borsaya alındı. Fiyat: **${ipoApp.proposed_price.toLocaleString()} Papel/lot**`,
                            color: 0x57F287,
                            fields: [
                                { name: 'Onaylayan', value: `<@${interaction.user.id}>`, inline: true },
                                { name: 'Founder Lotları', value: founderLots.toLocaleString(), inline: true },
                                { name: 'Halka Açık Lotlar', value: publicLots.toLocaleString(), inline: true },
                            ],
                            timestamp: new Date().toISOString(),
                        }],
                        components: [],
                    });

                } else {
                    await supabase
                        .from('ipo_applications')
                        .update({
                            status: 'rejected',
                            reviewer_user_id: interaction.user.id,
                            reviewed_at: new Date().toISOString(),
                        })
                        .eq('id', applicationId);

                    // Log: IPO ret
                    logToChannel(client, 'basvuru_red', logEmbeds.red({
                        type: 'IPO',
                        guildId: ipoApp.guild_id,
                        reviewerId: interaction.user.id,
                    }));

                    await interaction.editReply({
                        embeds: [{
                            title: '❌ IPO Başvurusu Reddedildi',
                            description: `Sunucu \`${ipoApp.guild_id}\` IPO başvurusu reddedildi.`,
                            color: 0xED4245,
                            fields: [
                                { name: 'Reddeden', value: `<@${interaction.user.id}>`, inline: true },
                                { name: 'Tarih', value: new Date().toLocaleDateString('tr-TR'), inline: true },
                            ],
                            timestamp: new Date().toISOString(),
                        }],
                        components: [],
                    });
                }
                return;
            }
            // ────────────────────────────────────────────────────────────────

            // ────────────────────────────────────────────────────────────────

        } catch (error) {
            console.error('Button interaction hatası:', error);
            try {
                if (interaction.deferred) {
                    await interaction.followUp({ content: '❌ Bir hata oluştu.', ephemeral: true });
                } else if (!interaction.replied) {
                    await interaction.reply({ content: '❌ Bir hata oluştu.', ephemeral: true });
                }
            } catch { /* ignore */ }
        }
        return;
    }

    // ─── Destek select menu'leri ─────────────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
        const { customId } = interaction;
        const isBug        = customId.startsWith('bugreport_select_');
        const isSuggestion = customId.startsWith('suggestion_select_');
        if (!isBug && !isSuggestion) return;

        try {
        await interaction.deferReply({ ephemeral: true });
            const reportId = customId.replace('bugreport_select_', '').replace('suggestion_select_', '');
            const newStatus = interaction.values[0];

            const { supabase } = require('./modules/database');

            const { data: report } = await supabase
                .from('bug_reports')
                .select('id, user_id, type, section, description, channel_id, message_id')
                .eq('id', reportId)
                .maybeSingle();

            if (!report) {
                await interaction.editReply({ content: '⚠️ Rapor bulunamadı.' });
                return;
            }

            await supabase
                .from('bug_reports')
                .update({ status: newStatus, updated_at: new Date().toISOString() })
                .eq('id', reportId);

            const STATUS_MAP = {
                reviewing:     { color: 0xF0A500, badge: '🔍 İnceleniyor' },
                need_info:     { color: 0x5865F2, badge: '💬 Bilgi Gerekiyor' },
                critical:      { color: 0xFF0000, badge: '⚠️ Kritik' },
                fixed_pending: { color: 0x00CED1, badge: '🔧 Deploy Bekleniyor' },
                resolved:      { color: 0x57F287, badge: isBug ? '✅ Çözüldü' : '✅ Kabul Edildi' },
                not_found:     { color: 0xED4245, badge: isBug ? '❌ Tespit Edilemedi' : '❌ Reddedildi' },
                duplicate:     { color: 0x99AAB5, badge: isBug ? '🔁 Bilinen Sorun' : '🔁 Zaten Mevcut' },
                invalid:       { color: 0x747F8D, badge: isBug ? '🚫 Geçersiz' : '🚫 Kapsam Dışı' },
                planned_next:  { color: 0x00CED1, badge: '🎯 Sonraki Sürüme Alındı' },
                long_term:     { color: 0x9B59B6, badge: '⏳ Uzun Vadeli' },
            };

            const cfg = STATUS_MAP[newStatus] ?? { color: 0x747F8D, badge: newStatus };
            const sectionLabel = report.section ? ` [${report.section}]` : '';
            const updatedEmbed = {
                title: isBug
                    ? `🐛 Hata Bildirimi${sectionLabel} — ${cfg.badge}`
                    : `💡 Öneri${sectionLabel} — ${cfg.badge}`,
                color: cfg.color,
                description: report.description,
                timestamp: new Date().toISOString(),
                footer: { text: `DiscoWeb Destek · User: ${report.user_id} · ${interaction.user.tag}` },
            };

            const bugOptions = [
                { label: '🔍 İnceleniyor',          value: 'reviewing',     description: 'Ekip incelemeye aldı' },
                { label: '💬 Bilgi Gerekiyor',       value: 'need_info',     description: 'Daha fazla bilgi isteniyor' },
                { label: '⚠️ Kritik',               value: 'critical',      description: 'Öncelikli ele alınacak' },
                { label: '🔧 Deploy Bekleniyor',     value: 'fixed_pending', description: 'Düzeltildi, yayınlanacak' },
                { label: '✅ Çözüldü',               value: 'resolved',      description: 'Sorun giderildi' },
                { label: '❌ Tespit Edilemedi',      value: 'not_found',     description: 'Üretilemedi' },
                { label: '🔁 Bilinen Sorun',         value: 'duplicate',     description: 'Zaten takip ediliyor' },
                { label: '🚫 Geçersiz',              value: 'invalid',       description: 'Alakasız veya spam' },
            ];
            const suggestionOptions = [
                { label: '🔍 İnceleniyor',           value: 'reviewing',     description: 'Ekip değerlendiriyor' },
                { label: '💬 Detay Gerekiyor',       value: 'need_info',     description: 'Daha fazla açıklama isteniyor' },
                { label: '🎯 Sonraki Sürüme Alındı', value: 'planned_next',  description: 'Yakında eklenecek' },
                { label: '⏳ Uzun Vadeli',           value: 'long_term',     description: 'Uzun vadede düşünülüyor' },
                { label: '✅ Kabul Edildi',           value: 'resolved',      description: 'Eklenecek' },
                { label: '❌ Reddedildi',            value: 'not_found',     description: 'Şimdilik planlanmıyor' },
                { label: '🔁 Zaten Mevcut',          value: 'duplicate',     description: 'Bu özellik zaten var' },
                { label: '🚫 Kapsam Dışı',           value: 'invalid',       description: 'Projenin odağıyla uyuşmuyor' },
            ];

            const DISCORD_BOT_TOKEN = config.discordToken;
            if (report.message_id && DISCORD_BOT_TOKEN) {
                await fetch(
                    `https://discord.com/api/v10/channels/${report.channel_id}/messages/${report.message_id}`,
                    {
                        method: 'PATCH',
                        headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            embeds: [updatedEmbed],
                            components: [{
                                type: 1,
                                components: [{
                                    type: 3,
                                    custom_id: customId,
                                    placeholder: '⚙️ Durumu güncelle...',
                                    options: isBug ? bugOptions : suggestionOptions,
                                }],
                            }],
                        }),
                    }
                );
            }

            await interaction.editReply({ content: `✅ Durum **${cfg.badge}** olarak güncellendi.` });
        } catch (err) {
            console.error('Select menu interaction hatası:', err);
            try {
                if (interaction.deferred) await interaction.followUp({ content: '❌ Bir hata oluştu.', ephemeral: true });
                else if (!interaction.replied) await interaction.reply({ content: '❌ Bir hata oluştu.', ephemeral: true });
            } catch { /* ignore */ }
        }
        return;
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const userId = interaction.user.id;
    const username = interaction.user.username;
    const guildId = interaction.guildId;

    try {
        await interaction.deferReply();
        
        switch (commandName) {
            case 'dev-setup-logs': {
                const DEVELOPER_ID = process.env.DEVELOPER_DISCORD_USER_ID;
                if (!DEVELOPER_ID || interaction.user.id !== DEVELOPER_ID) {
                    await interaction.editReply({ content: '❌ Bu komut yalnızca developer tarafından kullanılabilir.' });
                    return;
                }

                const categoryId = interaction.options.getString('kategori_id');

                const LOG_CHANNELS = [
                    // Başvurular
                    { key: 'basvuru_ekonomi',   name: 'basvuru-ekonomi',       topic: 'Yüksek Ekonomi başvuruları — onay/ret butonları' },
                    { key: 'basvuru_ipo',        name: 'basvuru-ipo',           topic: 'IPO başvuruları — onay/ret butonları' },
                    { key: 'basvuru_onay',       name: 'basvuru-onay',          topic: 'Onaylanan tüm başvurular (ekonomi + IPO)' },
                    { key: 'basvuru_red',        name: 'basvuru-red',           topic: 'Reddedilen tüm başvurular + gerekçe' },
                    // Borsa işlemleri
                    { key: 'borsa_trades',       name: 'borsa-islemler',        topic: 'Gerçekleşen alım-satım trade\'leri' },
                    { key: 'borsa_emirler',      name: 'borsa-emirler',         topic: 'Açılan / iptal edilen / süresi dolan emirler' },
                    { key: 'circuit_breaker',    name: 'circuit-breaker',       topic: 'Circuit breaker tetiklendi / kalktı' },
                    { key: 'buyuk_islemler',     name: 'buyuk-islemler',        topic: 'Büyük hacimli işlemler (eşik üzeri)' },
                    { key: 'suphe_log',          name: 'suphe-log',             topic: 'Wash trading girişimleri ve şüpheli aktiviteler' },
                    // Hazine & Ekonomi
                    { key: 'hazine_giris',       name: 'hazine-giris',          topic: 'Satın alımdan gelen burn + treasury kesintileri' },
                    { key: 'hazine_cikis',       name: 'hazine-cikis',          topic: 'Referral, temettü, delist tasfiyesi ödemeleri' },
                    { key: 'temetu_haftalik',    name: 'temetu-haftalik',       topic: 'Haftalık cron temettü dağıtımı özeti' },
                    { key: 'halving_log',        name: 'halving-log',           topic: 'Earn multiplier ve halving değişimleri' },
                    // Referral
                    { key: 'referral_aktivasyon', name: 'referral-aktivasyon', topic: 'Referral kodu kullanıldı / aktive oldu' },
                    { key: 'referral_odeme',     name: 'referral-odeme',        topic: 'Haftalık pasif gelir ödemeleri / pending' },
                    // Yönetim
                    { key: 'ceza_log',           name: 'ceza-log',              topic: 'Ceza verildi / kaldırıldı / delist kararları' },
                    { key: 'piyasa_olaylari',    name: 'piyasa-olaylari',       topic: 'Market event oluşturuldu / kapandı' },
                    { key: 'freeze_log',         name: 'freeze-log',            topic: 'Global freeze açıldı / kapandı' },
                    // Sistem
                    { key: 'cron_sonuclar',      name: 'cron-sonuclar',         topic: 'Haftalık cron job özetleri' },
                    { key: 'sistem_hatalar',     name: 'sistem-hatalar',        topic: 'API hataları ve kritik exception\'lar' },
                ];

                await interaction.editReply({ content: `⏳ ${LOG_CHANNELS.length} kanal oluşturuluyor...` });

                const createdChannels = [];
                const failedChannels = [];

                for (const ch of LOG_CHANNELS) {
                    try {
                        const created = await interaction.guild.channels.create({
                            name: ch.name,
                            type: 0, // GUILD_TEXT
                            parent: categoryId,
                            topic: ch.topic,
                            permissionOverwrites: [
                                {
                                    id: interaction.guild.roles.everyone.id,
                                    deny: ['SendMessages', 'AddReactions', 'CreatePublicThreads'],
                                    allow: ['ViewChannel', 'ReadMessageHistory'],
                                },
                            ],
                        });
                        createdChannels.push({ key: ch.key, name: ch.name, id: created.id });

                        // app_config'e kaydet
                        await supabase.from('app_config').upsert(
                            { key: `log_channel_${ch.key}`, value: created.id },
                            { onConflict: 'key' }
                        );

                        // bot_log_channels'a kaydet (sendLog/logToChannel buraya bakıyor)
                        await supabase.from('bot_log_channels').upsert(
                            {
                                guild_id: interaction.guild.id,
                                channel_type: ch.key,
                                channel_id: created.id,
                                is_active: true,
                            },
                            { onConflict: 'guild_id,channel_type' }
                        );
                    } catch (err) {
                        console.error(`Kanal oluşturma hatası (${ch.name}):`, err);
                        failedChannels.push(ch.name);
                    }
                }

                const lines = createdChannels.map(c => `<#${c.id}> \`${c.key}\``);
                const embed = {
                    title: '✅ Log Kanalları Oluşturuldu',
                    description: lines.join('\n'),
                    color: 0x57F287,
                    fields: failedChannels.length > 0
                        ? [{ name: '❌ Başarısız', value: failedChannels.join(', ') }]
                        : [{ name: 'Durum', value: 'Tüm kanallar başarıyla oluşturuldu ve DB\'ye kaydedildi.' }],
                    footer: { text: `Kategori: ${categoryId}` },
                    timestamp: new Date().toISOString(),
                };

                clearLogCache(); // Yeni kanal ID'leri hemen aktif olsun
                await interaction.editReply({ content: '', embeds: [embed] });
                return;
            }

            default:
                await interaction.reply('❌ Bilinmeyen komut!');
        }
    } catch (error) {
        console.error('Slash komut hatası:', error);

        // Interaction'a zaten yanıt verilmiş mi kontrol et
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: '❌ Komut çalıştırılırken bir hata oluştu!', flags: 64 });
        } else {
            await interaction.reply({ content: '❌ Komut çalıştırılırken bir hata oluştu!', flags: 64 });
        }
    }
});

// Yardım metni oluşturma fonksiyonu
const generateHelpText = () => {
    const helpText = `🤖 **Disc Nexus Bot**\n\n`
        + `Bu bot aktivite takibi ve ekonomi sistemi için bir izleyici/aracı olarak çalışır.\n`
        + `Tüm yönetim işlemleri web paneli üzerinden yapılır.\n\n`
        + `🌐 **Web Panel:** ${process.env.WEB_URL || 'http://localhost:3000'}`;
    return { content: helpText, flags: 0 };
};

// Log gönderme fonksiyonu (kanal üzerinden — components/buton destekli)
async function sendLog(guildId, channelType, embed, components = []) {
    try {
        const { data: logChannel } = await supabase
            .from('bot_log_channels')
            .select('channel_id')
            .eq('guild_id', guildId)
            .eq('channel_type', channelType)
            .eq('is_active', true)
            .maybeSingle();

        if (!logChannel) return;

        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;

        const channel = guild.channels.cache.get(logChannel.channel_id);
        if (!channel) return;

        const payload = { embeds: [embed] };
        if (components.length > 0) payload.components = components;

        await channel.send(payload);
    } catch (error) {
        console.error('Log gönderme hatası:', error);
    }
}

// ─── LOG YARDIMCILARI ─────────────────────────────────────────────────────────

// "Profili Görüntüle" link butonu — 3+ yerde kullanıldığı için tek yer
function profileButtonRow(userId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Profili Görüntüle')
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/users/${userId}`)
            .setEmoji('👤')
    );
}

// Audit log'dan yetkiliyi çek (ban/unban ortak kodu)
async function fetchAuditEntry(guild, auditType, targetId) {
    try {
        const logs  = await guild.fetchAuditLogs({ type: auditType, limit: 1 });
        const entry = logs.entries.first();
        if (entry && entry.target?.id === targetId) return entry;
    } catch { /* audit log erişimi yoksa atla */ }
    return null;
}

// ─── ÜYE GİRİŞ LOGU ──────────────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
    if (member.user?.bot) return;
    const user = member.user;
    const accountAgeDays = Math.floor((Date.now() - user.createdTimestamp) / 86_400_000);
    const isNewAccount = accountAgeDays < 7;

    const embed = new EmbedBuilder()
        .setAuthor({
            name: `${formatUser(user)} sunucuya katıldı`,
            iconURL: user.displayAvatarURL({ dynamic: true, size: 128 }),
        })
        .setColor(isNewAccount ? '#FEE75C' : '#57F287')
        .setDescription(isNewAccount
            ? `> ⚠️ **Şüpheli hesap!** Bu hesap yalnızca **${accountAgeDays}** gün önce oluşturuldu.\n\n<@${user.id}> sunucuya katıldı.`
            : `<@${user.id}> aramıza katıldı! Hoş geldin 🎉`)
        .addFields(
            { name: '👤 Kullanıcı',          value: `<@${user.id}>\n\`${formatUser(user)}\``,          inline: true },
            { name: '🆔 ID',                  value: `\`${user.id}\``,                                       inline: true },
            { name: '📅 Hesap Yaşı',          value: `${accountAgeDays} gün`,                                inline: true },
            { name: '🗓️ Hesap Açılış',       value: `<t:${Math.floor(user.createdTimestamp / 1000)}:F>`,   inline: true },
            { name: '🏠 Toplam Üye',          value: `**${member.guild.memberCount}** üye`,                  inline: true },
        )
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setFooter({ text: '📥 Üye Girişi', iconURL: member.guild.iconURL() })
        .setTimestamp();

    await sendLog(member.guild.id, 'auth', embed, [profileButtonRow(user.id)]);
});

// ─── ÜYE ÇIKIŞ LOGU ──────────────────────────────────────────────────────────
client.on('guildMemberRemove', async (member) => {
    if (member.user?.bot) return;
    const user = member.user;
    const timeInServer = member.joinedAt
        ? Math.floor((Date.now() - member.joinedAt.getTime()) / 86_400_000)
        : null;

    const roles = member.roles?.cache
        ?.filter(r => r.id !== member.guild.id)
        ?.map(r => `<@&${r.id}>`)
        ?.join(' ') || '*Rol yok*';

    const embed = new EmbedBuilder()
        .setAuthor({
            name: `${formatUser(user)} sunucudan ayrıldı`,
            iconURL: user.displayAvatarURL({ dynamic: true, size: 128 }),
        })
        .setColor('#ED4245')
        .setDescription(`<@${user.id}> sunucudan ayrıldı.`)
        .addFields(
            { name: '👤 Kullanıcı',        value: `\`${formatUser(user)}\``,    inline: true },
            { name: '🆔 ID',               value: `\`${user.id}\``,                 inline: true },
            ...(timeInServer !== null
                ? [{ name: '⏱️ Sunucuda Kalış', value: `${timeInServer} gün`,      inline: true }]
                : []),
            { name: '🎭 Sahip Olduğu Roller', value: truncate(roles, 512),     inline: false },
        )
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setFooter({ text: '📤 Üye Çıkışı', iconURL: member.guild.iconURL() })
        .setTimestamp();

    await sendLog(member.guild.id, 'auth', embed, [profileButtonRow(user.id)]);
});

// ─── ROL / TAKMAİSİM DEĞİŞİKLİK LOGU ────────────────────────────────────────
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (newMember.user?.bot) return;
    const user = newMember.user;

    const oldRoles = oldMember.roles.cache;
    const newRoles = newMember.roles.cache;

    // Rol eklendi
    const addedRoles = [...newRoles.filter(role => !oldRoles.has(role.id)).values()];
    if (addedRoles.length > 0) {
        const roleList = addedRoles.map(r => `<@&${r.id}> — \`${r.name}\``).join('\n');
        const embed = new EmbedBuilder()
            .setAuthor({
                name: `${formatUser(user)} — Rol Eklendi`,
                iconURL: user.displayAvatarURL({ dynamic: true, size: 128 }),
            })
            .setColor('#5865F2')
            .setDescription(`<@${user.id}> kullanıcısına **${addedRoles.length}** yeni rol eklendi.`)
            .addFields(
                { name: '👤 Kullanıcı',     value: `<@${user.id}>`,                    inline: true },
                { name: '🆔 ID',            value: `\`${user.id}\``,                    inline: true },
                { name: '➕ Eklenen Roller', value: truncate(roleList, 512),        inline: false },
            )
            .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
            .setFooter({ text: '🎭 Rol Yönetimi', iconURL: newMember.guild.iconURL() })
            .setTimestamp();

        await sendLog(newMember.guild.id, 'roles', embed);
    }

    // Rol çıkarıldı
    const removedRoles = [...oldRoles.filter(role => !newRoles.has(role.id)).values()];
    if (removedRoles.length > 0) {
        const roleList = removedRoles.map(r => `<@&${r.id}> — \`${r.name}\``).join('\n');
        const embed = new EmbedBuilder()
            .setAuthor({
                name: `${formatUser(user)} — Rol Çıkarıldı`,
                iconURL: user.displayAvatarURL({ dynamic: true, size: 128 }),
            })
            .setColor('#FFA500')
            .setDescription(`<@${user.id}> kullanıcısından **${removedRoles.length}** rol çıkarıldı.`)
            .addFields(
                { name: '👤 Kullanıcı',        value: `<@${user.id}>`,             inline: true },
                { name: '🆔 ID',               value: `\`${user.id}\``,             inline: true },
                { name: '➖ Çıkarılan Roller', value: truncate(roleList, 512), inline: false },
            )
            .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
            .setFooter({ text: '🎭 Rol Yönetimi', iconURL: newMember.guild.iconURL() })
            .setTimestamp();

        await sendLog(newMember.guild.id, 'roles', embed);
    }

    // Takma ad değişikliği
    if (oldMember.nickname !== newMember.nickname) {
        const embed = new EmbedBuilder()
            .setAuthor({
                name: `${formatUser(user)} — Takma Ad Değişti`,
                iconURL: user.displayAvatarURL({ dynamic: true, size: 128 }),
            })
            .setColor('#5865F2')
            .setDescription(`<@${user.id}> kullanıcısının sunucu takma adı değiştirildi.`)
            .addFields(
                { name: '👤 Kullanıcı', value: `<@${user.id}>`,              inline: true },
                { name: '🆔 ID',        value: `\`${user.id}\``,              inline: true },
                { name: '📝 Önceki Ad', value: oldMember.nickname || '*Yok*', inline: true },
                { name: '✏️ Yeni Ad',  value: newMember.nickname || '*Yok*', inline: true },
            )
            .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
            .setFooter({ text: '✏️ Takma Ad Değişikliği', iconURL: newMember.guild.iconURL() })
            .setTimestamp();

        await sendLog(newMember.guild.id, 'roles', embed);
    }
});

// ─── MESAJ SİLME LOGU ────────────────────────────────────────────────────────
client.on('messageDelete', async (message) => {
    if (!message.author || message.author.bot) return;
    const user = message.author;
    const content = truncate(message.content || '*İçerik önbellekte yok*', 900);
    const attachmentCount = message.attachments?.size || 0;

    const embed = new EmbedBuilder()
        .setAuthor({
            name: `${formatUser(user)} — Mesaj Silindi`,
            iconURL: user.displayAvatarURL({ dynamic: true, size: 128 }),
        })
        .setColor('#ED4245')
        .setDescription(`📍 <#${message.channel.id}> kanalında bir mesaj silindi.`)
        .addFields(
            { name: '👤 Yazar',    value: `<@${user.id}> — \`${formatUser(user)}\``, inline: true },
            { name: '📺 Kanal',   value: `<#${message.channel.id}>`,                    inline: true },
            { name: '🆔 Mesaj ID', value: `\`${message.id}\``,                           inline: true },
            { name: '🗑️ İçerik', value: `\`\`\`${content}\`\`\``,                      inline: false },
            ...(attachmentCount > 0
                ? [{ name: '📎 Ekler', value: `${attachmentCount} dosya silindi`, inline: true }]
                : []),
        )
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setFooter({ text: '🗑️ Mesaj Silindi', iconURL: message.guild?.iconURL?.() })
        .setTimestamp();

    await sendLog(message.guild.id, 'suspicious', embed);
});

// ─── MESAJ DÜZENLEME LOGU ─────────────────────────────────────────────────────
client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (!newMessage.author || newMessage.author.bot) return;
    if (oldMessage.content === newMessage.content) return;
    const user = newMessage.author;
    const before = truncate(oldMessage.content || '*Önceki içerik önbellekte yok*', 450);
    const after  = truncate(newMessage.content || '*İçerik yok*', 450);

    const embed = new EmbedBuilder()
        .setAuthor({
            name: `${formatUser(user)} — Mesaj Düzenlendi`,
            iconURL: user.displayAvatarURL({ dynamic: true, size: 128 }),
        })
        .setColor('#FEE75C')
        .setDescription(`📍 <#${newMessage.channel.id}> kanalında bir mesaj düzenlendi.`)
        .addFields(
            { name: '👤 Yazar',            value: `<@${user.id}> — \`${formatUser(user)}\``, inline: true },
            { name: '📺 Kanal',            value: `<#${newMessage.channel.id}>`,                 inline: true },
            { name: '🆔 Mesaj ID',         value: `\`${newMessage.id}\``,                         inline: true },
            { name: '📄 Önceki İçerik',   value: `\`\`\`${before}\`\`\``,                        inline: false },
            { name: '✏️ Güncel İçerik',  value: `\`\`\`${after}\`\`\``,                         inline: false },
        )
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setFooter({ text: '✏️ Mesaj Düzenlendi', iconURL: newMessage.guild?.iconURL?.() })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Mesaja Git')
            .setStyle(ButtonStyle.Link)
            .setURL(newMessage.url)
            .setEmoji('🔗')
    );

    await sendLog(newMessage.guild.id, 'suspicious', embed, [row]);
});

// ─── ADMIN KOMUT LOGU (slash komutları) ──────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const adminCommands = ['magazaekle', 'magazasil', 'promokod', 'bakim', 'logkanal', 'logkur'];

    if (adminCommands.includes(commandName)) {
        const user = interaction.user;

        const options = [];
        interaction.options?.data?.forEach(opt => {
            options.push(`\`${opt.name}\`: ${opt.value ?? '*-*'}`);
        });

        const embed = new EmbedBuilder()
            .setAuthor({
                name: `${formatUser(user)} — Admin Komutu`,
                iconURL: user.displayAvatarURL({ dynamic: true, size: 128 }),
            })
            .setColor('#E74C3C')
            .setDescription(`\`/${commandName}\` komutu kullanıldı.`)
            .addFields(
                { name: '👑 Kullanıcı', value: `<@${user.id}>`,                                       inline: true },
                { name: '📺 Kanal',     value: `<#${interaction.channel?.id ?? '0'}>`,                 inline: true },
                { name: '📋 Komut',     value: `\`/${commandName}\``,                                  inline: true },
                ...(options.length ? [{ name: '⚙️ Parametreler', value: options.join('\n'),           inline: false }] : []),
            )
            .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
            .setFooter({ text: '⚡ Admin Komutu', iconURL: interaction.guild?.iconURL?.() })
            .setTimestamp();

        await sendLog(interaction.guild.id, 'admin', embed);
    }
});

// ─── BAN / UNBAN LOGU ────────────────────────────────────────────────────────
client.on('guildBanAdd', async (ban) => {
    const user   = ban.user;
    const entry  = await fetchAuditEntry(ban.guild, 22 /* GuildBanAdd */, user.id);
    const reason = entry?.reason || ban.reason || '*Sebep belirtilmedi*';

    const embed = new EmbedBuilder()
        .setAuthor({ name: `${formatUser(user)} banlandı`, iconURL: user.displayAvatarURL({ dynamic: true, size: 128 }) })
        .setColor('#ED4245')
        .setDescription(`🔨 <@${user.id}> sunucudan **kalıcı olarak banlandı**.`)
        .addFields(
            { name: '👤 Kullanıcı', value: `\`${formatUser(user)}\``, inline: true },
            { name: '🆔 ID',        value: `\`${user.id}\``,           inline: true },
            ...(entry?.executor ? [{ name: '🛡️ Yetkili', value: `<@${entry.executor.id}>`, inline: true }] : []),
            { name: '📋 Sebep',     value: reason,                     inline: false },
        )
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setFooter({ text: '🔨 Ban İşlemi', iconURL: ban.guild.iconURL() })
        .setTimestamp();

    await sendLog(ban.guild.id, 'auth', embed);
});

client.on('guildBanRemove', async (ban) => {
    const user  = ban.user;
    const entry = await fetchAuditEntry(ban.guild, 23 /* GuildBanRemove */, user.id);

    const embed = new EmbedBuilder()
        .setAuthor({ name: `${formatUser(user)} kullanıcısının banı kaldırıldı`, iconURL: user.displayAvatarURL({ dynamic: true, size: 128 }) })
        .setColor('#57F287')
        .setDescription(`✅ <@${user.id}> kullanıcısının **banı kaldırıldı**.`)
        .addFields(
            { name: '👤 Kullanıcı', value: `\`${formatUser(user)}\``, inline: true },
            { name: '🆔 ID',        value: `\`${user.id}\``,           inline: true },
            ...(entry?.executor ? [{ name: '🛡️ Yetkili', value: `<@${entry.executor.id}>`, inline: true }] : []),
        )
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
        .setFooter({ text: '✅ Ban Kaldırma', iconURL: ban.guild.iconURL() })
        .setTimestamp();

    await sendLog(ban.guild.id, 'auth', embed);
});

// ─── SES KANALI GİRİŞ / ÇIKIŞ LOGU ──────────────────────────────────────────
client.on('voiceStateUpdate', async (oldState, newState) => {
    const member = newState.member ?? oldState.member;
    if (!member || member.user?.bot) return;

    const joinedChannel  = !oldState.channel && newState.channel;
    const leftChannel    = oldState.channel && !newState.channel;
    const switchedChannel = oldState.channel && newState.channel && oldState.channelId !== newState.channelId;

    if (joinedChannel) {
        const ch = newState.channel;
        const embed = new EmbedBuilder()
            .setAuthor({
                name: `${formatUser(member.user)} — Ses Kanalına Katıldı`,
                iconURL: member.user.displayAvatarURL({ dynamic: true, size: 128 }),
            })
            .setColor('#00BCD4')
            .setDescription(`🔊 <@${member.user.id}> **${ch.name}** kanalına bağlandı.`)
            .addFields(
                { name: '👤 Kullanıcı',        value: `<@${member.user.id}>`, inline: true },
                { name: '🔊 Kanal',            value: `**${ch.name}**`,       inline: true },
                { name: '👥 Kanalda Bulunan',  value: `${ch.members.size} kişi`, inline: true },
            )
            .setFooter({ text: '🔊 Ses Kanalı Girişi', iconURL: newState.guild.iconURL() })
            .setTimestamp();

        await sendLog(newState.guild.id, 'main', embed);

    } else if (leftChannel) {
        const ch = oldState.channel;
        const embed = new EmbedBuilder()
            .setAuthor({
                name: `${formatUser(member.user)} — Ses Kanalından Ayrıldı`,
                iconURL: member.user.displayAvatarURL({ dynamic: true, size: 128 }),
            })
            .setColor('#607D8B')
            .setDescription(`🔇 <@${member.user.id}> **${ch.name}** kanalından ayrıldı.`)
            .addFields(
                { name: '👤 Kullanıcı', value: `<@${member.user.id}>`, inline: true },
                { name: '🔊 Kanal',     value: `**${ch.name}**`,       inline: true },
            )
            .setFooter({ text: '🔇 Ses Kanalı Çıkışı', iconURL: oldState.guild.iconURL() })
            .setTimestamp();

        await sendLog(oldState.guild.id, 'main', embed);

    } else if (switchedChannel) {
        const from = oldState.channel;
        const to   = newState.channel;
        const embed = new EmbedBuilder()
            .setAuthor({
                name: `${formatUser(member.user)} — Ses Kanalı Değiştirdi`,
                iconURL: member.user.displayAvatarURL({ dynamic: true, size: 128 }),
            })
            .setColor('#00BCD4')
            .setDescription(`🔀 <@${member.user.id}> ses kanalını değiştirdi.`)
            .addFields(
                { name: '👤 Kullanıcı',   value: `<@${member.user.id}>`, inline: true },
                { name: '📤 Önceki',      value: `**${from.name}**`,     inline: true },
                { name: '📥 Yeni',        value: `**${to.name}**`,       inline: true },
            )
            .setFooter({ text: '🔀 Kanal Değişikliği', iconURL: newState.guild.iconURL() })
            .setTimestamp();

        await sendLog(newState.guild.id, 'main', embed);
    }
});

// Botu Başlat
client.login(config.discordToken);
