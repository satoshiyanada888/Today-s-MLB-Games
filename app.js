const API_BASE = 'https://statsapi.mlb.com/api/v1';
const SPORT_ID = 1; // MLB

// チーム正式名 → 愛称（ネタ・遊び用）
const TEAM_NICKNAMES = {
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
};

function getTeamDisplayName(teamName, useNickname) {
  if (!teamName) return '—';
  if (!useNickname) return teamName;
  return TEAM_NICKNAMES[teamName] ?? teamName;
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

  if (a === h) return '引き分け。今日は譲れない一戦でした。';
  if (diff >= 6) return '大差で決着。今日は一方のターンでした。';
  if (diff <= 2) return '最後まで目が離せなかった接戦！';
  return 'いい試合でした。';
}

function formatDisplayDate(date) {
  const d = new Date(date);
  return d.toLocaleDateString('ja-JP', {
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
  const map = {
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
  return map[state] ?? state;
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

function renderGame(game) {
  const useNickname = document.getElementById('nickname-toggle')?.checked ?? false;
  const away = game.teams?.away?.team;
  const home = game.teams?.home?.team;
  const awayName = getTeamDisplayName(away?.name, useNickname);
  const homeName = getTeamDisplayName(home?.name, useNickname);
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
    ${final && winner ? `<div class="winner-label">${(winner === 'away' ? awayName : homeName)} の勝利</div>` : ''}
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

function renderAllGames() {
  const container = document.getElementById('games-list');
  if (!container || cachedGames.length === 0) return;
  container.innerHTML = '';
  cachedGames.forEach((game) => container.appendChild(renderGame(game)));
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
  const dateEl = document.getElementById('date-display');
  dateEl.textContent = formatDisplayDate(new Date());

  const nicknameToggle = document.getElementById('nickname-toggle');
  if (nicknameToggle) {
    try {
      nicknameToggle.checked = localStorage.getItem('mlb-nickname-mode') === '1';
    } catch (_) {}
    nicknameToggle.addEventListener('change', () => {
      try {
        localStorage.setItem('mlb-nickname-mode', nicknameToggle.checked ? '1' : '0');
      } catch (_) {}
      renderAllGames();
    });
  }

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
        return;
      }

      cachedGames = games;
      const container = document.getElementById('games-list');
      container.innerHTML = '';
      games.forEach((game) => container.appendChild(renderGame(game)));
      showGamesList(true);
    })
    .catch((err) => {
      showLoading(false);
      showError('試合データの取得に失敗しました: ' + (err.message || 'Unknown error'));
    });
}

run();
