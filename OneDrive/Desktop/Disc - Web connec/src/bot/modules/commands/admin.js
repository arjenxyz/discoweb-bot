// modules/commands/admin.js - Admin komutları
const { supabase } = require('../database');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// !magazaekle komutu - mağaza ürünü ekleme
const handleMagazaEkleCommand = async (message, guildId) => {
    const payload = message.content.replace('!magazaekle', '').trim();
    const [title, priceText, durationText, roleId, description] = payload
        .split('|')
        .map((part) => part?.trim());

    if (!title || !priceText || !durationText || !roleId) {
        const embed = new EmbedBuilder()
            .setColor('#ff6b6b')
            .setTitle('❌ Kullanım Hatası!')
            .setDescription('Mağaza ürünü ekleme komutu yanlış kullanıldı.')
            .addFields(
                {
                    name: '✅ Doğru Kullanım',
                    value: '`!magazaekle Ürün Adı | Fiyat | Süre(Gün) | RolID | Açıklama`',
                    inline: false
                },
                {
                    name: '📝 Örnek',
                    value: '`!magazaekle VIP Üye | 50 | 30 | 123456789012345678 | Özel VIP üyelik`',
                    inline: false
                }
            )
            .setFooter({
                text: 'Admin Komutları',
                iconURL: message.guild.iconURL
            });

        message.reply({ embeds: [embed] });
        return;
    }

    const price = Number(priceText);
    if (Number.isNaN(price) || price <= 0) {
        const embed = new EmbedBuilder()
            .setColor('#ff6b6b')
            .setTitle('❌ Geçersiz Fiyat')
            .setDescription('Fiyat pozitif bir sayı olmalıdır.')
            .setFooter({
                text: 'Admin Komutları',
                iconURL: message.guild.iconURL
            });

        message.reply({ embeds: [embed] });
        return;
    }

    const durationDays = Number(durationText);
    if (Number.isNaN(durationDays) || durationDays <= 0) {
        const embed = new EmbedBuilder()
            .setColor('#ff6b6b')
            .setTitle('❌ Geçersiz Süre')
            .setDescription('Süre pozitif bir sayı olmalıdır (gün cinsinden).')
            .setFooter({
                text: 'Admin Komutları',
                iconURL: message.guild.iconURL
            });

        message.reply({ embeds: [embed] });
        return;
    }

    try {
        // Sunucu bilgilerini al
        const { data: server } = await supabase
            .from('servers')
            .select('id')
            .eq('discord_id', guildId)
            .maybeSingle();

        const serverId = server?.id
            ? server.id
            : (await supabase.from('servers').select('id').eq('slug', 'default').maybeSingle()).data?.id;

        if (!serverId) {
            const embed = new EmbedBuilder()
                .setColor('#ff6b6b')
                .setTitle('❌ Sunucu Kaydı Bulunamadı')
                .setDescription('Sunucu veritabanında kayıtlı değil.')
                .setFooter({
                    text: 'Admin Komutları',
                    iconURL: message.guild.iconURL
                });

            message.reply({ embeds: [embed] });
            return;
        }

        // Rol ID'sinin geçerli olup olmadığını kontrol et
        const role = message.guild.roles.cache.get(roleId);
        if (!role) {
            const embed = new EmbedBuilder()
                .setColor('#ff6b6b')
                .setTitle('❌ Geçersiz Rol ID')
                .setDescription('Lütfen doğru rol ID\'sini girin.')
                .setFooter({
                    text: 'Admin Komutları',
                    iconURL: message.guild.iconURL
                });

            message.reply({ embeds: [embed] });
            return;
        }

        // Ürünü ekle
        const { error } = await supabase.from('store_items').insert({
            server_id: serverId,
            title,
            description: description || null,
            price,
            status: 'active',
            role_id: roleId,
            duration_days: durationDays
        });

        if (error) {
            console.error('❌ Mağaza ekleme hatası:', error);
            const embed = new EmbedBuilder()
                .setColor('#ff6b6b')
                .setTitle('❌ Ürün Eklenirken Hata')
                .setDescription('Ürün veritabanına eklenemedi.')
                .setFooter({
                    text: 'Admin Komutları',
                    iconURL: message.guild.iconURL
                });

            message.reply({ embeds: [embed] });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor('#00ff88')
            .setTitle('✅ Ürün Başarıyla Eklendi!')
            .setDescription(`**${title}** mağazaya başarıyla eklendi.`)
            .setThumbnail(message.guild.iconURL)
            .addFields(
                {
                    name: '💰 Fiyat',
                    value: `${price.toLocaleString('tr-TR')} ₺`,
                    inline: true
                },
                {
                    name: '⏰ Süre',
                    value: `${durationDays} gün`,
                    inline: true
                },
                {
                    name: '👤 Rol',
                    value: role.name,
                    inline: true
                }
            )
            .setFooter({
                text: 'Admin Komutları • Mağaza Yönetimi',
                iconURL: message.guild.iconURL
            })
            .setTimestamp();

        if (description) {
            embed.addFields({
                name: '📝 Açıklama',
                value: description,
                inline: false
            });
        }

        message.reply({ embeds: [embed] });

    } catch (error) {
        console.error('Mağaza ekleme komutu hatası:', error);
        message.reply('❌ Beklenmeyen bir hata oluştu!');
    }
};

// !promokod komutu - promosyon kodu oluşturma
const handlePromoKodCommand = async (message, guildId) => {
    const payload = message.content.replace('!promokod', '').trim();
    const [code, valueText, expiresText] = payload.split('|').map((part) => part?.trim());

    if (!code || !valueText) {
        message.reply(
            '❌ **Kullanım hatası!**\n\n' +
            '✅ **Doğru kullanım:**\n' +
            '`!promokod KOD | İndirim(%) | Bitiş(YYYY-MM-DD)`\n\n' +
            '📝 **Örnek:**\n' +
            '`!promokod YILBAS50 | 50 | 2024-12-31`\n\n' +
            '💡 **Not:** Bitiş tarihi opsiyoneldir.'
        );
        return;
    }

    const value = Number(valueText);
    if (Number.isNaN(value) || value <= 0 || value > 100) {
        message.reply('❌ İndirim değeri 1-100 arası bir sayı olmalı!');
        return;
    }

    try {
        // Sunucu bilgilerini al
        const { data: server } = await supabase
            .from('servers')
            .select('id')
            .eq('discord_id', guildId)
            .maybeSingle();

        const serverId = server?.id
            ? server.id
            : (await supabase.from('servers').select('id').eq('slug', 'default').maybeSingle()).data?.id;

        if (!serverId) {
            message.reply('❌ Sunucu kaydı bulunamadı!');
            return;
        }

        // Aynı kod var mı kontrol et
        const { data: existingCode } = await supabase
            .from('promotions')
            .select('id')
            .eq('code', code.toUpperCase())
            .eq('server_id', serverId)
            .maybeSingle();

        if (existingCode) {
            message.reply('❌ Bu promosyon kodu zaten mevcut!');
            return;
        }

        const expiresAt = expiresText ? new Date(expiresText).toISOString() : null;

        // Promosyonu ekle
        const { error } = await supabase.from('promotions').insert({
            server_id: serverId,
            code: code.toUpperCase(),
            value,
            status: 'active',
            expires_at: expiresAt
        });

        if (error) {
            console.error('❌ Promosyon ekleme hatası:', error);
            message.reply('❌ Promosyon kodu eklenirken bir hata oluştu!');
            return;
        }

        const expiryInfo = expiresAt
            ? `\n⏰ Bitiş: ${new Date(expiresAt).toLocaleDateString('tr-TR')}`
            : '\n⏰ Süresiz';

        message.reply(
            `✅ **Promosyon kodu başarıyla eklendi!**\n\n` +
            `🎫 Kod: **${code.toUpperCase()}**\n` +
            `💰 İndirim: %${value}` +
            expiryInfo
        );

    } catch (error) {
        console.error('Promosyon komutu hatası:', error);
        message.reply('❌ Beklenmeyen bir hata oluştu!');
    }
};

// !magazasil komutu - mağaza ürünü silme/deaktif etme
const handleMagazaSilCommand = async (message, guildId) => {
    const payload = message.content.replace('!magazasil', '').trim();

    if (!payload) {
        message.reply(
            '❌ **Kullanım hatası!**\n\n' +
            '✅ **Doğru kullanım:**\n' +
            '`!magazasil Ürün ID`\n\n' +
            '💡 **Ürün ID\'sini öğrenmek için:** Mağaza ürünlerini web panelinden görebilirsin.'
        );
        return;
    }

    try {
        // Ürünü deaktif et
        const { error } = await supabase
            .from('store_items')
            .update({ status: 'inactive' })
            .eq('id', payload);

        if (error) {
            console.error('❌ Mağaza silme hatası:', error);
            message.reply('❌ Ürün bulunamadı veya silinirken hata oluştu!');
            return;
        }

        message.reply(`✅ **Ürün başarıyla kaldırıldı!**\n(ID: ${payload})`);

    } catch (error) {
        console.error('Mağaza silme komutu hatası:', error);
        message.reply('❌ Beklenmeyen bir hata oluştu!');
    }
};

// !bakim komutu - bakım modu kontrolü
const handleBakimCommand = async (message, guildId) => {
    const payload = message.content.replace('!bakim', '').trim().toLowerCase();

    if (!payload || !['ac', 'kapat', 'durum'].includes(payload)) {
        message.reply(
            '❌ **Kullanım hatası!**\n\n' +
            '✅ **Doğru kullanım:**\n' +
            '`!bakim ac` - Bakım modunu aç\n' +
            '`!bakim kapat` - Bakım modunu kapat\n' +
            '`!bakim durum` - Bakım modu durumunu göster'
        );
        return;
    }

    try {
        const supabase = require('../database').supabase;

        if (payload === 'durum') {
            // Bakım modu durumunu kontrol et
            const response = await fetch(`${process.env.WEB_URL || 'http://localhost:3000'}/api/maintenance`);
            const data = await response.json();

            const status = data.flags?.site?.is_active ? '🟡 AKTİF' : '🟢 PASİF';
            const reason = data.flags?.site?.reason || 'Belirtilmemiş';

            message.reply(
                `🔧 **Bakım Modu Durumu**\n\n` +
                `📊 Durum: ${status}\n` +
                `📝 Sebep: ${reason}`
            );
            return;
        }

        // Bakım modunu aç/kapat
        const isActive = payload === 'ac';
        const reason = isActive ? 'Admin tarafından açıldı' : null;

        // Web API'sine istek gönder
        const response = await fetch(`${process.env.WEB_URL || 'http://localhost:3000'}/api/admin/maintenance`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // Admin token'ı eklenmeli
            },
            body: JSON.stringify({
                key: 'site',
                is_active: isActive,
                reason: reason
            })
        });

        if (response.ok) {
            message.reply(`✅ **Bakım modu ${isActive ? 'açıldı' : 'kapatıldı'}!**`);
        } else {
            message.reply('❌ Bakım modu güncellenirken hata oluştu!');
        }

    } catch (error) {
        console.error('Bakım komutu hatası:', error);
        message.reply('❌ Beklenmeyen bir hata oluştu!');
    }
};

