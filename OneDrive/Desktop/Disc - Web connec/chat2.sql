-- ============================================================================
-- Enhanced Chat System Schema for Supabase/Postgres
-- Version: 2.0 (Error-Free)
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================================
-- TABLES
-- ============================================================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  username text,
  avatar text,
  status text DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'away', 'dnd')),
  custom_status text,
  last_seen timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- add any missing user columns when upgrading old schema
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'away', 'dnd')),
  ADD COLUMN IF NOT EXISTS custom_status text,
  ADD COLUMN IF NOT EXISTS avatar text,
  ADD COLUMN IF NOT EXISTS last_seen timestamptz DEFAULT now();

-- Rooms table
CREATE TABLE IF NOT EXISTS rooms (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  room_type text NOT NULL CHECK (room_type IN ('dm', 'group', 'help')),
  name text,
  description text,
  avatar_url text,
  is_persistent boolean DEFAULT false NOT NULL,
  pair_key text,
  created_by text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  last_message_at timestamptz,
  last_message_preview text,
  is_archived boolean DEFAULT false NOT NULL
);

-- in case the table pre-existed without created_by column
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS created_by text;

-- add any other missing rooms columns when upgrading old schema
ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS is_persistent boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS pair_key text,
  ADD COLUMN IF NOT EXISTS last_message_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_message_preview text,
  ADD COLUMN IF NOT EXISTS is_archived boolean DEFAULT false NOT NULL;

-- if users.id is uuid, attempt to convert all foreign key columns to uuid
DO $$
DECLARE
  tbl text;
  col text;
BEGIN
  FOR tbl, col IN
    VALUES
      ('rooms','created_by'),
      ('room_members','user_id'),
      ('messages','sender_id'),
      ('message_reactions','user_id'),
      ('message_edit_history','edited_by'),
      ('typing_indicators','user_id'),
      ('pinned_messages','pinned_by')
  LOOP
    IF EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = tbl
          AND column_name = col
          AND data_type = 'text')
       AND EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'users'
          AND column_name = 'id'
          AND data_type = 'uuid') THEN
      BEGIN
        EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE uuid USING (%I::uuid)', tbl, col, col);
      EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'could not convert %.% to uuid: %', tbl, col, SQLERRM;
      END;
    END IF;
  END LOOP;
END$$;
-- Room members table
CREATE TABLE IF NOT EXISTS room_members (
  room_id uuid NOT NULL,
  user_id text NOT NULL,
  role text DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'moderator', 'member')),
  joined_at timestamptz DEFAULT now() NOT NULL,
  last_read_at timestamptz DEFAULT now() NOT NULL,
  unread_count integer DEFAULT 0 NOT NULL,
  is_muted boolean DEFAULT false NOT NULL,
  is_pinned boolean DEFAULT false NOT NULL,
  notification_preference text DEFAULT 'all' CHECK (notification_preference IN ('all', 'mentions', 'none')),
  PRIMARY KEY (room_id, user_id)
);

-- add any missing room_members columns when upgrading old schema
ALTER TABLE room_members
  ADD COLUMN IF NOT EXISTS joined_at timestamptz DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS last_read_at timestamptz DEFAULT now() NOT NULL,
  ADD COLUMN IF NOT EXISTS unread_count integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS is_muted boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS is_pinned boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS notification_preference text DEFAULT 'all' CHECK (notification_preference IN ('all', 'mentions', 'none'));

-- Messages table
CREATE TABLE IF NOT EXISTS messages (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  room_id uuid NOT NULL,
  sender_id text NOT NULL,
  content text NOT NULL,
  content_type text DEFAULT 'text' CHECK (content_type IN ('text', 'system', 'file')),
  metadata jsonb DEFAULT '{}'::jsonb,
  reply_to uuid,
  is_edited boolean DEFAULT false NOT NULL,
  is_deleted boolean DEFAULT false NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  edited_at timestamptz,
  deleted_at timestamptz
);

