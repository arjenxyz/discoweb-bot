// modules/errorHandler.js - Akıllı Hata Kategorileri Sistemi

/**
 * Gelişmiş Hata Kategorileri ve İşleme Sistemi
 * Her hata türü için otomatik çözüm, retry ve bildirim stratejisi
 */

const { systemLogChannelId } = require('./config');

/**
 * Sistem hatalarını sadece developer kanalına gönder
 * Sunucu adminlerinin görmemesi için
 */
async function logSystemError(client, error, context = {}) {
    console.log('🔍 logSystemError called with:', { systemLogChannelId, error: error.message, context });

    if (!systemLogChannelId) {
        console.warn('SYSTEM_LOG_CHANNEL_ID not configured, system errors will not be logged');
        return;
    }

    try {
        console.log(`🔍 Fetching system log channel: ${systemLogChannelId}`);
        const channel = await client.channels.fetch(systemLogChannelId);
        console.log(`🔍 Channel fetched:`, channel?.name || 'NOT FOUND');

        if (!channel) {
            console.error(`System log channel ${systemLogChannelId} not found`);
            return;
        }

        const embed = {
            color: 0xff0000,
            title: '🚨 Sistem Hatası',
            description: 'Bot sisteminde kritik bir hata oluştu',
            fields: [
                {
                    name: 'Hata',
                    value: error.message || 'Bilinmeyen hata',
                    inline: false
                },
                {
                    name: 'Konum',
                    value: context.location || 'Bilinmiyor',
                    inline: true
                },
                {
                    name: 'Zaman',
                    value: new Date().toISOString(),
                    inline: true
                }
            ],
            timestamp: new Date()
        };

        if (context.stack) {
            embed.fields.push({
                name: 'Stack Trace',
                value: `\`\`\`\n${context.stack.substring(0, 1000)}\n\`\`\``,
                inline: false
            });
        }

        if (context.userId) {
            embed.fields.push({
                name: 'Kullanıcı',
                value: `<@${context.userId}>`,
                inline: true
            });
        }

        if (context.guildId) {
            embed.fields.push({
                name: 'Sunucu',
                value: context.guildId,
                inline: true
            });
        }

        console.log('🔍 Sending system error embed to channel');
        await channel.send({ embeds: [embed] });
        console.log('✅ System error logged successfully');
    } catch (logError) {
        console.error('Failed to log system error:', logError);
    }
}

