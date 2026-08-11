-- Performance indexes for earn system (3k+ guilds)
-- Run in Supabase SQL editor.

CREATE INDEX IF NOT EXISTS idx_daily_earnings_guild_user_source_date
  ON daily_earnings (guild_id, user_id, source, earning_date);

CREATE INDEX IF NOT EXISTS idx_daily_earnings_guild_settled
  ON daily_earnings (guild_id, settled_at);

CREATE INDEX IF NOT EXISTS idx_member_wallets_guild_user
  ON member_wallets (guild_id, user_id);

CREATE INDEX IF NOT EXISTS idx_member_profiles_guild_user
  ON member_profiles (guild_id, user_id);

CREATE INDEX IF NOT EXISTS idx_member_daily_stats_guild_user_date
  ON member_daily_stats (guild_id, user_id, stat_date);

CREATE INDEX IF NOT EXISTS idx_server_daily_stats_guild_date
  ON server_daily_stats (guild_id, stat_date);

CREATE INDEX IF NOT EXISTS idx_servers_discord_id
  ON servers (discord_id);