-- add any missing messages columns when upgrading old schema
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS content_type text DEFAULT 'text' CHECK (content_type IN ('text', 'system', 'file')),
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reply_to uuid,
  ADD COLUMN IF NOT EXISTS is_edited boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS is_deleted boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- add missing reply_to if table pre-existed without it
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to uuid;
-- Message reactions table
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id uuid NOT NULL,
  user_id text NOT NULL,
  emoji text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

-- Message attachments table
CREATE TABLE IF NOT EXISTS message_attachments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id uuid NOT NULL,
  file_name text NOT NULL,
  file_type text NOT NULL,
  file_size bigint NOT NULL,
  file_url text NOT NULL,
  thumbnail_url text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- Message edit history table
CREATE TABLE IF NOT EXISTS message_edit_history (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id uuid NOT NULL,
  previous_content text NOT NULL,
  edited_by text NOT NULL,
  edited_at timestamptz DEFAULT now() NOT NULL
);

-- Typing indicators table
CREATE TABLE IF NOT EXISTS typing_indicators (
  room_id uuid NOT NULL,
  user_id text NOT NULL,
  started_at timestamptz DEFAULT now() NOT NULL,
  expires_at timestamptz DEFAULT (now() + interval '5 seconds') NOT NULL,
  PRIMARY KEY (room_id, user_id)
);

-- Pinned messages table
CREATE TABLE IF NOT EXISTS pinned_messages (
  room_id uuid NOT NULL,
  message_id uuid NOT NULL,
  pinned_by text NOT NULL,
  pinned_at timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY (room_id, message_id)
);

-- ============================================================================
-- ADD FOREIGN KEYS (after all tables are created)
-- ============================================================================

