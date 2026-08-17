// Scheduled market check, triggered via GitHub Actions (nominally every 5 minutes,
// though GitHub's cron scheduler does not honor that interval reliably — actual
// firings can be delayed by an hour or more under load).
//
// Two speeds of monitoring ("濃淡"):
//   - No open position: normal cadence, gated by elapsed time (not wall-clock
//     minute) since GitHub's firings drift. Roughly every ~25+ minutes, fetch
//     price data, log it (24h, free), and — during JST 9:00-next day 1:00
//     trading hours — ask Claude (Haiku 4.5) for an entry verdict and notify
//     Discord on entry.
//   - Open position (an entry verdict happened): tight cadence that must not
//     depend on GitHub's unreliable scheduler, so the process itself loops
//     internally every 5 real minutes (via setTimeout) for as long as a
//     position stays open, asking Claude to judge it (hold / TP hit / SL hit /
//     bail out) using the entry context + recent price. On resolution it
//     notifies Discord and the loop keeps going for any other open positions,
//     exiting once none remain (or after a safety time cap, handing off to
//     the next scheduled firing).
//
// Open positions and last-tick state persist across runs as data/open-positions.json
// and data/state.json. Since GitHub Actions runners are ephemeral, the script commits
// and pushes these itself after every change (see commitState()) rather than relying
// solely on a separate workflow step — important because a run can now stay alive for
// hours inside the monitoring loop, and we don't want a mid-run failure to lose state.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
// Optional: Google Apps Script Web App URL for logging every check to a spreadsheet.
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL;
// Optional: link to the Google Sheets spreadsheet itself, included in Discord notifications.
const SPREADSHEET_URL = process.env.SPREADSHEET_URL;

const MODEL = 'claude-haiku-4-5';
const INTERVAL = '15min';
const CANDLE_COUNT = 40;
const MONITOR_CANDLE_COUNT = 12; // ポジション監視は直近3時間ぶんで十分

const SYMBOLS = [
  { label: 'BTC/USD', symbol: 'BTC/USD' },
  { label: 'GOLD (XAU/USD)', symbol: 'XAU/USD' },
];

const POSITIONS_FILE = fileURLToPath(new URL('../data/open-positions.json', import.meta.url));
const STATE_FILE = fileURLToPath(new URL('../data/state.json', import.meta.url));

// GitHub Actions の cron はスケジュール通りの分ちょうどには発火しない
// (高負荷時は数十分〜1時間以上ずれることがある)。壁時計の分と一致させる
// 判定にすると、ずれた瞬間に本チェックの条件を満たせず永久にスキップされて
// しまうため、「前回の本チェックからどれだけ経過したか」で判定する。
const MAIN_TICK_INTERVAL_MS = 25 * 60 * 1000;

// ポジション保有中の集中監視ループの設定。実際の間隔はこのプロセス自身の
// setTimeoutで作るため、GitHub Actionsのcron精度に依存しない。
const MONITOR_INTERVAL_MS = 5 * 60 * 1000;
// GitHub Actionsのジョブには上限(デフォルト360分)があるため、それより
// 手前で安全に終了する。時間切れの場合、ポジションは保有中のまま残り、
// 次にジョブが起動したタイミングで監視を再開する。
const MAX_LOOP_MS = 300 * 60 * 1000;

// Trading hours: JST 9:00 - next day 1:00 == UTC 0:00-15:59.
// Outside this window we still log price data, but skip the Claude call
// and Discord notification (no trading happening, no need to spend on it).
function isTradingHours(date = new Date()) {
  const utcHour = date.getUTCHours();
  return utcHour >= 0 && utcHour <= 15;
}

function isMainTick(state, date = new Date()) {
  if (!state.lastMainTick) return true;
  return date.getTime() - new Date(state.lastMainTick).getTime() >= MAIN_TICK_INTERVAL_MS;
}

