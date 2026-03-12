-- Disc Nexus: Tam reset + yeniden kurulum SQL

create extension if not exists "pgcrypto";

-- Önce mevcut objeleri temizle
drop trigger if exists store_orders_metrics_trigger on public.store_orders;
drop trigger if exists promotions_metrics_trigger on public.promotions;

drop function if exists public.touch_public_metrics();
drop function if exists public.refresh_public_metrics(uuid);

drop table if exists public.member_profiles cascade;
drop table if exists public.member_wallets cascade;
drop table if exists public.wallet_ledger cascade;
drop table if exists public.daily_earnings cascade;
drop table if exists public.member_daily_stats cascade;
drop table if exists public.server_daily_stats cascade;
drop table if exists public.member_overview_stats cascade;
drop table if exists public.server_overview_stats cascade;
drop table if exists public.store_items cascade;
drop table if exists public.web_audit_logs cascade;
drop table if exists public.error_logs cascade;
drop table if exists public.notifications cascade;
drop table if exists public.notification_reads cascade;
drop table if exists public.system_mails cascade;
drop table if exists public.system_mail_reads cascade;
drop table if exists public.system_mail_contacts cascade;
-- drop table if exists public.user_guilds cascade; -- koruma: sorgulama tablosu silinmesin
drop table if exists public.log_channel_configs cascade;
drop table if exists public.bot_log_channels cascade;
drop table if exists public.maintenance_flags cascade;
drop table if exists public.store_discounts cascade;
drop table if exists public.promotions cascade;
drop table if exists public.promotion_usages cascade;
drop table if exists public.discount_usages cascade;
drop table if exists public.store_orders cascade;
drop table if exists public.users cascade;
drop table if exists public.servers cascade;
drop table if exists public.members cascade;

-- Tablo kurulumları
create table public.servers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  discord_id text unique,
  avatar_url text,
  admin_role_id text, -- Admin rol ID'si
  verify_role_id text, -- Verify rol ID'si
  -- Tag / Booster earnings configuration (store server tag id/hash)
  tag_id text,
  tag_bonus_message numeric not null default 0,
  tag_bonus_voice numeric not null default 0,
  booster_bonus_message numeric not null default 0,
  booster_bonus_voice numeric not null default 0,
  is_setup boolean not null default false,
  approval_threshold numeric not null default 80,
  transfer_daily_limit numeric not null default 200,
  transfer_tax_rate numeric not null default 0.05,
  created_at timestamptz not null default now()
);

