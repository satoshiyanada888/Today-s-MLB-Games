const API_BASE = 'https://statsapi.mlb.com/api/v1';
const API_BASE_V11 = 'https://statsapi.mlb.com/api/v1.1';
const SPORT_ID = 1; // MLB
let currentLang = 'ja'; // 'ja' or 'en'
const PICK_STORAGE_PREFIX = 'mlb-pick-';
const IS_DEBUG = window.location.search.includes('debug=1');
const SUPABASE_URL = window.APP_CONFIG?.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = window.APP_CONFIG?.SUPABASE_ANON_KEY || '';
const DEBUG_LB_KEY = 'mlb-debug-leaderboard-mode';
let suppressServerVerifyOnce = false;

let supabaseClient = null;
let authedUser = null;

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function clamp01(n) {
  return clamp(n, 0, 1);
}

function isSupabaseEnabled() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase?.createClient);
}

async function initSupabase() {
  if (!isSupabaseEnabled()) return null;
  if (supabaseClient) return supabaseClient;

  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const { data: existing } = await supabaseClient.auth.getUser();
  if (existing?.user) {
    authedUser = existing.user;
    return supabaseClient;
  }

  // Anonymous login for frictionless MVP
  const { data, error } = await supabaseClient.auth.signInAnonymously();
  if (error) {
    console.warn('Supabase auth failed', error);
    return null;
  }
  authedUser = data?.user ?? null;
  return supabaseClient;
}

function getTodayISO() {
  return getTodayParam(); // YYYY-MM-DD
}

function sanitizeHandle(raw) {
  const v = (raw || '').trim();
  if (!v) return '';
  // allow simple chars
  const cleaned = v.replace(/[^\w\-\.]/g, '').slice(0, 18);
  return cleaned;
}

async function ensureProfile() {
  const sb = await initSupabase();
  if (!sb || !authedUser) return null;

  const { data } = await sb.from('profiles').select('handle').eq('id', authedUser.id).maybeSingle();
  if (data?.handle) return data.handle;
  return null;
}

async function upsertProfile(handle) {
  const sb = await initSupabase();
  if (!sb || !authedUser) return false;
  const h = sanitizeHandle(handle);
  if (!h) return false;
  const { error } = await sb.from('profiles').upsert({ id: authedUser.id, handle: h });
  return !error;
}

async function upsertDailyPick(date, gamePk, side) {
  const sb = await initSupabase();
  if (!sb || !authedUser) return;
  await sb.from('daily_picks').upsert({
    user_id: authedUser.id,
    date,
    game_pk: gamePk,
    side,
  });
}

async function upsertPickResult(date, gamePk, side, outcome) {
  const sb = await initSupabase();
  if (!sb || !authedUser) return;
  await sb.from('pick_results').upsert({
    user_id: authedUser.id,
    date,
    game_pk: gamePk,
    side,
    outcome,
    computed_at: new Date().toISOString(),
  });
}

async function verifyPickResultServer(date) {
  const sb = await initSupabase();
  if (!sb) return null;
  const { data, error } = await sb.functions.invoke('verify-pick', {
    body: { date },
  });
  if (error) {
    // 409: game not final / no winner etc.
    console.warn('verify-pick failed', error);
    return null;
  }
  return data || null;
}

async function fetchLeaderboard(date) {
  const sb = await initSupabase();
  if (!sb) return [];
  const { data } = await sb
    .from('daily_leaderboard')
    .select('handle,hits,total')
    .eq('date', date)
    .order('hits', { ascending: false })
    .order('computed_at', { ascending: true })
    .limit(15);
  return data || [];
}

function getDebugLbMode() {
  if (!IS_DEBUG) return 'real';
  const qs = new URLSearchParams(window.location.search);
  if (qs.get('lb') === 'mock') return 'mock';
  try {
    return localStorage.getItem(DEBUG_LB_KEY) || 'real';
  } catch (_) {
    return 'real';
  }
}

function setDebugLbMode(mode) {
  if (!IS_DEBUG) return;
  const v = mode === 'mock' ? 'mock' : 'real';
  try {
    localStorage.setItem(DEBUG_LB_KEY, v);
  } catch (_) {}
}

