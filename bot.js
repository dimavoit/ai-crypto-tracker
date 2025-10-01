/**
 * AI Crypto Tracker Bot v2.1
 * - Primary data source: Binance
 * - Fallback: CoinGecko (optional x-cg-demo-api-key)
 * - Russian UX, simple commands: /start, /price <SYMBOL>, /signal <SYMBOL>
 */

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');

// ---- Config -----------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const PORT = Number(process.env.PORT) || 10000;

axios.defaults.timeout = 8000;
axios.defaults.headers.common['User-Agent'] = 'AI-Crypto-Tracker/2.1 (+render.com)';

const app = express();

// ---- State (in-memory; for production use a DB) ------------------------------
const users = new Map();

// ---- Mappings ----------------------------------------------------------------
const symbolMapping = {
  'BTC': 'bitcoin',
  'ETH': 'ethereum',
  'SOL': 'solana',
  'ADA': 'cardano',
  'DOT': 'polkadot',
  'MATIC': 'matic-network',
  'LINK': 'chainlink',
  'UNI': 'uniswap',
  'AVAX': 'avalanche-2',
  'ATOM': 'cosmos',
  'XRP': 'ripple',
  'DOGE': 'dogecoin',
  'LTC': 'litecoin',
  'BCH': 'bitcoin-cash'
};

// Binance trading pairs vs USDT
const binancePair = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', ADA: 'ADAUSDT',
  DOT: 'DOTUSDT', MATIC: 'MATICUSDT', LINK: 'LINKUSDT', UNI: 'UNIUSDT',
  AVAX: 'AVAXUSDT', ATOM: 'ATOMUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT',
  LTC: 'LTCUSDT', BCH: 'BCHUSDT'
};

// ---- Helpers -----------------------------------------------------------------
function round(value, decimals = 2) {
  if (value === null || value === undefined || isNaN(value)) return 0;
  const d = Math.pow(10, decimals);
  return Math.round(value * d) / d;
}

function computeMetricsFromSeries(prices, volumes, currentPrice, change24h, volume24h) {
  if (!Array.isArray(prices) || prices.length === 0) return null;

  const high7d = Math.max(...prices);
  const low7d = Math.min(...prices);

  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    const cur = prices[i];
    if (prev > 0) {
      const r = (cur - prev) / prev;
      if (Number.isFinite(r)) returns.push(r);
    }
  }
  const variance = returns.reduce((a, b) => a + b * b, 0) / Math.max(1, returns.length);
  const volatility = Math.sqrt(variance) * Math.sqrt(365) * 100;

  const avgVolume = volumes && volumes.length
    ? volumes.reduce((a, b) => a + b, 0) / volumes.length
    : 0;

  return {
    price: currentPrice,
    change24h: change24h,
    volume24h: volume24h,
    high7d, low7d,
    volatility,
    avgVolume,
    support: low7d * 1.02,     // +2% от недельного минимума
    resistance: high7d * 0.98  // -2% от недельного максимума
  };
}

// ---- Data providers ----------------------------------------------------------
async function fetchFromBinance(symbol) {
  const pair = binancePair[symbol];
  if (!pair) throw new Error('PAIR_NOT_SUPPORTED');

  // 24h ticker + last 7d hourly klines
  const [tickerRes, klinesRes] = await Promise.all([
    axios.get('https://api.binance.com/api/v3/ticker/24hr', { params: { symbol: pair } }),
    axios.get('https://api.binance.com/api/v3/klines', { params: { symbol: pair, interval: '1h', limit: 168 } })
  ]);

  const t = tickerRes.data;
  const kl = klinesRes.data;

  const prices = kl.map(k => parseFloat(k[4]));   // close
  const volumes = kl.map(k => parseFloat(k[7]));  // quote asset volume (USDT)
  const currentPrice = parseFloat(t.lastPrice);
  const change24h = parseFloat(t.priceChangePercent);
  const volume24h = parseFloat(t.quoteVolume);

  return computeMetricsFromSeries(prices, volumes, currentPrice, change24h, volume24h);
}