create table public.users (
  id uuid primary key default gen_random_uuid(),
  discord_id text not null unique,
  username text not null,
  email text,
  points integer not null default 0,
  role_level integer not null default 1,
  oauth_access_token text,
  oauth_refresh_token text,
  oauth_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.members (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  discord_id text not null,
  username text not null,
  display_name text,
  avatar_url text,
  points integer not null default 0,
  role_level integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (server_id, discord_id)
);

create table public.store_items (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  title text not null,
  description text,
  price numeric not null,
  status text not null check (status in ('active','inactive')),
  role_id text not null,
  duration_days integer not null check (duration_days >= 0),
  created_at timestamptz not null default now()
);

create table public.store_orders (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  user_id text not null,
  item_id uuid references public.store_items(id) on delete set null,
  item_title text,
  role_id text not null,
  duration_days integer not null,
  retry_count integer not null default 0,
  expires_at timestamptz,
  applied_at timestamptz,
  revoked_at timestamptz,
  failure_reason text,
  amount numeric not null,
  discount_code text,
  discount_percent numeric,
  status text not null check (status in ('paid','pending','refunded','failed')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.promotions (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  code text not null,
  value numeric not null,
  max_uses integer,
  used_count integer not null default 0,
  status text not null check (status in ('active','disabled','expired')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.promotion_usages (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.promotions(id) on delete cascade,
  user_id text not null,
  used_at timestamptz not null default now(),
  unique (promotion_id, user_id)
);

create table public.store_discounts (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  code text not null,
  percent numeric not null,
  max_uses integer,
  used_count integer not null default 0,
  status text not null check (status in ('active','disabled','expired')),
  expires_at timestamptz,
  is_welcome boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.discount_usages (
  id uuid primary key default gen_random_uuid(),
  discount_id uuid not null references public.store_discounts(id) on delete cascade,
  user_id text not null,
  order_id uuid references public.store_orders(id) on delete set null,
  used_at timestamptz not null default now(),
  unique (discount_id, user_id)
);

create table public.maintenance_flags (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  key text not null,
  is_active boolean not null default false,
  reason text,
  updated_by text,
  updated_at timestamptz not null default now(),
  unique (server_id, key)
);

create table public.log_channel_configs (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  channel_type text not null check (channel_type in (
    'user_main','user_auth','user_roles','user_exchange','user_store',
    'admin_main','admin_wallet','admin_store','admin_notifications','admin_settings',
    'main','auth','roles','system','suspicious','store','wallet','notifications','settings','admin'
  )),
  webhook_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (guild_id, channel_type)
);

create table public.bot_log_channels (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  channel_id text not null,
  category_id text,
  channel_type text not null check (channel_type in (
    'user_main','user_auth','user_roles','user_exchange','user_store',
    'admin_main','admin_wallet','admin_store','admin_notifications','admin_settings',
    'main','auth','roles','system','suspicious','store','wallet','notifications','settings','admin'
  )),
  webhook_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (guild_id, channel_type)
);

create table public.member_profiles (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  user_id text not null,
  about text,
  tag_granted_at timestamptz,
  deleted_at timestamptz, -- Soft delete için
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (guild_id, user_id)
);

create table public.member_wallets (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  user_id text not null,
  balance numeric not null default 0,
  deleted_at timestamptz, -- Soft delete için
  updated_at timestamptz not null default now(),
  unique (guild_id, user_id)
);

create table public.wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  user_id text not null,
  amount numeric not null,
  type text not null check (type in ('earn_voice','earn_message','transfer_in','transfer_out','transfer_tax','purchase','admin_adjust','refund','promotion')),
  balance_after numeric,
  metadata jsonb not null default '{}'::jsonb,
  deleted_at timestamptz, -- Soft delete için
  created_at timestamptz not null default now()
);

create table public.daily_earnings (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  user_id text not null,
  source text not null check (source in ('voice','message')),
  earning_date date not null,
  amount numeric not null default 0,
  settled_at timestamptz,
  deleted_at timestamptz, -- Soft delete için
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (guild_id, user_id, source, earning_date)
);

create table public.member_daily_stats (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  user_id text not null,
  stat_date date not null,
  message_count integer not null default 0,
  voice_minutes integer not null default 0,
  deleted_at timestamptz, -- Soft delete için
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (guild_id, user_id, stat_date)
);

create table public.server_daily_stats (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  stat_date date not null,
  message_count integer not null default 0,
  voice_minutes integer not null default 0,
  deleted_at timestamptz, -- Soft delete için
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (guild_id, stat_date)
);

create table public.member_overview_stats (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  user_id text not null,
  total_messages integer not null default 0,
  total_voice_minutes integer not null default 0,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (guild_id, user_id)
);

create table public.server_overview_stats (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  total_messages integer not null default 0,
  total_voice_minutes integer not null default 0,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (guild_id)
);

create table public.error_logs (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  title text not null,
  severity text not null,
  category text,
  context jsonb,
  solution text,
  created_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null, -- Sunucu ID'si
  title text not null,
  body text not null,
  type text not null check (type in ('announcement','mail')),
  status text not null default 'published',
  target_user_id text,
  created_by text,
  author_name text,
  author_avatar_url text,
  details_url text,
  image_url text,
  created_at timestamptz not null default now()
);

create table public.notification_reads (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  user_id text not null,
  read_at timestamptz not null default now(),
  unique (notification_id, user_id)
);

create table public.system_mails (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  user_id text,
  title text not null,
  body text not null,
  metadata jsonb,
  category text not null check (category in ('announcement','maintenance','sponsor','update','lottery','reward','order')),
  status text not null default 'published',
  created_by text,
  author_name text,
  author_avatar_url text,
  image_url text,
  details_url text,
  created_at timestamptz not null default now()
);

create table public.system_mail_reads (
  id uuid primary key default gen_random_uuid(),
  mail_id uuid not null references public.system_mails(id) on delete cascade,
  user_id text not null,
  read_at timestamptz not null default now(),
  unique (mail_id, user_id)
);

create table public.system_mail_contacts (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  user_id text not null,
  subject text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.user_guilds (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  guild_id text not null,
  guild_name text not null,
  guild_icon text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, guild_id)
);

create index log_channel_configs_guild_idx on public.log_channel_configs (guild_id);
create index log_channel_configs_type_idx on public.log_channel_configs (channel_type);
create index bot_log_channels_guild_idx on public.bot_log_channels (guild_id);
create index bot_log_channels_type_idx on public.bot_log_channels (channel_type);
create index maintenance_flags_server_idx on public.maintenance_flags (server_id);
create index maintenance_flags_key_idx on public.maintenance_flags (key);

create index member_profiles_guild_idx on public.member_profiles (guild_id);
create index member_profiles_user_idx on public.member_profiles (user_id);

create index member_wallets_guild_idx on public.member_wallets (guild_id);
create index member_wallets_user_idx on public.member_wallets (user_id);
create index wallet_ledger_user_idx on public.wallet_ledger (user_id);
create index wallet_ledger_created_idx on public.wallet_ledger (created_at desc);
create index daily_earnings_date_idx on public.daily_earnings (earning_date);
create index daily_earnings_settled_idx on public.daily_earnings (settled_at);
create index member_daily_stats_user_idx on public.member_daily_stats (user_id);
create index member_daily_stats_date_idx on public.member_daily_stats (stat_date);
create index server_daily_stats_date_idx on public.server_daily_stats (stat_date);
create index member_overview_stats_user_idx on public.member_overview_stats (user_id);

create index store_items_server_idx on public.store_items (server_id);
create index store_items_status_idx on public.store_items (status);

create index members_server_idx on public.members (server_id);
create index members_discord_idx on public.members (discord_id);

create index store_orders_server_idx on public.store_orders (server_id);
create index store_orders_user_idx on public.store_orders (user_id);
create index store_orders_expires_idx on public.store_orders (expires_at);
create index store_orders_applied_idx on public.store_orders (applied_at);
create index store_orders_revoked_idx on public.store_orders (revoked_at);

create index error_logs_code_idx on public.error_logs (code);
create index error_logs_created_idx on public.error_logs (created_at desc);
create index notifications_status_idx on public.notifications (status);
create index notifications_created_idx on public.notifications (created_at desc);
create index notification_reads_user_idx on public.notification_reads (user_id);
create index if not exists user_guilds_user_idx on public.user_guilds (user_id);
create index if not exists user_guilds_guild_idx on public.user_guilds (guild_id);



alter table public.error_logs enable row level security;

alter table public.log_channel_configs enable row level security;

alter table public.bot_log_channels enable row level security;

alter table public.member_profiles enable row level security;

alter table public.member_wallets enable row level security;

alter table public.wallet_ledger enable row level security;

alter table public.daily_earnings enable row level security;

alter table public.notifications enable row level security;
create policy "notifications_read" on public.notifications
for select using (status = 'published');

alter table public.user_guilds enable row level security;
drop policy if exists "user_guilds_service_only" on public.user_guilds;
create policy "user_guilds_service_only" on public.user_guilds
for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- Mevcut veritabanları için güvenli güncellemeler
alter table public.promotions add column if not exists max_uses integer;
alter table public.promotions add column if not exists used_count integer not null default 0;

alter table public.users add column if not exists email text;
alter table public.users add column if not exists oauth_access_token text;
alter table public.users add column if not exists oauth_refresh_token text;
alter table public.users add column if not exists oauth_expires_at timestamptz;

alter table public.members add column if not exists display_name text;
alter table public.members add column if not exists avatar_url text;

alter table public.log_channel_configs drop constraint if exists log_channel_configs_channel_type_check;
alter table public.log_channel_configs
  add constraint log_channel_configs_channel_type_check
  check (channel_type in (
    'user_main','user_auth','user_roles','user_exchange','user_store',
    'admin_main','admin_wallet','admin_store','admin_notifications','admin_settings',
    'main','auth','roles','system','suspicious','store','wallet','notifications','settings','admin'
  ));

alter table public.bot_log_channels drop constraint if exists bot_log_channels_channel_type_check;
alter table public.bot_log_channels
  add constraint bot_log_channels_channel_type_check
  check (channel_type in (
    'user_main','user_auth','user_roles','user_exchange','user_store',
    'admin_main','admin_wallet','admin_store','admin_notifications','admin_settings',
    'main','auth','roles','system','suspicious','store','wallet','notifications','settings','admin'
  ));

-- Realtime yayını (varsa eklemeyi dene)
do $$
begin
exception
  when duplicate_object then null;
end $$;

-- Wallet reset fonksiyonu
create or replace function public.reset_all_wallets()
returns jsonb
language plpgsql
security definer
as $$
declare
  wallet_record record;
  result jsonb := '{"success": true, "reset_count": 0, "ledger_entries": 0}'::jsonb;
  reset_count integer := 0;
  ledger_count integer := 0;
begin
  -- Tüm wallet kayıtlarını sıfırla ve ledger'a kayıt ekle
  for wallet_record in
    select id, guild_id, user_id, balance
    from public.member_wallets
    where balance > 0
  loop
    -- Ledger'a admin_adjust kaydı ekle (negatif miktar)
    insert into public.wallet_ledger (
      guild_id, user_id, amount, type, balance_after, metadata
    ) values (
      wallet_record.guild_id,
      wallet_record.user_id,
      -wallet_record.balance,
      'admin_adjust',
      0,
      '{"reason": "system_reset", "previous_balance": ' || wallet_record.balance || '}'::jsonb
    );

    -- Balance'ı sıfırla
    update public.member_wallets
    set balance = 0, updated_at = now()
    where id = wallet_record.id;

    reset_count := reset_count + 1;
    ledger_count := ledger_count + 1;
  end loop;

  -- Sonucu güncelle
  result := jsonb_set(result, '{reset_count}', reset_count::text::jsonb);
  result := jsonb_set(result, '{ledger_entries}', ledger_count::text::jsonb);

  return result;
end;
$$;

-- Özel indirim kodları için yeni kolon
alter table public.store_discounts add column if not exists is_special boolean not null default false;

-- Bulk purchase support for store_orders
alter table public.store_orders add column if not exists items jsonb;
alter table public.store_orders add column if not exists subtotal numeric;
alter table public.store_orders add column if not exists discount_amount numeric;