function seededRand(seedStr) {
  // simple xorshift32 seeded by string
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let x = h >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

function createMockLeaderboard(date, yourHandle) {
  const rand = seededRand(`${date}:${yourHandle || 'anon'}`);
  const baseHandles = [
    'Slugger', 'Curveball', 'Fastball', 'Dugout', 'Bullpen',
    'RBIking', 'Walkoff', 'NoHitter', 'Ace', 'Rookie',
    'PinchHit', 'StealHome', 'GrandSlam', 'MVP', 'Closer'
  ];
  const rows = baseHandles.slice(0, 10).map((h) => {
    const suffix = Math.floor(rand() * 90 + 10);
    const hits = rand() > 0.45 ? 1 : 0;
    return { handle: `${h}${suffix}`, hits, total: 1, isYou: false };
  });

  if (yourHandle) {
    const youHits = rand() > 0.5 ? 1 : 0;
    rows.push({ handle: yourHandle, hits: youHits, total: 1, isYou: true });
  }

  rows.sort((a, b) => b.hits - a.hits || a.handle.localeCompare(b.handle));
  return rows.slice(0, 15);
}

async function renderLeaderboard() {
  const el = document.getElementById('leaderboard');
  if (!el) return;

  const mode = getDebugLbMode();
  const title = currentLang === 'en' ? 'Leaderboard (Today)' : '今日のランキング';

  // Debug: mock leaderboard (no Supabase writes/reads)
  if (IS_DEBUG && mode === 'mock') {
    let handle = null;
    if (isSupabaseEnabled()) {
      handle = await ensureProfile();
    }
    if (!handle) {
      handle = currentLang === 'en' ? 'you' : 'あなた';
    }
    const date = getTodayISO();
    const rows = createMockLeaderboard(date, handle);
    const note =
      currentLang === 'en'
        ? 'Debug mode: showing mock leaderboard (not Supabase).'
        : 'デバッグ: ランキングをモック表示中（Supabase未使用）';

    el.innerHTML = `
      <div class="leaderboard-title">${title}</div>
      <div class="leaderboard-cta">${note}</div>
      <div>
        ${rows
          .map(
            (r, i) => `
          <div class="leaderboard-row ${r.isYou ? 'leaderboard-row-you' : ''}">
            <div class="leaderboard-left">
              <div class="leaderboard-rank">${i + 1}</div>
              <div class="leaderboard-handle">${r.handle}</div>
            </div>
            <div class="leaderboard-score">${r.hits}/${r.total}</div>
          </div>`
          )
          .join('')}
      </div>
      <div class="leaderboard-debug">
        <button type="button" class="leaderboard-debug-btn" data-lb="real">${
          currentLang === 'en' ? 'Switch to real' : '実データに戻す'
        }</button>
        <button type="button" class="leaderboard-debug-btn" data-lb="mock-refresh">${
          currentLang === 'en' ? 'Refresh mock' : 'モック再生成'
        }</button>
      </div>
    `;
    el.hidden = false;

    const toReal = el.querySelector('[data-lb="real"]');
    const refresh = el.querySelector('[data-lb="mock-refresh"]');
    if (toReal) {
      toReal.addEventListener('click', async () => {
        setDebugLbMode('real');
        await renderLeaderboard();
      });
    }
    if (refresh) {
      refresh.addEventListener('click', async () => {
        // Change the seed slightly by toggling a timestamp into storage
        try {
          localStorage.setItem('mlb-debug-mock-tick', String(Date.now()));
        } catch (_) {}
        await renderLeaderboard();
      });
    }
    return;
  }

  if (!isSupabaseEnabled()) {
    const msg =
      currentLang === 'en'
        ? 'Leaderboard is disabled. Set SUPABASE_URL and SUPABASE_ANON_KEY in config.js, then reload.'
        : 'ランキングは未設定です。`config.js` に SUPABASE_URL / SUPABASE_ANON_KEY を設定して、リロードしてください。';
    const hint =
      currentLang === 'en'
        ? 'Tip: Use config.example.js and supabase_schema.sql.'
        : 'ヒント: `config.example.js` と `supabase_schema.sql` を使って設定できます。';

    el.innerHTML = `
      <div class="leaderboard-title">${title}</div>
      <div class="leaderboard-cta">${msg}</div>
      <div class="leaderboard-cta">${hint}</div>
    `;
    el.hidden = false;
    return;
  }

  const date = getTodayISO();
  const handle = await ensureProfile();
  const rows = await fetchLeaderboard(date);

  const cta =
    currentLang === 'en'
      ? 'Set a handle to appear on the leaderboard.'
      : 'ランキングに表示するため、ニックネームを設定してね。';
  const saveLabel = currentLang === 'en' ? 'Save' : '保存';
  const placeholder = currentLang === 'en' ? 'handle (e.g. yama7)' : 'ニックネーム（例: yama7）';

  el.innerHTML = `
    <div class="leaderboard-title">${title}</div>
    <div>
      ${
        rows.length
          ? rows
              .map(
                (r, i) => `
        <div class="leaderboard-row">
          <div class="leaderboard-left">
            <div class="leaderboard-rank">${i + 1}</div>
            <div class="leaderboard-handle">${r.handle}</div>
          </div>
          <div class="leaderboard-score">${r.hits}/${r.total}</div>
        </div>`
              )
              .join('')
          : `<div class="leaderboard-cta">${
              currentLang === 'en'
                ? 'No results yet. Make a pick and come back after the game.'
                : 'まだ記録がありません。予想して、試合後にまた見てね。'
            }</div>`
      }
    </div>
    ${
      handle
        ? ''
        : `<div class="leaderboard-cta">${cta}</div>
           <div class="leaderboard-input">
             <input id="handle-input" type="text" inputmode="text" autocomplete="nickname" placeholder="${placeholder}">
             <button id="handle-save" type="button">${saveLabel}</button>
           </div>`
    }
    ${
      IS_DEBUG
        ? `<div class="leaderboard-debug">
            <button type="button" class="leaderboard-debug-btn" data-lb="mock">${
              currentLang === 'en' ? 'Debug: mock leaderboard' : 'デバッグ: モック表示'
            }</button>
          </div>`
        : ''
    }
  `;

  el.hidden = false;

  if (!handle) {
    const btn = document.getElementById('handle-save');
    const input = document.getElementById('handle-input');
    if (btn && input) {
      btn.addEventListener('click', async () => {
        const ok = await upsertProfile(input.value);
        if (ok) {
          await renderLeaderboard();
        }
      });
    }
  }

  if (IS_DEBUG) {
    const btn = el.querySelector('[data-lb="mock"]');
    if (btn) {
      btn.addEventListener('click', async () => {
        setDebugLbMode('mock');
        await renderLeaderboard();
      });
    }
  }
}

// チーム正式名 → 日本語チーム名（日本語モードで使用）
const TEAM_NAMES = {
  ja: {
    'Arizona Diamondbacks': 'ダイヤモンドバックス',
    'Atlanta Braves': 'ブレーブス',
    'Baltimore Orioles': 'オリオールズ',
    'Boston Red Sox': 'レッドソックス',
    'Chicago Cubs': 'カブス',
    'Chicago White Sox': 'ホワイトソックス',
    'Cincinnati Reds': 'レッズ',
    'Cleveland Guardians': 'ガーディアンズ',
    'Cleveland Indians': 'インディアンス',
    'Colorado Rockies': 'ロッキーズ',
    'Detroit Tigers': 'タイガース',
    'Houston Astros': 'アストロズ',
    'Kansas City Royals': 'ロイヤルズ',
    'Los Angeles Angels': 'エンゼルス',
    'Los Angeles Dodgers': 'ドジャース',
    'Miami Marlins': 'マーリンズ',
    'Milwaukee Brewers': 'ブルワーズ',
    'Minnesota Twins': 'ツインズ',
    'New York Mets': 'メッツ',
    'New York Yankees': 'ヤンキース',
    'Oakland Athletics': 'アスレチックス',
    'Philadelphia Phillies': 'フィリーズ',
    'Pittsburgh Pirates': 'パイレーツ',
    'San Diego Padres': 'パドレス',
    'San Francisco Giants': 'ジャイアンツ',
    'Seattle Mariners': 'マリナーズ',
    'St. Louis Cardinals': 'カージナルス',
    'Tampa Bay Rays': 'レイズ',
    'Texas Rangers': 'レンジャーズ',
    'Toronto Blue Jays': 'ブルージェイズ',
    'Washington Nationals': 'ナショナルズ',
  },
};

function getTeamDisplayName(team) {
  if (!team) return '—';
  const base =
    team.name ||
    team.teamName ||
    team.clubName ||
    team.locationName ||
    '—';
  if (currentLang === 'ja') {
    const ja = TEAM_NAMES.ja[team.name] || TEAM_NAMES.ja[team.teamName] || TEAM_NAMES.ja[base];
    return ja || base;
  }
  // en: APIの英語名をそのまま使う
  return base;
}

// 試合結果に合わせた「言い換え」コメント（ネタ・遊び用）
function getResultComment(game) {
  if (!isFinal(game.status)) return null;
  const away = game.teams?.away;
  const home = game.teams?.home;
  if (!away || !home) return null;
  const a = away.score ?? 0;
  const h = home.score ?? 0;
  const diff = Math.abs(a - h);

  if (a === h) {
    return currentLang === 'en'
      ? 'Tied game. Neither side would give in today.'
      : '引き分け。今日は譲れない一戦でした。';
  }
  if (diff >= 6) {
    return currentLang === 'en'
      ? 'Blowout game. One side dominated today.'
      : '大差で決着。今日は一方のターンでした。';
  }
  if (diff <= 2) {
    return currentLang === 'en'
      ? 'A nail-biting close game!'
      : '最後まで目が離せなかった接戦！';
  }
  return currentLang === 'en' ? 'Good game.' : 'いい試合でした。';
}

function formatDisplayDate(date) {
  const d = new Date(date);
  const locale = currentLang === 'en' ? 'en-US' : 'ja-JP';
  return d.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short'
  });
}

