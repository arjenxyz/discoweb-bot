// modules/store.js
const { supabase, getGuild, getLocalDateStartIso } = require('./database');
const { handleError, ERROR_CATEGORIES } = require('./errorHandler');
const { EmbedBuilder } = require('discord.js');

// Render an HTML delivery-failure notification using inline CSS (Foxord-styled)
function renderDeliveryFailureHtml(orderId, failureCode = null) {
        const siteUrl = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL || '';
        const normalizedSite = siteUrl ? siteUrl.replace(/\/$/, '') : '';
        const refundUrl = normalizedSite ? `${normalizedSite}/api/member/refund?orderId=${orderId}` : null;
        const dateStr = new Date().toLocaleDateString('tr-TR');

        const labelMap = {
            'DATA_001': 'Rol Bulunamadı — Destek İste',
            'PERM_001': 'Bot Yetkisi Eksik — Destek',
            'PERM_002': 'Hiyerarşi Sorunu — Destek',
            'ROLE_ASSIGN_FAILED': '💰 İade İşlemini Başlat',
            'DEFAULT': '💰 İade İşlemini Başlat'
        };

        const label = (failureCode && labelMap[failureCode]) ? labelMap[failureCode] : labelMap['DEFAULT'];

        const buttonHtml = refundUrl
                ? `<a href="${refundUrl}" style="display:inline-block;background:#5865F2;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">${label}</a>`
                : `<span style="display:inline-block;padding:12px 18px;border-radius:8px;background:#444;color:#ddd">İade linki mevcut değil</span>`;

        return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
    body{background:#0f1113;margin:0;padding:24px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial;color:#e6eef8}
    .card{max-width:600px;margin:0 auto;background:#0b0c0d;border-radius:12px;padding:22px;border:1px solid rgba(255,255,255,0.03)}
    .header{display:flex;align-items:center;gap:12px}
    .logo{width:48px;height:48;border-radius:10px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#5865F2,#8b5cf6);font-weight:800;color:#fff}
    .title{font-size:18px;font-weight:800}
    .muted{color:#b9bbbe;font-size:13px}
    .body{background:#111214;padding:16px;border-radius:10px;margin-top:16px;color:#e6eef8;line-height:1.6}
    .meta{font-family:Courier New,monospace;background:rgba(255,255,255,0.02);padding:12px;border-radius:8px;margin-top:12px;color:#c5c7c9}
    .footer{margin-top:18px;color:#9aa0a6;font-size:13px}
    a.button{display:inline-block}
</style>
</head><body>
    <div class="card">
        <div class="header">
            <div class="logo">FOX</div>
            <div>
                <div class="title">🛠️ Sistem Raporu: İşlem Kesintisi Bildirimi</div>
                <div class="muted">DiscoWeb tarafından otomatik bildirim</div>
            </div>
        </div>

        <div class="body">
            <p>Merhaba, ben DiscoWeb Baş Geliştiricisi.</p>
            <p>Sistemimizdeki otomatik izleme protokolleri, az önce gerçekleştirmeye çalıştığın bir satın alma işleminde beklenmedik bir kesinti tespit etti. Kayıtlarımıza göre, Discord gateway senkronizasyonu veya bot servisindeki anlık bir kesinti (timeout) nedeniyle ürün teslimatın başarıyla finalize edilemedi.</p>

            <div class="meta"><strong>İşlem Detayları:</strong><br>Durum: <strong>FAILED_TO_DELIVER</strong><br>Hata Kodu: <strong>${failureCode || 'UNKNOWN'}</strong><br>İşlem Tarihi: <strong>${dateStr}</strong></div>

            <p style="margin-top:14px">Seni mağdur etmemek adına, sistem üzerinden Otomatik İade Protokolü'nü hazırladım. Aşağıdaki butonu kullanarak harcadığın Papel miktarını saniyeler içinde hesabına geri tanımlayabilirsin.</p>

            <div style="margin-top:12px">${buttonHtml}</div>

            <p style="margin-top:16px">Neden bu hatayı aldın?<br>Geliştirme aşamasında olduğumuz bazı modüllerde anlık veritabanı yoğunluğu yaşanabiliyor. Ekibimiz (yani ben) şu an bu "bottleneck" (darboğaz) sorununu çözmek için kodları optimize ediyor.</p>

            <div class="footer">Yaşanan aksaklık için özür dilerim. DiscoWeb'i geliştirmeye ve daha stabil hale getirmeye devam ediyoruz. - Developer</div>
        </div>
    </div>
</body></html>`;
}

let orderWorkerRunning = false;

// Log gönderme fonksiyonu
async function sendStoreLog(guildId, embed) {
    try {
        const { data: logChannel } = await supabase
            .from('bot_log_channels')
            .select('channel_id')
            .eq('guild_id', guildId)
            .eq('channel_type', 'store')
            .eq('is_active', true)
            .maybeSingle();

        if (!logChannel) return;

        const guild = await getGuild(null, guildId); // client null olabilir, guild'ı al
        if (!guild) return;

        const channel = guild.channels.cache.get(logChannel.channel_id);
        if (!channel) return;

        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('Store log gönderme hatası:', error);
    }
}

const processStoreOrders = async (client, guildId) => {
    if (!client.isReady()) return;

    console.log(`🔄 ${guildId} için store orders kontrol ediliyor...`);

    try {
        const nowIso = new Date().toISOString();

        // Önce bu guild'ın server_id'sini bul
        const { data: server, error: serverError } = await supabase
            .from('servers')
            .select('id')
            .eq('discord_id', guildId)
            .maybeSingle();

        if (serverError || !server) {
            await handleError('SERVER_NOT_FOUND', 'DATA', {
                guildId,
                error: serverError || new Error('Server not found'),
                client
            });
            return;
        }

        const { data: pendingOrders, error: pendingError } = await supabase
            .from('store_orders')
            .select('id,user_id,role_id,expires_at,duration_days,created_at,retry_count')
            .eq('server_id', server.id)
            .eq('status', 'paid')
            .is('applied_at', null)
            .limit(25);

        if (pendingError) {
            await handleError('DATABASE_ERROR', 'SYSTEM', {
                guildId,
                serverId: server.id,
                error: pendingError,
                client
            });
            return;
        } else if (pendingOrders?.length) {
            console.log(`📦 ${guildId} için ${pendingOrders.length} bekleyen sipariş bulundu`);
            const guild = await getGuild(client, guildId);
            for (const order of pendingOrders) {
                try {
                    const member = await guild.members.fetch(order.user_id).catch(() => null);
                    if (!member) {
                        console.log(`❌ ${order.user_id} üyesi bulunamadı, sipariş atlandı`);
                        const { error: updateError } = await supabase
                            .from('store_orders')
                            .update({ applied_at: nowIso })
                            .eq('id', order.id);

                        if (updateError) {
                            await handleError('DATABASE_ERROR', 'SYSTEM', {
                                orderId: order.id,
                                userId: order.user_id,
                                error: updateError,
                                retryCount: order.retry_count || 0,
                                client
                            });
                        }
                        continue;
                    }

                    if (!order.role_id) {
                        await supabase
                            .from('store_orders')
                            .update({ status: 'failed', failure_reason: 'Rol ID eksik.' })
                            .eq('id', order.id);
                        continue;
                    }

                    let expiresAt = null;
                    if (order.duration_days === 0) {
                        expiresAt = null;
                    } else {
                        const { data: permanentOrder } = await supabase
                            .from('store_orders')
                            .select('id')
                            .eq('user_id', order.user_id)
                            .eq('role_id', order.role_id)
                            .eq('status', 'paid')
                            .is('revoked_at', null)
                            .is('expires_at', null)
                            .neq('id', order.id)
                            .limit(1);

                        if (permanentOrder?.length) {
                            expiresAt = null;
                        } else {
                            const { data: activeOrders } = await supabase
                                .from('store_orders')
                                .select('expires_at')
                                .eq('user_id', order.user_id)
                                .eq('role_id', order.role_id)
                                .eq('status', 'paid')
                                .is('revoked_at', null)
                                .gt('expires_at', nowIso)
                                .neq('id', order.id)
                                .order('expires_at', { ascending: false })
                                .limit(1);

                            const baseIso = activeOrders?.length
                                ? activeOrders[0].expires_at
                                : nowIso;

                            expiresAt = new Date(
                                Date.parse(baseIso) + order.duration_days * 86400000,
                            ).toISOString();
                        }
                    }

                    if (!member.roles.cache.has(order.role_id)) {
                        // Önce rolün sunucuda var olup olmadığını kontrol et
                        const roleExists = guild.roles.cache.has(order.role_id);
                        if (!roleExists) {
                            // Geçersiz rol ID hatası
                            const errorResult = await handleError('INVALID_ROLE_ID', 'DATA', {
                                orderId: order.id,
                                userId: order.user_id,
                                roleId: order.role_id,
                                guildId,
                                retryCount: order.retry_count || 0,
                                client
                            });

                            await supabase
                                .from('store_orders')
                                .update({
                                    status: 'failed',
                                    failure_reason: errorResult.errorInfo.title,
                                    failure_code: errorResult.errorInfo.code,
                                    retry_count: (order.retry_count || 0) + 1,
                                    last_retry_at: new Date().toISOString()
                                })
                                .eq('id', order.id);
                            continue;
                        }

                        // Check bot role hierarchy and permissions before attempting to add
                        try {
                            const botMember = guild.members.me || (client && client.user ? await guild.members.fetch(client.user.id).catch(() => null) : null);
                            const roleObj = guild.roles.cache.get(order.role_id);
                            const botHighestPos = botMember?.roles?.highest?.position ?? -1;
                            const targetPos = roleObj?.position ?? 0;
                            if (botHighestPos <= targetPos) {
                                const errorResult = await handleError('BOT_ROLE_HIERARCHY', 'PERMISSION', {
                                    orderId: order.id,
                                    userId: order.user_id,
                                    roleId: order.role_id,
                                    guildId,
                                    retryCount: order.retry_count || 0,
                                    client
                                });

                                await supabase
                                    .from('store_orders')
                                    .update({
                                        status: 'failed',
                                        failure_reason: errorResult.errorInfo.title,
                                        failure_code: errorResult.errorInfo.code,
                                        retry_count: (order.retry_count || 0) + 1,
                                        last_retry_at: new Date().toISOString()
                                    })
                                    .eq('id', order.id);

                                // notify user
                                try {
                                    const html = renderDeliveryFailureHtml(order.id, errorResult?.errorInfo?.code || null);
                                    await supabase.from('system_mails').insert({
                                        guild_id: guildId,
                                        user_id: order.user_id,
                                        title: '🛠️ Sistem Raporu: İşlem Kesintisi Bildirimi',
                                        body: html,
                                        category: 'system',
                                        status: 'published',
                                        author_name: 'DiscoWeb Baş Geliştiricisi',
                                        created_at: new Date().toISOString()
                                    });
                                } catch (mailErr) {
                                    console.warn('Failed to insert delivery-failure system mail', mailErr);
                                }

                                continue;
                            }
                        } catch (hierErr) {
                            console.warn('Hierarchy check failed', hierErr);
                        }

                        const result = await member.roles.add(order.role_id).catch(async (err) => {
                            console.error('❌ Rol ekleme hatası:', err);

                            // Rol ekleme hatası - muhtemelen izin problemi
                            let errorType = 'BOT_MISSING_PERMISSIONS';
                            if (err.code === 50013) errorType = 'BOT_MISSING_PERMISSIONS';
                            else if (err.code === 50035) errorType = 'ROLE_HIERARCHY';

                            const errorResult = await handleError(errorType, 'PERMISSION', {
                                orderId: order.id,
                                userId: order.user_id,
                                roleId: order.role_id,
                                guildId,
                                errorCode: err.code,
                                retryCount: order.retry_count || 0,
                                client
                            });

                            await supabase
                                .from('store_orders')
                                .update({
                                    status: 'failed',
                                    failure_reason: errorResult.errorInfo.title,
                                    failure_code: errorResult.errorInfo.code,
                                    retry_count: (order.retry_count || 0) + 1,
                                    last_retry_at: new Date().toISOString()
                                })
                                .eq('id', order.id);
                            // Insert a system mail so the user is notified about delivery failure and can request a refund
                            try {
                                const html = renderDeliveryFailureHtml(order.id, errorResult?.errorInfo?.code || null);
                                await supabase.from('system_mails').insert({
                                    guild_id: guildId,
                                    user_id: order.user_id,
                                    title: '🛠️ Sistem Raporu: İşlem Kesintisi Bildirimi',
                                    body: html,
                                    category: 'system',
                                    status: 'published',
                                    author_name: 'DiscoWeb Baş Geliştiricisi',
                                    created_at: new Date().toISOString()
                                });
                            } catch (mailErr) {
                                console.warn('Failed to insert delivery-failure system mail', mailErr);
                            }
                            return null;
                        });

                        if (!result) {
                            continue;
                        }

                        // Başarılı mağaza satın alma logu
                        const embed = new EmbedBuilder()
                            .setColor('#4caf50')
                            .setTitle('🛒 Mağaza Satın Alma')
                            .setDescription(`<@${order.user_id}> bir ürün satın aldı`)
                            .addFields(
                                { name: 'Kullanıcı', value: `<@${order.user_id}>`, inline: true },
                                { name: 'Rol', value: `<@&${order.role_id}>`, inline: true },
                                { name: 'Süre', value: order.duration_days === 0 ? 'Kalıcı' : `${order.duration_days} gün`, inline: true }
                            )
                            .setTimestamp();

                        await sendStoreLog(guildId, embed);
                    }

                    await supabase
                        .from('store_orders')
                        .update({ applied_at: nowIso, expires_at: expiresAt })
                        .eq('id', order.id);
                } catch (err) {
                    console.error('❌ Sipariş işleme hatası:', err);
                }
            }
        }

        const { data: expiredOrders, error: expiredError } = await supabase
            .from('store_orders')
            .select('id,user_id,role_id,retry_count')
            .eq('server_id', server.id)
            .eq('status', 'paid')
            .not('expires_at', 'is', null)
            .lte('expires_at', nowIso)
            .is('revoked_at', null)
            .limit(25);

        if (expiredError) {
            await handleError('DATABASE_ERROR', 'SYSTEM', {
                guildId,
                serverId: server.id,
                error: expiredError,
                client
            });
        } else if (expiredOrders?.length) {
            const guild = await getGuild(client, guildId);
            for (const order of expiredOrders) {
                try {
                    const { data: stillActive } = await supabase
                        .from('store_orders')
                        .select('id')
                        .eq('user_id', order.user_id)
                        .eq('role_id', order.role_id)
                        .eq('status', 'paid')
                        .is('revoked_at', null)
                        .neq('id', order.id)
                        .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
                        .limit(1);

                    if (!stillActive?.length) {
                        const member = await guild.members.fetch(order.user_id).catch(() => null);
                        if (member?.roles.cache.has(order.role_id)) {
                            const result = await member.roles.remove(order.role_id).catch((err) => {
                                return handleError({
                                    error: err,
                                    context: { orderId: order.id, userId: order.user_id, roleId: order.role_id },
                                    category: ERROR_CATEGORIES.PERMISSION.ROLE_REMOVAL_FAILED,
                                    orderId: order.id,
                                    retryCount: order.retry_count || 0
                                });
                            });

                            if (!result) {
                                // handleError zaten durumu işledi
                                continue;
                            }
                        }
                    }

                    const { error: revokeError } = await supabase
                        .from('store_orders')
                        .update({ revoked_at: nowIso })
                        .eq('id', order.id);

                    if (revokeError) {
                        await handleError('DATABASE_ERROR', 'SYSTEM', {
                            orderId: order.id,
                            userId: order.user_id,
                            error: revokeError,
                            retryCount: order.retry_count || 0,
                            client
                        });
                    }
                } catch (err) {
                    await handleError('PROCESS_CRASH', 'SYSTEM', {
                        orderId: order.id,
                        userId: order.user_id,
                        error: err,
                        retryCount: order.retry_count || 0,
                        client
                    });
                }
            }
        }
    } catch (err) {
        console.error(`❌ ${guildId} için store orders işleme hatası:`, err);
    }
};

const processPendingOrdersAtMidnight = async (client, guildId, timezoneOffsetMinutes) => {
    if (!client.isReady() || orderWorkerRunning) return;
    orderWorkerRunning = true;

    try {
        const nowIso = new Date().toISOString();
        const todayStartIso = getLocalDateStartIso(timezoneOffsetMinutes);

        const { data: pendingOrders, error } = await supabase
            .from('store_orders')
            .select('id,user_id,role_id,duration_days,created_at,retry_count')
            .eq('status', 'pending')
            .lt('created_at', todayStartIso)
            .limit(50);

        if (error) {
            await handleError('DATABASE_ERROR', 'SYSTEM', {
                guildId,
                timezoneOffsetMinutes,
                error: error,
                client
            });
            return;
        }

        if (!pendingOrders?.length) return;

        const guild = await getGuild(client, guildId);
        for (const order of pendingOrders) {
            try {
                const member = await guild.members.fetch(order.user_id).catch(() => null);
                if (!member) {
                    // Kullanıcı sunucuda değil, bu bir geçici durum olabilir
                    await handleError('USER_NOT_FOUND', 'USER', {
                        orderId: order.id,
                        userId: order.user_id,
                        guildId,
                        retryCount: order.retry_count || 0,
                        client
                    });
                    continue;
                }

                if (!order.role_id) {
                    await handleError('MISSING_PRODUCT_DATA', 'DATA', {
                        orderId: order.id,
                        userId: order.user_id,
                        retryCount: order.retry_count || 0
                    });
                    continue;
                }

                if (!member.roles.cache.has(order.role_id)) {
                    // Önce rolün sunucuda var olup olmadığını kontrol et
                    const roleExists = guild.roles.cache.has(order.role_id);
                    if (!roleExists) {
                        await handleError('INVALID_ROLE_ID', 'DATA', {
                            orderId: order.id,
                            roleId: order.role_id,
                            guildId,
                            retryCount: order.retry_count || 0,
                            client
                        });
                        continue;
                    }

                    // Check bot role hierarchy and permissions before attempting to add
                    try {
                        const botMember = guild.members.me || (client && client.user ? await guild.members.fetch(client.user.id).catch(() => null) : null);
                        const roleObj = guild.roles.cache.get(order.role_id);
                        const botHighestPos = botMember?.roles?.highest?.position ?? -1;
                        const targetPos = roleObj?.position ?? 0;
                        if (botHighestPos <= targetPos) {
                            const errorResult = await handleError('BOT_ROLE_HIERARCHY', 'PERMISSION', {
                                orderId: order.id,
                                userId: order.user_id,
                                roleId: order.role_id,
                                guildId,
                                retryCount: order.retry_count || 0,
                                client
                            });

                            await supabase
                                .from('store_orders')
                                .update({
                                    status: 'failed',
                                    failure_reason: errorResult.errorInfo.title,
                                    failure_code: errorResult.errorInfo.code,
                                    retry_count: (order.retry_count || 0) + 1,
                                    last_retry_at: new Date().toISOString()
                                })
                                .eq('id', order.id);

                            try {
                                const html = renderDeliveryFailureHtml(order.id, errorResult?.errorInfo?.code || null);
                                await supabase.from('system_mails').insert({
                                    guild_id: guildId,
                                    user_id: order.user_id,
                                    title: '🛠️ Sistem Raporu: İşlem Kesintisi Bildirimi',
                                    body: html,
                                    category: 'system',
                                    status: 'published',
                                    author_name: 'DiscoWeb Baş Geliştiricisi',
                                    created_at: new Date().toISOString()
                                });
                            } catch (mailErr) {
                                console.warn('Failed to insert delivery-failure system mail', mailErr);
                            }

                            continue;
                        }
                    } catch (hierErr) {
                        console.warn('Hierarchy check failed', hierErr);
                    }

                    const result = await member.roles.add(order.role_id).catch((err) => {
                        return handleError('ROLE_HIERARCHY', 'PERMISSION', {
                            orderId: order.id,
                            userId: order.user_id,
                            roleId: order.role_id,
                            error: err,
                            retryCount: order.retry_count || 0
                        });
                    });

                    if (!result) {
                        // handleError zaten durumu güncelledi
                        // Ayrıca kullanıcıya sistem bildirimi gönder: teslimat başarısızlığı ve iade butonu
                        try {
                            const html = renderDeliveryFailureHtml(order.id, result?.errorInfo?.code || null);
                            await supabase.from('system_mails').insert({
                                guild_id: guildId,
                                user_id: order.user_id,
                                title: '🛠️ Sistem Raporu: İşlem Kesintisi Bildirimi',
                                body: html,
                                category: 'system',
                                status: 'published',
                                author_name: 'DiscoWeb Baş Geliştiricisi',
                                created_at: new Date().toISOString()
                            });
                        } catch (mailErr) {
                            console.warn('Failed to insert delivery-failure system mail', mailErr);
                        }
                        continue;
                    }
                }

                let expiresAt = null;
                if (order.duration_days === 0) {
                    expiresAt = null;
                } else {
                    const { data: permanentOrder } = await supabase
                        .from('store_orders')
                        .select('id')
                        .eq('user_id', order.user_id)
                        .eq('role_id', order.role_id)
                        .eq('status', 'paid')
                        .is('revoked_at', null)
                        .is('expires_at', null)
                        .neq('id', order.id)
                        .limit(1);

                    if (permanentOrder?.length) {
                        expiresAt = null;
                    } else {
                        const { data: activeOrders } = await supabase
                            .from('store_orders')
                            .select('expires_at')
                            .eq('user_id', order.user_id)
                            .eq('role_id', order.role_id)
                            .eq('status', 'paid')
                            .is('revoked_at', null)
                            .gt('expires_at', nowIso)
                            .neq('id', order.id)
                            .order('expires_at', { ascending: false })
                            .limit(1);

                        const baseIso = activeOrders?.length
                            ? activeOrders[0].expires_at
                            : nowIso;

                        expiresAt = new Date(
                            Date.parse(baseIso) + order.duration_days * 86400000,
                        ).toISOString();
                    }
                }

                const { error: updateError } = await supabase
                    .from('store_orders')
                    .update({ status: 'paid', applied_at: nowIso, expires_at: expiresAt })
                    .eq('id', order.id);

                if (updateError) {
                    await handleError('DATABASE_ERROR', 'SYSTEM', {
                        orderId: order.id,
                        userId: order.user_id,
                        status: 'paid',
                        error: updateError,
                        retryCount: order.retry_count || 0,
                        client
                    });
                    continue;
                }

                console.log(`✅ Sipariş ${order.id} başarıyla işlendi`);
            } catch (err) {
                await handleError('PROCESS_CRASH', 'SYSTEM', {
                    orderId: order.id,
                    userId: order.user_id,
                    error: err,
                    retryCount: order.retry_count || 0,
                    client
                });
            }
        }
    } finally {
        orderWorkerRunning = false;
    }
};

module.exports = {
    processStoreOrders,
    processPendingOrdersAtMidnight
};