const ERROR_CATEGORIES = {
    // 🔗 Ağ ve Bağlantı Hataları
    NETWORK: {
        API_UNAVAILABLE: {
            code: 'NET_001',
            title: 'Discord API Erişilemiyor',
            description: 'Discord API yanıt vermiyor veya erişilemiyor',
            severity: 'HIGH',
            autoRetry: true,
            retryDelay: 5 * 60 * 1000, // 5 dakika
            maxRetries: 3,
            adminAlert: true,
            userMessage: 'Sistem şu anda meşgul. Lütfen birkaç dakika sonra tekrar deneyin.',
            solution: 'Discord API durumunu kontrol et, VPN kullan, rate limit kontrolü yap'
        },
        TIMEOUT: {
            code: 'NET_002',
            title: 'İşlem Zaman Aşımı',
            description: 'Discord API yanıtı çok uzun sürdü',
            severity: 'MEDIUM',
            autoRetry: true,
            retryDelay: 2 * 60 * 1000, // 2 dakika
            maxRetries: 2,
            adminAlert: false,
            userMessage: 'İşlem zaman aşımına uğradı. Otomatik olarak tekrar deneniyor.',
            solution: 'Timeout süresini artır, network bağlantısını kontrol et'
        },
        RATE_LIMIT: {
            code: 'NET_003',
            title: 'Rate Limit Aşıldı',
            description: 'Discord API rate limit sınırına ulaşıldı',
            severity: 'MEDIUM',
            autoRetry: true,
            retryDelay: 60 * 1000, // 1 dakika
            maxRetries: 5,
            adminAlert: false,
            userMessage: 'Sistem yoğun. Kısa süre sonra otomatik olarak işlenecek.',
            solution: 'Rate limit stratejisini gözden geçir, batch processing kullan'
        }
    },

    // 🔐 İzin ve Yetki Hataları
    PERMISSION: {
        BOT_MISSING_PERMISSIONS: {
            code: 'PERM_001',
            title: 'Bot Yetkisi Yok',
            description: 'Bot gerekli Discord yetkisine sahip değil',
            severity: 'CRITICAL',
            autoRetry: false,
            adminAlert: true,
            userMessage: 'Sistem yapılandırma hatası. Lütfen yöneticilere başvurun.',
            solution: 'Bot\'a "Manage Roles" yetkisi ver, rol hierarchy\'sini kontrol et'
        },
        ROLE_HIERARCHY: {
            code: 'PERM_002',
            title: 'Rol Hierarchy Problemi',
            description: 'Bot verilen rolü yerleştiremiyor (hierarchy düşük)',
            severity: 'HIGH',
            autoRetry: false,
            adminAlert: true,
            userMessage: 'Rol atama hatası. Lütfen yöneticilere başvurun.',
            solution: 'Bot rolünü en üste taşı, rol izinlerini kontrol et'
        },
        CHANNEL_ACCESS: {
            code: 'PERM_003',
            title: 'Kanal Erişimi Yok',
            description: 'Bot kanala erişemiyor veya mesaj gönderemiyor',
            severity: 'HIGH',
            autoRetry: true,
            retryDelay: 10 * 60 * 1000, // 10 dakika
            maxRetries: 2,
            adminAlert: true,
            userMessage: 'Bildirim gönderilemedi. İşlem tamamlandı.',
            solution: 'Bot\'un kanal izinlerini kontrol et'
        }
    },

    // 📊 Veri ve Yapılandırma Hataları
    DATA: {
        INVALID_ROLE_ID: {
            code: 'DATA_001',
            title: 'Geçersiz Rol ID',
            description: 'Belirtilen rol ID sunucuda bulunmuyor',
            severity: 'HIGH',
            autoRetry: false,
            adminAlert: true,
            userMessage: 'Ürün yapılandırma hatası. Lütfen yöneticilere başvurun.',
            solution: 'Rol ID\'sini kontrol et, ürünü yeniden düzenle'
        },
        MISSING_PRODUCT_DATA: {
            code: 'DATA_002',
            title: 'Ürün Verisi Eksik',
            description: 'Ürün bilgileri eksik veya bozuk',
            severity: 'HIGH',
            autoRetry: false,
            adminAlert: true,
            userMessage: 'Ürün bilgisi bulunamadı. Lütfen tekrar deneyin.',
            solution: 'Ürün verilerini kontrol et, eksik alanları doldur'
        },
        INVALID_USER_DATA: {
            code: 'DATA_003',
            title: 'Geçersiz Kullanıcı Verisi',
            description: 'Kullanıcı bilgileri hatalı veya eksik',
            severity: 'MEDIUM',
            autoRetry: true,
            retryDelay: 5 * 60 * 1000, // 5 dakika
            maxRetries: 2,
            adminAlert: false,
            userMessage: 'Kullanıcı bilgileri güncelleniyor. Lütfen bekleyin.',
            solution: 'Kullanıcı verilerini yeniden senkronize et'
        }
    },

    // 👤 Kullanıcı İle İlgili Hatalar
    USER: {
        USER_NOT_FOUND: {
            code: 'USER_001',
            title: 'Kullanıcı Bulunamadı',
            description: 'Kullanıcı sunucuda bulunmuyor',
            severity: 'MEDIUM',
            autoRetry: true,
            retryDelay: 30 * 60 * 1000, // 30 dakika
            maxRetries: 3,
            adminAlert: false,
            userMessage: 'Kullanıcı sunucuda bulunamadı. Daha sonra tekrar kontrol edilecek.',
            solution: 'Kullanıcının sunucuda olup olmadığını kontrol et'
        },
        USER_LEFT_GUILD: {
            code: 'USER_002',
            title: 'Kullanıcı Sunucudan Ayrıldı',
            description: 'Kullanıcı sipariş verdikten sonra sunucudan ayrılmış',
            severity: 'LOW',
            autoRetry: false,
            adminAlert: false,
            userMessage: 'Sipariş tamamlandı (kullanıcı sunucudan ayrılmış)',
            solution: 'Otomatik olarak tamamlandı olarak işaretle'
        },
        USER_BANNED: {
            code: 'USER_003',
            title: 'Kullanıcı Yasaklandı',
            description: 'Kullanıcı sunucudan yasaklanmış',
            severity: 'LOW',
            autoRetry: false,
            adminAlert: false,
            userMessage: 'Sipariş tamamlandı (kullanıcı yasaklanmış)',
            solution: 'Otomatik olarak tamamlandı olarak işaretle'
        }
    },

    // ⚙️ Sistem ve Teknik Hatalar
    SYSTEM: {
        DATABASE_ERROR: {
            code: 'SYS_001',
            title: 'Veritabanı Hatası',
            description: 'Veritabanı bağlantı veya sorgu hatası',
            severity: 'CRITICAL',
            autoRetry: true,
            retryDelay: 1 * 60 * 1000, // 1 dakika
            maxRetries: 3,
            adminAlert: true,
            userMessage: 'Sistem hatası. Lütfen daha sonra tekrar deneyin.',
            solution: 'Database bağlantısını kontrol et, connection pool\'u kontrol et'
        },
        MEMORY_ERROR: {
            code: 'SYS_002',
            title: 'Bellek Hatası',
            description: 'Sistem belleği yetersiz',
            severity: 'CRITICAL',
            autoRetry: false,
            adminAlert: true,
            userMessage: 'Sistem aşırı yüklenmiş. Lütfen daha sonra tekrar deneyin.',
            solution: 'Memory kullanımını kontrol et, restart yap'
        },
        PROCESS_CRASH: {
            code: 'SYS_003',
            title: 'İşlem Çöktü',
            description: 'Bot işlemi beklenmedik şekilde durdu',
            severity: 'CRITICAL',
            autoRetry: true,
            retryDelay: 2 * 60 * 1000, // 2 dakika
            maxRetries: 2,
            adminAlert: true,
            userMessage: 'Geçici sistem hatası. Otomatik olarak düzeltiliyor.',
            solution: 'Process monitoring ekle, auto-restart yap'
        }
    },

    // ⏰ Zaman ve Süre Hataları
    TIMING: {
        ORDER_TIMEOUT: {
            code: 'TIME_001',
            title: 'Sipariş Zaman Aşımı',
            description: 'Sipariş çok uzun süredir bekliyor',
            severity: 'MEDIUM',
            autoRetry: false,
            adminAlert: false,
            userMessage: 'Sipariş zaman aşımına uğradı. Otomatik olarak iade edildi.',
            solution: 'Timeout süresini ayarla, queue sistemini iyileştir'
        },
        RETRY_LIMIT_EXCEEDED: {
            code: 'TIME_002',
            title: 'Retry Limiti Aşıldı',
            description: 'Maksimum retry sayısına ulaşıldı',
            severity: 'HIGH',
            autoRetry: false,
            adminAlert: true,
            userMessage: 'İşlem birden çok kez başarısız oldu. Lütfen destek ile iletişime geçin.',
            solution: 'Hata nedenini araştır, manuel müdahale yap'
        }
    },

    // 🛒 Ürün ve Stok Hataları
    PRODUCT: {
        OUT_OF_STOCK: {
            code: 'PROD_001',
            title: 'Stok Tükendi',
            description: 'Ürün stokta yok',
            severity: 'MEDIUM',
            autoRetry: false,
            adminAlert: false,
            userMessage: 'Ürün şu anda stokta yok. Lütfen daha sonra tekrar deneyin.',
            solution: 'Stok yönetim sistemini kontrol et'
        },
        PRODUCT_DISABLED: {
            code: 'PROD_002',
            title: 'Ürün Devre Dışı',
            description: 'Ürün yönetici tarafından devre dışı bırakılmış',
            severity: 'LOW',
            autoRetry: false,
            adminAlert: false,
            userMessage: 'Bu ürün şu anda mevcut değil.',
            solution: 'Ürün durumunu kontrol et'
        }
    }
};