function getTodayParam() {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const y = now.getFullYear();
  // MLB API accepts YYYY-MM-DD format
  return `${y}-${m}-${d}`;
}

function getGameStatusText(status) {
  const state = status?.detailedState ?? status?.statusCode ?? '';
  if (currentLang === 'en') {
    const mapEn = {
      'Scheduled': 'Scheduled',
      'Pre-Game': 'Pre-game',
      'Warmup': 'Warmup',
      'In Progress': 'In Progress',
      'Final': 'Final',
      'Final: Tie': 'Final: Tie',
      'Suspended': 'Suspended',
      'Postponed': 'Postponed',
      'Canceled': 'Canceled'
    };
    return mapEn[state] ?? state;
  }
  const mapJa = {
    'Scheduled': '予定',
    'Pre-Game': '試合前',
    'Warmup': 'ウォームアップ',
    'In Progress': '試合中',
    'Final': '試合終了',
    'Final: Tie': '引き分け',
    'Suspended': 'サスペンデッド',
    'Postponed': '延期',
    'Canceled': '中止'
  };
  return mapJa[state] ?? state;
}

function isFinal(status) {
  const code = status?.statusCode ?? '';
  return code === 'F' || code === 'FD' || code === 'FF' || code === 'FT' || code === 'FO';
}

