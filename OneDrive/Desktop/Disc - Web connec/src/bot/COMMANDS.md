# 🤖 Disc Nexus Bot Komutları

## 📋 Genel Bilgiler

Bot **hem slash komutları (/)** hem de **prefix komutları (!)** destekler. Slash komutları daha modern ve kullanıcı dostudur.

### 📁 Klasör Yapısı
```
modules/commands/
├── index.js      # Ana yönlendirici
├── user.js       # Kullanıcı komutları
└── admin.js      # Admin komutları
```

## ✨ Slash Komutları (Önerilen)

### 👤 Kullanıcı Komutları

#### `/kayit`
- **Açıklama:** Sisteme kayıt olma
- **Otomatik:** İlk mesajda otomatik kayıt olur
- **Tekrar:** Zaten kayıtlı kullanıcılara bilgi verir

#### `/profil`
- **Açıklama:** Kullanıcı profil bilgilerini gösterir
- **Bilgiler:**
  - Kayıt tarihi
  - Rol seviyesi
  - Toplam puan
  - Cüzdan bakiyesi
  - Günlük istatistikler (mesaj, ses)

#### `/para`
- **Açıklama:** Cüzdan bakiyesini gösterir
- **Bilgiler:** Güncel bakiye ve son işlem tarihi

#### `/top`
- **Açıklama:** Sunucudaki en zengin 10 kullanıcıyı listeler
- **Sıralama:** Bakiyeye göre azalan sırada
- **Medal:** İlk 3 kullanıcı için özel ikon

#### `/yardim`
- **Açıklama:** Tüm kullanılabilir komutları listeler
- **Admin Farkı:** Adminlere özel komutlar gösterilir

### 🔧 Admin Komutları

#### `/magazaekle`
- **Açıklama:** Mağaza ürünü ekleme
- **Parametreler:**
  - `urun_adi` (gerekli): Ürün adı
  - `fiyat` (gerekli): Ürün fiyatı
  - `sure` (gerekli): Geçerlilik süresi (gün)
  - `rol_id` (gerekli): Discord rol ID'si
  - `aciklama` (opsiyonel): Ürün açıklaması

#### `/magazasil`
- **Açıklama:** Mağaza ürünü kaldırma/deaktif etme
- **Parametreler:**
  - `urun_id` (gerekli): Ürün ID'si

#### `/promokod`
- **Açıklama:** Promosyon kodu oluşturma
- **Parametreler:**
  - `kod` (gerekli): Promosyon kodu
  - `indirim` (gerekli): İndirim yüzdesi (1-100)
  - `bitis_tarihi` (opsiyonel): Bitiş tarihi (YYYY-MM-DD)

#### `/bakim`
- **Açıklama:** Bakım modu kontrolü
- **Parametreler:**
  - `islem` (gerekli): İşlem türü (Aç/Kapat/Durum)

## 📢 Prefix Komutları (Eski Sistem)

Eski sistem hala çalışır. Tüm slash komutlarının prefix versiyonları mevcuttur:

- `!kayit` → `/kayit`
- `!profil` → `/profil`
- `!para` → `/para`
- `!top` → `/top`
- `!yardim` → `/yardim`
- `!magazaekle` → `/magazaekle`
- `!magazasil` → `/magazasil`
- `!promokod` → `/promokod`
- `!bakim` → `/bakim`

## ⚙️ Teknik Detaylar

### Otomatik Kayıt Sistemi
- İlk mesajda kullanıcı otomatik kaydedilir
- Kazanç sistemi çalışırken kayıt kontrolü yapılır
- Hata durumunda sessizce devam eder

### Güvenlik
- Admin komutları rol kontrolü ile korunur
- Tüm veritabanı işlemleri error handling ile yapılır
- Kullanıcı dostu hata mesajları

### Genişletme
Yeni komut eklemek için:
1. İlgili kategoriye fonksiyon ekleyin (`user.js` veya `admin.js`)
2. `index.js` dosyasında yönlendirmeyi ekleyin
3. Slash komutunu `index.js` başına ekleyin
4. Yardım metnini güncelleyin

## 🎯 Kullanım İpuçları

- İlk mesajınızda otomatik kayıt olursunuz
- Hem slash hem prefix komutları kullanabilirsiniz
- Admin komutları sadece yetkili kullanıcılar tarafından kullanılabilir
- Tüm komutlar Türkçe karakter destekler
- Hata durumunda açıklayıcı mesajlar alırsınız

## 🔄 Geçiş Dönemi

Bot şu anda **hibrit modda** çalışır:
- **Yeni kullanıcılar** slash komutlarını kullanabilir
- **Eski kullanıcılar** prefix komutlarını kullanmaya devam edebilir
- Tüm komutlar aynı işlevselliği sağlar