async function loadState() {
  try {
    const text = await readFile(STATE_FILE, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function saveState(state) {
  await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function requireEnv() {
  const missing = [];
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!TWELVEDATA_API_KEY) missing.push('TWELVEDATA_API_KEY');
  if (!DISCORD_WEBHOOK_URL) missing.push('DISCORD_WEBHOOK_URL');
  if (missing.length) {
    throw new Error(`必要な環境変数(GitHub Secrets)が未設定です: ${missing.join(', ')}`);
  }
}

async function loadOpenPositions() {
  try {
    const text = await readFile(POSITIONS_FILE, 'utf8');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function saveOpenPositions(positions) {
  await writeFile(POSITIONS_FILE, `${JSON.stringify(positions, null, 2)}\n`, 'utf8');
}

// 状態ファイルの変更をリポジトリにコミット・プッシュする。監視ループが
// 数時間続くこともあるため、最後にまとめてではなく、状態が変わるたびに
// その場でコミットする(途中でジョブが落ちても進捗を失わないため)。
// ローカル実行(GitHub Actions外)では誤ってpushしないようスキップする。
function commitState() {
  if (process.env.GITHUB_ACTIONS !== 'true') {
    console.log('(ローカル実行のため状態のコミットはスキップします)');
    return;
  }
  try {
    const status = execFileSync(
      'git',
      ['status', '--porcelain', '--', 'data/open-positions.json', 'data/state.json'],
      { encoding: 'utf8' }
    );
    if (!status.trim()) return;
    execFileSync('git', ['config', 'user.name', 'github-actions[bot]']);
    execFileSync('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
    execFileSync('git', ['add', 'data/open-positions.json', 'data/state.json']);
    execFileSync('git', ['commit', '-m', 'chore: update run state [skip ci]']);
    execFileSync('git', ['push']);
    console.log('状態をコミットしました');
  } catch (err) {
    console.error('状態のコミットに失敗しました:', err.message || err);
  }
}

async function fetchCandles(symbol) {
  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', INTERVAL);
  url.searchParams.set('outputsize', String(CANDLE_COUNT));
  url.searchParams.set('apikey', TWELVEDATA_API_KEY);
  url.searchParams.set('format', 'JSON');
  // 指定しないと銘柄の取引所現地時間で返ってくる(銘柄ごとにタイムゾーンが
  // 異なる)。JSTに統一し、Claudeへの分析データも日本時間で一貫させる。
  url.searchParams.set('timezone', 'Asia/Tokyo');

  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.status === 'error') {
    throw new Error(`価格データ取得エラー (${symbol}): ${data.message || res.status}`);
  }
  if (!Array.isArray(data.values) || data.values.length === 0) {
    throw new Error(`価格データが空です (${symbol})`);
  }
  // Twelve Data returns newest-first; reverse to chronological order.
  return data.values.slice().reverse();
}

function candlesToText(candles) {
  const header = '日時(JST) | 始値 | 高値 | 安値 | 終値';
  const rows = candles.map(
    (c) => `${c.datetime} | ${c.open} | ${c.high} | ${c.low} | ${c.close}`
  );
  return [header, ...rows].join('\n');
}

function buildEntryPrompt(label, candlesText) {
  return (
    `あなたは経験豊富なテクニカルアナリスト兼トレーダーです。\n` +
    `以下は「${label}」の直近の価格データ（${INTERVAL}足、日本時間(JST)、時系列は古い→新しい順）です。\n\n` +
    `${candlesText}\n\n` +
    `このデータをもとに、現時点でエントリーすべきチャンスがあるかどうかを判断してください。\n` +
    `トレンド、直近の高値・安値（サポート・レジスタンス）、値動きの勢いを踏まえて判断してください。\n\n` +
    `エントリーを推奨する場合は、想定される方向（買い/売り）、エントリーすべき価格帯、` +
    `目安となる利確(TP)・損切り(SL)の価格を具体的な数値で示してください。\n` +
    `見送るべき場合は、その理由を簡潔に述べてください。\n\n` +
    `## 出力フォーマット\n` +
    `日本語で、以下の形式のみで簡潔に回答してください（全体で300字程度、余計な前置きは不要）。\n` +
    `最初の行に必ず \`判定: エントリー\` または \`判定: 見送り\` と明記してください。\n` +
    `エントリーの場合は続けて「方向:」「おすすめ度:」(セットアップの良さを5段階で。` +
    `数字が大きいほど自信度が高い。必ず「3/5」のように分母の5も含めて記載してください)` +
    `「エントリー価格帯:」「TP:」「SL:」「根拠:」を、\n` +
    `見送りの場合は続けて「理由:」を記載してください。\n` +
    `最後に「本分析は教育・参考目的であり投資助言ではありません」という一文を必ず添えてください。`
  );
}

function buildMonitorPrompt(label, position, candlesText) {
  return (
    `あなたは経験豊富なテクニカルアナリスト兼トレーダーです。\n` +
    `以下のポジションを保有中です。\n\n` +
    `銘柄: ${label}\n` +
    `方向: ${position.direction}\n` +
    `エントリー価格帯: ${position.entryRange}\n` +
    `TP: ${position.tp}\n` +
    `SL: ${position.sl}\n` +
    `エントリー根拠: ${position.reason}\n\n` +
    `直近の価格データ（${INTERVAL}足、日本時間(JST)、時系列は古い→新しい順）:\n${candlesText}\n\n` +
    `現時点でこのポジションをどう扱うべきか判断してください。\n\n` +
    `## 出力フォーマット\n` +
    `日本語で、以下の形式のみで簡潔に回答してください（全体で200字程度、余計な前置きは不要）。\n` +
    `最初の行に必ず \`判定: 保有継続\` \`判定: TP到達\` \`判定: SL到達\` \`判定: 撤退推奨\` の\n` +
    `いずれか一つを明記してください。TP/SLの価格に実際に到達していなくても、\n` +
    `根拠が崩れたと判断した場合は「撤退推奨」としてください。\n` +
    `続けて「コメント:」に理由を簡潔に記載してください。\n` +
    `最後に「本分析は教育・参考目的であり投資助言ではありません」という一文を必ず添えてください。`
  );
}

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude APIエラー (${res.status}): ${body}`);
  }

  const data = await res.json();
  return (data.content || []).map((b) => b.text || '').join('\n').trim();
}

function extractField(text, label) {
  const re = new RegExp(`${label}[:：]\\s*(.+)`);
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

// "63,050～63,080" や "4375円" のような文字列から最初の数値を取り出す。
// エントリー価格帯の代表値として使う(範囲の場合は下限側)。
function parseNumber(str) {
  if (!str) return NaN;
  const m = String(str).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

function parseAnalysis(analysisText) {
  return {
    verdict: extractField(analysisText, '判定'),
    direction: extractField(analysisText, '方向'),
    confidence: extractField(analysisText, 'おすすめ度'),
    entryRange: extractField(analysisText, 'エントリー価格帯'),
    tp: extractField(analysisText, 'TP'),
    sl: extractField(analysisText, 'SL'),
    reason: extractField(analysisText, '根拠') || extractField(analysisText, '理由'),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postToSheet(row) {
  const res = await fetch(SHEETS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${await res.text()}`);
  }
}

// Apps Script の web app はまれに一時的な404/エラーを返すことがあるため、
// 1回だけ間隔を空けてリトライしてから諦める。
async function logToSheet(row) {
  if (!SHEETS_WEBHOOK_URL) return;
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await postToSheet(row);
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        console.error('スプレッドシート記録エラー:', err.message || err);
      } else {
        await sleep(2000);
      }
    }
  }
}

