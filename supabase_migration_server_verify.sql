-- Migration: move result computation server-side (Edge Function)
-- Run this AFTER supabase_schema.sql has been applied.

-- Disallow clients from inserting/updating pick_results directly.
drop policy if exists "pick_results_insert_self" on public.pick_results;
drop policy if exists "pick_results_update_self" on public.pick_results;

-- (Optional) also disallow clients from reading raw daily_picks
-- If you want to keep daily_picks private, uncomment:
-- drop policy if exists "daily_picks_select_all" on public.daily_picks;
-- create policy "daily_picks_select_self"
-- on public.daily_picks for select
-- to authenticated
-- using (auth.uid() = user_id);

