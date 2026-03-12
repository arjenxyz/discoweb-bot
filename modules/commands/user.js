// modules/commands/user.js - Kullanıcı komutları
const { supabase } = require('../database');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const EMOJIS = require('../emojis');

// Otomatik kayıt fonksiyonu
const autoRegisterIfNeeded = async (userId, username) => {
    try {
        // Kullanıcı kayıtlı mı kontrol et
        const { data: existingUser } = await supabase
            .from('users')
            .select('id')
            .eq('discord_id', userId)
            .maybeSingle();

        // Kayıtlı değilse otomatik kaydet
        if (!existingUser) {
            const userData = {
                discord_id: userId,
                username: username,
                points: 0,
                role_level: 1
            };

            const { error } = await supabase
                .from('users')
                .upsert(userData);

            if (!error) {
                console.log(`🤖 Otomatik kayıt: ${username}`);
            }
        }
    } catch (error) {
        console.error('Otomatik kayıt hatası:', error);
    }
};

// !kayit komutu - gelişmiş versiyon
const handleKayitCommand = async (message) => {
    const userId = message.author.id;
    const username = message.author.username;

    console.log(`📝 Kayıt isteği geldi: ${username}`);

    try {
        // Önce kullanıcı kayıtlı mı kontrol et
        const { data: existingUser, error: checkError } = await supabase
            .from('users')
            .select('username, created_at, points, role_level')
            .eq('discord_id', userId)
            .maybeSingle();

        if (checkError) {
            console.error('Kayıt kontrol hatası:', checkError);
            message.reply('Bir hata oluştu, lütfen tekrar deneyin.');
            return;
        }

        if (existingUser) {
            const joinDate = new Date(existingUser.created_at).toLocaleDateString('tr-TR');

            const embed = new EmbedBuilder()
                .setColor('#ffa500')
                .setTitle('✅ Zaten Kayıtlısın!')
                .setDescription(`**${existingUser.username}**, sistemde zaten kayıtlısın.`)
                .setThumbnail(message.author.displayAvatarURL ? message.author.displayAvatarURL({ dynamic: true, size: 128 }) : message.author.avatarURL({ dynamic: true, size: 128 }))
                .addFields(
                    {
                        name: '📅 Kayıt Tarihi',
                        value: joinDate,
                        inline: true
                    },
                    {
                        name: '⭐ Rol Seviyesi',
                        value: `Seviye ${existingUser.role_level}`,
                        inline: true
                    },
                    {
                        name: '💰 Puan',
                        value: existingUser.points.toString(),
                        inline: true
                    }
                )
                .setFooter({
                    text: 'Sistem özelliklerini kullanmaya devam edebilirsin!',
                    iconURL: message.guild.iconURL
                })
                .setTimestamp();

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('view_profile')
                        .setLabel('👤 Profil Görüntüle')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('view_wallet')
                        .setLabel('💰 Cüzdan Görüntüle')
                        .setStyle(ButtonStyle.Success)
                );

            message.reply({ embeds: [embed], components: [row] });
            return;
        }

        // Veriyi hazırla
        const userData = {
            discord_id: userId,
            username: username,
            points: 0,
            role_level: 1
        };

        // Supabase'e Yaz
        const { data, error } = await supabase
            .from('users')
            .upsert(userData)
            .select();

        if (error) {
            console.error('❌ Supabase kayıt hatası:', error);
            message.reply('❌ Bir hata oluştu, veritabanına bağlanılamadı. Lütfen daha sonra tekrar deneyin.');
        } else {
            console.log('✅ Veritabanına yazıldı:', username);

            // Başarılı kayıt embed'i
            const embed = new EmbedBuilder()
                .setColor('#00ff88')
                .setTitle('🎉 Hoş Geldin!')
                .setDescription(`**${username}**, başarıyla sisteme kaydedildin!`)
                .setThumbnail(message.author.displayAvatarURL ? message.author.displayAvatarURL() : null)
                .addFields(
                    {
                        name: '✅ Kayıt Durumu',
                        value: 'Başarıyla tamamlandı',
                        inline: true
                    },
                    {
                        name: '🎮 Artık Yapabileceklerin',
                        value: '• Mağazadan rol satın al\n• Mesaj ve ses ile para kazan\n• Cüzdanını yönet\n• Promosyon kodlarını kullan',
                        inline: false
                    },
                    {
                        name: '💡 İpucu',
                        value: 'İlk mesajında otomatik kayıt olursun, bu komutu tekrar kullanmana gerek yok!',
                        inline: false
                    }
                )
                .setFooter({
                    text: 'Para Sistemi • Keyifli vakitler!',
                    iconURL: message.guild.iconURL
                })
                .setTimestamp();

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('view_store')
                        .setLabel('🛒 Mağazaya Git')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('view_profile')
                        .setLabel('👤 Profil Görüntüle')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('earn_money')
                        .setLabel('💰 Para Kazan')
                        .setStyle(ButtonStyle.Secondary)
                );

            message.reply({ embeds: [embed], components: [row] });
        }
    } catch (error) {
        console.error('Kayıt komutu hatası:', error);
        message.reply('❌ Beklenmeyen bir hata oluştu. Lütfen daha sonra tekrar deneyin.');
    }
};