function getWinner(game) {
  const away = game.teams?.away;
  const home = game.teams?.home;
  if (!away || !home) return null;
  const aScore = away.score ?? 0;
  const hScore = home.score ?? 0;
  if (aScore > hScore) return 'away';
  if (hScore > aScore) return 'home';
  return null;
}

function getTeamCode(team, fallbackName) {
  if (!team && !fallbackName) return '';
  if (team?.abbreviation) return team.abbreviation;
  const base = team?.teamName || team?.name || fallbackName || '';
  if (!base) return '';
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0].slice(0, 3).toUpperCase();
  }
  return parts
    .map((p) => p[0])
    .join('')
    .slice(0, 3)
    .toUpperCase();
}

function formatWinnerLabel(teamName) {
  if (!teamName) return '';
  if (currentLang === 'en') return `${teamName} won`;
  return `${teamName} の勝利`;
}

function renderGame(game) {
  const away = game.teams?.away?.team;
  const home = game.teams?.home?.team;
  const awayName = getTeamDisplayName(away);
  const homeName = getTeamDisplayName(home);
  const awayScore = game.teams?.away?.score ?? '-';
  const homeScore = game.teams?.home?.score ?? '-';
  const status = game.status ?? {};
  const winner = getWinner(game);
  const final = isFinal(status);
  const resultComment = getResultComment(game);

  const card = document.createElement('article');
  card.className = 'game-card';

  const awayWinner = final && winner === 'away';
  const homeWinner = final && winner === 'home';

  card.innerHTML = `
    <div class="game-status">${getGameStatusText(status)}</div>
    <div class="matchup">
      <div class="team ${awayWinner ? 'winner' : ''}">
        <span class="team-name">${awayName}</span>
        <span class="score">${awayScore}</span>
      </div>
      <span class="vs">@</span>
      <div class="team ${homeWinner ? 'winner' : ''}">
        <span class="team-name">${homeName}</span>
        <span class="score">${homeScore}</span>
      </div>
    </div>
    ${final && winner ? `<div class="winner-label">${formatWinnerLabel(winner === 'away' ? awayName : homeName)}</div>` : ''}
    ${resultComment ? `<div class="result-comment">${resultComment}</div>` : ''}
  `;

  return card;
}

function showLoading(show) {
  const el = document.getElementById('loading');
  el.hidden = !show;
}

function showError(message) {
  const el = document.getElementById('error');
  el.textContent = message;
  el.hidden = false;
}

function showNoGames(show) {
  document.getElementById('no-games').hidden = !show;
}

function showGamesList(show) {
  document.getElementById('games-list').hidden = !show;
}

let cachedGames = [];
let pickGame = null;
let pickSelection = null;

let hypePollTimerId = null;
let hypePollGamePk = null;
let hypePollTick = 0;
let hypePollIntervalMs = 120_000;

function stopHypePolling() {
  if (hypePollTimerId) {
    clearInterval(hypePollTimerId);
    hypePollTimerId = null;
  }
  hypePollGamePk = null;
  hypePollTick = 0;
  hypePollIntervalMs = 120_000;
}

function getHypeText() {
  if (currentLang === 'en') {
    return {
      title: 'Drama meter',
      waiting: 'Updates during the game.',
      noData: 'No win-probability data yet.',
      labelWP: 'Win prob',
      live: 'LIVE',
      final: 'FINAL',
    };
  }
  return {
    title: '盛り上がりメーター',
    waiting: '試合中に自動更新します。',
    noData: '勝率データがまだありません。',
    labelWP: '勝率',
    live: 'LIVE',
    final: '終了',
  };
}