/**
 * Hata koduna göre hata bilgilerini döndürür
 */
function getErrorInfo(errorCode) {
    for (const category of Object.values(ERROR_CATEGORIES)) {
        for (const error of Object.values(category)) {
            if (error.code === errorCode) {
                return error;
            }
        }
    }
    return null;
}

/**
 * Hata logunu oluşturur ve kaydeder
 */
async function logError(errorInfo, context = {}) {
    const errorLog = {
        code: errorInfo.code,
        title: errorInfo.title,
        severity: errorInfo.severity,
        category: context.category || 'SYSTEM', // Kategoriyi context'ten al
        context: {
            ...context,
            error: context.error || new Error(errorInfo.description)
        },
        solution: generateSolution(errorInfo, context),
        timestamp: new Date()
    };

    // Veritabanına kaydet
    await saveErrorLog(errorLog);

    // Admin alert kontrolü
    if (errorInfo.adminAlert) {
        await sendAdminAlert(errorLog);
    }

    return errorLog;
}

/**
 * Hata türüne göre otomatik çözüm önerisi üretir
 */
function generateSolution(errorInfo, context = {}) {
    let solution = errorInfo.solution;

    // Context'e göre çözüm önerisini kişiselleştir
    if (context.orderId) {
        solution += `\n• Sipariş ID: ${context.orderId}`;
    }
    if (context.userId) {
        solution += `\n• Kullanıcı ID: ${context.userId}`;
    }
    if (context.retryCount) {
        solution += `\n• Retry sayısı: ${context.retryCount}`;
    }

    return solution;
}

