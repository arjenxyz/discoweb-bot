# DiscoWeb Bot

[![Website](https://img.shields.io/badge/Website-discowebtr.vercel.app-blue)](https://discowebtr.vercel.app)
[![Docs](https://img.shields.io/badge/Docs-discowebtr.vercel.app/docs-green)](https://discowebtr.vercel.app/docs)
[![Discord](https://img.shields.io/badge/Discord-3Y6YNwdE5Q-5865F2)](https://discord.gg/3Y6YNwdE5Q)
[![Deploy to Render](https://img.shields.io/badge/Deploy-Render-46E3B7)](https://dashboard.render.com/select-repo?type=web)

DiscoWeb’in Discord botu: ekonomi (papel), mesaj/ses kazancı, mağaza rol teslimi, log kanalları ve web panel için HTTP API.

Web paneli: [`arjenxyz/discoweb`](https://github.com/arjenxyz/discoweb) · Bot: [`arjenxyz/discoweb-bot`](https://github.com/arjenxyz/discoweb-bot)

Her iki taraf **aynı Supabase** projesini kullanır.

---

## Ne yapar?

| Özellik | Açıklama |
|---|---|
| Mesaj kazancı | Anti-spam sonrası buffer → `daily_earnings` → claim / gece settlement |
| Ses kazancı | Klasik voice (join/leave + tick). **Activity kazancı yok** |
| Mağaza | `store_orders` poll → Discord rolü ver/al |
| Loglar | Webhook / kanal logları (`bot_log_channels`) |
| HTTP API | Web panelin çağırdığı Express API (`/api/*`) |
| Quiz cron | Web quiz endpoint’lerini periyodik tetikler |

Kurulum ve ekonomi ayarları **web panelden** yapılır (setup wizard, earn-settings).

---

## Mimari (kısa)

```
Discord Gateway ──► Bot (Render, sürekli açık)
                      │
                      ├── Express BOT API  ◄──  Web (Vercel)  BOT_API_URL
                      │
                      └── Supabase (PostgreSQL)  ◄──  Web + Bot
```

- Bot **uzun ömürlü** process ister (Discord WebSocket). Vercel/Netlify bot için uygun değil.
- Aynı process Express açar → panel `BOT_API_URL` ile konuşur. Bu yüzden Render’da **Web Service** kullanıyoruz (Background Worker HTTP almaz).

---

## 1) Discord uygulaması

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. **Bot** → Reset Token → `DISCORD_TOKEN` olarak sakla
3. **Privileged Gateway Intents** aç:
   - **Server Members Intent**
   - **Message Content Intent**
4. OAuth2 → URL Generator:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions (önerilen): `Manage Roles`, `Manage Channels`, `Manage Webhooks`, `View Channels`, `Send Messages`, `Embed Links`, `Attach Files`, `Read Message History`, `Connect`, `Speak`, `Mute Members` (opsiyonel)
5. Üretilen invite ile botu sunucuya ekle
6. Application ID → `DISCORD_CLIENT_ID`
7. Bot rolünü, vereceği rollerin **üstüne** koy (rol hiyerarşisi)

---

## 2) Supabase (SQL)

Bot ve web **aynı** projeyi paylaşır.

### Mevcut DiscoWeb DB’n varsa

Supabase → **SQL Editor** → sırayla:

1. [`migrations/20260811_earn_spam_settings.sql`](./migrations/20260811_earn_spam_settings.sql) — spam / ses anti-abuse kolonları  
2. [`migrations/20260811_earn_perf_indexes.sql`](./migrations/20260811_earn_perf_indexes.sql) — indexler  

### Sıfırdan

1. Web reposundaki `supabase/` şema + tüm migration’ları uygula ([discoweb](https://github.com/arjenxyz/discoweb))  
2. Yukarıdaki bot migration’larını çalıştır  
3. Activity oturum takibi için: web `create_activity_tables.sql` (ödül yok, sadece kayıt)

> `schema.old.sql` yıkıcı `DROP` içerir — production’da çalıştırma.

### Botun dokunduğu başlıca tablolar

| Tablo | Kullanım |
|---|---|
| `servers` | earn ayarları, `verify_role_id`, spam flags |
| `member_wallets` / `wallet_ledger` | bakiye |
| `daily_earnings` | günlük mesaj/ses birikimi |
| `member_daily_stats` / `server_*_stats` / `*_overview_stats` | istatistik |
| `member_profiles` | üye profil / izin cache |
| `store_orders` | mağaza teslimatı |
| `bot_log_channels` / `log_channel_configs` | log kanalları |
| `system_mails` | sistem postası |
| `maintenance_flags` | bakım |
| `error_logs` | hata kaydı |
| `activity_sessions` / `activity_participation` | Activity takip (kazanç yok) |
| `app_config` | bazı kanal ID’leri |

Kazanç / anti-abuse alanları (örnek): `earn_per_message`, `earn_per_voice_minute`, `voice_earn_enabled`, `verify_role_id`, `spam_*`, `daily_*_earn_cap`, tag/boost bonusları.

---

## 3) Ortam değişkenleri

Şablon: [`.env.example`](./.env.example)

### Zorunlu (bot)

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
SUPABASE_URL=https://XXXX.supabase.co
SUPABASE_SERVICE_ROLE_KEY=   # service_role — anon değil
BOT_API_KEY=                 # uzun rastgele secret
WEB_URL=https://your-web.vercel.app
```

### Render otomatik / opsiyonel

```env
PORT=10000                   # Render set eder; kod PORT veya BOT_API_PORT dinler
BOT_API_ORIGINS=             # ekstra CORS origin’ler (virgül)
PAPEL_PER_MESSAGE=0.2        # sunucu ayarı yoksa fallback
PAPEL_PER_VOICE_MINUTE=0.2
PAPEL_TIMEZONE_OFFSET=180    # TR
QUIZ_CRON_SECRET=            # web ile aynı
EARN_BUFFER_FLUSH_MS=8000
ORDER_POLL_INTERVAL_MS=300000
```

### Web panelde (Vercel) eşleşmesi

Bot deploy olduktan sonra web env’e ekle:

```env
DISCORD_BOT_TOKEN=           # bot’taki DISCORD_TOKEN ile AYNI değer
BOT_API_URL=https://YOUR-SERVICE.onrender.com
BOT_API_KEY=                 # bot’taki BOT_API_KEY ile AYNI
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

İsim farkı: bot `DISCORD_TOKEN`, web `DISCORD_BOT_TOKEN` — değer aynı token.

---

## 4) Render’a kurulum (en kolay yol)

### Öneri

| Ayar | Değer |
|---|---|
| Tip | **Web Service** (Gateway + `/api`) |
| Plan | **Starter** (veya üstü). Free uyur → bot kopar |
| Runtime | Node |
| Region | `Frankfurt` (EU) uygun |
| Branch | `main` |
| Build | `npm ci --omit=dev` |
| Start | `npm start` |
| Health check | `/api/test` |

### A) Blueprint (hızlı)

1. Repo’da `render.yaml` var  
2. [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**  
3. `arjenxyz/discoweb-bot` bağla  
4. `sync: false` olan secret’ları doldur (`DISCORD_TOKEN`, Supabase, `BOT_API_KEY`, `WEB_URL`, …)  
5. Deploy

### B) Manuel Web Service

1. **New** → **Web Service** → GitHub `discoweb-bot`  
2. Build / Start yukarıdaki gibi  
3. Environment’a `.env.example` anahtarlarını ekle  
4. Deploy → URL’yi kopyala (`https://….onrender.com`)  
5. Web (Vercel) → `BOT_API_URL` = bu URL, `BOT_API_KEY` aynı  
6. Logs’ta `Bot … olarak giriş yaptı` ve `Bot API` dinlediğini gör

### Doğrulama

```bash
curl https://YOUR-SERVICE.onrender.com/api/test
# {"message":"Bot API çalışıyor", ...}
```

Panelden sunucu setup / earn-settings kaydı → bot `invalidate-config` almalı.

### Sık hatalar

| Belirti | Çözüm |
|---|---|
| Bot offline / reconnect loop | Free plan uyuyor → Starter’a geç |
| `403 forbidden` panel→bot | `BOT_API_KEY` web/bot aynı değil |
| CORS | `WEB_URL` / `BOT_API_ORIGINS` panel origin’ini içermeli |
| Ses kazanç yok | `verify_role_id`, `voice_earn_enabled`, spam voice kuralları, Message/Members/Voice intents |
| Mesaj kazanç yok | Message Content Intent + earn ayarları |
| Rol verilemiyor | Bot rolü hedef rolün üstünde olmalı |

---

## 5) Yerel çalıştırma

```bash
git clone https://github.com/arjenxyz/discoweb-bot.git
cd discoweb-bot
npm ci
cp .env.example .env
# .env doldur
npm start
```

Giriş noktası: `src/index.js` (`package.json` → `npm start`). Kök `index.js` sadece `require('./src/index.js')`.

Yerelde API: `http://localhost:3000/api/test`  
Web `.env.local`: `BOT_API_URL=http://localhost:3000`

---

## Proje yapısı

```
src/
  index.js              # Discord client, event’ler, interval’ler
  api/webApi.js         # Express BOT API
  core/                 # config, database, logger, errors
  services/
    messageProcessor.js # mesaj kazancı
    earnings.js         # ses kazancı + settlement
    earnBuffer.js       # batch yazma
    antiSpam.js
    store.js
    activity.js         # Activity join/leave (ödülsüz)
  utils/                # mail, log kanalları, quiz cron, …
migrations/             # bot SQL patch’leri
render.yaml             # Render Blueprint
.env.example
```

---

## Kazanç özeti

1. **Mesaj** — anti-spam → buffer (~8s) → `daily_earnings`  
2. **Ses** — sadece klasik voice; Activity ödül vermez  
3. Tag / boost bonusları `servers` üzerinden  
4. Gün sonu (TR) settlement veya kullanıcı claim (web)

Admin: web → `/admin/earn-settings`

---

## HTTP API (özet)

Auth: `Authorization: Bearer <BOT_API_KEY>` (çoğu endpoint)

| Method | Path | Amaç |
|---|---|---|
| GET | `/api/test` | health |
| POST | `/api/log` | log gönder |
| POST | `/api/setup-server-logs` | log kanalları kur |
| POST | `/api/invalidate-config` | sunucu config cache temizle |
| POST | `/api/notify-ipo` | IPO bildirimi |
| POST | `/api/broadcast-system` | sistem yayını |
| POST | `/api/log-sdk-activity` | Activity SDK log |

---

## Lisans / destek

ISC · Destek: [Discord](https://discord.gg/3Y6YNwdE5Q) · Panel: [discowebtr.vercel.app](https://discowebtr.vercel.app)