function setHypeUI({ value, sub, rightTag, live }) {
  const root = document.getElementById('pick-card');
  const wrap = root?.querySelector('#pick-hype');
  if (!wrap) return;

  const v = clamp(Number(value) || 0, 0, 100);
  const fill = wrap.querySelector('#pick-hype-fill');
  const valEl = wrap.querySelector('#pick-hype-value');
  const subEl = wrap.querySelector('#pick-hype-sub');
  const tagEl = wrap.querySelector('#pick-hype-tag');

  wrap.dataset.live = live ? 'true' : 'false';
  wrap.dataset.level = v >= 75 ? 'insane' : v >= 50 ? 'hot' : v >= 25 ? 'warm' : 'calm';

  if (fill) fill.style.width = `${v}%`;
  if (valEl) valEl.textContent = `${Math.round(v)} / 100`;
  if (subEl) subEl.textContent = sub || '';
  if (tagEl) tagEl.textContent = rightTag || '';
}

function ensureHypeInterval(ms) {
  const next = Number(ms) || 0;
  if (!hypePollGamePk) return;
  if (next <= 0) return;
  if (hypePollTimerId && hypePollIntervalMs === next) return;

  if (hypePollTimerId) clearInterval(hypePollTimerId);
  hypePollIntervalMs = next;
  hypePollTimerId = setInterval(() => {
    hypePollTick++;
    const tick = hypePollTick;
    if (!hypePollGamePk) return;
    refreshHypeOnce(hypePollGamePk, tick);
  }, hypePollIntervalMs);
}

async function fetchLiveFeedV11(gamePk) {
  const url = `${API_BASE_V11}/game/${encodeURIComponent(String(gamePk))}/feed/live`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`feed/live error: ${res.status}`);
  return await res.json();
}

async function fetchWinProbability(gamePk) {
  const url = `${API_BASE}/game/${encodeURIComponent(String(gamePk))}/winProbability`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`winProbability error: ${res.status}`);
  return await res.json();
}

function extractLastWpSample(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const p = arr[i];
    if (!p || typeof p !== 'object') continue;
    const homeWP = Number(p.homeTeamWinProbability);
    const awayWP = Number(p.awayTeamWinProbability);
    const drama = Number(p.dramaIndex);
    const lev = Number(p.leverageIndex);
    const ok =
      Number.isFinite(homeWP) ||
      Number.isFinite(awayWP) ||
      Number.isFinite(drama) ||
      Number.isFinite(lev);
    if (!ok) continue;
    return {
      homeWP: Number.isFinite(homeWP) ? homeWP : null,
      awayWP: Number.isFinite(awayWP) ? awayWP : null,
      dramaIndex: Number.isFinite(drama) ? drama : null,
      leverageIndex: Number.isFinite(lev) ? lev : null,
      inning: p?.about?.inning ?? null,
      half: p?.about?.halfInning ?? null,
    };
  }
  return null;
}

function hypeFromDramaAndLeverage(dramaIndex, leverageIndex) {
  const d = Number.isFinite(dramaIndex) ? clamp(dramaIndex, 0, 320) : null;
  const l = Number.isFinite(leverageIndex) ? clamp(leverageIndex, 0, 6) : null;

  const dScore = d == null ? null : Math.sqrt(d / 320) * 100; // 0..100
  const lScore = l == null ? null : clamp01(l / 4) * 100; // 0..100

  if (dScore == null && lScore == null) return null;
  if (dScore != null && lScore == null) return dScore;
  if (dScore == null && lScore != null) return lScore;
  return dScore * 0.7 + lScore * 0.3;
}