/**
 * Hata loglama ve bildirim sistemi
 */
async function logError(errorInfo, context = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        code: errorInfo.code,
        title: errorInfo.title,
        severity: errorInfo.severity,
        context,
        solution: generateSolution(errorInfo, context)
    };

    console.error(`[${errorInfo.severity}] ${errorInfo.code}: ${errorInfo.title}`);
    console.error(`Çözüm: ${logEntry.solution}`);

    // Admin bildirim sistemi
    if (errorInfo.adminAlert) {
        await sendAdminNotification(logEntry, context.client);
    }

    // Veritabanına kaydet
    await saveErrorLog(logEntry);

    return logEntry;
}

/**
 * Admin'e hata bildirimi gönderir
 * Sistem hataları: Botun kendi sunucusuna
 * Admin hataları: İlgili sunucunun log kanalına
 */
async function sendAdminNotification(errorLog, client) {
    try {
        const config = require('./config');

        // Hata türüne göre kanal seçimi
        let targetChannelId = null;
        let targetGuildId = null;
        let mentionAdmins = false;

        // Sistem hataları (bot ile ilgili) - sadece developer kanalına gönder
        if (['SYSTEM', 'NETWORK'].includes(errorLog.category)) {
            console.log('🔍 Sistem hatası yakalandı, logSystemError çağrılıyor...');
            await logSystemError(client, new Error(errorLog.context?.error?.message || errorLog.title), {
                location: errorLog.code,
                severity: errorLog.severity,
                category: errorLog.category
            });
            return; // Sistem hatalarında normal log kanalına gönderme
        }
        // Admin hataları (sunucu ile ilgili)
        else {
            targetGuildId = errorLog.context?.guildId;
            if (targetGuildId) {
                targetChannelId = await getServerLogChannel(targetGuildId);
                mentionAdmins = ['CRITICAL', 'HIGH'].includes(errorLog.severity);
            }
        }

        if (!targetChannelId || !client) {
            // Fallback: console'a yaz
            console.log(`🚨 ADMIN ALERT: ${errorLog.title} (${errorLog.code})`);
            console.log(`Çözüm: ${errorLog.solution}`);
            return;
        }

        const guild = client.guilds.cache.get(targetGuildId);
        if (!guild) {
            console.error(`Guild bulunamadı: ${targetGuildId}`);
            return;
        }

        const channel = guild.channels.cache.get(targetChannelId);
        if (!channel) {
            console.error(`Log kanalı bulunamadı: ${targetChannelId}`);
            return;
        }

        // Embed oluştur
        const embed = {
            color: getSeverityColor(errorLog.severity),
            title: `🚨 ${errorLog.title}`,
            description: `**Kod:** ${errorLog.code}\n**Önem:** ${errorLog.severity}`,
            fields: [
                {
                    name: '🔍 Sorun',
                    value: errorLog.context?.error?.message || 'Bilinmeyen hata',
                    inline: false
                },
                {
                    name: '💡 Çözüm Önerisi',
                    value: errorLog.solution,
                    inline: false
                }
            ],
            timestamp: errorLog.timestamp,
            footer: {
                text: 'Bot Hata Bildirim Sistemi'
            }
        };

        // Context bilgilerini ekle
        if (errorLog.context) {
            const contextFields = [];
            if (errorLog.context.orderId) contextFields.push(`📦 Sipariş: ${errorLog.context.orderId}`);
            if (errorLog.context.userId) contextFields.push(`👤 Kullanıcı: ${errorLog.context.userId}`);
            if (errorLog.context.guildId) contextFields.push(`🏠 Sunucu: ${errorLog.context.guildId}`);
            if (errorLog.context.roleId) contextFields.push(`🎭 Rol: ${errorLog.context.roleId}`);

            if (contextFields.length > 0) {
                embed.fields.push({
                    name: '📋 Bağlam',
                    value: contextFields.join('\n'),
                    inline: false
                });
            }
        }

        // Admin rolünü etiketle (acil durumlar için)
        let messageContent = '';
        if (mentionAdmins) {
            const adminRole = guild.roles.cache.get(config.adminRoleId);
            if (adminRole) {
                messageContent = `${adminRole} **ACİL DURUM!**`;
            }
        }

        await channel.send({ content: messageContent, embeds: [embed] });

    } catch (notificationError) {
        console.error('Admin bildirimi gönderilemedi:', notificationError);
        // Fallback
        console.log(`🚨 ADMIN ALERT: ${errorLog.title} (${errorLog.code})`);
        console.log(`Çözüm: ${errorLog.solution}`);
    }
}

