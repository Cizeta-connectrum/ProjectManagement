// Scheduled market check, runs every 30 minutes via GitHub Actions (24 hours a day):
//   - Always fetches the latest OHLC price data and logs it to a spreadsheet
//     (free, no API cost) so price history keeps accumulating beyond the
//     40-candle window Claude sees on any single call.
//   - Only during JST 9:00-next day 1:00 (trading hours) does it also ask
//     Claude (Haiku 4.5) whether there's an entry chance, log that verdict,
//     and notify Discord when the verdict is an entry.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
// Optional: Google Apps Script Web App URL for logging every check to a spreadsheet.
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL;

const MODEL = 'claude-haiku-4-5';
const INTERVAL = '15min';
const CANDLE_COUNT = 40;

const SYMBOLS = [
  { label: 'BTC/USD', symbol: 'BTC/USD' },
  { label: 'GOLD (XAU/USD)', symbol: 'XAU/USD' },
];

// Trading hours: JST 9:00 - next day 1:00 == UTC 0:00-15:59.
// Outside this window we still log price data, but skip the Claude call
// and Discord notification (no trading happening, no need to spend on it).
function isTradingHours(date = new Date()) {
  const utcHour = date.getUTCHours();
  return utcHour >= 0 && utcHour <= 15;
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

function buildPrompt(label, candlesText) {
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

async function analyze(label, candlesText) {
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
      messages: [{ role: 'user', content: buildPrompt(label, candlesText) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude APIエラー (${label}, ${res.status}): ${body}`);
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

async function logToSheet(row) {
  if (!SHEETS_WEBHOOK_URL) return;
  try {
    const res = await fetch(SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      console.error(`スプレッドシート記録エラー: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    console.error('スプレッドシート記録エラー:', err.message || err);
  }
}

// Log the newest candles (chronological order) as raw price rows.
// We log the latest 2 (30 min / 15min interval = 2 new candles per run);
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

async function notifyDiscord(label, analysisText) {
  const nowJst = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const content =
    `@everyone 🔔 **${label}** でエントリーチャンスを検知しました\n\n` +
    `${analysisText}\n\n` +
    `_検知時刻: ${nowJst} (JST)_`;

  const res = await fetch(DISCORD_WEBHOOK_URL, {
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

async function checkSymbol({ label, symbol }) {
  console.log(`--- ${label} ---`);
  const candles = await fetchCandles(symbol);

  // Always accumulate raw price history, 24 hours a day (free, no Claude call).
  await logPriceData(label, candles);

  if (!isTradingHours()) {
    console.log(`-> 取引時間外(1:00-9:00 JST)のため価格データのみ記録し、分析はスキップ (${label})`);
    return;
  }

  const analysisText = await analyze(label, candlesToText(candles));
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
  if (isEntry) {
    await notifyDiscord(label, analysisText);
    console.log(`-> Discordに通知しました (${label})`);
  } else {
    console.log(`-> 見送り、通知なし (${label})`);
  }
}

async function main() {
  requireEnv();
  let hadError = false;
  for (const s of SYMBOLS) {
    try {
      await checkSymbol(s);
    } catch (err) {
      hadError = true;
      console.error(`エラー (${s.label}):`, err.message || err);
    }
  }
  if (hadError) process.exitCode = 1;
}

main();