async function fetchFromCoinGecko(symbol) {
  const coinId = symbolMapping[symbol];
  if (!coinId) throw new Error('COIN_NOT_SUPPORTED');

  const headers = {};
  if (process.env.COINGECKO_API_KEY) {
    headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
  }

  const [priceRes, historyRes] = await Promise.all([
    axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: coinId,
        vs_currencies: 'usd',
        include_24hr_change: 'true',
        include_24hr_vol: 'true'
      },
      headers
    }),
    axios.get(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart`, {
      params: { vs_currency: 'usd', days: 7 },
      headers
    })
  ]);

  const priceData = priceRes.data[coinId] || {};
  const historyData = historyRes.data || {};

  const prices = (historyData.prices || []).map(p => p[1]);
  const volumes = (historyData.total_volumes || []).map(v => v[1]);
  const currentPrice = Number(priceData.usd);
  const change24h = Number(priceData.usd_24h_change || 0);
  const volume24h = Number(priceData.usd_24h_vol || 0);

  return computeMetricsFromSeries(prices, volumes, currentPrice, change24h, volume24h);
}

/** Unified market data fetcher with fallback */
async function getMarketData(inputSymbol) {
  const s = String(inputSymbol || '').toUpperCase();
  const pair = binancePair[s];
  console.log(`Получаю данные для ${s}${pair ? ` (${pair})` : ''}...`);

  // Try Binance first
  try {
    const res = await fetchFromBinance(s);
    if (res) return { provider: 'Binance', symbol: s, ...res };
  } catch (e) {
    const code = e?.response?.status;
    console.warn('Binance error:', code || e.message);
  }

  // Fallback to CoinGecko
  try {
    const res = await fetchFromCoinGecko(s);
    if (res) return { provider: 'CoinGecko', symbol: s, ...res };
  } catch (e) {
    const code = e?.response?.status;
    if (code === 451) {
      console.error('CoinGecko: 451 Unavailable For Legal Reasons');
    } else {
      console.error('CoinGecko error:', code || e.message);
    }
  }

  return null;
}

// ---- Messages formatting -----------------------------------------------------
function formatMarketMessage(md) {
  const arrow = md.change24h >= 0 ? '🟢' : '🔴';
  const provider = md.provider === 'Binance' ? 'Binance' : 'CoinGecko';

  return [
    `📊 *${md.symbol}* — данные: _${provider}_`,
    `Цена: *$${round(md.price, 2).toLocaleString('en-US')}* ${arrow}`,
    `Изм. 24ч: *${round(md.change24h, 2)}%*`,
    `Объём 24ч: *$${round(md.volume24h, 0).toLocaleString('en-US')}*`,
    `Недельный диапазон: *$${round(md.low7d,2)}* — *$${round(md.high7d,2)}*`,
    `Волатильность(год): *${round(md.volatility,2)}%*`,
    `📉 Поддержка: *$${round(md.support,2)}*`,
    `📈 Сопротивление: *$${round(md.resistance,2)}*`
  ].join('\n');
}

function formatSignal(md) {
  const nearSupport = md.price <= md.support * 1.02;
  const nearResistance = md.price >= md.resistance * 0.98;

  let idea = 'Нейтрально. Ждём сигнала у уровней.';
  if (nearSupport) idea = 'Вблизи *поддержки*. Возможен аккуратный лонг со стопом ниже поддержки.';
  if (nearResistance) idea = 'Вблизи *сопротивления*. Возможен шорт/фиксация прибыли.';

  const sl = md.price * (md.change24h < 0 ? 0.96 : 0.94); // грубый стоп 4–6%
  const tp = md.price * (md.change24h < 0 ? 1.06 : 1.08); // грубый тейк 6–8%

  return [
    formatMarketMessage(md),
    '',
    `🎯 Идея: ${idea}`,
    `🛑 Стоп: *$${round(sl, 2)}*`,
    `✅ Тейк: *$${round(tp, 2)}*`
  ].join('\n');
}

// ---- Telegram bot ------------------------------------------------------------
let bot = null;
if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
  console.warn('⚠️ BOT_TOKEN не задан. Задайте переменную окружения BOT_TOKEN в Render.');
} else {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.onText(/^\/start$/, (msg) => {
    const chatId = msg.chat.id;
    users.set(chatId, { id: chatId, username: msg.from?.username });
    bot.sendMessage(
      chatId,
      [
        '🤖 Привет! Я *AI Crypto Tracker*.',
        'Команды:',
        '• `/price BTC` — быстрая сводка',
        '• `/signal BTC` — уровни + черновой план',
        '',
        'Поддерживаемые тикеры: BTC, ETH, SOL, ADA, DOT, MATIC, LINK, UNI, AVAX, ATOM, XRP, DOGE, LTC, BCH.',
      ].join('\n'),
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/^\/price\s+([A-Za-z]{2,10})$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const symbol = (match[1] || '').toUpperCase();
    const md = await getMarketData(symbol);
    if (!md) {
      return bot.sendMessage(chatId, `❌ Не удалось получить данные по ${symbol}. Попробуйте позже или другой тикер.`);
    }
    bot.sendMessage(chatId, formatMarketMessage(md), { parse_mode: 'Markdown' });
  });

  bot.onText(/^\/signal\s+([A-Za-z]{2,10})$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const symbol = (match[1] || '').toUpperCase();
    const md = await getMarketData(symbol);
    if (!md) {
      return bot.sendMessage(chatId, `❌ Не удалось получить данные по ${symbol}.`);
    }
    bot.sendMessage(chatId, formatSignal(md), { parse_mode: 'Markdown' });
  });

  // Fallback: user sends just "BTC"
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (/^[A-Za-z]{2,10}$/.test(text)) {
      const symbol = text.toUpperCase();
      const md = await getMarketData(symbol);
      if (!md) return;
      bot.sendMessage(chatId, formatMarketMessage(md), { parse_mode: 'Markdown' });
    }
  });
}

// ---- HTTP server -------------------------------------------------------------
app.get('/', (_req, res) => {
  res.status(200).send('AI Crypto Tracker Bot is running.');
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'OK',
    uptime: process.uptime(),
    users: users.size,
    region_hint: process.env.RENDER_REGION || 'unknown'
  });
});

app.listen(PORT, () => {
  console.log(`🚀 AI Crypto Tracker Bot запущен!`);
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`💡 Для получения токена напишите @BotFather в Telegram`);
  console.log(`🔧 Не забудьте заменить YOUR_BOT_TOKEN_HERE на ваш токен!`);
});

console.log('🤖 AI Crypto Tracker Bot v2.1 готов к работе!');
