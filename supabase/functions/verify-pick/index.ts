// Supabase Edge Function: verify-pick
// Computes HIT/MISS on the server by fetching MLB Stats API.
//
// Request body: { date: "YYYY-MM-DD" }
// Auth: requires Authorization header (supabase-js functions.invoke provides it)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isFinalStatus(code: string | null | undefined) {
  const c = code || "";
  return c === "F" || c === "FD" || c === "FF" || c === "FT" || c === "FO";
}

function winnerFromRuns(awayRuns: number | null, homeRuns: number | null) {
  if (awayRuns == null || homeRuns == null) return null;
  if (awayRuns > homeRuns) return "away";
  if (homeRuns > awayRuns) return "home";
  return null;
}

function toISODate(d: Date) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Missing Supabase env vars" }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "Missing Authorization" }, 401);

  // user client (to resolve auth.uid from JWT)
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
  const userId = userData.user.id;

  let body: any = {};
  try {
    body = await req.json();
  } catch (_) {
    return json({ error: "Invalid JSON" }, 400);
  }

  const date = String(body?.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: "Invalid date" }, 400);
  }

  // admin client (bypass RLS)
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: pick, error: pickErr } = await admin
    .from("daily_picks")
    .select("game_pk, side")
    .eq("user_id", userId)
    .eq("date", date)
    .maybeSingle();

  if (pickErr) return json({ error: "Failed to load pick" }, 500);
  if (!pick) return json({ error: "No pick for date" }, 404);

  const gamePk = Number(pick.game_pk);
  const side = String(pick.side);
  if (!gamePk || (side !== "away" && side !== "home")) {
    return json({ error: "Invalid pick data" }, 400);
  }

  // Fetch MLB live feed for authoritative status & score
  const mlbUrl = `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`;
  const mlbRes = await fetch(mlbUrl);
  if (!mlbRes.ok) return json({ error: "MLB API error" }, 502);
  const mlb = await mlbRes.json();

  const statusCode = mlb?.gameData?.status?.statusCode ?? null;
  if (!isFinalStatus(statusCode)) {
    return json({ error: "Game not final", statusCode }, 409);
  }

  const awayRuns = mlb?.liveData?.linescore?.teams?.away?.runs ?? null;
  const homeRuns = mlb?.liveData?.linescore?.teams?.home?.runs ?? null;
  const winner = winnerFromRuns(
    typeof awayRuns === "number" ? awayRuns : null,
    typeof homeRuns === "number" ? homeRuns : null,
  );
  if (!winner) {
    return json({ error: "No winner (tie/unknown)", awayRuns, homeRuns }, 409);
  }

  const outcome = winner === side;

  const { error: upsertErr } = await admin.from("pick_results").upsert({
    user_id: userId,
    date,
    game_pk: gamePk,
    side,
    outcome,
    computed_at: new Date().toISOString(),
  });

  if (upsertErr) return json({ error: "Failed to write result" }, 500);

  // Update streak stats (profiles)
  // Requires profiles columns: current_streak, best_streak, last_streak_date
  try {
    const { data: prof } = await admin
      .from("profiles")
      .select("current_streak,best_streak,last_streak_date")
      .eq("id", userId)
      .maybeSingle();

    const cur = Number(prof?.current_streak ?? 0) || 0;
    const best = Number(prof?.best_streak ?? 0) || 0;
    const last = String(prof?.last_streak_date ?? "");

    const today = new Date(`${date}T00:00:00Z`);
    const yesterday = new Date(today.getTime() - 86400 * 1000);
    const ymdYesterday = toISODate(yesterday);

    let nextCur = 0;
    let nextBest = best;
    let nextLast = date;

    if (outcome) {
      nextCur = last === ymdYesterday ? cur + 1 : 1;
      nextBest = Math.max(nextBest, nextCur);
    } else {
      nextCur = 0;
    }

    await admin.from("profiles").update({
      current_streak: nextCur,
      best_streak: nextBest,
      last_streak_date: nextLast,
    }).eq("id", userId);
  } catch (_) {
    // ignore: migration not applied yet
  }

  return json({
    date,
    gamePk,
    side,
    winner,
    outcome,
    awayRuns,
    homeRuns,
    statusCode,
  });
});