/**
 * Sistem log kanalını alır (.env'den)
 */
async function getSystemLogChannel(guildId) {
    try {
        const config = require('./config');

        // Sistem hataları için özel kanal (.env'den)
        if (config.systemLogChannelId) {
            return config.systemLogChannelId;
        }

        // Fallback: Veritabanından al (geriye uyumluluk için)
        const { supabase } = require('./database');
        const { data: server } = await supabase
            .from('servers')
            .select('system_log_channel_id')
            .eq('discord_id', guildId)
            .maybeSingle();

        return server?.system_log_channel_id;
    } catch (error) {
        console.error('Sistem log kanalı alınamadı:', error);
        return null;
    }
}

/**
 * Sunucu log kanalını alır
 */
async function getServerLogChannel(guildId) {
    try {
        const { supabase } = require('./database');
        const { data: server } = await supabase
            .from('servers')
            .select('log_channel_id')
            .eq('discord_id', guildId)
            .maybeSingle();

        return server?.log_channel_id;
    } catch (error) {
        console.error('Sunucu log kanalı alınamadı:', error);
        return null;
    }
}

/**
 * Önem derecesine göre renk döndürür
 */
function getSeverityColor(severity) {
    switch (severity) {
        case 'CRITICAL': return 0xFF0000; // Kırmızı
        case 'HIGH': return 0xFF6600;    // Turuncu
        case 'MEDIUM': return 0xFFFF00;  // Sarı
        case 'LOW': return 0x00FF00;     // Yeşil
        default: return 0x0099FF;        // Mavi
    }
}

