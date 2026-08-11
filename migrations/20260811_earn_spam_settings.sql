-- Anti-abuse / spam settings for earn system
-- Run in Supabase SQL editor if columns are missing.

ALTER TABLE servers ADD COLUMN IF NOT EXISTS spam_message_cooldown_ms integer DEFAULT 5000;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS spam_min_message_length integer DEFAULT 3;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS spam_flood_count integer DEFAULT 5;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS spam_flood_window_ms integer DEFAULT 15000;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS spam_block_sticker_only boolean DEFAULT true;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS spam_block_attachment_only boolean DEFAULT true;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS spam_block_emoji_only boolean DEFAULT true;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS spam_voice_block_alone boolean DEFAULT true;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS spam_voice_block_mute_deaf boolean DEFAULT true;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS daily_message_earn_cap numeric DEFAULT 0;
ALTER TABLE servers ADD COLUMN IF NOT EXISTS daily_voice_earn_cap numeric DEFAULT 0;
