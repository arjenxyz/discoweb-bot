# DiscoWeb Bot - Discord Yönetim Botu

[![Website](https://img.shields.io/badge/Website-discowebtr.vercel.app-blue)](https://discowebtr.vercel.app)
[![Docs](https://img.shields.io/badge/Docs-discowebtr.vercel.app/docs-green)](https://discowebtr.vercel.app/docs)
[![Discord](https://img.shields.io/badge/Discord-3Y6YNwdE5Q-5865F2)](https://discord.gg/3Y6YNwdE5Q)

DiscoWeb'in Discord botu bileşeni. Modüler yapıda geliştirilmiş kapsamlı yönetim ve ekonomi sistemi.

## 📁 Proje Yapısı

```
src/bot/
├── index.js          # Ana bot dosyası - sadece başlatma ve event'ler
├── index_old.js      # Eski tek dosyalı versiyon (yedek)
├── schema.sql        # Bot için gerekli veritabanı tabloları
├── modules/
│   ├── config.js     # Ayarlar ve environment variables
│   ├── database.js   # Supabase bağlantısı ve yardımcı fonksiyonlar
│   ├── store.js      # Mağaza işlemleri (sipariş işleme)
│   ├── earnings.js   # Kazanç sistemi (mesaj/voice earnings, settlement)
│   └── commands.js   # Komut işleme (!kayit, !magazaekle, !promokod)
└── package.json
```

## 🚀 Özellikler

- **Modüler Yapı**: Kod artık küçük, yönetilebilir modüllere bölünmüş
- **Mağaza Sistemi**: Rol satışları, sipariş yönetimi
- **Kazanç Sistemi**: Mesaj ve voice aktivitesi için otomatik kazanç
- **Komut Sistemi**: !kayit, !magazaekle, !promokod komutları
- **Kurulum Değişikliği**: İnteraktif `/setup` kaldırıldı — tüm kurulumlar web panelinden yürütülür
- **Durum Ayarı**: Bot "Sunucu Aktivitesini İzliyor" şeklinde görünür

## 📦 Kurulum

1. Gerekli paketleri yükleyin:
```bash
npm install
```

2. `.env` dosyasını oluşturun ve gerekli değişkenleri ayarlayın:
```
DISCORD_TOKEN=your_bot_token
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
GUILD_ID=your_guild_id
REQUIRED_ROLE_ID=required_role_id
DISCORD_ADMIN_ROLE_ID=admin_role_id
```

3. **Veritabanını hazırlayın:**
   - Supabase Dashboard'a gidin
   - SQL Editor'ı açın
   - `schema.sql` dosyasının içeriğini kopyalayıp çalıştırın

4. Botu çalıştırın:
```bash
node index.js
```

## �️ Veritabanı Tabloları

Bot aşağıdaki tabloları kullanır:

- `servers` - Sunucu bilgileri
- `users` - Kullanıcı kayıtları
- `store_items` - Mağaza ürünleri
- `store_orders` - Mağaza siparişleri
- `promotions` - Promosyon kodları
- `member_wallets` - Üye cüzdanları
- `wallet_ledger` - Cüzdan hareket geçmişi
- `daily_earnings` - Günlük kazançlar
- `member_daily_stats` - Üye günlük istatistikleri
- `server_daily_stats` - Sunucu günlük istatistikleri
- `member_overview_stats` - Üye genel istatistikleri
- `server_overview_stats` - Sunucu genel istatistikleri

## �🔧 Modüller Açıklaması

### config.js
Tüm ayarları ve environment değişkenlerini merkezi olarak yönetir.

### database.js
Supabase bağlantısı ve tarih/saat yardımcı fonksiyonları.

### store.js
Mağaza siparişlerinin işlenmesi, rol verme/alma işlemleri.

### earnings.js
Kazanç hesaplaması, cüzdan işlemleri, günlük settlement.

### commands.js
Kullanıcı komutlarının işlenmesi ve yanıtları.

## 📝 Komutlar

- `!kayit` - Sistemi kayıt olma
- `!magazaekle Ürün | Fiyat | Süre | RolID | Açıklama` - Mağaza ürünü ekleme (admin)
- `!promokod Kod | İndirim% | BitişTarihi` - Promosyon kodu oluşturma (admin)

## 🔄 Migration

Eski tek dosyalı `index_old.js` dosyası yedek olarak saklanmıştır. Gerektiğinde geri dönebilirsiniz.