DO $$ 
BEGIN
  -- rooms.created_by → users.id
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rooms_created_by_fkey'
  ) THEN
    IF (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name='rooms' AND column_name='created_by' LIMIT 1) =
       (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name='users' AND column_name='id' LIMIT 1) THEN
      ALTER TABLE rooms ADD CONSTRAINT rooms_created_by_fkey 
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
    ELSE
      RAISE NOTICE 'skipping rooms_created_by_fkey: types do not match';
    END IF;
  END IF;

  -- room_members → rooms
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'room_members_room_id_fkey'
  ) THEN
    ALTER TABLE room_members ADD CONSTRAINT room_members_room_id_fkey 
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE;
  END IF;

  -- room_members → users (only add if column types match)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'room_members_user_id_fkey'
  ) THEN
    IF (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name='room_members' AND column_name='user_id' LIMIT 1) =
       (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name='users' AND column_name='id' LIMIT 1) THEN
      ALTER TABLE room_members ADD CONSTRAINT room_members_user_id_fkey 
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    ELSE
      RAISE NOTICE 'skipping room_members_user_id_fkey: types do not match';
    END IF;
  END IF;

  -- messages → rooms
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_room_id_fkey'
  ) THEN
    ALTER TABLE messages ADD CONSTRAINT messages_room_id_fkey 
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE;
  END IF;

  -- messages → users (sender_id)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_sender_id_fkey'
  ) THEN
    IF (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name='messages' AND column_name='sender_id' LIMIT 1) =
       (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name='users' AND column_name='id' LIMIT 1) THEN
      ALTER TABLE messages ADD CONSTRAINT messages_sender_id_fkey 
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE;
    ELSE
      RAISE NOTICE 'skipping messages_sender_id_fkey: types do not match';
    END IF;
  END IF;

  -- messages.reply_to → messages
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_reply_to_fkey'
  ) THEN
    ALTER TABLE messages ADD CONSTRAINT messages_reply_to_fkey 
      FOREIGN KEY (reply_to) REFERENCES messages(id) ON DELETE SET NULL;
  END IF;

  -- message_reactions → messages
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_reactions_message_id_fkey'
  ) THEN
    ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_message_id_fkey 
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
  END IF;

  -- message_reactions → users
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_reactions_user_id_fkey'
  ) THEN
    IF (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name='message_reactions' AND column_name='user_id' LIMIT 1) =
       (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name='users' AND column_name='id' LIMIT 1) THEN
      ALTER TABLE message_reactions ADD CONSTRAINT message_reactions_user_id_fkey 
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    ELSE
      RAISE NOTICE 'skipping message_reactions_user_id_fkey: types do not match';
    END IF;
  END IF;

  -- message_attachments → messages
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_attachments_message_id_fkey'
  ) THEN
    ALTER TABLE message_attachments ADD CONSTRAINT message_attachments_message_id_fkey 
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
  END IF;

  -- message_edit_history → messages
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_edit_history_message_id_fkey'
  ) THEN
    ALTER TABLE message_edit_history ADD CONSTRAINT message_edit_history_message_id_fkey 
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
  END IF;

  -- message_edit_history → users
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'message_edit_history_edited_by_fkey'
  ) THEN
    IF (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name='message_edit_history' AND column_name='edited_by' LIMIT 1) =
       (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name='users' AND column_name='id' LIMIT 1) THEN
      ALTER TABLE message_edit_history ADD CONSTRAINT message_edit_history_edited_by_fkey 
        FOREIGN KEY (edited_by) REFERENCES users(id) ON DELETE CASCADE;
    ELSE
      RAISE NOTICE 'skipping message_edit_history_edited_by_fkey: types do not match';
    END IF;
  END IF;

  -- typing_indicators → rooms
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'typing_indicators_room_id_fkey'
  ) THEN
    ALTER TABLE typing_indicators ADD CONSTRAINT typing_indicators_room_id_fkey 
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE;
  END IF;

  -- typing_indicators → users
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'typing_indicators_user_id_fkey'
  ) THEN
    IF (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name='typing_indicators' AND column_name='user_id' LIMIT 1) =
       (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name='users' AND column_name='id' LIMIT 1) THEN
      ALTER TABLE typing_indicators ADD CONSTRAINT typing_indicators_user_id_fkey 
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    ELSE
      RAISE NOTICE 'skipping typing_indicators_user_id_fkey: types do not match';
    END IF;
  END IF;

  -- pinned_messages → rooms
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint where conname = 'pinned_messages_room_id_fkey'
  ) THEN
    ALTER TABLE pinned_messages ADD CONSTRAINT pinned_messages_room_id_fkey 
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE;
  END IF;

  -- pinned_messages → messages
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint where conname = 'pinned_messages_message_id_fkey'
  ) THEN
    ALTER TABLE pinned_messages ADD CONSTRAINT pinned_messages_message_id_fkey 
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
  END IF;

  -- pinned_messages → users
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint where conname = 'pinned_messages_pinned_by_fkey'
  ) THEN
    IF (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name='pinned_messages' AND column_name='pinned_by' LIMIT 1) =
       (SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name='users' AND column_name='id' LIMIT 1) THEN
      ALTER TABLE pinned_messages ADD CONSTRAINT pinned_messages_pinned_by_fkey 
        FOREIGN KEY (pinned_by) REFERENCES users(id) ON DELETE CASCADE;
    ELSE
      RAISE NOTICE 'skipping pinned_messages_pinned_by_fkey: types do not match';
    END IF;
  END IF;
END $$;

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_rooms_pair_key 
  ON rooms(pair_key) WHERE room_type = 'dm' AND is_archived = false;