// !profil komutu - kullanıcı profili göster
const handleProfilCommand = async (message) => {
    const userId = message.author.id;

    try {
        // Kullanıcı bilgilerini al
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('username, points, role_level, created_at')
            .eq('discord_id', userId)
            .maybeSingle();

        if (userError || !user) {
            message.reply('❌ Profil bulunamadı. Önce `!kayit` olmalısın!');
            return;
        }

        // Cüzdan bilgilerini al
        const { data: wallet } = await supabase
            .from('member_wallets')
            .select('balance')
            .eq('guild_id', message.guild.id)
            .eq('user_id', userId)
            .maybeSingle();

        // Günlük istatistikleri al
        const today = new Date().toISOString().split('T')[0];
        const { data: todayStats } = await supabase
            .from('member_daily_stats')
            .select('message_count, voice_minutes')
            .eq('guild_id', message.guild.id)
            .eq('user_id', userId)
            .eq('stat_date', today)
            .maybeSingle();

        const joinDate = new Date(user.created_at).toLocaleDateString('tr-TR');
        const balance = wallet?.balance || 0;
        const messages = todayStats?.message_count || 0;
        const voiceMinutes = todayStats?.voice_minutes || 0;

        // Profesyonel profil embed'i
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('👤 Kullanıcı Profili')
            .setDescription(`**${user.username}** kullanıcısının detaylı bilgileri`)
            .setThumbnail(message.author.displayAvatarURL ? message.author.displayAvatarURL() : null)
            .addFields(
                {
                    name: '📅 Kayıt Tarihi',
                    value: joinDate,
                    inline: true
                },
                {
                    name: '⭐ Rol Seviyesi',
                    value: `Seviye ${user.role_level}`,
                    inline: true
                },
                {
                    name: '💰 Puan',
                    value: user.points.toString(),
                    inline: true
                },
                {
                    name: '💵 Cüzdan Bakiyesi',
                    value: `${balance.toLocaleString('tr-TR')} ₺`,
                    inline: true
                },
                {
                    name: '💬 Bugün Mesaj',
                    value: `${messages} adet`,
                    inline: true
                },
                {
                    name: '🎤 Bugün Ses',
                    value: `${voiceMinutes} dakika`,
                    inline: true
                }
            )
            .setFooter({
                text: 'Kullanıcı Profil Sistemi',
                iconURL: message.guild.iconURL || null
            })
            .setTimestamp();

        // Profil butonları
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('view_wallet')
                    .setLabel('💰 Cüzdan')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('view_stats')
                    .setLabel('📊 İstatistikler')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('edit_profile')
                    .setLabel('⚙️ Düzenle')
                    .setStyle(ButtonStyle.Success)
            );

        message.reply({ embeds: [embed], components: [row] });

    } catch (error) {
        console.error('Profil komutu hatası:', error);
        message.reply('❌ Profil bilgileri alınırken hata oluştu.');
    }
};

