# DiscoWeb - Discord Sunucu Yönetim Sistemi

[![Website](https://img.shields.io/badge/Website-discowebtr.vercel.app-blue)](https://discowebtr.vercel.app)
[![Docs](https://img.shields.io/badge/Docs-discowebtr.vercel.app/docs-green)](https://discowebtr.vercel.app/docs)
[![Discord](https://img.shields.io/badge/Discord-3Y6YNwdE5Q-5865F2)](https://discord.gg/3Y6YNwdE5Q)

## 📋 Genel Bakış

DiscoWeb, Discord sunucuları için geliştirilmiş kapsamlı bir yönetim platformudur. Web arayüzü ve Discord botu entegrasyonu ile sunucu ekonomisi, rol yönetimi, mağaza sistemi ve AI destekli moderasyon özelliklerini sunar.

## 🏗️ Teknoloji Altyapısı

### Web Uygulaması
- **Framework**: Next.js 16 (App Router)
- **Dil**: TypeScript
- **Stil**: Tailwind CSS
- **Veritabanı**: Supabase (PostgreSQL)
- **Kimlik Doğrulama**: Discord OAuth2
- **Gerçek Zamanlı**: Supabase Realtime

### Discord Botu
- **Framework**: Discord.js
- **Dil**: Node.js
- **Modüler Yapı**: Commands, Database, Store, Earnings modülleri
- **Veritabanı**: Supabase entegrasyonu

## 🚀 Özellikler

### 🔐 Kimlik Doğrulama ve Yetkilendirme
- Discord OAuth2 ile güvenli giriş
- Rol tabanlı erişim kontrolü
- Admin ve üye ayrıcalıkları
- Kuralları kabul mekanizması

### 💰 Ekonomi Sistemi
- **Cüzdan Yönetimi**: Üye bakiyeleri ve işlem geçmişi
- **Kazanç Sistemi**: Mesaj ve ses katılımına göre otomatik kazanç
- **Mağaza**: Rol satın alma ve süre yönetimi
- **Promosyon Kodları**: İndirim ve kampanya yönetimi
- **Transfer Sistemi**: Üye arası para transferi

### 🛒 Mağaza ve Sipariş Yönetimi
- Dinamik ürün kataloğu
- Otomatik rol atama ve kaldırma
- Sipariş durumu takibi
- İndirim ve promosyon entegrasyonu

### 📊 Analitik ve İstatistikler
- Gerçek zamanlı sunucu metrikleri
- Üye katılım istatistikleri
- Kazanç ve harcama analizleri
- Dashboard üzerinden görselleştirme

### 🤖 AI Destekli Moderasyon
- Ban/Mute senaryoları ile aday eğitimi
- Performans metriği takibi
- Yetkilendirme sistemi
- Otomatik değerlendirme

### 📢 Bildirim Sistemi
- Gerçek zamanlı bildirimler
- Kategori bazlı filtreleme
- Okunma durumu takibi
- Admin duyuru yayınlama

### 🔧 Yönetim Paneli (Admin)
- Sistem durumu monitörleme
- Log kanalları yönetimi
- Bakım modu kontrolü
- Audit log takibi
- Mağaza ve kampanya yönetimi

## 📁 Proje Yapısı

```
src/
├── bot/                    # Discord Botu
│   ├── index.js           # Ana bot dosyası
│   ├── modules/           # Modüler bileşenler
│   │   ├── commands.js    # Komut işleme
│   │   ├── database.js    # Veritabanı bağlantısı
│   │   ├── store.js       # Mağaza işlemleri
│   │   ├── earnings.js    # Kazanç hesaplaması
│   │   └── config.js      # Yapılandırma
│   ├── schema.sql         # Bot veritabanı şeması
│   └── package.json
│
├── web/                    # Web Uygulaması
│   ├── app/               # Next.js App Router
│   │   ├── api/           # API Routes
│   │   │   ├── auth/      # Kimlik doğrulama
│   │   │   ├── discord/   # Discord entegrasyonu
│   │   │   ├── member/    # Üye işlemleri
│   │   │   ├── admin/     # Admin API'leri
│   │   │   └── maintenance/ # Bakım modu
│   │   ├── admin/         # Admin paneli sayfaları
│   │   ├── auth/          # Giriş sayfaları
│   │   ├── dashboard/     # Üye dashboard'u
│   │   ├── maintenance/   # Bakım sayfası
│   │   └── page.tsx       # Ana landing page
│   ├── lib/               # Yardımcı kütüphaneler
│   │   ├── supabaseClient.ts
│   │   ├── serverLogger.ts
│   │   └── maintenance.ts
│   ├── config/            # Yapılandırma
│   │   └── site.ts
│   ├── supabase/          # Eski veritabanı şeması (arşiv)
│   │   └── schema.sql
│   ├── schema.sql         # Ana veritabanı şeması
│   └── package.json
```

## 🗄️ Veritabanı Şeması

### Ana Tablolar
- **servers**: Sunucu bilgileri
- **users**: Discord kullanıcı kayıtları
- **member_profiles**: Detaylı üye profilleri
- **store_items**: Mağaza ürünleri
- **store_orders**: Sipariş geçmişi
- **member_wallets**: Cüzdan bakiyeleri
- **wallet_ledger**: İşlem geçmişi
- **daily_earnings**: Günlük kazanç kayıtları
- **promotions**: Promosyon kodları

### Yönetim Tabloları
- **web_audit_logs**: Web işlemi logları
- **notifications**: Bildirim sistemi
- **log_channel_configs**: Log kanalları
- **maintenance_flags**: Bakım modu
- **public_metrics**: Sistem metrikleri

### AI Moderasyon
- **ai_scenarios**: Eğitim senaryoları
- **ai_case_runs**: Uygulama kayıtları
- **ai_candidate_scores**: Performans puanları

## 🔧 Kurulum ve Yapılandırma

### Gereksinimler
- Node.js 18+
- PostgreSQL (Supabase)
- Discord Bot Token
- Discord OAuth2 Uygulaması

### Çevre Değişkenleri

#### Web Uygulaması (.env.local)
```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Discord
NEXT_PUBLIC_DISCORD_CLIENT_ID=your_client_id
DISCORD_CLIENT_SECRET=your_client_secret
NEXT_PUBLIC_REDIRECT_URI=your_redirect_uri
DISCORD_BOT_TOKEN=your_bot_token

# Sunucu Yapılandırması
DISCORD_GUILD_ID=your_guild_id
DISCORD_REQUIRED_ROLE_ID=required_role_id
DISCORD_ADMIN_ROLE_ID=admin_role_id
MAINTENANCE_ROLE_ID=maintenance_role_id
```

#### Discord Botu (.env)
```env
DISCORD_TOKEN=your_bot_token
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
GUILD_ID=your_guild_id
REQUIRED_ROLE_ID=required_role_id
ADMIN_ROLE_ID=admin_role_id
```

### Kurulum Adımları

1. **Repository'yi klonlayın**
```bash
git clone <repository-url>
cd disc-nexus
```

2. **Web uygulamasını kurun**
```bash
cd src/web
npm install
cp .env.example .env.local
# .env.local dosyasını düzenleyin
npm run dev
```

3. **Discord botunu kurun**
```bash
cd src/bot
npm install
cp .env.example .env
# .env dosyasını düzenleyin
node index.js
```

4. **Veritabanını başlatın**
```bash
# Ana schema dosyasını Supabase'e yükleyin
cd src
psql -h your_supabase_host -U postgres -d postgres -f schema.sql

# Alternatif olarak Supabase Dashboard'dan SQL Editor kullanarak
# src/schema.sql içeriğini çalıştırın
```

## 🎮 Kullanım

### Web Arayüzü
- **Ana Sayfa**: Sistem tanıtımı ve özellikler
- **Dashboard**: Üye paneli (cüzdan, mağaza, işlemler)
- **Admin Panel**: Sistem yönetimi ve monitörleme

### Discord Bot Komutları
- `!kayit`: Sisteme kayıt olma
- `!magazaekle`: Mağaza ürünü ekleme (admin)
- `!promokod`: Promosyon kodu oluşturma (admin)

### API Endpoints

#### Kimlik Doğrulama
- `POST /api/discord/exchange`: Discord OAuth token değişimi
- `GET /api/member/profile`: Üye profili
- `GET /api/member/overview`: Genel istatistikler

#### Mağaza ve Cüzdan
- `GET /api/member/store`: Mağaza ürünleri
- `POST /api/member/purchase`: Ürün satın alma
- `GET /api/member/wallet`: Cüzdan bakiyesi
- `POST /api/member/transfer`: Para transferi

#### Yönetim
- `GET /api/admin/*`: Admin veri endpoint'leri
- `POST /api/admin/*`: Admin işlem endpoint'leri

## 🔒 Güvenlik

### Row Level Security (RLS)
- Supabase RLS politikaları ile veri güvenliği
- Service role ile bot işlemleri
- Kullanıcı bazlı veri erişimi

### Rol Tabanlı Erişim
- Discord rol ID'leri ile yetkilendirme
- Admin, moderator, üye ayrıcalıkları
- API endpoint koruması

### Loglama ve Audit
- Tüm işlemlerin loglanması
- Web audit logs
- Discord bot log kanalları

## 📈 Ölçeklenebilirlik

### Performans Optimizasyonları
- Supabase edge functions
- Gerçek zamanlı subscriptions
- Indexed veritabanı sorguları
- Lazy loading ve pagination

### Bakım ve Monitörleme
- Maintenance mode sistemi
- Sistem durumu dashboard'u
- Error tracking ve alerting
- Performance metrics

## 🤝 Katkıda Bulunma

1. Fork edin
2. Feature branch oluşturun (`git checkout -b feature/amazing-feature`)
3. Commit edin (`git commit -m 'Add amazing feature'`)
4. Push edin (`git push origin feature/amazing-feature`)
5. Pull Request açın

## 📝 Lisans

Bu proje MIT lisansı altında lisanslanmıştır.

## 📞 Destek

Herhangi bir sorun yaşarsanız:
- GitHub Issues sayfasını kullanın
- Discord sunucumuzda yardım isteyin
- Dokümantasyonu inceleyin

---

**Not**: Bu sistem aktif geliştirme aşamasındadır. Beta sürümünde olabilirsiniz.</content>
<parameter name="filePath">c:\Users\newli\OneDrive\Desktop\Disc - Web connec\README.md