// !logkanali komutu - log kanallarını ayarlama
const handleLogKanalCommand = async (interaction) => {
    try {
        // Sadece admin yetkisi kontrolü
        if (!interaction.member.permissions.has('Administrator')) {
            const embed = new EmbedBuilder()
                .setColor('#ff6b6b')
                .setTitle('❌ Yetki Hatası')
                .setDescription('Bu komutu kullanabilmek için **Administrator** yetkisine sahip olmalısınız.')
                .setFooter({
                    text: 'Admin Komutları',
                    iconURL: interaction.guild.iconURL()
                });

            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        const logChannel = interaction.options.getChannel('log_kanal');
        const systemLogChannel = interaction.options.getChannel('sistem_log_kanal');

        // Veritabanını güncelle
        const updateData = {};
        if (logChannel) updateData.log_channel_id = logChannel.id;
        if (systemLogChannel) updateData.system_log_channel_id = systemLogChannel.id;

        if (Object.keys(updateData).length === 0) {
            const embed = new EmbedBuilder()
                .setColor('#ffa726')
                .setTitle('⚠️ Uyarı')
                .setDescription('En az bir log kanalı belirtmelisiniz!')
                .addFields(
                    {
                        name: '📋 Kullanım',
                        value: '`/logkanali log_kanal:#kanal` - Genel log kanalı ayarla\n`/logkanali sistem_log_kanal:#kanal` - Sistem log kanalı ayarla\n`/logkanali log_kanal:#kanal sistem_log_kanal:#kanal` - Her ikisini birden ayarla',
                        inline: false
                    }
                )
                .setFooter({
                    text: 'Admin Komutları',
                    iconURL: interaction.guild.iconURL()
                });

            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        const { error } = await supabase
            .from('servers')
            .update(updateData)
            .eq('server_id', interaction.guild.id);

        if (error) {
            console.error('Log kanal güncelleme hatası:', error);
            const embed = new EmbedBuilder()
                .setColor('#ff6b6b')
                .setTitle('❌ Veritabanı Hatası')
                .setDescription('Log kanalları güncellenirken bir hata oluştu.')
                .setFooter({
                    text: 'Admin Komutları',
                    iconURL: interaction.guild.iconURL()
                });

            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        // Başarılı embed oluştur
        const embed = new EmbedBuilder()
            .setColor('#4caf50')
            .setTitle('✅ Log Kanalları Güncellendi')
            .setDescription('Log kanalları başarıyla ayarlandı!')
            .setFooter({
                text: 'Admin Komutları',
                iconURL: interaction.guild.iconURL()
            });

        if (logChannel) {
            embed.addFields({
                name: '📝 Genel Log Kanalı',
                value: `<#${logChannel.id}>`,
                inline: true
            });
        }

        if (systemLogChannel) {
            embed.addFields({
                name: '🔧 Sistem Log Kanalı',
                value: `<#${systemLogChannel.id}>`,
                inline: true
            });
        }

        await interaction.reply({ embeds: [embed] });

    } catch (error) {
        console.error('Log kanal komutu hatası:', error);
        const embed = new EmbedBuilder()
            .setColor('#ff6b6b')
            .setTitle('❌ Beklenmeyen Hata')
            .setDescription('Log kanalları ayarlanırken beklenmeyen bir hata oluştu.')
            .setFooter({
                text: 'Admin Komutları',
                iconURL: interaction.guild.iconURL()
            });

        if (!interaction.replied) {
            await interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }
};

// !logkur komutu - otomatik log sistemi kurma
const handleLogKurCommand = async (interaction) => {
    try {
        // Sadece admin yetkisi kontrolü
        if (!interaction.member.permissions.has('Administrator')) {
            const embed = new EmbedBuilder()
                .setColor('#ff6b6b')
                .setTitle('❌ Yetki Hatası')
                .setDescription('Bu komutu kullanabilmek için **Administrator** yetkisine sahip olmalısınız.')
                .setFooter({
                    text: 'Admin Komutları',
                    iconURL: interaction.guild.iconURL()
                });

            return interaction.editReply({ embeds: [embed] });
        }

        const onay = interaction.options.getBoolean('onay');
        if (!onay) {
            const embed = new EmbedBuilder()
                .setColor('#ffa726')
                .setTitle('⚠️ Onay Gerekli')
                .setDescription('Log sistemini kurmak için `onay: true` parametresini kullanmalısınız.')
                .addFields({
                    name: '📋 Bu komut şunları yapar:',
                    value: '• "Bot Logs" kategorisi oluşturur\n• 8 adet log kanalı oluşturur\n• Kanalları Supabase\'e kaydeder\n• Admin rolüne özel izinler verir',
                    inline: false
                })
                .setFooter({
                    text: 'Admin Komutları',
                    iconURL: interaction.guild.iconURL()
                });

            return interaction.editReply({ embeds: [embed] });
        }

        // Değişkenleri tanımla
        const createdChannels = [];
        const channelData = [];

        // Log kanalları tanımları (system hariç - sadece sahibi için)
        const logChannels = [
            { type: 'main', name: '🚀-ana-log', description: 'Genel bot aktiviteleri' },
            { type: 'auth', name: '🔐-giris-cikis', description: 'Kullanıcı giriş/çıkış işlemleri' },
            { type: 'roles', name: '🎭-rol-islemleri', description: 'Rol verme/alma işlemleri' },
            { type: 'suspicious', name: '🚨-supheli-aktiviteler', description: 'Şüpheli aktiviteler' },
            { type: 'store', name: '🛒-magaza-islemleri', description: 'Mağaza satın alma işlemleri' },
            { type: 'wallet', name: '💰-cuzdan-islemleri', description: 'Para kazanma/harcama işlemleri' },
            { type: 'admin', name: '👑-admin-komutlari', description: 'Admin komut kullanımı' },
            { type: 'settings', name: '🔧-ayar-degisiklikleri', description: 'Sunucu ayar değişiklikleri' }
        ];

        // Önce mevcut log kategorisini kontrol et
        let logCategory = interaction.guild.channels.cache.find(
            channel => channel.name === 'bot-logs' && channel.type === 4 // Category
        );

        if (!logCategory) {
            // Kategori oluştur
            logCategory = await interaction.guild.channels.create({
                    name: 'Bot Logs',
                    type: 4, // GUILD_CATEGORY
                    permissionOverwrites: [
                        {
                            id: interaction.guild.id, // @everyone
                            deny: ['ViewChannel']
                        },
                        {
                            id: interaction.guild.roles.cache.find(role => role.name === 'Admin')?.id ||
                                 interaction.guild.roles.cache.find(role => role.permissions.has('Administrator'))?.id,
                            allow: ['ViewChannel', 'ReadMessageHistory']
                        }
                ]
            });
        }
        for (const logChannel of logChannels) {
            const channel = await interaction.guild.channels.create({
                    name: logChannel.name,
                    type: 0, // GUILD_TEXT
                    parent: logCategory.id,
                    topic: logChannel.description,
                    permissionOverwrites: [
                        {
                            id: interaction.guild.id, // @everyone
                            deny: ['ViewChannel']
                        },
                        {
                            id: interaction.guild.roles.cache.find(role => role.name === 'Admin')?.id ||
                                 interaction.guild.roles.cache.find(role => role.permissions.has('Administrator'))?.id,
                            allow: ['ViewChannel', 'ReadMessageHistory', 'SendMessages']
                        }
                    ]
                });

                createdChannels.push(`${logChannel.name} (${logChannel.description})`);
                channelData.push({
                    guild_id: interaction.guild.id,
                    channel_type: logChannel.type,
                    channel_id: channel.id,
                    is_active: true
                });

        }

        // Supabase'e kaydet
        if (channelData.length > 0) {
            const { error } = await supabase
                    .from('bot_log_channels')
                    .upsert(channelData, { onConflict: 'guild_id,channel_type' });

                if (error) {
                    console.error('Log kanalları kaydetme hatası:', error);
                    const embed = new EmbedBuilder()
                        .setColor('#ff6b6b')
                        .setTitle('❌ Veritabanı Hatası')
                        .setDescription('Kanallar oluşturuldu ancak veritabanına kaydedilemedi.')
                        .setFooter({
                            text: 'Admin Komutları',
                            iconURL: interaction.guild.iconURL()
                        });

                    return interaction.editReply({ embeds: [embed] });
            }
        }

        // Başarılı embed oluştur
        const embed = new EmbedBuilder()
            .setColor('#4caf50')
            .setTitle('✅ Log Sistemi Kuruldu')
            .setDescription(`**${createdChannels.length}** adet log kanalı başarıyla oluşturuldu!`)
            .addFields(
                {
                    name: '📁 Kategori',
                    value: logCategory.name,
                    inline: true
                },
                {
                    name: '🔒 İzinler',
                    value: 'Sadece Admin rolü görebilir',
                    inline: true
                },
                {
                    name: '📋 Oluşturulan Kanallar',
                    value: createdChannels.map(name => `• ${name}`).join('\n'),
                    inline: false
                }
            )
            .setFooter({
                text: 'Admin Komutları',
                iconURL: interaction.guild.iconURL()
            });

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('Log kurulum komutu hatası:', error);
        const embed = new EmbedBuilder()
            .setColor('#ff6b6b')
            .setTitle('❌ Beklenmeyen Hata')
            .setDescription('Log sistemi kurulurken beklenmeyen bir hata oluştu.')
            .setFooter({
                text: 'Admin Komutları',
                iconURL: interaction.guild.iconURL()
            });

        await interaction.editReply({ embeds: [embed] });
    }
};

// !kurumukaldir komutu - kurulum kaldırma
const handleKurulumKaldirCommand = async (message, guildId) => {
    try {
        // Admin kontrolü
        const member = message.member;
        const { data: server } = await supabase
            .from('servers')
            .select('admin_role_id')
            .eq('discord_id', guildId)
            .single();

        if (!server?.admin_role_id || !member.roles.cache.has(server.admin_role_id)) {
            const embed = new EmbedBuilder()
                .setColor('#ff6b6b')
                .setTitle('❌ Yetki Hatası')
                .setDescription('Bu komutu kullanabilmek için admin yetkiniz bulunmuyor.')
                .setFooter({
                    text: 'Admin Komutları',
                    iconURL: message.guild.iconURL
                });

            message.reply({ embeds: [embed] });
            return;
        }

        // Onay butonları
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('confirm_remove_setup')
                    .setLabel('✅ Evet, Kurulum Kaldır')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId('cancel_remove_setup')
                    .setLabel('❌ İptal')
                    .setStyle(ButtonStyle.Secondary)
            );

        const embed = new EmbedBuilder()
            .setColor('#ffa500')
            .setTitle('⚠️ Kurulum Kaldırma Onayı')
            .setDescription('Bu işlem geri alınamaz! Tüm veriler, kanallar ve webhook\'lar silinecek.')
            .addFields(
                { name: '🗑️ Silinecek Öğeler', value: '• Veritabanı kayıtları\n• Discord kanalları\n• Webhook\'lar\n• Mağaza ürünleri\n• Kullanıcı cüzdanları\n• Log kayıtları', inline: false },
                { name: '⚠️ Uyarı', value: 'Bu işlem kalıcıdır ve geri alınamaz!', inline: false }
            )
            .setFooter({
                text: 'Onaylamak için "Evet, Kurulum Kaldır" butonuna tıklayın',
                iconURL: message.guild.iconURL
            });

        const reply = await message.reply({ embeds: [embed], components: [row] });

        // Button interaction collector
        const filter = (interaction) => {
            return interaction.user.id === message.author.id;
        };

        const collector = reply.createMessageComponentCollector({ filter, time: 30000 });

        collector.on('collect', async (interaction) => {
            if (interaction.customId === 'confirm_remove_setup') {
                await interaction.deferUpdate();

                try {
                    // Silme işlemini başlat
                    const result = await performSetupRemoval(guildId, server.id);

                    const resultEmbed = new EmbedBuilder()
                        .setColor(result.success ? '#00ff00' : '#ff6b6b')
                        .setTitle(result.success ? '✅ Kurulum Başarıyla Kaldırıldı' : '❌ Kurulum Kaldırma Hatası')
                        .setDescription(result.message)
                        .addFields(
                            { name: '🗑️ Silinen Kanallar', value: `${result.discordCleanup?.channelsDeleted || 0}`, inline: true },
                            { name: '🔗 Silinen Webhook\'lar', value: `${result.discordCleanup?.webhooksDeleted || 0}`, inline: true },
                            { name: '💾 Temizlenen Veriler', value: 'Tüm veritabanı kayıtları', inline: true }
                        );

                    if (result.discordCleanup?.errors?.length > 0) {
                        resultEmbed.addFields({
                            name: '⚠️ Uyarılar',
                            value: result.discordCleanup.errors.slice(0, 3).join('\n'),
                            inline: false
                        });
                    }

                    await interaction.editReply({ embeds: [resultEmbed], components: [] });

                } catch (error) {
                    console.error('Setup removal error:', error);
                    const errorEmbed = new EmbedBuilder()
                        .setColor('#ff6b6b')
                        .setTitle('❌ Kurulum Kaldırma Hatası')
                        .setDescription('Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.')
                        .setFooter({
                            text: 'Admin Komutları',
                            iconURL: message.guild.iconURL
                        });

                    await interaction.editReply({ embeds: [errorEmbed], components: [] });
                }

            } else if (interaction.customId === 'cancel_remove_setup') {
                const cancelEmbed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('✅ İşlem İptal Edildi')
                    .setDescription('Kurulum kaldırma işlemi iptal edildi.')
                    .setFooter({
                        text: 'Admin Komutları',
                        iconURL: message.guild.iconURL
                    });

                await interaction.editReply({ embeds: [cancelEmbed], components: [] });
            }
        });

        collector.on('end', (collected, reason) => {
            if (reason === 'time') {
                const timeoutEmbed = new EmbedBuilder()
                    .setColor('#ffa500')
                    .setTitle('⏰ Zaman Aşımı')
                    .setDescription('30 saniye içinde yanıt verilmediği için işlem iptal edildi.')
                    .setFooter({
                        text: 'Admin Komutları',
                        iconURL: message.guild.iconURL
                    });

                reply.edit({ embeds: [timeoutEmbed], components: [] }).catch(() => {});
            }
        });

    } catch (error) {
        console.error('Kurulum kaldırma komutu hatası:', error);
        const embed = new EmbedBuilder()
            .setColor('#ff6b6b')
            .setTitle('❌ Komut Hatası')
            .setDescription('Beklenmeyen bir hata oluştu.')
            .setFooter({
                text: 'Admin Komutları',
                iconURL: message.guild.iconURL
            });

        message.reply({ embeds: [embed] });
    }
};

// Setup removal işlemi
const performSetupRemoval = async (guildId, serverId) => {
    console.log('🗑️ Bot: Starting setup removal for guild:', guildId);

    const botToken = process.env.DISCORD_BOT_TOKEN;
    const discordCleanupResults = { channelsDeleted: 0, webhooksDeleted: 0, errors: [] };

    try {
        // 1. Discord kanalları ve webhook'ları sil
        const { data: channelConfigs } = await supabase
            .from('log_channel_configs')
            .select('discord_channel_id, webhook_url')
            .eq('guild_id', guildId)
            .eq('is_active', true);

        if (botToken && channelConfigs) {
            console.log('🗑️ Bot: Cleaning up Discord channels and webhooks...');

            for (const config of channelConfigs) {
                // Kanalı sil
                if (config.discord_channel_id) {
                    try {
                        const deleteResponse = await fetch(
                            `https://discord.com/api/v10/channels/${config.discord_channel_id}`,
                            {
                                method: 'DELETE',
                                headers: { Authorization: `Bot ${botToken}` },
                            }
                        );

                        if (deleteResponse.ok) {
                            console.log(`✅ Bot: Deleted Discord channel: ${config.discord_channel_id}`);
                            discordCleanupResults.channelsDeleted++;
                        } else if (deleteResponse.status === 404) {
                            console.log(`⚠️ Bot: Channel already deleted: ${config.discord_channel_id}`);
                        } else {
                            const errorText = await deleteResponse.text();
                            console.error(`❌ Bot: Failed to delete channel ${config.discord_channel_id}:`, errorText);
                            discordCleanupResults.errors.push(`Channel ${config.discord_channel_id}: ${errorText}`);
                        }
                    } catch (error) {
                        console.error(`❌ Bot: Error deleting channel ${config.discord_channel_id}:`, error);
                        discordCleanupResults.errors.push(`Channel ${config.discord_channel_id}: ${String(error)}`);
                    }
                }

                // Webhook'u sil
                if (config.webhook_url) {
                    try {
                        const webhookMatch = config.webhook_url.match(/https:\/\/discord\.com\/api\/webhooks\/(\d+)\/(.+)/);
                        if (webhookMatch) {
                            const [, webhookId, webhookToken] = webhookMatch;
                            const deleteResponse = await fetch(
                                `https://discord.com/api/v10/webhooks/${webhookId}/${webhookToken}`,
                                { method: 'DELETE' }
                            );

                            if (deleteResponse.ok) {
                                console.log(`✅ Bot: Deleted webhook: ${webhookId}`);
                                discordCleanupResults.webhooksDeleted++;
                            } else if (deleteResponse.status === 404) {
                                console.log(`⚠️ Bot: Webhook already deleted: ${webhookId}`);
                            } else {
                                const errorText = await deleteResponse.text();
                                console.error(`❌ Bot: Failed to delete webhook ${webhookId}:`, errorText);
                                discordCleanupResults.errors.push(`Webhook ${webhookId}: ${errorText}`);
                            }
                        }
                    } catch (error) {
                        console.error(`❌ Bot: Error deleting webhook for ${config.webhook_url}:`, error);
                        discordCleanupResults.errors.push(`Webhook ${config.webhook_url}: ${String(error)}`);
                    }
                }
            }
        }

        // 2. Veritabanı kayıtlarını sil (foreign key sırasına göre)
        const deleteOperations = [
            // Store orders first (references store items)
            supabase.from('store_orders').delete().eq('server_id', serverId),
            // Store items
            supabase.from('store_items').delete().eq('server_id', serverId),
            // Promotions
            supabase.from('promotions').delete().eq('server_id', serverId),
            // Wallet ledger
            supabase.from('wallet_ledger').delete().eq('guild_id', guildId),
            // Member wallets
            supabase.from('member_wallets').delete().eq('guild_id', guildId),
            // Member profiles
            supabase.from('member_profiles').delete().eq('guild_id', guildId),
            // Web audit logs
            supabase.from('web_audit_logs').delete().eq('guild_id', guildId),
            // Notifications
            supabase.from('notifications').delete().eq('guild_id', guildId),
            // Notification reads
            supabase.from('notification_reads').delete().eq('guild_id', guildId),
            // Log channel configs
            supabase.from('log_channel_configs').delete().eq('guild_id', guildId).eq('is_active', true),
            // Bot log channels
            supabase.from('bot_log_channels').delete().eq('guild_id', guildId).eq('is_active', true),
            // Maintenance flags
            supabase.from('maintenance_flags').delete().eq('server_id', serverId),
            // Finally delete server
            supabase.from('servers').delete().eq('discord_id', guildId),
        ];

        const results = await Promise.allSettled(deleteOperations);

        // Hata kontrolü
        const errors = results
            .filter((result) => result.status === 'rejected')
            .map((result) => result.reason);

        if (errors.length > 0) {
            console.error('❌ Bot: Some delete operations failed:', errors);
            return {
                success: false,
                message: 'Bazı veriler silinirken hata oluştu.',
                discordCleanup: discordCleanupResults
            };
        }

        console.log('✅ Bot: Setup removed successfully for guild:', guildId);
        return {
            success: true,
            message: 'Kurulum başarıyla kaldırıldı. Tüm veriler, kanallar ve webhook\'lar temizlendi.',
            discordCleanup: discordCleanupResults
        };

    } catch (error) {
        console.error('❌ Bot: Setup removal error:', error);
        return {
            success: false,
            message: 'Kurulum kaldırılırken beklenmeyen bir hata oluştu.',
            discordCleanup: discordCleanupResults
        };
    }
};

module.exports = {
    handleMagazaEkleCommand,
    handlePromoKodCommand,
    handleMagazaSilCommand,
    handleBakimCommand,
    handleLogKanalCommand,
    handleLogKurCommand,
    handleKurulumKaldirCommand
};