async function refreshHypeOnce(gamePk, tick) {
  const t = getHypeText();
  try {
    const [feedRes, wpRes] = await Promise.allSettled([
      fetchLiveFeedV11(gamePk),
      fetchWinProbability(gamePk),
    ]);
    if (tick !== hypePollTick) return;

    const feed = feedRes.status === 'fulfilled' ? feedRes.value : null;
    const wp = wpRes.status === 'fulfilled' ? wpRes.value : null;

    const statusCode = feed?.gameData?.status?.statusCode ?? null;
    const abstract = feed?.gameData?.status?.abstractGameState ?? '';
    const isLive =
      abstract === 'Live' ||
      statusCode === 'I' ||
      String(feed?.gameData?.status?.detailedState ?? '').toLowerCase().includes('in progress');
    const isFinalLike = isFinal({ statusCode: statusCode || '' });

    ensureHypeInterval(isLive ? 30_000 : 120_000);

    const sample = extractLastWpSample(wp);
    const hypeVal = hypeFromDramaAndLeverage(sample?.dramaIndex ?? null, sample?.leverageIndex ?? null);

    const inning = feed?.liveData?.linescore?.currentInning ?? sample?.inning ?? null;
    const state = feed?.liveData?.linescore?.inningState ?? '';
    const half = sample?.half ?? null;
    const phaseText = isFinalLike ? t.final : isLive ? t.live : '';

    let wpText = '';
    if (sample?.homeWP != null && sample?.awayWP != null) {
      const home = clamp(sample.homeWP, 0, 100);
      const away = clamp(sample.awayWP, 0, 100);
      wpText =
        currentLang === 'en'
          ? `${t.labelWP}: Home ${Math.round(home)}% · Away ${Math.round(away)}%`
          : `${t.labelWP}: ホーム ${Math.round(home)}% · アウェイ ${Math.round(away)}%`;
    } else if (sample?.homeWP != null) {
      wpText =
        currentLang === 'en'
          ? `${t.labelWP}: Home ${Math.round(clamp(sample.homeWP, 0, 100))}%`
          : `${t.labelWP}: ホーム ${Math.round(clamp(sample.homeWP, 0, 100))}%`;
    }

    const inningText =
      inning != null
        ? currentLang === 'en'
          ? `Inning ${inning}${state ? ` (${state})` : ''}${half ? ` · ${half}` : ''}`
          : `${inning}回${state ? `（${state}）` : ''}${half ? `・${half}` : ''}`
        : '';

    if (!isLive && !isFinalLike) {
      setHypeUI({
        value: 0,
        rightTag: phaseText,
        sub: [inningText, t.waiting].filter(Boolean).join(' · '),
        live: false,
      });
      return;
    }

    if (hypeVal == null) {
      setHypeUI({
        value: 0,
        rightTag: phaseText,
        sub: [inningText, wpText || t.noData].filter(Boolean).join(' · '),
        live: isLive,
      });
      return;
    }

    setHypeUI({
      value: hypeVal,
      rightTag: phaseText,
      sub: [inningText, wpText].filter(Boolean).join(' · '),
      live: isLive,
    });

    if (isFinalLike) stopHypePolling();
  } catch (_) {
    if (tick !== hypePollTick) return;
    setHypeUI({ value: 0, rightTag: '', sub: '', live: false });
  }
}

function initHypeForPick(gamePk) {
  if (!gamePk) return;
  if (hypePollGamePk !== gamePk) {
    stopHypePolling();
    hypePollGamePk = gamePk;
  }
  hypePollTick++;
  const myTick = hypePollTick;
  refreshHypeOnce(gamePk, myTick);
  ensureHypeInterval(hypePollIntervalMs);
}

function getTodayStorageKey() {
  return `${PICK_STORAGE_PREFIX}${getTodayParam()}`;
}

function choosePickGame(games) {
  if (!games || games.length === 0) return null;
  // シンプルに先頭の試合をピックアップ
  return games[0];
}