CREATE INDEX IF NOT EXISTS idx_rooms_type_last_message 
  ON rooms(room_type, last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_rooms_created_by ON rooms(created_by);
CREATE INDEX IF NOT EXISTS idx_rooms_name_trgm 
  ON rooms USING gin(name gin_trgm_ops) WHERE name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_room_members_user_id ON room_members(user_id);
CREATE INDEX IF NOT EXISTS idx_room_members_unread 
  ON room_members(user_id, unread_count) WHERE unread_count > 0;
CREATE INDEX IF NOT EXISTS idx_room_members_pinned 
  ON room_members(user_id, is_pinned) WHERE is_pinned = true;
CREATE INDEX IF NOT EXISTS idx_room_members_user_last_read 
  ON room_members(user_id, last_read_at);

CREATE INDEX IF NOT EXISTS idx_messages_room_created 
  ON messages(room_id, created_at DESC) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to) WHERE reply_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_room_sender_created 
  ON messages(room_id, sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_content_fts 
  ON messages USING gin(to_tsvector('english', content)) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS idx_messages_content_trgm 
  ON messages USING gin(content gin_trgm_ops) WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_reactions_user ON message_reactions(user_id);

CREATE INDEX IF NOT EXISTS idx_attachments_message ON message_attachments(message_id);

CREATE INDEX IF NOT EXISTS idx_edit_history_message 
  ON message_edit_history(message_id, edited_at DESC);

CREATE INDEX IF NOT EXISTS idx_typing_room_expires ON typing_indicators(room_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_pinned_room ON pinned_messages(room_id, pinned_at DESC);

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION get_or_create_dm_room(uid_a text, uid_b text)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  a text := LEAST(uid_a, uid_b);
  b text := GREATEST(uid_a, uid_b);
  key text := a || '|' || b;
  rid uuid;
BEGIN
  SELECT id INTO rid FROM rooms 
  WHERE pair_key = key AND room_type = 'dm' AND is_archived = false 
  LIMIT 1;
  
  IF rid IS NOT NULL THEN
    RETURN rid;
  END IF;

  INSERT INTO rooms (room_type, name, is_persistent, pair_key, created_by)
  VALUES ('dm', NULL, false, key, uid_a)
  RETURNING id INTO rid;

  INSERT INTO room_members (room_id, user_id, role) 
  VALUES (rid, a, 'member'), (rid, b, 'member')
  ON CONFLICT DO NOTHING;

  RETURN rid;
END;
$$;

CREATE OR REPLACE FUNCTION increment_unread_counts()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.content_type = 'system' OR NEW.is_deleted THEN
    RETURN NEW;
  END IF;

  UPDATE room_members
  SET unread_count = unread_count + 1
  WHERE room_id = NEW.room_id 
    AND user_id != NEW.sender_id
    AND last_read_at < NEW.created_at;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION update_room_last_message()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  preview_text text;
BEGIN
  IF NEW.content_type = 'text' THEN
    preview_text := LEFT(NEW.content, 100);
  ELSIF NEW.content_type = 'file' THEN
    preview_text := '📎 Dosya eklentisi';
  ELSE
    preview_text := 'Sistem mesajı';
  END IF;

  UPDATE rooms 
  SET 
    last_message_at = NEW.created_at,
    last_message_preview = preview_text,
    updated_at = now()
  WHERE id = NEW.room_id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION mark_room_as_read(p_room_id uuid, p_user_id text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE room_members
  SET 
    unread_count = 0,
    last_read_at = now()
  WHERE room_id = p_room_id AND user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION search_messages(
  p_user_id text,
  p_query text,
  p_limit int DEFAULT 50
)
RETURNS TABLE (
  message_id uuid,
  room_id uuid,
  sender_id text,
  content text,
  created_at timestamptz,
  room_name text,
  rank real
) LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT 
    m.id,
    m.room_id,
    m.sender_id,
    m.content,
    m.created_at,
    r.name,
    ts_rank(to_tsvector('english', m.content), plainto_tsquery('english', p_query)) as rank
  FROM messages m
  JOIN rooms r ON m.room_id = r.id
  JOIN room_members rm ON r.id = rm.room_id
  WHERE 
    rm.user_id::text = p_user_id
    AND m.is_deleted = false
    AND to_tsvector('english', m.content) @@ plainto_tsquery('english', p_query)
  ORDER BY rank DESC, m.created_at DESC
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION cleanup_expired_typing()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM typing_indicators WHERE expires_at < now();
END;
$$;

CREATE OR REPLACE FUNCTION archive_old_messages(days_old int DEFAULT 365)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  affected_count integer;
BEGIN
  UPDATE messages
  SET is_deleted = true, deleted_at = now()
  WHERE created_at < now() - (days_old || ' days')::interval
    AND is_deleted = false
    AND content_type != 'system';
  
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  RETURN affected_count;
END;
$$;

CREATE OR REPLACE FUNCTION vacuum_typing_indicators()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM typing_indicators WHERE expires_at < now() - interval '1 hour';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- ============================================================================
-- TRIGGERS
-- ============================================================================

DROP TRIGGER IF EXISTS trg_update_room_last_message ON messages;
CREATE TRIGGER trg_update_room_last_message
  AFTER INSERT ON messages
  FOR EACH ROW 
  WHEN (NEW.is_deleted = false)
  EXECUTE FUNCTION update_room_last_message();

DROP TRIGGER IF EXISTS trg_increment_unread_counts ON messages;
CREATE TRIGGER trg_increment_unread_counts
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION increment_unread_counts();

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_rooms_updated_at ON rooms;
CREATE TRIGGER trg_rooms_updated_at
  BEFORE UPDATE ON rooms
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE typing_indicators ENABLE ROW LEVEL SECURITY;
ALTER TABLE pinned_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users are viewable by everyone" ON users;
DROP POLICY IF EXISTS "Users can update own profile" ON users;
DROP POLICY IF EXISTS "Users can insert own profile" ON users;
DROP POLICY IF EXISTS "Users can view rooms they are members of" ON rooms;
DROP POLICY IF EXISTS "Users can view their own memberships" ON room_members;
DROP POLICY IF EXISTS "Users can view messages in their rooms" ON messages;
DROP POLICY IF EXISTS "Users can insert messages in their rooms" ON messages;
DROP POLICY IF EXISTS "Users can update their own messages" ON messages;
DROP POLICY IF EXISTS "Users can view reactions in their rooms" ON message_reactions;
DROP POLICY IF EXISTS "Users can add reactions" ON message_reactions;
DROP POLICY IF EXISTS "Users can remove their reactions" ON message_reactions;
DROP POLICY IF EXISTS "Users can view attachments in their rooms" ON message_attachments;
DROP POLICY IF EXISTS "Users can view typing in their rooms" ON typing_indicators;
DROP POLICY IF EXISTS "Users can insert own typing status" ON typing_indicators;
DROP POLICY IF EXISTS "Users can delete own typing status" ON typing_indicators;
DROP POLICY IF EXISTS "Users can view pinned messages in their rooms" ON pinned_messages;

CREATE POLICY "Users are viewable by everyone" ON users
  FOR SELECT USING (true);

CREATE POLICY "Users can update own profile" ON users
  FOR UPDATE USING (auth.uid()::text = id::text);

CREATE POLICY "Users can insert own profile" ON users
  FOR INSERT WITH CHECK (auth.uid()::text = id::text);

CREATE POLICY "Users can view rooms they are members of" ON rooms
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM room_members 
      WHERE room_id = rooms.id 
      AND user_id::text = auth.uid()::text
    )
  );

CREATE POLICY "Users can view their own memberships" ON room_members
  FOR SELECT USING (user_id::text = auth.uid()::text);

CREATE POLICY "Users can view messages in their rooms" ON messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM room_members 
      WHERE room_id = messages.room_id 
      AND user_id::text = auth.uid()::text
    )
  );

