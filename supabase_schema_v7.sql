-- Sweeger PRD v7 & Priority Match v2 Idempotent Schema Migration
-- Safe to run multiple times in Supabase SQL Editor before deploying to Render.com.

-- 1. Users table additions (onboarding profile, username, Poddy privacy, invite code, email opt-out)
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS interests jsonb DEFAULT '[]'::jsonb;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS gender text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS age integer;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS location text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS onboarding_completed boolean DEFAULT false;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS poddy_privacy text DEFAULT 'open';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS poddy_invite_code text UNIQUE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email_unsubscribed boolean DEFAULT false;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- 2. Subscriptions grace period
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS grace_period_end timestamptz;

-- 3. Rooms & Participants additions (categories, paid Live rooms, live mic/cam presence, layer chat)
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS category text DEFAULT 'Football';
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS is_paid boolean DEFAULT false;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS price_ngn integer DEFAULT 0;
ALTER TABLE public.room_participants ADD COLUMN IF NOT EXISTS mic_on boolean DEFAULT false;
ALTER TABLE public.room_participants ADD COLUMN IF NOT EXISTS cam_on boolean DEFAULT false;
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS layer text DEFAULT 'general';
ALTER TABLE public.watch_mate_members ADD COLUMN IF NOT EXISTS match_reason text DEFAULT 'matched';

-- 4. Paid Live Room Tickets
CREATE TABLE IF NOT EXISTS public.paid_room_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL,
  user_id text NOT NULL,
  price_ngn integer NOT NULL,
  creator_keeps_ngn integer NOT NULL,
  sweeger_fee_ngn integer NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (room_id, user_id)
);

-- 5. Coming Soon & Reminders
CREATE TABLE IF NOT EXISTS public.coming_soon_streams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  category text DEFAULT 'Football',
  channel_name text,
  thumbnail text,
  scheduled_start timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.stream_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id uuid NOT NULL,
  user_id text NOT NULL,
  notify_poddy boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  UNIQUE (stream_id, user_id)
);

-- 6. Persistent Mutes, Blocks, Moderation Reports & Move Audit Trail
CREATE TABLE IF NOT EXISTS public.user_mutes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  muted_user_id text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (user_id, muted_user_id)
);

CREATE TABLE IF NOT EXISTS public.user_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  blocked_user_id text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (user_id, blocked_user_id)
);

CREATE TABLE IF NOT EXISTS public.moderation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id text NOT NULL,
  target_user_id text,
  room_id text,
  show_id text,
  reason text NOT NULL,
  details text,
  status text DEFAULT 'open',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.moderation_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id text,
  actor_id text NOT NULL,
  target_user_id text,
  action text NOT NULL,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

-- 7. Poddy Streaks
CREATE TABLE IF NOT EXISTS public.poddy_streaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a text NOT NULL,
  user_b text NOT NULL,
  streak_days integer DEFAULT 1,
  last_watched_date text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (user_a, user_b)
);

-- 8. Wallet, Double-Entry Transactions & Manual Withdrawals
CREATE TABLE IF NOT EXISTS public.wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text UNIQUE NOT NULL,
  balance_ngn integer DEFAULT 0,
  creator_balance_ngn integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  counterparty_id text,
  bucket text NOT NULL,
  direction text NOT NULL,
  type text NOT NULL,
  amount_ngn integer NOT NULL,
  gross_amount_ngn integer DEFAULT 0,
  platform_fee_ngn integer DEFAULT 0,
  balance_after_ngn integer DEFAULT 0,
  reference text NOT NULL,
  content_id text,
  content_title text,
  content_type text,
  description text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.withdrawal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  amount_ngn integer NOT NULL,
  status text DEFAULT 'pending',
  bank_details jsonb DEFAULT '{}'::jsonb,
  payout_reference text,
  note text,
  processed_by text,
  processed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- 9. Cinema (Sweeger Picks, Community Picks, Priority Match, Share, Distributor, Bookings, Lobby)
CREATE TABLE IF NOT EXISTS public.cinema_movies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  genre text,
  industry text,
  youtube_id text,
  thumbnail text,
  duration_minutes integer DEFAULT 90,
  break_minutes integer DEFAULT 10,
  source text DEFAULT 'sweeger_pick',
  posted_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cinema_shows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  movie_id uuid,
  host_id text,
  host_name text,
  title text NOT NULL,
  youtube_id text,
  thumbnail text,
  genre text,
  industry text,
  starts_at timestamptz NOT NULL,
  duration_minutes integer DEFAULT 120,
  break_minutes integer DEFAULT 10,
  visibility text DEFAULT 'public',
  priority_match_enabled boolean DEFAULT false,
  priority_criteria jsonb,
  show_type text DEFAULT 'sweeger_pick',
  lobby_admin_id text,
  status text DEFAULT 'scheduled',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cinema_bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id uuid NOT NULL,
  user_id text NOT NULL,
  mode text DEFAULT 'general',
  private_group_id uuid,
  active_communities jsonb DEFAULT '{"general":true,"watchmate":false,"poddy":false}'::jsonb,
  status text DEFAULT 'booked',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (show_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.cinema_private_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id uuid NOT NULL,
  creator_id text NOT NULL,
  member_ids jsonb DEFAULT '[]'::jsonb,
  max_size integer DEFAULT 2,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cinema_match_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id uuid NOT NULL,
  requester_id text NOT NULL,
  requester_name text,
  gender text DEFAULT 'Any',
  min_age integer,
  max_age integer,
  location text DEFAULT 'Any',
  group_size integer DEFAULT 1,
  also_watch_with_general boolean DEFAULT true,
  private_group_id uuid,
  accepted_user_ids jsonb DEFAULT '[]'::jsonb,
  status text DEFAULT 'open',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cinema_friend_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  show_id uuid NOT NULL,
  inviter_id text NOT NULL,
  inviter_name text,
  invitee_id text NOT NULL,
  status text DEFAULT 'pending',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cinema_community_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id text NOT NULL,
  post_type text NOT NULL,
  title text NOT NULL,
  description text,
  when_label text,
  youtube_id text,
  thumbnail text,
  video_url text,
  price_ngn integer DEFAULT 0,
  sessions_per_day integer DEFAULT 1,
  starts_at timestamptz,
  review_status text DEFAULT 'under_review',
  review_note text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.distributor_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL,
  creator_id text NOT NULL,
  title text NOT NULL,
  price_ngn integer NOT NULL,
  starts_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.distributor_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  post_id uuid NOT NULL,
  user_id text NOT NULL,
  price_ngn integer NOT NULL,
  creator_keeps_ngn integer NOT NULL,
  sweeger_fee_ngn integer NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (session_id, user_id)
);