function loadPickSelection() {
  try {
    const raw = localStorage.getItem(getTodayStorageKey());
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function savePickSelection(side) {
  if (!pickGame || !pickGame.gamePk) return;
  const data = { gamePk: pickGame.gamePk, side };
  try {
    localStorage.setItem(getTodayStorageKey(), JSON.stringify(data));
  } catch (_) {}
  pickSelection = data;

  // Server submit (optional)
  if (isSupabaseEnabled()) {
    upsertDailyPick(getTodayISO(), pickGame.gamePk, side);
  }
}

function forceDebugResult(kind) {
  if (!IS_DEBUG) return;
  if (!pickGame || !pickGame.teams || !pickGame.status) return;
  // Ensure we have a selection to evaluate against
  if (!pickSelection) {
    pickSelection = { gamePk: pickGame.gamePk, side: 'away' };
  }
  const side = pickSelection.side === 'home' ? 'home' : 'away';
  const otherSide = side === 'home' ? 'away' : 'home';

  pickGame.status.statusCode = 'F';
  if (kind === 'hit') {
    pickGame.teams[side].score = 5;
    pickGame.teams[otherSide].score = 3;
  } else if (kind === 'miss') {
    pickGame.teams[side].score = 2;
    pickGame.teams[otherSide].score = 7;
  }
  suppressServerVerifyOnce = true;
  renderPickCard();
}

function renderPickCard() {
  const container = document.getElementById('pick-card');
  if (!container) return;

  if (!pickGame) {
    stopHypePolling();
    container.innerHTML =
      currentLang === 'en'
        ? '<div class="pick-card-empty">No games today.</div>'
        : '<div class="pick-card-empty">今日はピックアップできる試合がありません。</div>';
    return;
  }

  const away = pickGame.teams?.away?.team;
  const home = pickGame.teams?.home?.team;
  const awayName = getTeamDisplayName(away);
  const homeName = getTeamDisplayName(home);

  const status = pickGame.status ?? {};
  const final = isFinal(status);
  const winner = getWinner(pickGame);

  const hasPick = !!pickSelection && pickSelection.gamePk === pickGame.gamePk;
  const pickedSide = hasPick ? pickSelection.side : null;
  const pickedName =
    pickedSide === 'away' ? awayName : pickedSide === 'home' ? homeName : null;

  let resultBadgeHtml = '';
  let statusText = '';

  if (hasPick && final && winner) {
    const hit = pickedSide === winner;
    if (hit) {
      resultBadgeHtml =
        '<span class="pick-result-badge hit">' +
        (currentLang === 'en' ? 'HIT!' : '的中！') +
        '</span>';
      statusText =
        currentLang === 'en'
          ? `You picked ${pickedName}.`
          : `あなたの予想：${pickedName}`;
    } else {
      resultBadgeHtml =
        '<span class="pick-result-badge miss">' +
        (currentLang === 'en' ? 'MISS' : 'ハズレ…') +
        '</span>';
      statusText =
        currentLang === 'en'
          ? `You picked ${pickedName}, but the other side won.`
          : `あなたの予想：${pickedName}（逆側が勝利）`;
    }
  } else if (hasPick && !final) {
    statusText =
      currentLang === 'en'
        ? `You picked ${pickedName}. Result will be available after the game.`
        : `あなたの予想：${pickedName}（試合終了後に結果がわかります）`;
  } else {
    statusText =
      currentLang === 'en'
        ? 'Pick which team you think will win.'
        : 'どちらが勝つか、直感で予想してみよう。';
  }

  const labelText = currentLang === 'en' ? "Today's pick" : '今日の1試合';
  const awayBtnLabel =
    currentLang === 'en' ? `${awayName} wins` : `${awayName} が勝つ`;
  const homeBtnLabel =
    currentLang === 'en' ? `${homeName} wins` : `${homeName} が勝つ`;
  const vsText = currentLang === 'en' ? 'vs' : 'vs';

  const awayCode = getTeamCode(away, awayName);
  const homeCode = getTeamCode(home, homeName);

  // カード全体の光り方
  container.className = 'pick-card';
  if (hasPick && final && winner) {
    const hit = pickedSide === winner;
    container.classList.add(hit ? 'pick-card-hit' : 'pick-card-miss');

    // Submit result (prefer server-verified)
    if (suppressServerVerifyOnce) {
      suppressServerVerifyOnce = false;
    } else if (isSupabaseEnabled()) {
      verifyPickResultServer(getTodayISO()).then((res) => {
        // If function is not deployed yet, fall back to client upsert.
        if (!res) {
          upsertPickResult(getTodayISO(), pickGame.gamePk, pickedSide, hit);
        }
        renderLeaderboard();
      });
    }
  }

  const awayBadgeClass = `pick-badge pick-badge-away${
    pickedSide === 'away' ? ' selected' : ''
  }`;
  const homeBadgeClass = `pick-badge pick-badge-home${
    pickedSide === 'home' ? ' selected' : ''
  }`;

  container.innerHTML = `
    <div class="pick-label">${labelText}</div>
    <h2 class="pick-title">
      <span class="pick-team">
        <span class="${awayBadgeClass}">${awayCode}</span>
        <span class="pick-team-name">${awayName}</span>
      </span>
      <span class="pick-vs">${vsText}</span>
      <span class="pick-team">
        <span class="${homeBadgeClass}">${homeCode}</span>
        <span class="pick-team-name">${homeName}</span>
      </span>
    </h2>
    <div class="pick-buttons">
      <button type="button" class="pick-btn" data-pick="away"${hasPick ? ' disabled' : ''}>
        ${awayBtnLabel}
      </button>
      <button type="button" class="pick-btn" data-pick="home"${hasPick ? ' disabled' : ''}>
        ${homeBtnLabel}
      </button>
    </div>
    <div class="pick-status">
      ${resultBadgeHtml}${statusText}
    </div>
    <div class="pick-hype" id="pick-hype" data-level="calm" data-live="false">
      <div class="pick-hype-head">
        <div class="pick-hype-title">${getHypeText().title}</div>
        <div class="pick-hype-right">
          <span class="pick-hype-tag" id="pick-hype-tag"></span>
          <span class="pick-hype-value" id="pick-hype-value">-- / 100</span>
        </div>
      </div>
      <div class="pick-hype-bar">
        <div class="pick-hype-fill" id="pick-hype-fill" style="width:0%"></div>
      </div>
      <div class="pick-hype-sub" id="pick-hype-sub">${getHypeText().waiting}</div>
    </div>
    ${
      IS_DEBUG
        ? `<div class="pick-debug">
            <button type="button" class="pick-debug-btn" data-debug="hit">${
              currentLang === 'en' ? 'Debug: HIT' : 'デバッグ: 当たり'
            }</button>
            <button type="button" class="pick-debug-btn" data-debug="miss">${
              currentLang === 'en' ? 'Debug: MISS' : 'デバッグ: ハズレ'
            }</button>
          </div>`
        : ''
    }
  `;

  if (!hasPick) {
    const awayBtn = container.querySelector('[data-pick="away"]');
    const homeBtn = container.querySelector('[data-pick="home"]');
    if (awayBtn) {
      awayBtn.addEventListener('click', () => {
        savePickSelection('away');
        renderPickCard();
      });
    }
    if (homeBtn) {
      homeBtn.addEventListener('click', () => {
        savePickSelection('home');
        renderPickCard();
      });
    }
  }

  if (IS_DEBUG) {
    const hitBtn = container.querySelector('[data-debug="hit"]');
    const missBtn = container.querySelector('[data-debug="miss"]');
    if (hitBtn) {
      hitBtn.addEventListener('click', () => forceDebugResult('hit'));
    }
    if (missBtn) {
      missBtn.addEventListener('click', () => forceDebugResult('miss'));
    }
  }

  initHypeForPick(pickGame.gamePk);
}

function renderAllGames() {
  const container = document.getElementById('games-list');
  if (!container || cachedGames.length === 0) return;
  container.innerHTML = '';
  cachedGames.forEach((game) => container.appendChild(renderGame(game)));
}

function applyLanguageToStaticText() {
  const titleTextEl = document.querySelector('.app-title-text');
  if (titleTextEl) {
    titleTextEl.textContent = "Today's MLB Games"; // タイトルは両言語共通の英語にしておく
  }
  const sectionTitleEl = document.querySelector('.section-title');
  if (sectionTitleEl) {
    sectionTitleEl.textContent =
      currentLang === 'en' ? "Today's scoreboard" : '今日のスコアボード';
  }
  const loadingEl = document.getElementById('loading');
  if (loadingEl) {
    loadingEl.textContent =
      currentLang === 'en' ? 'Loading games...' : '試合データを取得中...';
  }
  const noGamesEl = document.getElementById('no-games');
  if (noGamesEl) {
    noGamesEl.textContent =
      currentLang === 'en' ? 'No games today.' : '今日の試合はありません。';
  }
  const dateEl = document.getElementById('date-display');
  if (dateEl) {
    dateEl.textContent = formatDisplayDate(new Date());
  }

  // ピックカードも文言が変わるので再描画
  renderPickCard();
}

function updateLanguageButtons() {
  const buttons = document.querySelectorAll('.lang-btn');
  buttons.forEach((btn) => {
    const lang = btn.dataset.lang;
    btn.classList.toggle('lang-btn-active', lang === currentLang);
  });
}

function setLanguage(lang) {
  if (lang !== 'ja' && lang !== 'en') lang = 'ja';
  currentLang = lang;
  try {
    localStorage.setItem('mlb-lang', lang);
  } catch (_) {}
  updateLanguageButtons();
  applyLanguageToStaticText();
  renderAllGames();
  renderLeaderboard();
}

async function fetchTodaysGames() {
  const dateParam = getTodayParam();
  const url = `${API_BASE}/schedule?sportId=${SPORT_ID}&date=${encodeURIComponent(dateParam)}&hydrate=team,linescore`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  const data = await res.json();
  return data;
}

function run() {
  // 言語の復元
  try {
    const stored = localStorage.getItem('mlb-lang');
    if (stored === 'ja' || stored === 'en') {
      currentLang = stored;
    }
  } catch (_) {}

  const langButtons = document.querySelectorAll('.lang-btn');
  langButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const lang = btn.dataset.lang;
      setLanguage(lang);
    });
  });

  applyLanguageToStaticText();
  renderLeaderboard();

  showLoading(true);
  showError('');
  showNoGames(false);
  showGamesList(false);

  fetchTodaysGames()
    .then((data) => {
      showLoading(false);
      const dates = data.dates || [];
      const games = dates.length > 0 ? (dates[0].games || []) : [];

      if (games.length === 0) {
        showNoGames(true);
        pickGame = null;
        pickSelection = null;
        renderPickCard();
        return;
      }

      cachedGames = games;
      pickGame = choosePickGame(games);
      pickSelection = loadPickSelection();
      if (pickSelection && pickSelection.gamePk !== pickGame?.gamePk) {
        // 別試合を過去に保存していた場合はリセット
        pickSelection = null;
      }
      renderPickCard();
      renderAllGames();
      showGamesList(true);
    })
    .catch((err) => {
      showLoading(false);
      const prefix =
        currentLang === 'en'
          ? 'Failed to fetch games: '
          : '試合データの取得に失敗しました: ';
      showError(prefix + (err.message || 'Unknown error'));
    });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('./service-worker.js')
        .catch(() => {
          // 特に何もしない（PWA機能がなくてもアプリは動く）
        });
    });
  }
}

run();