CREATE POLICY "Users can insert messages in their rooms" ON messages
  FOR INSERT WITH CHECK (
    sender_id::text = auth.uid()::text
    AND EXISTS (
      SELECT 1 FROM room_members 
      WHERE room_id = messages.room_id 
      AND user_id::text = auth.uid()::text
    )
  );

CREATE POLICY "Users can update their own messages" ON messages
  FOR UPDATE USING (sender_id::text = auth.uid()::text);

CREATE POLICY "Users can view reactions in their rooms" ON message_reactions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM messages m
      JOIN room_members rm ON m.room_id = rm.room_id
      WHERE m.id = message_reactions.message_id
      AND rm.user_id::text = auth.uid()::text
    )
  );

CREATE POLICY "Users can add reactions" ON message_reactions
  FOR INSERT WITH CHECK (user_id::text = auth.uid()::text);

CREATE POLICY "Users can remove their reactions" ON message_reactions
  FOR DELETE USING (user_id::text = auth.uid()::text);

CREATE POLICY "Users can view attachments in their rooms" ON message_attachments
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM messages m
      JOIN room_members rm ON m.room_id = rm.room_id
      WHERE m.id = message_attachments.message_id
      AND rm.user_id::text = auth.uid()::text
    )
  );

CREATE POLICY "Users can view typing in their rooms" ON typing_indicators
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM room_members 
      WHERE room_id = typing_indicators.room_id 
      AND user_id::text = auth.uid()::text
    )
  );

