# SQL migrations (bot)

Bu klasör **botu etkileyen incremental** SQL dosyalarını tutar.
Tam şema DiscoWeb web paneli ile **aynı Supabase projesinde** yaşar.

## Sıra (mevcut projeye ekleme)

Supabase Dashboard → **SQL Editor** → sırayla çalıştır:

1. `20260811_earn_spam_settings.sql` — anti-abuse kolonları (`servers`)
2. `20260811_earn_perf_indexes.sql` — kazanç performans indexleri

## Sıfırdan kurulum

1. [discoweb](https://github.com/arjenxyz/discoweb) reposundaki `supabase/` şema + migration'larını uygula
   (veya zaten çalışan bir DiscoWeb Supabase'i kullan).
2. Yukarıdaki bot migration'larını çalıştır.
3. Activity takibi için (kazanç yok, sadece oturum kaydı):
   web reposu `supabase/migrations/create_activity_tables.sql`

## Not

`schema.old.sql` (web) yıkıcı `DROP` içerir — **production'da çalıştırma**.
Yalnızca boş bir deneme projesinde kullanılabilir.