// !para komutu - cüzdan bakiyesi göster
const handleParaCommand = async (message) => {
    const userId = message.author.id;
    const guildId = message.guild.id;

    console.log(`🔍 Para sorgusu: userId=${userId}, guildId=${guildId}`);

    try {
        // Cüzdan bilgilerini al
        const { data: wallet, error } = await supabase
            .from('member_wallets')
            .select('balance, updated_at')
            .eq('guild_id', guildId)
            .eq('user_id', userId)
            .maybeSingle();

        if (error) {
            console.error('Para komutu hatası:', error);
            message.reply('❌ Cüzdan bilgileri alınırken hata oluştu.');
            return;
        }

        const balance = wallet?.balance || 0;
        const lastUpdate = wallet?.updated_at
            ? new Date(wallet.updated_at).toLocaleString('tr-TR')
            : 'Hiç işlem yapılmamış';

        // Profesyonel embed oluştur
        const embed = new EmbedBuilder()
            .setColor('#00ff88')
            .setTitle('💰 Cüzdan Bilgileri')
            .setDescription(`**${message.author.username}** kullanıcısının cüzdan durumu`)
            .setThumbnail(message.author.displayAvatarURL ? message.author.displayAvatarURL() : null)
            .addFields(
                {
                    name: '🪙 Mevcut Bakiye',
                    value: `**${balance.toLocaleString('tr-TR')} ₺**`,
                    inline: true
                },
                {
                    name: '📅 Son Güncelleme',
                    value: lastUpdate,
                    inline: true
                },
                {
                    name: '💡 İpucu',
                    value: 'Para kazanmak için mesaj yazın veya ses kanalına katılın!',
                    inline: false
                }
            )
            .setFooter({
                text: 'Para Sistemi • Bot tarafından yönetiliyor',
                iconURL: message.guild.iconURL || null
            })
            .setTimestamp();

        // Butonlar oluştur
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('refresh_balance')
                    .setLabel('🔄 Yenile')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('view_profile')
                    .setLabel('👤 Profil')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId('view_store')
                    .setLabel('🛒 Mağaza')
                    .setStyle(ButtonStyle.Success)
            );

        message.reply({ embeds: [embed], components: [row] });

    } catch (error) {
        console.error('Para komutu hatası:', error);
        message.reply('❌ Beklenmeyen bir hata oluştu.');
    }
};

// !top komutu - en zengin kullanıcılar
const handleTopCommand = async (message) => {
    const guildId = message.guild.id;

    try {
        // En zengin 10 kullanıcıyı al
        const { data: topUsers, error } = await supabase
            .from('member_wallets')
            .select('user_id, balance')
            .eq('guild_id', guildId)
            .order('balance', { ascending: false })
            .limit(10);

        if (error) {
            console.error('Top komutu hatası:', error);
            message.reply('❌ Sıralama alınırken hata oluştu.');
            return;
        }

        if (!topUsers || topUsers.length === 0) {
            const embed = new EmbedBuilder()
                .setColor('#ff6b6b')
                .setTitle('🏆 Zenginlik Sıralaması')
                .setDescription('Henüz kimse para kazanmamış!')
                .setFooter({
                    text: 'Para kazanmak için aktif olun!',
                    iconURL: message.guild.iconURL
                });
            message.reply({ embeds: [embed] });
            return;
        }

        // Top 10 listesini embed fields olarak oluştur
        const fields = [];
        for (let i = 0; i < topUsers.length; i++) {
            const user = topUsers[i];
            const discordUser = await message.guild.members.fetch(user.user_id).catch(() => null);
            const username = discordUser ? discordUser.displayName : 'Bilinmeyen';

            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
            const balance = user.balance.toLocaleString('tr-TR');

            fields.push({
                name: `${medal} ${username}`,
                value: `💰 ${balance} ₺`,
                inline: true
            });
        }

        const embed = new EmbedBuilder()
            .setColor('#ffd700')
            .setTitle('🏆 En Zengin Kullanıcılar')
            .setDescription('Sunucudaki en zengin üyelerin sıralaması')
            .setThumbnail(message.guild.iconURL || null)
            .addFields(fields)
            .setFooter({
                text: `Toplam ${topUsers.length} kullanıcı • ${new Date().toLocaleDateString('tr-TR')}`,
                iconURL: message.guild.iconURL || null
            })
            .setTimestamp();

        // Yenile butonu
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('refresh_leaderboard')
                    .setLabel('🔄 Yenile')
                    .setStyle(ButtonStyle.Secondary)
            );

        message.reply({ embeds: [embed], components: [row] });

    } catch (error) {
        console.error('Top komutu hatası:', error);
        message.reply('❌ Beklenmeyen bir hata oluştu.');
    }
};

