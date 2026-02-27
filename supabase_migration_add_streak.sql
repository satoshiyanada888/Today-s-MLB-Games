-- Migration: add streak stats to profiles
-- Run this in Supabase SQL Editor.

alter table public.profiles
  add column if not exists current_streak integer not null default 0,
  add column if not exists best_streak integer not null default 0,
  add column if not exists last_streak_date text;