// Log the newest candles (chronological order) as raw price rows.
// We log the latest 2 (30 min / 15min interval = 2 new candles per main tick);
// the Apps Script side dedupes by (symbol, datetime) so occasional overlap
// or a missed run doesn't create duplicate/gappy rows.
async function logPriceData(label, candles) {
  const newest = candles.slice(-2);
  for (const c of newest) {
    await logToSheet({
      type: 'price',
      datetime: c.datetime,
      symbol: label,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    });
  }
}

async function postDiscordMessage(content) {
  // wait=true を付けて、Discord側でメッセージ作成が完了するまで待つ。
  // 付けない場合、送信リクエスト自体の受理だけで204が返るため、
  // 実際の投稿に失敗していてもこちら側では気づけない。
  const url = new URL(DISCORD_WEBHOOK_URL);
  url.searchParams.set('wait', 'true');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: ['everyone'] },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Discord通知エラー: ${res.status} ${body}`);
  }
}

function spreadsheetLine() {
  return SPREADSHEET_URL ? `📊 スプレッドシート: ${SPREADSHEET_URL}\n\n` : '';
}

// 「ポジション追跡ログ」から集計した銘柄別の勝ち/負け/撤退推奨件数を
// Apps Script(doGet)から取得する。TP到達は勝ち、SL到達は負けに数え、
// 撤退推奨はエントリー価格と決着時点の価格を比較した結果(利益/損失)で
// 勝ち・負けそれぞれに振り分ける(Apps Script側で集計済み)。
// 未設定・失敗時はnullを返し、呼び出し側は勝率表示を省略する。
async function fetchWinStats(label) {
  if (!SHEETS_WEBHOOK_URL) return null;
  try {
    const url = new URL(SHEETS_WEBHOOK_URL);
    url.searchParams.set('symbol', label);
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error('勝率取得エラー:', err.message || err);
    return null;
  }
}

function winRateLine(stats) {
  if (!stats) return '';
  const win = stats.win || 0;
  const loss = stats.loss || 0;
  const bail = stats.bail || 0;
  const decided = win + loss;
  if (decided === 0) return '';
  const pct = Math.round((win / decided) * 100);
  const bailPart = bail ? `、うち撤退推奨${bail}` : '';
  return `📈 この銘柄の勝率: ${pct}%（${win}勝${loss}敗${bailPart}）\n\n`;
}

async function notifyEntry(label, analysisText) {
  const nowJst = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const stats = await fetchWinStats(label);
  await postDiscordMessage(
    `@everyone 🔔 **${label}** でエントリーチャンスを検知しました\n\n` +
      `${analysisText}\n\n` +
      winRateLine(stats) +
      spreadsheetLine() +
      `_検知時刻: ${nowJst} (JST)_`
  );
}

async function notifyResolution(label, verdict, comment, lastClose) {
  const nowJst = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const emoji = verdict === 'TP到達' ? '✅' : verdict === 'SL到達' ? '🛑' : '⚠️';
  const stats = await fetchWinStats(label);
  await postDiscordMessage(
    `@everyone ${emoji} **${label}** ポジション追跡終了: ${verdict}\n\n` +
      `現在値: ${lastClose}\n${comment}\n\n` +
      winRateLine(stats) +
      spreadsheetLine() +
      `_検知時刻: ${nowJst} (JST)_`
  );
}

// 通常監視: ポジション未保有の銘柄を、30分おきのメインティックでのみチェックする。
// 常に価格データを記録し、取引時間内(JST 9:00-翌1:00)ならAIにエントリー判定させる。
// エントリー判定が出たら、追跡開始用のポジション情報を返す。
async function checkSymbol({ label, symbol }) {
  console.log(`--- ${label} ---`);
  const candles = await fetchCandles(symbol);

  await logPriceData(label, candles);

  if (!isTradingHours()) {
    console.log(`-> 取引時間外(1:00-9:00 JST)のため価格データのみ記録し、分析はスキップ (${label})`);
    return null;
  }

  const analysisText = await callClaude(buildEntryPrompt(label, candlesToText(candles)));
  console.log(analysisText);

  const fields = parseAnalysis(analysisText);
  const nowJst = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const lastClose = candles[candles.length - 1].close;

  await logToSheet({
    type: 'analysis',
    timestamp: nowJst,
    symbol: label,
    lastClose,
    ...fields,
  });

  const isEntry = /^エントリー/.test(fields.verdict);
  if (!isEntry) {
    console.log(`-> 見送り、通知なし (${label})`);
    return null;
  }

  await notifyEntry(label, analysisText);
  console.log(`-> Discordに通知しました (${label})`);
  return {
    direction: fields.direction,
    entryRange: fields.entryRange,
    tp: fields.tp,
    sl: fields.sl,
    reason: fields.reason,
    enteredAt: nowJst,
  };
}

// ポジション監視: 保有中の銘柄を5分おきにチェックする。
// TP到達/SL到達/撤退推奨のいずれかになったら追跡終了(true を返す)。
async function monitorPosition(label, symbol, position) {
  console.log(`--- ${label} (ポジション監視) ---`);
  const candles = await fetchCandles(symbol);
  const recentCandlesText = candlesToText(candles.slice(-MONITOR_CANDLE_COUNT));

  const monitorText = await callClaude(buildMonitorPrompt(label, position, recentCandlesText));
  console.log(monitorText);

  const verdict = extractField(monitorText, '判定');
  const comment = extractField(monitorText, 'コメント');
  const nowJst = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const lastClose = candles[candles.length - 1].close;

  // 撤退推奨はTP/SLに到達する前の判断なので、勝ち負けが自明ではない。
  // エントリー価格と現在値を比較し、含み益なら利益、含み損なら損失として記録する。
  let pnl = '';
  if (verdict === '撤退推奨') {
    const entryPrice = parseNumber(position.entryRange);
    const exitPrice = parseNumber(lastClose);
    if (!Number.isNaN(entryPrice) && !Number.isNaN(exitPrice)) {
      const diff = position.direction === '売り' ? entryPrice - exitPrice : exitPrice - entryPrice;
      pnl = diff > 0 ? '利益' : diff < 0 ? '損失' : '同値';
    }
  }

  await logToSheet({
    type: 'position_check',
    timestamp: nowJst,
    symbol: label,
    lastClose,
    verdict,
    comment,
    pnl,
  });

  const resolved = verdict !== '保有継続';
  if (resolved) {
    await notifyResolution(label, verdict, comment, lastClose);
    console.log(`-> ポジション追跡終了 (${label}): ${verdict}`);
  } else {
    console.log(`-> 保有継続 (${label})`);
  }
  return resolved;
}

// 1回ぶんのチェックを行う。ポジション保有中の銘柄は毎回monitorPosition、
// 未保有の銘柄は前回の本チェックから十分な時間が経っていればcheckSymbol。
// state/positionsは呼び出し側が保持する参照をその場で書き換える。
async function runOnce(state, positions) {
  const now = new Date();
  const mainTick = isMainTick(state, now);
  let changed = false;
  let hadError = false;

  for (const s of SYMBOLS) {
    try {
      const openPosition = positions[s.label];
      if (openPosition) {
        const resolved = await monitorPosition(s.label, s.symbol, openPosition);
        if (resolved) {
          delete positions[s.label];
          changed = true;
        }
      } else if (mainTick) {
        const newPosition = await checkSymbol(s);
        if (newPosition) {
          positions[s.label] = newPosition;
          changed = true;
        }
      } else {
        console.log(`--- ${s.label} ---\n-> ポジションなし・前回のチェックからまだ間もないためスキップ`);
      }
    } catch (err) {
      hadError = true;
      console.error(`エラー (${s.label}):`, err.message || err);
    }
  }

  if (mainTick) {
    state.lastMainTick = now.toISOString();
    changed = true;
  }

  return { changed, hadError };
}

async function main() {
  requireEnv();
  const state = await loadState();
  const positions = await loadOpenPositions();
  let hadAnyError = false;
  const loopStart = Date.now();

  for (;;) {
    const { changed, hadError } = await runOnce(state, positions);
    if (hadError) hadAnyError = true;

    if (changed) {
      await saveState(state);
      await saveOpenPositions(positions);
      commitState();
    }

    if (Object.keys(positions).length === 0) {
      break;
    }
    if (Date.now() - loopStart >= MAX_LOOP_MS) {
      console.log('監視ループの上限時間に達したため終了します(ポジションは保有中のまま次回のジョブに引き継ぎます)');
      break;
    }

    console.log(`-> ポジション保有中のため${MONITOR_INTERVAL_MS / 60000}分後に再チェックします`);
    await sleep(MONITOR_INTERVAL_MS);
  }

  if (hadAnyError) process.exitCode = 1;
}

main();