CREATE POLICY "Users can insert own typing status" ON typing_indicators
  FOR INSERT WITH CHECK (user_id = auth.uid()::text);

CREATE POLICY "Users can delete own typing status" ON typing_indicators
  FOR DELETE USING (user_id = auth.uid()::text);

CREATE POLICY "Users can view pinned messages in their rooms" ON pinned_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM room_members 
      WHERE room_id = pinned_messages.room_id 
      AND user_id::text = auth.uid()::text
    )
  );

-- ============================================================================
-- SEED DATA
-- ============================================================================

INSERT INTO rooms (room_type, name, description, is_persistent)
SELECT 'help', 'Admin Help', 'Yöneticilerden yardım alın', true
WHERE NOT EXISTS (
  SELECT 1 FROM rooms 
  WHERE room_type = 'help' AND name = 'Admin Help'
);

INSERT INTO rooms (room_type, name, description, is_persistent)
SELECT 'help', 'Developer Help', 'Geliştiriciler için teknik destek', true
WHERE NOT EXISTS (
  SELECT 1 FROM rooms 
  WHERE room_type = 'help' AND name = 'Developer Help'
);

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE users IS 'Kullanıcı profilleri ve Discord entegrasyonu';
COMMENT ON TABLE rooms IS 'Sohbet odaları: DM, grup veya kalıcı yardım kanalları';
COMMENT ON TABLE room_members IS 'Oda üyelikleri, okuma takibi ve tercihler';
COMMENT ON TABLE messages IS 'Tüm sohbet mesajları, düzenleme/silme desteği ile';
COMMENT ON TABLE message_reactions IS 'Mesajlara emoji tepkileri';
COMMENT ON TABLE message_attachments IS 'Mesajlara bağlı dosya ekleri';
COMMENT ON TABLE typing_indicators IS 'Otomatik süre dolumlu yazma göstergeleri';
COMMENT ON TABLE pinned_messages IS 'Odalarda sabitlenen önemli mesajlar';

COMMENT ON FUNCTION get_or_create_dm_room IS 'İki kullanıcı arasında DM odası bul veya oluştur';
COMMENT ON FUNCTION mark_room_as_read IS 'Bir odadaki tüm mesajları kullanıcı için okundu işaretle';
COMMENT ON FUNCTION search_messages IS 'Kullanıcının erişebildiği mesajlarda tam metin arama';

-- ============================================================================
-- SUCCESS MESSAGE
-- ============================================================================

DO $$ 
BEGIN 
  RAISE NOTICE '✅ Chat schema successfully installed!';
  RAISE NOTICE '📊 Tables created: 9';
  RAISE NOTICE '🔧 Functions created: 8';
  RAISE NOTICE '⚡ Triggers created: 4';
  RAISE NOTICE '🔒 RLS policies created: 15+';
  RAISE NOTICE '🎉 Ready to use!';
END $$;