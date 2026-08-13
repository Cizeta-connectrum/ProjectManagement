// Scheduled market check, runs every 5 minutes via GitHub Actions (24 hours a day).
//
// Two speeds of monitoring ("濃淡"):
//   - No open position: normal cadence. On the :00/:30 tick, fetch price data,
//     log it (24h, free), and — during JST 9:00-next day 1:00 trading hours —
//     ask Claude (Haiku 4.5) for an entry verdict and notify Discord on entry.
//     Off-tick runs and outside trading hours are skipped entirely (cheap).
//   - Open position (an entry verdict happened): tight cadence. Every 5 minutes,
//     ask Claude to judge the position (hold / TP hit / SL hit / bail out) using
//     the entry context + recent price, log it, and on resolution notify Discord
//     and drop back to normal cadence.
//
// Open positions persist across runs as data/open-positions.json, committed
// back to the repo by the workflow (GitHub Actions runners are ephemeral).

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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

// Trading hours: JST 9:00 - next day 1:00 == UTC 0:00-15:59.
// Outside this window we still log price data, but skip the Claude call
// and Discord notification (no trading happening, no need to spend on it).
function isTradingHours(date = new Date()) {
  const utcHour = date.getUTCHours();
  return utcHour >= 0 && utcHour <= 15;
}

// The "normal" cadence tick, aligned with the old 30-minute schedule.
// Off-tick runs only matter for symbols with an open position (checked every 5 min).
function isMainTick(date = new Date()) {
  const minute = date.getUTCMinutes();
  return minute === 0 || minute === 30;
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

async function fetchCandles(symbol) {
  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', INTERVAL);
  url.searchParams.set('outputsize', String(CANDLE_COUNT));
  url.searchParams.set('apikey', TWELVEDATA_API_KEY);
  url.searchParams.set('format', 'JSON');

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
  const header = '日時 | 始値 | 高値 | 安値 | 終値';
  const rows = candles.map(
    (c) => `${c.datetime} | ${c.open} | ${c.high} | ${c.low} | ${c.close}`
  );
  return [header, ...rows].join('\n');
}

function buildEntryPrompt(label, candlesText) {
  return (
    `あなたは経験豊富なテクニカルアナリスト兼トレーダーです。\n` +
    `以下は「${label}」の直近の価格データ（${INTERVAL}足、時系列は古い→新しい順）です。\n\n` +
    `${candlesText}\n\n` +
    `このデータをもとに、現時点でエントリーすべきチャンスがあるかどうかを判断してください。\n` +
    `トレンド、直近の高値・安値（サポート・レジスタンス）、値動きの勢いを踏まえて判断してください。\n\n` +
    `エントリーを推奨する場合は、想定される方向（買い/売り）、エントリーすべき価格帯、` +
    `目安となる利確(TP)・損切り(SL)の価格を具体的な数値で示してください。\n` +
    `見送るべき場合は、その理由を簡潔に述べてください。\n\n` +
    `## 出力フォーマット\n` +
    `日本語で、以下の形式のみで簡潔に回答してください（全体で300字程度、余計な前置きは不要）。\n` +
    `最初の行に必ず \`判定: エントリー\` または \`判定: 見送り\` と明記してください。\n` +
    `エントリーの場合は続けて「方向:」「エントリー価格帯:」「TP:」「SL:」「根拠:」を、\n` +
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
    `直近の価格データ（${INTERVAL}足、時系列は古い→新しい順）:\n${candlesText}\n\n` +
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

function parseAnalysis(analysisText) {
  return {
    verdict: extractField(analysisText, '判定'),
    direction: extractField(analysisText, '方向'),
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

async function notifyEntry(label, analysisText) {
  const nowJst = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  await postDiscordMessage(
    `@everyone 🔔 **${label}** でエントリーチャンスを検知しました\n\n` +
      `${analysisText}\n\n` +
      spreadsheetLine() +
      `_検知時刻: ${nowJst} (JST)_`
  );
}

async function notifyResolution(label, verdict, comment, lastClose) {
  const nowJst = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const emoji = verdict === 'TP到達' ? '✅' : verdict === 'SL到達' ? '🛑' : '⚠️';
  await postDiscordMessage(
    `@everyone ${emoji} **${label}** ポジション追跡終了: ${verdict}\n\n` +
      `現在値: ${lastClose}\n${comment}\n\n` +
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

  await logToSheet({
    type: 'position_check',
    timestamp: nowJst,
    symbol: label,
    lastClose,
    verdict,
    comment,
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

async function main() {
  requireEnv();
  const mainTick = isMainTick();
  const positions = await loadOpenPositions();
  let positionsChanged = false;
  let hadError = false;

  for (const s of SYMBOLS) {
    try {
      const openPosition = positions[s.label];
      if (openPosition) {
        const resolved = await monitorPosition(s.label, s.symbol, openPosition);
        if (resolved) {
          delete positions[s.label];
          positionsChanged = true;
        }
      } else if (mainTick) {
        const newPosition = await checkSymbol(s);
        if (newPosition) {
          positions[s.label] = newPosition;
          positionsChanged = true;
        }
      } else {
        console.log(`--- ${s.label} ---\n-> ポジションなし・定時チェック外のため今回はスキップ`);
      }
    } catch (err) {
      hadError = true;
      console.error(`エラー (${s.label}):`, err.message || err);
    }
  }

  if (positionsChanged) {
    await saveOpenPositions(positions);
  }

  if (hadError) process.exitCode = 1;
}

main();
