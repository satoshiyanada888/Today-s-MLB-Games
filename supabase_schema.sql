-- MLB Scoreboard (MVP leaderboard) schema for Supabase
-- Run this in Supabase SQL Editor.

-- Profiles (public handle)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text not null unique,
  created_at timestamptz not null default now()
);

-- One pick per user per day
create table if not exists public.daily_picks (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  date text not null, -- YYYY-MM-DD
  game_pk bigint not null,
  side text not null check (side in ('away','home')),
  created_at timestamptz not null default now(),
  unique (user_id, date)
);

-- Result submission (MVP: client-computed; later replace with server-verified)
create table if not exists public.pick_results (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  date text not null, -- YYYY-MM-DD
  game_pk bigint not null,
  side text not null check (side in ('away','home')),
  outcome boolean not null, -- true=hit
  computed_at timestamptz not null default now(),
  unique (user_id, date)
);

-- Simple daily leaderboard
create or replace view public.daily_leaderboard as
select
  pr.date,
  pr.user_id,
  p.handle,
  sum(case when pr.outcome then 1 else 0 end)::int as hits,
  count(*)::int as total,
  max(pr.computed_at) as computed_at
from public.pick_results pr
join public.profiles p on p.id = pr.user_id
group by pr.date, pr.user_id, p.handle;

-- Enable RLS
alter table public.profiles enable row level security;
alter table public.daily_picks enable row level security;
alter table public.pick_results enable row level security;

-- Policies
-- profiles: public read, self insert/update
drop policy if exists "profiles_select_all" on public.profiles;
create policy "profiles_select_all"
on public.profiles for select
to anon, authenticated
using (true);

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self"
on public.profiles for insert
to authenticated
with check (auth.uid() = id);

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self"
on public.profiles for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

-- daily_picks: self upsert/select
drop policy if exists "daily_picks_select_all" on public.daily_picks;
create policy "daily_picks_select_all"
on public.daily_picks for select
to anon, authenticated
using (true);

drop policy if exists "daily_picks_insert_self" on public.daily_picks;
create policy "daily_picks_insert_self"
on public.daily_picks for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "daily_picks_update_self" on public.daily_picks;
create policy "daily_picks_update_self"
on public.daily_picks for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- pick_results: public read, self insert/update
drop policy if exists "pick_results_select_all" on public.pick_results;
create policy "pick_results_select_all"
on public.pick_results for select
to anon, authenticated
using (true);

drop policy if exists "pick_results_insert_self" on public.pick_results;
create policy "pick_results_insert_self"
on public.pick_results for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "pick_results_update_self" on public.pick_results;
create policy "pick_results_update_self"
on public.pick_results for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

