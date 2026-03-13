// 1. Modülleri Çağır
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const express = require('express');
const config = require('./modules/config');
const { supabase, getGuild, getMaintenanceStatus } = require('./modules/database');
const { processStoreOrders, processPendingOrdersAtMidnight } = require('./modules/store');
const { processVoiceEarnings, addDailyEarning, processDailySettlement } = require('./modules/earnings');
const { handleMessage } = require('./modules/commands');
const { logSystemError } = require('./modules/errorHandler');
const permissionCache = require('./modules/permissionCache');
const mailTemplates = require('./modules/mailTemplates');
const { sendSystemMail } = require('./modules/notifications');
const { formatUser, truncate } = require('./modules/logger');

// Sistem hatalarını yakala ve sadece developer kanalına gönder
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    logSystemError(client, error, { location: 'uncaughtException' });
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    logSystemError(client, new Error(String(reason)), { location: 'unhandledRejection' });
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

// Slash komutları için komut listesi
const commands = [
    // `setup` komutu artık web paneline taşındı — bot üzerinden komutla kurulmaz.

    new SlashCommandBuilder()
        .setName('logkanali')
        .setDescription('Log kanallarını ayarla (Admin)')
        .addChannelOption(option =>
            option.setName('log_kanal')
                .setDescription('Genel log kanalı')
                .setRequired(false))
        .addChannelOption(option =>
            option.setName('sistem_log_kanal')
                .setDescription('Sistem log kanalı (bot hataları için)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('logkur')
        .setDescription('Otomatik log sistemi kur (Admin)')
        .addBooleanOption(option =>
            option.setName('onay')
                .setDescription('Log sistemini kurmak istediğinize emin misiniz?')
                .setRequired(true)),

    // Admin komutları
    new SlashCommandBuilder()
        .setName('magazaekle')
        .setDescription('Mağaza ürünü ekle (Admin)')
        .addStringOption(option =>
            option.setName('urun_adi')
                .setDescription('Ürün adı')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('fiyat')
                .setDescription('Ürün fiyatı')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('sure')
                .setDescription('Geçerlilik süresi (gün)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('rol_id')
                .setDescription('Discord rol ID\'si')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('aciklama')
                .setDescription('Ürün açıklaması')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('magazasil')
        .setDescription('Mağaza ürünü kaldır (Admin)')
        .addStringOption(option =>
            option.setName('urun_id')
                .setDescription('Ürün ID\'si')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('promokod')
        .setDescription('Promosyon kodu oluştur (Admin)')
        .addStringOption(option =>
            option.setName('kod')
                .setDescription('Promosyon kodu')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('indirim')
                .setDescription('İndirim yüzdesi (1-100)')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('bitis_tarihi')
                .setDescription('Bitiş tarihi (YYYY-MM-DD)')
                .setRequired(false)),

    new SlashCommandBuilder()
        .setName('bakim')
        .setDescription('Bakım modu kontrolü (Admin)')
        .addStringOption(option =>
            option.setName('islem')
                .setDescription('İşlem türü')
                .setRequired(true)
                .addChoices(
                    { name: 'Aç', value: 'ac' },
                    { name: 'Kapat', value: 'kapat' },
                    { name: 'Durum', value: 'durum' }
                )),

    new SlashCommandBuilder()
        .setName('deep-clean')
        .setDescription('Sunucu verilerini derinlemesine temizle (Admin - TEHLİKELİ)')
        .addStringOption(option =>
            option.setName('onay')
                .setDescription('Onay için "EVET_SIL" yazın')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('kurulum-kaldir')
        .setDescription('Kurulumu kaldır ve tüm verileri temizle (Admin)')
        .addStringOption(option =>
            option.setName('onay')
                .setDescription('Onay için "EVET_KURULUMU_KALDIR" yazın')
                .setRequired(true)),

    new SlashCommandBuilder()
        .setName('restore-data')
        .setDescription('Silinen verileri geri getir (Admin)')
        .addStringOption(option =>
            option.setName('veri_turu')
                .setDescription('Geri getirilecek veri türü')
                .setRequired(true)
                .addChoices(
                    { name: 'Kullanıcı Verileri', value: 'user_data' },
                    { name: 'Mağaza Verileri', value: 'store_data' },
                    { name: 'Tüm Veriler', value: 'all_data' }
                ))
        .addStringOption(option =>
            option.setName('kullanici_id')
                .setDescription('Belirli kullanıcı ID (opsiyonel)')
                .setRequired(false))
].map(command => command.toJSON());

// Bot presence güncelleme fonksiyonu
async function updateBotPresence(client) {
    try {
        const maintenanceStatus = await getMaintenanceStatus(config.guildId);
        
        let activityName, status;
        if (maintenanceStatus.isMaintenance) {
            activityName = maintenanceStatus.reason || 'Web hizmeti bakımda';
            status = 'dnd'; // Do Not Disturb
        } else {
            activityName = 'Akıllı Mağaza Sistemi | v.1.0';
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


// Slash komutlarını kaydetme fonksiyonu
const registerSlashCommands = async (guildId = null) => {
    try {
        const rest = new REST({ version: '10' }).setToken(config.discordToken);

        // Eğer guildId belirtilmemişse, config'deki guild'i kullan
        const targetGuildId = guildId || config.guildId;

        console.log(`🔄 Slash komutları ${guildId ? 'yeni sunucu için' : 'ana sunucu için'} kaydediliyor...`);

        await rest.put(
            Routes.applicationGuildCommands(config.clientId, targetGuildId),
            { body: commands }
        );

        console.log(`✅ Slash komutları ${guildId ? 'yeni sunucuya' : 'ana sunucuya'} başarıyla kaydedildi!`);
    } catch (error) {
        console.error('❌ Slash komutları kaydedilirken hata:', error);
    }
};

// Bot Hazır Olduğunda
client.once('ready', async () => {
    console.log('------------------------------------');
    console.log(`🤖 Bot ${client.user.tag} olarak giriş yaptı!`);
    console.log('🌍 Supabase bağlantısı hazır.');
    console.log(`🧩 Guild sayısı: ${client.guilds.cache.size}`);
    console.log(`🎯 Rol kontrolü: ${config.requiredRoleId}`);
    console.log('------------------------------------');

    // Tüm sunuculara slash komutlarını kaydet
    console.log('🔄 Tüm sunuculara slash komutları kaydediliyor...');
    const registerPromises = [];
    
    client.guilds.cache.forEach(async (guild) => {
        console.log(`📝 ${guild.name} (${guild.id}) sunucusuna komutlar kaydediliyor...`);
        registerPromises.push(registerSlashCommands(guild.id));
    });
    
    try {
        await Promise.all(registerPromises);
        console.log('✅ Tüm sunuculara slash komutları başarıyla kaydedildi!');
    } catch (error) {
        console.error('❌ Bazı sunuculara slash komutları kaydedilirken hata:', error);
    }

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

    try {
        await handleMessage(message, config, addDailyEarning);
    } catch (err) {
        console.error('handleMessage threw:', err);
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
// Bot yeni bir sunucuya eklendiğinde
client.on('guildCreate', async (guild) => {
    console.log(`🎉 Bot yeni sunucuya eklendi: ${guild.name} (${guild.id})`);
    
    try {
        // Yeni sunucuya slash komutlarını kaydet
        await registerSlashCommands(guild.id);
        console.log(`✅ Slash komutları ${guild.name} sunucusuna başarıyla kaydedildi!`);
    } catch (error) {
        console.error(`❌ ${guild.name} sunucusuna slash komutları kaydedilirken hata:`, error);
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
        } catch (error) {
            console.error('Button interaction hatası:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({
                    content: '❌ Buton etkileşimi sırasında bir hata oluştu.',
                    ephemeral: true
                });
            }
        }
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const userId = interaction.user.id;
    const username = interaction.user.username;
    const guildId = interaction.guildId;

    try {
        await interaction.deferReply();
        
        switch (commandName) {
            case 'setup':
                await interaction.editReply({ content: '❌ `/setup` komutu kaldırıldı — lütfen kurulum için web panelini kullanın.' });
                break;

            case 'ayarlar':
                // Ayarlar komutu - mevcut ayarları göster
                const { data: serverSettings } = await supabase
                    .from('servers')
                    .select('admin_role_id, verify_role_id, is_setup')
                    .eq('discord_id', guildId)
                    .maybeSingle();
                
                if (!serverSettings || !serverSettings.is_setup) {
                    await interaction.editReply({ content: '❌ Sunucu henüz kurulmamış! Lütfen kurulum için **web panelini** kullanın.' });
                    return;
                }
                
                const adminRoleObj = interaction.guild.roles.cache.get(serverSettings.admin_role_id);
                const verifyRoleObj = interaction.guild.roles.cache.get(serverSettings.verify_role_id);
                
                await interaction.editReply({ 
                    content: `⚙️ **Sunucu Ayarları**\n\n🔧 **Admin Rol:** ${adminRoleObj || 'Bulunamadı'}\n✅ **Verify Rol:** ${verifyRoleObj || 'Bulunamadı'}\n📊 **Durum:** ${serverSettings.is_setup ? '✅ Kurulmuş' : '❌ Kurulmamış'}` 
                });
                break;

            // Admin komutları
            case 'magazaekle':
                if (!interaction.member?.roles?.cache?.has(config.adminRoleId)) {
                    await interaction.editReply({ content: '❌ Bu komut için admin yetkiniz yok!' });
                    return;
                }
                const { handleMagazaEkleCommand } = require('./modules/commands/admin');
                const magazaData = {
                    content: `!magazaekle ${interaction.options.getString('urun_adi')} | ${interaction.options.getInteger('fiyat')} | ${interaction.options.getInteger('sure')} | ${interaction.options.getString('rol_id')} | ${interaction.options.getString('aciklama') || ''}`.trim(),
                    reply: async (msg) => await interaction.editReply(msg)
                };
                await handleMagazaEkleCommand(magazaData, guildId);
                break;

            case 'magazasil':
                if (!interaction.member?.roles?.cache?.has(config.adminRoleId)) {
                    await interaction.reply({ content: '❌ Bu komut için admin yetkiniz yok!', ephemeral: true });
                    return;
                }
                const { handleMagazaSilCommand } = require('./modules/commands/admin');
                const silData = {
                    content: `!magazasil ${interaction.options.getString('urun_id')}`,
                    reply: async (msg) => await interaction.reply(msg)
                };
                await handleMagazaSilCommand(silData, guildId);
                break;

            case 'promokod':
                if (!interaction.member?.roles?.cache?.has(config.adminRoleId)) {
                    await interaction.reply({ content: '❌ Bu komut için admin yetkiniz yok!', ephemeral: true });
                    return;
                }
                const { handlePromoKodCommand } = require('./modules/commands/admin');
                const promoData = {
                    content: `!promokod ${interaction.options.getString('kod')} | ${interaction.options.getInteger('indirim')} | ${interaction.options.getString('bitis_tarihi') || ''}`.trim(),
                    reply: async (msg) => await interaction.reply(msg)
                };
                await handlePromoKodCommand(promoData, guildId);
                break;

            case 'bakim':
                if (!interaction.member?.roles?.cache?.has(config.adminRoleId)) {
                    await interaction.reply({ content: '❌ Bu komut için admin yetkiniz yok!', ephemeral: true });
                    return;
                }
                const { handleBakimCommand } = require('./modules/commands/admin');
                const bakimData = {
                    content: `!bakim ${interaction.options.getString('islem')}`,
                    reply: async (msg) => await interaction.reply(msg)
                };
                await handleBakimCommand(bakimData, guildId);
                break;

            case 'deep-clean':
                // Sadece admin rolüne sahip kullanıcılar kullanabilir
                if (!interaction.member?.permissions?.has('Administrator')) {
                    await interaction.reply({ 
                        content: '❌ Bu komut için Administrator yetkiniz gerekli!', 
                        ephemeral: true 
                    });
                    return;
                }

                const onay = interaction.options.getString('onay');
                if (onay !== 'EVET_SIL') {
                    await interaction.reply({
                        content: '❌ Derin temizlik için onay gerekli! Komutu şu şekilde kullanın:\n`/deep-clean onay:EVET_SIL`',
                        ephemeral: true
                    });
                    return;
                }

                await interaction.deferReply();

                try {
                    // Sunucu bilgilerini al
                    const { data: server } = await supabase
                        .from('servers')
                        .select('id, name')
                        .eq('discord_id', guildId)
                        .single();

                    if (!server) {
                        await interaction.editReply('❌ Bu sunucu için kayıt bulunamadı!');
                        return;
                    }

                    // Derin temizlik işlemleri
                    console.log(`Deep clean: Starting for server ${server.name} (${guildId})`);

                    // 1. Kullanıcı verilerini soft delete ile işaretle
                    const softDeleteQueries = [
                        supabase.from('member_wallets').update({ deleted_at: new Date().toISOString() }).eq('guild_id', guildId),
                        supabase.from('wallet_ledger').update({ deleted_at: new Date().toISOString() }).eq('guild_id', guildId),
                        supabase.from('daily_earnings').update({ deleted_at: new Date().toISOString() }).eq('guild_id', guildId),
                        supabase.from('member_daily_stats').update({ deleted_at: new Date().toISOString() }).eq('guild_id', guildId),
                        supabase.from('server_daily_stats').update({ deleted_at: new Date().toISOString() }).eq('guild_id', guildId),
                        supabase.from('member_overview_stats').update({ deleted_at: new Date().toISOString() }).eq('guild_id', guildId),
                        supabase.from('server_overview_stats').update({ deleted_at: new Date().toISOString() }).eq('guild_id', guildId),
                        supabase.from('web_audit_logs').update({ deleted_at: new Date().toISOString() }).eq('guild_id', guildId),
                        supabase.from('member_profiles').update({ deleted_at: new Date().toISOString() }).eq('guild_id', guildId),
                        supabase.from('store_orders').update({ deleted_at: new Date().toISOString() }).eq('server_id', server.id),
                        supabase.from('promotions').update({ deleted_at: new Date().toISOString() }).eq('server_id', server.id)
                    ];

                    // Paralel olarak çalıştır
                    const results = await Promise.allSettled(softDeleteQueries);
                    const successCount = results.filter(r => r.status === 'fulfilled').length;
                    const failCount = results.filter(r => r.status === 'rejected').length;

                    console.log(`Deep clean: ${successCount} successful, ${failCount} failed operations`);

                    // Başarı mesajı
                    const successEmbed = new EmbedBuilder()
                        .setColor('#ff5722')
                        .setTitle('🗑️ Derin Temizlik Tamamlandı')
                        .setDescription(`**${server.name}** sunucusundaki tüm kullanıcı verileri temizlendi.`)
                        .addFields(
                            {
                                name: '🕐 Geri Getirme Süresi',
                                value: 'Verileriniz **30 gün** boyunca geri getirilebilir.\n\nGeri getirmek için: `/restore-data veri_turu:Tüm Veriler`',
                                inline: false
                            },
                            {
                                name: '📊 Temizlenen Veriler',
                                value: '• Kullanıcı bakiyeleri\n• Cüzdan hareketleri\n• Günlük kazançlar\n• İstatistikler\n• Mağaza siparişleri\n• Web aktiviteleri\n• Promosyonlar',
                                inline: false
                            },
                            {
                                name: '⚠️ Önemli Not',
                                value: 'Bu işlem sadece **bu sunucudaki** verileri etkiler.\nKullanıcıların diğer sunuculardaki verileri korunur.',
                                inline: false
                            }
                        )
                        .setFooter({
                            text: `Sunucu: ${server.name} | İşlemler: ${successCount}/${successCount + failCount} başarılı`,
                            iconURL: interaction.guild.iconURL()
                        })
                        .setTimestamp();

                    await interaction.editReply({ embeds: [successEmbed] });

                } catch (error) {
                    console.error('Deep clean error:', error);
                    await interaction.editReply({
                        content: '❌ Derin temizlik sırasında bir hata oluştu!',
                        ephemeral: true
                    });
                }
                break;

            case 'kurulum-kaldir':
                // Sadece admin rolüne sahip kullanıcılar kullanabilir
                if (!interaction.member?.permissions?.has('Administrator')) {
                    await interaction.reply({ 
                        content: '❌ Bu komut için Administrator yetkiniz gerekli!', 
                        ephemeral: true 
                    });
                    return;
                }

                const onayKurulum = interaction.options.getString('onay');
                if (onayKurulum !== 'EVET_KURULUMU_KALDIR') {
                    await interaction.reply({
                        content: '❌ Kurulum kaldırma için onay gerekli! Komutu şu şekilde kullanın:\n`/kurulum-kaldir onay:EVET_KURULUMU_KALDIR`',
                        ephemeral: true
                    });
                    return;
                }

                await interaction.deferReply();

                try {
                    // Kurulum kaldırma işlemini başlat
                    const { handleKurulumKaldirCommand } = require('./modules/commands/admin');
                    const kurulumData = {
                        author: { id: userId, username: username },
                        guild: { id: guildId, iconURL: interaction.guild.iconURL },
                        reply: async (msg) => await interaction.editReply(msg)
                    };
                    await handleKurulumKaldirCommand(kurulumData);
                } catch (error) {
                    console.error('Kurulum kaldırma hatası:', error);
                    await interaction.editReply({
                        content: '❌ Kurulum kaldırma sırasında bir hata oluştu!',
                        ephemeral: true
                    });
                }
                break;

            case 'restore-data':
                // Sadece admin rolüne sahip kullanıcılar kullanabilir
                if (!interaction.member?.permissions?.has('Administrator')) {
                    await interaction.reply({ 
                        content: '❌ Bu komut için Administrator yetkiniz gerekli!', 
                        ephemeral: true 
                    });
                    return;
                }

                await interaction.deferReply();

                try {
                    const veriTuru = interaction.options.getString('veri_turu');
                    const kullaniciId = interaction.options.getString('kullanici_id');

                    // Sunucu bilgilerini al
                    const { data: server } = await supabase
                        .from('servers')
                        .select('id, name')
                        .eq('discord_id', guildId)
                        .single();

                    if (!server) {
                        await interaction.editReply('❌ Bu sunucu için kayıt bulunamadı!');
                        return;
                    }

                    let restoreQueries = [];
                    let description = '';

                    // Veri türüne göre sorguları hazırla
                    if (veriTuru === 'user_data') {
                        description = 'Kullanıcı verileri geri yükleniyor...';
                        restoreQueries = [
                            supabase.from('member_wallets').update({ deleted_at: null }).eq('guild_id', guildId),
                            supabase.from('wallet_ledger').update({ deleted_at: null }).eq('guild_id', guildId),
                            supabase.from('daily_earnings').update({ deleted_at: null }).eq('guild_id', guildId),
                            supabase.from('member_daily_stats').update({ deleted_at: null }).eq('guild_id', guildId),
                            supabase.from('member_overview_stats').update({ deleted_at: null }).eq('guild_id', guildId),
                            supabase.from('web_audit_logs').update({ deleted_at: null }).eq('guild_id', guildId),
                            supabase.from('member_profiles').update({ deleted_at: null }).eq('guild_id', guildId)
                        ];

                        if (kullaniciId) {
                            // Belirli kullanıcı için filtre ekle
                            restoreQueries = restoreQueries.map(query => query.eq('user_id', kullaniciId));
                            description = `Kullanıcı ${kullaniciId} verileri geri yükleniyor...`;
                        }
                    } else if (veriTuru === 'store_data') {
                        description = 'Mağaza verileri geri yükleniyor...';
                        restoreQueries = [
                            supabase.from('store_orders').update({ deleted_at: null }).eq('server_id', server.id),
                            supabase.from('promotions').update({ deleted_at: null }).eq('server_id', server.id)
                        ];
                    } else if (veriTuru === 'all_data') {
                        description = 'Tüm veriler geri yükleniyor...';
                        restoreQueries = [
                            supabase.from('member_wallets').update({ deleted_at: null }).eq('guild_id', guildId),
                            supabase.from('wallet_ledger').update({ deleted_at: null }).eq('guild_id', guildId),
                            supabase.from('daily_earnings').update({ deleted_at: null }).eq('guild_id', guildId),
                            supabase.from('member_daily_stats').update({ deleted_at: null }).eq('guild_id', guildId),
                            supabase.from('server_daily_stats').update({ deleted_at: null }).eq('guild_id', guildId),
                            supabase.from('member_overview_stats').update({ deleted_at: null }).eq('guild_id', guildId),
                            supabase.from('server_overview_stats').update({ deleted_at: null }).eq('guild_id', guildId),
                            supabase.from('web_audit_logs').update({ deleted_at: null }).eq('guild_id', guildId),
                            supabase.from('member_profiles').update({ deleted_at: null }).eq('guild_id', guildId),
                            supabase.from('store_orders').update({ deleted_at: null }).eq('server_id', server.id),
                            supabase.from('promotions').update({ deleted_at: null }).eq('server_id', server.id)
                        ];
                    }

                    // Önce kaç kayıt geri yükleneceğini hesapla
                    let totalRecords = 0;
                    for (const query of restoreQueries) {
                        const { count } = await query.select('*', { count: 'exact', head: true });
                        totalRecords += count || 0;
                    }

                    if (totalRecords === 0) {
                        await interaction.editReply('ℹ️ Geri yüklenecek veri bulunamadı. Veriler zaten geri yüklenmiş veya hiç silinmemiş olabilir.');
                        return;
                    }

                    // Geri yükleme işlemini başlat
                    console.log(`Restore: Starting for server ${server.name} (${guildId}), ${totalRecords} records`);

                    const results = await Promise.allSettled(restoreQueries);
                    const successCount = results.filter(r => r.status === 'fulfilled').length;

                    console.log(`Restore: ${successCount}/${restoreQueries.length} operations successful`);

                    // Başarı mesajı
                    const restoreEmbed = new EmbedBuilder()
                        .setColor('#4caf50')
                        .setTitle('✅ Veriler Geri Yüklendi')
                        .setDescription(`**${server.name}** sunucusundaki veriler başarıyla geri yüklendi.`)
                        .addFields(
                            {
                                name: '📊 Geri Yüklenen Kayıtlar',
                                value: `${totalRecords} kayıt geri yüklendi`,
                                inline: true
                            },
                            {
                                name: '⏰ İşlem Durumu',
                                value: `${successCount}/${restoreQueries.length} işlem başarılı`,
                                inline: true
                            },
                            {
                                name: '💡 Not',
                                value: 'Veriler artık web panelinde ve bot sisteminde görünür olacak.',
                                inline: false
                            }
                        )
                        .setFooter({
                            text: `Sunucu: ${server.name}`,
                            iconURL: interaction.guild.iconURL()
                        })
                        .setTimestamp();

                    await interaction.editReply({ embeds: [restoreEmbed] });

                } catch (error) {
                    console.error('Restore error:', error);
                    await interaction.editReply({
                        content: '❌ Veri geri yükleme sırasında bir hata oluştu!',
                        ephemeral: true
                    });
                }
                break;

            case 'logkanali':
                const { handleLogKanalCommand } = require('./modules/commands/admin');
                await handleLogKanalCommand(interaction);
                break;

            case 'logkur':
                try {
                    const { handleLogKurCommand } = require('./modules/commands/admin');
                    await handleLogKurCommand(interaction);
                } catch (error) {
                    console.error('Logkur komutu hatası:', error);
                    // Bu komut kendi error handling'ini yapıyor, burada ekstra bir şey yapma
                }
                break;

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
const generateHelpText = (isAdmin) => {
    let helpText = `🤖 **Disc Nexus Bot Komutları**\n\n`;

    // Genel komutlar
    helpText += `👤 **Slash Komutları:**\n`;
    helpText += `• \`/setup\` - Kaldırıldı; kurulum için web panelini kullanın\n`;
    helpText += `• \`/ayarlar\` - Sunucu ayarlarını görüntüle\n`;
    helpText += `• \`/yardim\` - Bu yardım mesajını göster\n\n`;

    // Admin komutları
    if (isAdmin) {
        helpText += `🔧 **Admin Komutları:**\n`;
        helpText += `• \`/magazaekle\` - Mağaza ürünü ekle\n`;
        helpText += `• \`/magazasil\` - Mağaza ürünü kaldır\n`;
        helpText += `• \`/promokod\` - Promosyon kodu oluştur\n`;
        helpText += `• \`/bakim\` - Bakım modunu kontrol et\n`;
        helpText += `• \`/kurulum-kaldir\` - Kurulumu kaldır ve tüm verileri temizle\n\n`;
    }

    helpText += `💡 **İpucu:** Hem slash (/) hem prefix (!) komutları çalışır!\n`;
    helpText += `🌐 **Web Panel:** ${process.env.WEB_URL || 'http://localhost:3000'}`;

    return { content: helpText, flags: 0 }; // ephemeral yerine flags: 0
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