/**
 * Hata logunu veritabanına kaydeder
 */
async function saveErrorLog(errorLog) {
    try {
        const { supabase } = require('./database');

        // BigInt'leri string'e çevir (JSON serialization için)
        const safeContext = JSON.parse(JSON.stringify(errorLog.context, (key, value) =>
            typeof value === 'bigint' ? value.toString() : value
        ));

        await supabase
            .from('error_logs')
            .insert({
                code: errorLog.code,
                title: errorLog.title,
                severity: errorLog.severity,
                category: errorLog.category,
                context: safeContext,
                solution: errorLog.solution,
                created_at: errorLog.timestamp
            });
    } catch (dbError) {
        console.error('Error log kaydedilemedi:', dbError);
    }
}

/**
 * Hata türüne göre retry stratejisi belirler
 */
function shouldRetry(errorInfo, currentRetryCount) {
    if (!errorInfo.autoRetry) return false;
    if (currentRetryCount >= errorInfo.maxRetries) return false;
    return true;
}

/**
 * Retry için bekleme süresini hesaplar
 */
function calculateRetryDelay(errorInfo, retryCount) {
    // Exponential backoff: Her retry'da süre 2 katına çıkar
    const baseDelay = errorInfo.retryDelay;
    const exponentialDelay = baseDelay * Math.pow(2, retryCount - 1);

    // Maximum 1 saat delay
    return Math.min(exponentialDelay, 60 * 60 * 1000);
}

/**
 * Ana hata işleme fonksiyonu
 */
async function handleError(errorType, category, context = {}) {
    // Backward compatibility: Eğer ilk parametre obje ise, eski format kullanılıyor
    if (typeof errorType === 'object' && errorType !== null) {
        const params = errorType;
        errorType = params.errorType || 'UNKNOWN_ERROR';
        category = params.category || 'SYSTEM';
        context = params.context || {};
        if (params.retryCount !== undefined) {
            context.retryCount = params.retryCount;
        }
        if (params.client) {
            context.client = params.client;
        }
    }

    const errorInfo = ERROR_CATEGORIES[category]?.[errorType];

    if (!errorInfo) {
        console.error(`Bilinmeyen hata: ${category}.${errorType}`);
        return null;
    }

    // Hata logla
    const errorLog = await logError(errorInfo, { ...context, category });

    // Retry kontrolü
    if (shouldRetry(errorInfo, context.retryCount || 0)) {
        const delay = calculateRetryDelay(errorInfo, context.retryCount || 0);
        console.log(`${delay / 1000} saniye sonra tekrar denenecek...`);

        setTimeout(() => {
            // Retry callback'i çağır
            if (context.retryCallback) {
                context.retryCallback();
            }
        }, delay);
    }

    return {
        errorInfo,
        shouldRetry: shouldRetry(errorInfo, context.retryCount || 0),
        retryDelay: calculateRetryDelay(errorInfo, context.retryCount || 0),
        userMessage: errorInfo.userMessage,
        adminMessage: generateSolution(errorInfo, context)
    };
}

module.exports = {
    ERROR_CATEGORIES,
    getErrorInfo,
    handleError,
    shouldRetry,
    calculateRetryDelay,
    logError,
    logSystemError
};