const handleSiparislerimCommand = async (message, guild = null) => {
    try {
        const userId = message.author?.id || message.user?.id;
        const guildObj = guild || message.guild;
        const replyFunc = message.reply || message.editReply;

        // Kullanıcının bekleyen siparişlerini çek
        const { data: orders, error } = await supabase
            .from('store_orders')
            .select('id,item_title,amount,status,created_at,duration_days,role_id,failure_reason')
            .eq('user_id', userId)
            .eq('status', 'pending')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Siparişler hatası:', error);
            const embed = new EmbedBuilder()
                .setColor('#ff4444')
                .setTitle('❌ Siparişler Getirilemedi')
                .setDescription('Siparişleriniz alınırken bir teknik sorun oluştu.')
                .setThumbnail('https://cdn.discordapp.com/attachments/123456789012345678/123456789012345678/error-icon.png')
                .addFields(
                    {
                        name: '🔧 Teknik Destek',
                        value: 'Lütfen daha sonra tekrar deneyin. Sorun devam ederse yetkiliye başvurun.',
                        inline: false
                    }
                )
                .setFooter({
                    text: '💻 Sistem hatası • Lütfen bekleyin',
                    iconURL: null
                })
                .setTimestamp();

            return replyFunc({ embeds: [embed] });
        }

        if (!orders || orders.length === 0) {
            const embed = new EmbedBuilder()
                .setColor('#2f3136')
                .setTitle('📭 Bekleyen Sipariş Yok')
                .setDescription('Şu anda bekleyen siparişiniz bulunmuyor.')
                .setThumbnail('https://cdn.discordapp.com/attachments/123456789012345678/123456789012345678/empty-cart.png')
                .addFields(
                    {
                        name: '🛒 Mağaza Keşfi',
                        value: 'Mükemmel ürünlerimizi keşfetmek için `/yardim` komutunu kullanın veya web sitemize göz atın!',
                        inline: false
                    }
                )
                .setFooter({
                    text: '💎 Premium ürünler sizi bekliyor',
                    iconURL: null
                })
                .setTimestamp();

            return replyFunc({ embeds: [embed] });
        }

        // Sipariş istatistiklerini hesapla
        const totalAmount = orders.reduce((sum, order) => sum + Number(order.amount), 0);
        const oldestOrder = orders.reduce((oldest, order) => 
            new Date(order.created_at) < new Date(oldest.created_at) ? order : oldest
        );

        // Siparişleri embed fields olarak hazırla
        const fields = orders.map((order, index) => {
            const createdDate = new Date(order.created_at).toLocaleDateString('tr-TR', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });

            const durationText = order.duration_days > 0 ? `${order.duration_days} gün` : '♾️ Kalıcı';
            const orderId = order.id.slice(-8).toUpperCase(); // Son 8 karakter

            return {
                name: `${EMOJIS.PACKAGE} ${order.item_title}`,
                value: `\`\`\`yaml\nID: ${orderId}\n${EMOJIS.MONEY} Tutar: ${order.amount.toLocaleString('tr-TR')} ₺\n${EMOJIS.CLOCK} Tarih: ${createdDate}\n${EMOJIS.HOURGLASS} Süre: ${durationText}\n${EMOJIS.CHART} Durum: Bekleniyor\n\`\`\``,
                inline: true
            };
        });

        const embed = new EmbedBuilder()
            .setColor('#2f3136') // Discord dark theme rengi
            .setTitle(`${EMOJIS.SHOPPING} Bekleyen Siparişleriniz`)
            .setDescription(`**${orders.length}** adet bekleyen siparişiniz bulunmaktadır.`)
            .setThumbnail('https://cdn.discordapp.com/attachments/123456789012345678/123456789012345678/package-icon.png') // Placeholder
            .addFields(
                {
                    name: `${EMOJIS.CHART} Sipariş Özeti`,
                    value: `\`\`\`diff\n+ Toplam Tutar: ${totalAmount.toLocaleString('tr-TR')} ₺\n+ Sipariş Sayısı: ${orders.length}\n+ En Eski: ${new Date(oldestOrder.created_at).toLocaleDateString('tr-TR')}\n\`\`\``,
                    inline: false
                }
            )
            .addFields(fields)
            .setFooter({
                text: '💡 Siparişleriniz otomatik olarak işlenir • Destek için yetkiliye başvurun',
                iconURL: null
            })
            .setTimestamp();

        replyFunc({ embeds: [embed] });

    } catch (error) {
        console.error('Siparişlerim komutu hatası:', error);
        message.reply('❌ Beklenmeyen bir hata oluştu.');
    }
};

module.exports = {
    autoRegisterIfNeeded,
    handleKayitCommand,
    handleProfilCommand,
    handleTopCommand,
    handleSiparislerimCommand
};