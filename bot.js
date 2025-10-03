// =============================
// AI Crypto Tracker Bot v4.3 — Enhanced (signals)
// =============================

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');

// -----------------------------
// CONFIG & ENV
// -----------------------------
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const CRON_KEY = process.env.CRON_KEY || 'my-secret';

// сигналка (ENV с дефолтами)
const SIGNAL_COOLDOWN_MIN = parseInt(process.env.SIGNAL_COOLDOWN_MIN || '15', 10);
const IMPULSE_PCT = parseFloat(process.env.IMPULSE_PCT || '1.5');                 // импульс за окно
const IMPULSE_WINDOW_MIN = parseInt(process.env.IMPULSE_WINDOW_MIN || '30', 10);  // окно для импульса
const VOLUME_MULT = parseFloat(process.env.VOLUME_MULT || '1.5');                 // последний 1h объём > mult * avg
const VOLUME_Z = parseFloat(process.env.VOLUME_Z || '2.0');                       // или z-score > порога
const ATR_PERIOD = parseInt(process.env.ATR_PERIOD || '14', 10);
const ATR_MULT = parseFloat(process.env.ATR_MULT || '1.5');

// Режимы
const DISABLE_INTERVALS = String(process.env.DISABLE_INTERVALS || 'false').toLowerCase() === 'true';

// -----------------------------
// BOT
// -----------------------------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// storage (in-memory)
const users = new Map();
const positions = new Map();
const awaitingInput = new Map();
const lastSignals = new Map(); // key: positionId -> { hash, at }

// simple admin pass
const ADMIN_PASSWORD = 'crypto123';

// -----------------------------
// SYMBOL MAPS
// -----------------------------
const symbolMapping = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', ADA: 'cardano',
  DOT: 'polkadot', MATIC: 'matic-network', LINK: 'chainlink', UNI: 'uniswap',
  AVAX: 'avalanche-2', ATOM: 'cosmos', XRP: 'ripple', DOGE: 'dogecoin',
  LTC: 'litecoin', BCH: 'bitcoin-cash', ONDO: 'ondoprotocol'
};
const binancePair = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', ADA: 'ADAUSDT',
  DOT: 'DOTUSDT', MATIC: 'MATICUSDT', LINK: 'LINKUSDT', UNI: 'UNIUSDT',
  AVAX: 'AVAXUSDT', ATOM: 'ATOMUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT',
  LTC: 'LTCUSDT', BCH: 'BCHUSDT', ONDO: 'ONDOUSDT'
};

// -----------------------------
// AXIOS CLIENTS
// -----------------------------
const cg = axios.create({
  baseURL: 'https://api.coingecko.com/api/v3',
  timeout: 10000,
  headers: process.env.COINGECKO_API_KEY
    ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY, 'User-Agent': 'ai-crypto-tracker/1.0' }
    : { 'User-Agent': 'ai-crypto-tracker/1.0' }
});

async function cgSimplePrice(coinId) {
  return cg.get('/simple/price', {
    params: {
      ids: coinId,
      vs_currencies: 'usd',
      include_24hr_change: true,
      include_24hr_vol: true
    }
  });
}
async function cgMarketChart(coinId) {
  return cg.get(`/coins/${coinId}/market_chart`, {
    params: { vs_currency: 'usd', days: 7 }
  });
}

// CoinCap fallback
async function coinCapFallback(sym) {
  const map = {
    BTC:'bitcoin', ETH:'ethereum', SOL:'solana', ADA:'cardano', DOT:'polkadot',
    MATIC:'polygon', LINK:'chainlink', UNI:'uniswap', AVAX:'avalanche',
    ATOM:'cosmos', XRP:'xrp', DOGE:'dogecoin', LTC:'litecoin', BCH:'bitcoin-cash',
    ONDO:'ondo'
  };
  const id = map[sym.toUpperCase()];
  if (!id) return null;
  const now = Date.now(), start = now - 7*24*60*60*1000;
  const p = await axios.get(`https://api.coincap.io/v2/assets/${id}`);
  const price = parseFloat(p.data?.data?.priceUsd);
  if (!isFinite(price)) return null;

  const h = await axios.get(`https://api.coincap.io/v2/assets/${id}/history`, {
    params: { interval: 'h1', start, end: now }
  });
  const prices = (h.data?.data || []).map(x => +x.priceUsd);
  if (!prices.length) return null;

  const rets = [];
  for (let i = 1; i < prices.length; i++) rets.push((prices[i]-prices[i-1])/prices[i-1]);
  const high7d = Math.max(...prices);
  const low7d = Math.min(...prices);
  const volatility = Math.sqrt(rets.reduce((s,r)=>s+r*r,0)/rets.length) * Math.sqrt(365) * 100;

  return {
    price, change24h: 0, volume24h: 0,
    high7d, low7d, volatility, avgVolume: 0,
    support: low7d*1.02, resistance: high7d*0.98
  };
}

// -----------------------------
// INDICATORS (EMA / ATR / helpers)
// -----------------------------
function ema(arr, period) {
  if (!arr || arr.length === 0) return [];
  const k = 2 / (period + 1);
  let prev = arr[0], out = [prev];
  for (let i = 1; i < arr.length; i++) {
    prev = arr[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
function atrFromOhlc(ohlc, period = 14) {
  // ohlc: [{o,h,l,c}, ...] hourly
  if (!ohlc || ohlc.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < ohlc.length; i++) {
    const h = ohlc[i].h, l = ohlc[i].l, pc = ohlc[i-1].c;
    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    trs.push(tr);
  }
  const atrs = ema(trs, period);
  return atrs.at(-1);
}
function mean(arr){return arr.reduce((a,b)=>a+b,0)/arr.length;}
function std(arr){const m=mean(arr);return Math.sqrt(mean(arr.map(x=>(x-m)**2)));}

// -----------------------------
// MARKET DATA (CoinGecko + fallback)
// -----------------------------
async function getMarketData(symbol) {
  try {
    const coinId = symbolMapping[symbol.toUpperCase()];
    if (!coinId) return null;

    const [priceResponse, historyResponse] = await Promise.all([
      cgSimplePrice(coinId),
      cgMarketChart(coinId)
    ]);

    const priceData = priceResponse.data[coinId];
    const historyData = historyResponse.data;
    if (!priceData || !historyData) return null;

    const prices = historyData.prices.map(p => p[1]);
    const volumes = historyData.total_volumes.map(v => v[1]);

    const currentPrice = priceData.usd;
    const change24h = priceData.usd_24h_change || 0;
    const volume24h = priceData.usd_24h_vol || 0;

    const high7d = Math.max(...prices);
    const low7d = Math.min(...prices);
    const avgVolume = volumes.length ? mean(volumes) : 0;

    // волатильность
    const returns = [];
    for (let i = 1; i < prices.length; i++) returns.push((prices[i]-prices[i-1])/prices[i-1]);
    const volatility = Math.sqrt(returns.reduce((a,b)=>a+b*b,0)/returns.length) * Math.sqrt(365) * 100;

    return {
      price: currentPrice,
      change24h, volume24h,
      high7d, low7d, volatility, avgVolume,
      support: low7d * 1.02,
      resistance: high7d * 0.98
    };
  } catch (error) {
    console.error('CoinGecko error:', error.response?.status, error.message);
    try {
      const fb = await coinCapFallback(symbol);
      if (fb) return fb;
    } catch (e) {
      console.error('CoinCap fallback error:', e.message);
    }
    return null;
  }
}

// -----------------------------
// BINANCE klines (1h/15m) для сигналов и контекста
// -----------------------------
async function getKlines(symbol, interval = '1h', limit = 200) {
  const pair = binancePair[symbol.toUpperCase()];
  if (!pair) return null;
  try {
    const { data } = await axios.get('https://api.binance.com/api/v3/klines', {
      params: { symbol: pair, interval, limit }
    });
    // map to arrays/objects
    const ohlc = data.map(k => ({
      t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5]
    }));
    return ohlc;
  } catch (e) {
    // гео-блок 451 возможен; просто вернем null
    return null;
  }
}
async function getBtcContext() {
  const kl = await getKlines('BTC', '1h', 72);
  if (!kl) {
    // fallback по CG 24h, чтобы не ломать вывод
    const md = await getMarketData('BTC');
    if (!md) return null;
    return { trendLabel: md.change24h >= 0 ? 'бычий' : 'медвежий', ret1h: 0, ret24h: md.change24h, price: md.price };
  }
  const closes = kl.map(k => k.c);
  const ema20 = ema(closes, 20).at(-1);
  const ema50 = ema(closes, 50).at(-1);
  const trendLabel = ema20 > ema50 ? 'бычий' : (ema20 < ema50 ? 'медвежий' : 'флэт');
  const last = closes.at(-1), c1h = closes.at(-2), c24h = closes.at(-25) ?? closes[0];
  const ret1h = ((last - c1h) / c1h) * 100;
  const ret24h = ((last - c24h) / c24h) * 100;
  return { trendLabel, ret1h, ret24h, price: last };
}

// -----------------------------
// LEVELS (улучшено)
// -----------------------------
function calculateOptimalLevels(entryPrice, direction, md, riskPercent = 4) {
  if (!md) return null;
  const { volatility, support, resistance } = md;
  const volBuf = entryPrice * (volatility / 100) * 0.4;
  let sl, tp;

  if (direction === 'long') {
    const stopBySupport = support - volBuf;
    const stopByRisk = entryPrice * (1 - riskPercent / 100);
    sl = Math.min(stopBySupport, stopByRisk);
    const riskAmt = entryPrice - sl;
    tp = Math.max(resistance, entryPrice + riskAmt * 2);
  } else {
    const stopByRes = resistance + volBuf;
    const stopByRisk = entryPrice * (1 + riskPercent / 100);
    sl = Math.max(stopByRes, stopByRisk);
    const riskAmt = sl - entryPrice;
    tp = Math.min(support, entryPrice - riskAmt * 2);
  }
  return {
    stopLoss: Math.round(sl * 100) / 100,
    takeProfit: Math.round(tp * 100) / 100,
    riskPercent: Math.abs((sl - entryPrice) / entryPrice * 100)
  };
}

// -----------------------------
// SIGNAL ENGINE (на 1h/15m)
// -----------------------------
function percentChange(a, b) { return ((a - b) / b) * 100; }

// дедуп: проверка и запись
function checkAndStoreSignal(positionId, hash) {
  const now = Date.now();
  const rec = lastSignals.get(positionId);
  if (rec) {
    const minutesPassed = (now - rec.at) / 60000;
    if (rec.hash === hash && minutesPassed < SIGNAL_COOLDOWN_MIN) {
      return false; // дубликат в кулдауне
    }
  }
  lastSignals.set(positionId, { hash, at: now });
  return true;
}

// основной расчёт сигналов по свечам
async function generateRealtimeSignals(symbol, md, position) {
  // 1h и 15m свечи
  const h1 = await getKlines(symbol, '1h', 100);
  const m15 = await getKlines(symbol, '15m', Math.ceil(IMPULSE_WINDOW_MIN/15) + 5);
  if (!h1 && !m15) return [];

  const out = [];
  // импульс (15–30м): сравниваем close текущей и close окна назад
  if (m15 && m15.length > 2) {
    const closes = m15.map(x => x.c);
    const last = closes.at(-1);
    const backIdx = Math.max(0, closes.length - Math.ceil(IMPULSE_WINDOW_MIN/15) - 1);
    const ref = closes[backIdx];
    const d = percentChange(last, ref);
    if (Math.abs(d) >= IMPULSE_PCT) {
      out.push({ type: 'impulse', message: `⚡ Импульс за ${IMPULSE_WINDOW_MIN}м: ${d>0?'+':''}${d.toFixed(2)}%` });
    }
  }

  if (h1 && h1.length > 60) {
    const closes = h1.map(x => x.c);
    const highs = h1.map(x => x.h);
    const lows = h1.map(x => x.l);
    const vols = h1.map(x => x.v);
    const last = h1.at(-1);

    // EMA20/EMA50 по альту
    const e20 = ema(closes, 20).at(-1);
    const e50 = ema(closes, 50).at(-1);
    if (e20 && e50) {
      if (e20 > e50 && closes.at(-1) > e20) out.push({ type: 'ema', message: '🟢 EMA20 выше EMA50 (бычий контекст)' });
      if (e20 < e50 && closes.at(-1) < e20) out.push({ type: 'ema', message: '🔴 EMA20 ниже EMA50 (медвежий контекст)' });
    }

    // ATR волатильный бар
    const ohlc = h1.map(x => ({ o: x.o, h: x.h, l: x.l, c: x.c }));
    const atr = atrFromOhlc(ohlc, ATR_PERIOD);
    if (atr) {
      const trueRangeLast = Math.max(last.h - last.l, Math.abs(last.h - h1.at(-2).c), Math.abs(last.l - h1.at(-2).c));
      if (trueRangeLast > ATR_MULT * atr) {
        out.push({ type: 'atr', message: `📏 Волатильный час: TR>${ATR_MULT}×ATR, подумайте о подтяжке SL` });
      }
    }

    // Пробой S/R (используем weekly из md)
    if (md) {
      if (closes.at(-1) > md.resistance) out.push({ type: 'breakout', message: '🚀 Пробой сопротивления' });
      if (closes.at(-1) < md.support) out.push({ type: 'breakdown', message: '⚠️ Пробой поддержки' });
    }

    // Объёмы: последний 1h vs средний 1h (24–72ч) + z-score
    const lastVol = vols.at(-1);
    const lookback = vols.slice(-72, -1); // 72 часа ~ 3 дня
    if (lookback.length >= 12) {
      const avg = mean(lookback);
      const s = std(lookback);
      const z = s > 0 ? (lastVol - avg) / s : 0;
      if (lastVol > VOLUME_MULT * avg || z >= VOLUME_Z) {
        out.push({ type: 'volume', message: '📈 Повышенные объёмы (1h)' });
      }
    }
  }

  // Дедупка для позиции
  if (!out.length) return out;
  const hash = out.map(s => s.type).sort().join('|');
  if (!checkAndStoreSignal(position.id, hash)) return []; // подавили повтор
  return out;
}

// базовые (старые) сигналы на основе CG (оставляем как резерв)
function generateSimpleSignals(position, md) {
  const signals = [];
  const { price, change24h, volume24h, avgVolume } = md;

  const stopDistance = Math.abs(price - position.stopLoss) / position.stopLoss * 100;
  const takeProfitDistance = Math.abs(price - position.takeProfit) / position.takeProfit * 100;
  if (stopDistance < 2) signals.push({ type: 'warning', message: '🔴 ВНИМАНИЕ! Приближение к стоп-лоссу' });
  if (takeProfitDistance < 3) signals.push({ type: 'profit', message: '🎯 Близко к тейк-профиту! Рассмотрите частичную фиксацию' });

  if (avgVolume && volume24h > avgVolume * 1.5) {
    signals.push({ type: 'volume_day', message: '📈 Повышенные объёмы (24h)' });
  }
  if (Math.abs(change24h) > 8) {
    signals.push({ type: 'volatility', message: `⚡ Высокая волатильность: ${change24h>0?'+':''}${change24h.toFixed(1)}%` });
  }
  return signals;
}

// дивергенция alt vs BTC
async function divergenceNote(symbol) {
  const btc = await getBtcContext();
  const altH1 = await getKlines(symbol, '1h', 3);
  if (!btc || !altH1) return { btc, note: null };
  const alt1h = percentChange(altH1.at(-1).c, altH1.at(-2).c);
  let note = null;
  if (alt1h >= 1 && btc.ret1h <= -1) note = '⚠️ Дивергенция: альт растёт при падении BTC';
  if (alt1h <= -1 && btc.ret1h >= 1) note = '⚠️ Дивергенция: альт падает при росте BTC';
  return { btc, note };
}

// -----------------------------
// POSITION SIZE (как было)
// -----------------------------
function calculatePositionSize(deposit, entryPrice, stopLoss, riskPercent = 4) {
  const riskAmount = deposit * (riskPercent / 100);
  const priceRisk = Math.abs(entryPrice - stopLoss);
  const positionValue = riskAmount / (priceRisk / entryPrice);
  const quantity = positionValue / entryPrice;
  return {
    quantity: Math.round(quantity * 100000) / 100000,
    positionValue: Math.round(positionValue * 100) / 100,
    riskAmount: Math.round(riskAmount * 100) / 100
  };
}

// -----------------------------
// INPUT PARSER (добавлен ONDO)
// -----------------------------
function parsePositionInput(text) {
  const normalizedText = text.toLowerCase().replace(/[,.$]/g, ' ');
  const symbolMatch = normalizedText.match(/\b(btc|eth|sol|ada|dot|matic|link|uni|avax|atom|xrp|doge|ltc|bch|ondo)\b/);
  const directionMatch = normalizedText.match(/\b(long|short|лонг|шорт)\b/);
  const priceMatch = normalizedText.match(/\b(\d+(?:\.\d+)?)\b/);
  const depositMatch = normalizedText.match(/(?:депозит|deposit|деп)\s*(\d+(?:\.\d+)?)/);
  const sizeMatch = normalizedText.match(/(?:размер|size|количество)\s*(\d+(?:\.\d+)?)/);
  return {
    symbol: symbolMatch ? symbolMatch[1].toUpperCase() : null,
    direction: directionMatch ? (/(long|лонг)/.test(directionMatch[1]) ? 'long' : 'short') : null,
    entryPrice: priceMatch ? parseFloat(priceMatch[1]) : null,
    deposit: depositMatch ? parseFloat(depositMatch[1]) : null,
    size: sizeMatch ? parseFloat(sizeMatch[1]) : null
  };
}

// -----------------------------
// START
// -----------------------------
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (!users.has(userId)) {
    users.set(userId, { id: userId, username: msg.from.username, isPremium: false, registeredAt: new Date(), positionCount: 0 });
  }

  const welcomeMessage = `
🤖 <b>AI Crypto Tracker Bot (обновленная версия)</b>

🚀 Привет! Я AI Crypto Tracker.  
Я помогаю отслеживать ваши криптопозиции и даю персональные торговые сигналы на основе реальных рыночных данных.  

<b>Что я умею:</b>  
📊 TP/SL с учётом волатильности  
⚡ Онлайн-сигналы (импульс, пробой, EMA, ATR)  
📈 P&L по портфелю  
🔔 Уведомления

<b>Поддерживаю:</b> BTC, ETH, SOL, ADA, DOT, MATIC, LINK, UNI, AVAX, ATOM, XRP, DOGE, LTC, BCH, ONDO

━━━━━━━━━━━━━━━━━━━━
🎯 <b>Добавим вашу первую позицию?</b>

Примеры:
<code>BTC long 114000</code>
<code>ETH short 3200, deposit 1000</code>

<b>Я сам посчитаю уровни и буду присылать сигналы.</b>`;
  bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML' });
});

// -----------------------------
// MESSAGE (add position flow)
// -----------------------------
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const chatId = msg.chat.id, userId = msg.from.id;
  if (!users.has(userId)) return bot.sendMessage(chatId, 'Пожалуйста, начните с /start');

  const user = users.get(userId);
  if (!user.isPremium && user.positionCount >= 3) {
    return bot.sendMessage(chatId, `❌ <b>Лимит бесплатных позиций исчерпан!</b>\n\nБесплатно: до 3 позиций\nPremium: безлимит\n\n/subscribe`, { parse_mode: 'HTML' });
  }

  const parsed = parsePositionInput(msg.text);
  if (!parsed.symbol || !parsed.direction || !parsed.entryPrice) {
    return bot.sendMessage(chatId, `❌ <b>Не могу понять формат</b>\n\nПримеры:\n<code>BTC long 114000</code>\n<code>ETH short 3200, deposit 1000</code>`, { parse_mode: 'HTML' });
  }

  const analysisMsg = await bot.sendMessage(chatId, '🤖 <b>AI Crypto Tracker анализирует...</b>\n\n⏳ Получаю рыночные данные...', { parse_mode: 'HTML' });
  const md = await getMarketData(parsed.symbol);
  if (!md) {
    await bot.editMessageText(`❌ Не удалось получить данные по ${parsed.symbol}.\nПроверьте символ или попробуйте позже.`, {
      chat_id: chatId, message_id: analysisMsg.message_id
    }); return;
  }

  await bot.editMessageText('🤖 <b>AI Crypto Tracker анализирует...</b>\n\n📊 Считаю уровни и индикаторы...', {
    chat_id: chatId, message_id: analysisMsg.message_id, parse_mode: 'HTML'
  });

  const levels = calculateOptimalLevels(parsed.entryPrice, parsed.direction, md);
  if (!levels) {
    await bot.editMessageText('❌ Ошибка при расчёте уровней', { chat_id: chatId, message_id: analysisMsg.message_id });
    return;
  }

  let size = null;
  if (parsed.deposit) size = calculatePositionSize(parsed.deposit, parsed.entryPrice, levels.stopLoss);

  // BTC контекст + дивергенция
  const { btc, note } = await divergenceNote(parsed.symbol);

  const volStr = md.volatility > 50 ? 'высокая' : md.volatility > 30 ? 'средняя' : 'низкая';
  const delta = ((md.price - parsed.entryPrice) / parsed.entryPrice * 100);
  const cur = md.price.toFixed(4), sup = md.support.toFixed(4), res = md.resistance.toFixed(4);
  let text = `
📊 <b>${parsed.symbol}USDT — ${parsed.direction.toUpperCase()}</b>
💰 Вход: $${parsed.entryPrice}
${parsed.deposit ? `💵 Депозит: $${parsed.deposit}` : ''}

📈 <b>Рынок:</b>
• Текущая: $${cur} (${delta>=0?'+':''}${delta.toFixed(2)}%)
• 24ч: ${md.change24h>=0?'+':''}${md.change24h.toFixed(2)}%
• Волатильность: ${volStr} (${md.volatility.toFixed(1)}%)
• Поддержка: $${sup} | Сопротивление: $${res}

🎯 <b>Рекомендации:</b>
🛑 SL: $${levels.stopLoss} (риск ~${levels.riskPercent.toFixed(1)}%)
🎯 TP: $${levels.takeProfit} (R/R ≥ 2:1)`;

  if (size) {
    text += `\n📦 Размер: ${size.quantity} ${parsed.symbol} (~$${size.positionValue})\n<i>Риск: $${size.riskAmount}</i>`;
  }

  if (btc) {
    text += `\n\n📌 <b>Контекст BTC:</b>\n• Тренд: ${btc.trendLabel}\n• 1ч: ${btc.ret1h.toFixed(2)}% | 24ч: ${btc.ret24h.toFixed(2)}%\n${note ? `• ${note}` : '• Дивергенций не замечено'}`;
  }

  text += `\n\n<b>✅ Добавить позицию?</b>`;

  await bot.deleteMessage(chatId, analysisMsg.message_id);
  bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Да, добавить', callback_data: `add_position_${userId}_${Date.now()}` },
         { text: '⚙️ Изменить', callback_data: `modify_position_${userId}_${Date.now()}` }],
        [{ text: '📊 Подробнее', callback_data: `details_position_${userId}_${Date.now()}` }]
      ]
    }
  });

  awaitingInput.set(userId, {
    symbol: parsed.symbol, direction: parsed.direction, entryPrice: parsed.entryPrice,
    deposit: parsed.deposit, size: parsed.size, marketData: md, optimalLevels: levels, positionSize: size
  });
});

// -----------------------------
// CALLBACKS (кнопки)
// -----------------------------
bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id, userId = q.from.id, data = q.data;
  if (data.startsWith('add_position_')) {
    const tmp = awaitingInput.get(userId);
    if (!tmp) return bot.answerCallbackQuery(q.id, { text: 'Данные устарели, создайте заново' });

    const positionId = `${userId}_${Date.now()}`;
    const position = {
      id: positionId, userId, symbol: tmp.symbol, direction: tmp.direction,
      entryPrice: tmp.entryPrice, stopLoss: tmp.optimalLevels.stopLoss, takeProfit: tmp.optimalLevels.takeProfit,
      quantity: tmp.positionSize ? tmp.positionSize.quantity : 1, deposit: tmp.deposit || 0,
      createdAt: new Date(), isActive: true
    };
    positions.set(positionId, position);
    const user = users.get(userId); user.positionCount++;
    awaitingInput.delete(userId);

    const md = await getMarketData(tmp.symbol);
    const price = md ? md.price : tmp.entryPrice;
    let pnl = tmp.direction === 'long' ? (price - tmp.entryPrice)*position.quantity : (tmp.entryPrice - price)*position.quantity;
    const pnlPct = (pnl / (position.quantity*tmp.entryPrice))*100;

    const sigs = md ? await generateRealtimeSignals(tmp.symbol, md, position) : [];
    const lines = sigs.length ? sigs.map(s => '• ' + s.message).join('\n') : '• 🟡 Консолидация / без сигнала';

    const { btc, note } = await divergenceNote(tmp.symbol);
    let btcBlock = '';
    if (btc) btcBlock = `\n📌 <b>Контекст BTC:</b>\n• Тренд: ${btc.trendLabel}\n• 1ч: ${btc.ret1h.toFixed(2)}% | 24ч: ${btc.ret24h.toFixed(2)}%\n${note?`• ${note}`:''}`;

    const text = `
✅ <b>Позиция добавлена</b>

📊 <b>${tmp.symbol} ${tmp.direction.toUpperCase()} #${user.positionCount}</b>
Вход: $${tmp.entryPrice} | Размер: ${position.quantity} ${tmp.symbol}
SL: $${position.stopLoss} | TP: $${position.takeProfit}

📈 Сейчас: $${price} | P&L: ${pnl>=0?'+':''}${pnl.toFixed(2)} (${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}%)

🎯 <b>Текущие сигналы:</b>
${lines}${btcBlock}

Используйте команды:
• /positions • /signals • /balance`;
    bot.editMessageText(text, { chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML' });
    return bot.answerCallbackQuery(q.id, { text: 'Добавлено!' });
  }

  if (data.startsWith('details_position_')) {
    const tmp = awaitingInput.get(userId);
    if (!tmp) return bot.answerCallbackQuery(q.id, { text: 'Данные устарели' });
    const t = `
📊 <b>Подробный анализ для ${tmp.symbol}</b>

<b>Почему такие уровни:</b>
• SL ниже поддержки ($${tmp.marketData.support.toFixed(2)}) с учётом волатильности
• TP у сопротивления ($${tmp.marketData.resistance.toFixed(2)}) и R/R≥2:1
• Волатильность: ${tmp.marketData.volatility.toFixed(1)}%

<b>Контекст недели:</b>
• Диапазон: $${tmp.marketData.low7d.toFixed(2)} — $${tmp.marketData.high7d.toFixed(2)}
• Средний объём (неделя): ${(tmp.marketData.avgVolume/1e6).toFixed(1)}M`;
    bot.sendMessage(chatId, t, { parse_mode: 'HTML' });
    return bot.answerCallbackQuery(q.id, { text: 'Отправил детали' });
  }

  if (data.startsWith('modify_position_')) {
    return bot.answerCallbackQuery(q.id, { text: 'Редактор в разработке' });
  }
});

// -----------------------------
// /positions — расширенный статус
// -----------------------------
bot.onText(/\/positions/, async (msg) => {
  const chatId = msg.chat.id, userId = msg.from.id;
  const my = Array.from(positions.values()).filter(p => p.userId === userId && p.isActive);
  if (!my.length) {
    return bot.sendMessage(chatId, `📭 <b>Нет активных позиций.</b>\n\nДобавьте:\n<code>BTC long 114000</code>\n<code>ETH short 3200, deposit 1000</code>`, { parse_mode: 'HTML' });
  }

  let text = '📊 <b>Ваши активные позиции:</b>\n\n';
  const btc = await getBtcContext();

  for (const p of my) {
    const md = await getMarketData(p.symbol);
    let pnl = 0, pnlPct = 0, cur = 'N/A';
    let emaBlock='', distBlock='', atrBlock='', ch1hBlock='';
    if (md) {
      cur = md.price;
      pnl = p.direction==='long' ? (md.price - p.entryPrice)*p.quantity : (p.entryPrice - md.price)*p.quantity;
      pnlPct = (pnl / (p.quantity*p.entryPrice))*100;

      // 1h индикаторы
      const h1 = await getKlines(p.symbol, '1h', 80);
      if (h1 && h1.length>60) {
        const closes = h1.map(x=>x.c);
        const e20 = ema(closes,20).at(-1), e50 = ema(closes,50).at(-1);
        if (e20 && e50) {
          const side = e20>e50?'бычий':'медвежий';
          emaBlock = `EMA: ${side}`;
        }
        const ohlc = h1.map(x=>({o:x.o,h:x.h,l:x.l,c:x.c}));
        const atr = atrFromOhlc(ohlc, ATR_PERIOD);
        if (atr) atrBlock = `ATR: ${atr.toFixed(4)}`;

        const last = closes.at(-1), prev = closes.at(-2);
        const ch1h = percentChange(last, prev);
        ch1hBlock = `1ч: ${ch1h>=0?'+':''}${ch1h.toFixed(2)}%`;
      }

      const distSL = ((md.price - p.stopLoss)/p.stopLoss*100);
      const distTP = ((p.takeProfit - md.price)/p.takeProfit*100);
      distBlock = `до SL: ${distSL<0?distSL.toFixed(2):'+'+distSL.toFixed(2)}% | до TP: ${distTP<0?distTP.toFixed(2):'+'+distTP.toFixed(2)}%`;
    }

    const emoji = pnl>=0?'🟢':'🔴';
    text += `${emoji} <b>${p.symbol} ${p.direction.toUpperCase()}</b>\n`;
    text += `Вход: $${p.entryPrice} | Текущая: $${cur}\n`;
    text += `P&L: ${pnl>=0?'+':''}${pnl.toFixed(2)} (${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}%)\n`;
    text += `SL: ${p.stopLoss} | TP: ${p.takeProfit}\n`;
    if (distBlock) text += `${distBlock}\n`;
    if (emaBlock||atrBlock||ch1hBlock) text += `${[emaBlock,atrBlock,ch1hBlock].filter(Boolean).join(' • ')}\n`;
    text += `\n`;
  }

  if (btc) text += `📌 <b>Контекст BTC:</b> тренд ${btc.trendLabel}, 1ч ${btc.ret1h.toFixed(2)}%, 24ч ${btc.ret24h.toFixed(2)}%\n`;
  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

// -----------------------------
// /signals — «живые» сигналы (на 1h/15m)
// -----------------------------
bot.onText(/\/signals/, async (msg) => {
  const chatId = msg.chat.id, userId = msg.from.id;
  const my = Array.from(positions.values()).filter(p => p.userId === userId && p.isActive);
  if (!my.length) {
    return bot.sendMessage(chatId, `📭 <b>Нет активных позиций.</b>`, { parse_mode: 'HTML' });
  }

  let text = '🎯 <b>Торговые сигналы (онлайн):</b>\n\n';
  let any = false;

  for (const p of my) {
    const md = await getMarketData(p.symbol);
    if (!md) continue;
    const rts = await generateRealtimeSignals(p.symbol, md, p);
    if (rts.length) {
      any = true;
      text += `📊 <b>${p.symbol}</b> ($${md.price}):\n${rts.map(s=>'• '+s.message).join('\n')}\n\n`;
    }
  }

  if (!any) text += '✅ Сейчас особых сигналов нет.\n';
  const btc = await getBtcContext();
  if (btc) text += `\n📌 <b>Контекст BTC:</b> тренд ${btc.trendLabel}, 1ч ${btc.ret1h.toFixed(2)}%, 24ч ${btc.ret24h.toFixed(2)}%`;
  bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
});

// -----------------------------
// /balance — без изменений (кроме вставки BTC-блока)
// -----------------------------
bot.onText(/\/balance/, async (msg) => {
  const chatId = msg.chat.id, userId = msg.from.id;
  const my = Array.from(positions.values()).filter(p => p.userId === userId && p.isActive);
  if (!my.length) return bot.sendMessage(chatId, '📭 <b>У вас нет активных позиций.</b>', { parse_mode: 'HTML' });

  let totalPnL = 0, totalInvested = 0, profitable = 0;
  const analysisMsg = await bot.sendMessage(chatId, '📊 <b>Анализирую портфель...</b>', { parse_mode: 'HTML' });

  for (const p of my) {
    const md = await getMarketData(p.symbol);
    if (!md) continue;
    const invested = p.entryPrice * p.quantity; totalInvested += invested;
    let pnl = p.direction==='long' ? (md.price - p.entryPrice)*p.quantity : (p.entryPrice - md.price)*p.quantity;
    totalPnL += pnl; if (pnl>0) profitable++;
  }

  const pct = totalInvested>0 ? (totalPnL/totalInvested*100) : 0;
  const emoji = totalPnL>=0?'🟢':'🔴', trendEmoji = totalPnL>=0?'📈':'📉';
  let status = pct>5?'🔥 Отличная работа!': pct>0?'✅ Портфель в плюсе': pct>-5?'⚠️ Небольшие потери':'🔴 Требует внимания';

  let text = `
${emoji} <b>Общий баланс портфеля:</b>

💰 P&L: ${totalPnL>=0?'+':''}${totalPnL.toFixed(2)} ${trendEmoji}
📊 Процент: ${pct>=0?'+':''}${pct.toFixed(2)}%
📈 Активных позиций: ${my.length}
🎯 Прибыльных: ${profitable}/${my.length} (${(my.length?profitable/my.length*100:0).toFixed(0)}%)

${status}

<b>Рекомендации:</b>
${pct>10?'• Зафиксируйте часть прибыли\n':''}${pct<-10?'• Проверьте SL по убыточным\n':''}`;

  const btc = await getBtcContext();
  if (btc) text += `\n📌 <b>Контекст BTC:</b> тренд ${btc.trendLabel}, 1ч ${btc.ret1h.toFixed(2)}%, 24ч ${btc.ret24h.toFixed(2)}%`;
  bot.editMessageText(text, { chat_id: chatId, message_id: analysisMsg.message_id, parse_mode: 'HTML' });
});

// -----------------------------
// /help /subscribe /close /admin (как было)
// -----------------------------
bot.onText(/\/subscribe/, (m)=> bot.sendMessage(m.chat.id, `💎 <b>AI Crypto Tracker Premium</b>\n\n• Безлимит позиций\n• Продвинутые сигналы\n• Приоритетная поддержка\n\nСвязь: @your_username`, { parse_mode:'HTML' }));

bot.onText(/\/help/, (m)=> bot.sendMessage(m.chat.id, `
📋 <b>Помощь</b>

Добавление:
<code>BTC long 114000</code>
<code>ETH short 3200, deposit 1000</code>

Команды:
/positions — статус
/signals — онлайн-сигналы
/balance — P&L
/subscribe — Premium
`, { parse_mode:'HTML' }));

bot.onText(/\/close (.+)/, (msg, match)=>{
  const chatId = msg.chat.id, userId = msg.from.id, n = parseInt(match[1]);
  const my = Array.from(positions.values()).filter(p => p.userId===userId && p.isActive);
  if (n<1 || n>my.length) return bot.sendMessage(chatId, `❌ Позиция #${n} не найдена.\nИспользуйте /positions`);
  my[n-1].isActive=false; const u=users.get(userId); if(u) u.positionCount=Math.max(0,(u.positionCount||1)-1);
  bot.sendMessage(chatId, `✅ Закрыта ${my[n-1].symbol} ${my[n-1].direction.toUpperCase()} #${n}`);
});

bot.onText(/\/admin (.+)/, (msg, match)=>{
  const chatId = msg.chat.id; const params = match[1].split(' ');
  if (params[0]!==ADMIN_PASSWORD) return bot.sendMessage(chatId,'❌ Неверный пароль');

  const cmd = params[1];
  if (cmd==='stats') {
    const totalUsers = users.size;
    const totalPositions = Array.from(positions.values()).filter(p=>p.isActive).length;
    const premiumUsers = Array.from(users.values()).filter(u=>u.isPremium).length;
    const msgText = `📊 <b>Статистика</b>\n\n👥 Пользователей: ${totalUsers}\n💎 Premium: ${premiumUsers}\n📈 Активных позиций: ${totalPositions}`;
    return bot.sendMessage(chatId, msgText, { parse_mode:'HTML' });
  }
});

// -----------------------------
// AUTO NOTIFIER (interval) — можно отключить DISABLE_INTERVALS=true
// -----------------------------
if (!DISABLE_INTERVALS) {
  setInterval(async ()=>{
    for (const p of positions.values()) {
      if (!p.isActive) continue;
      try {
        const md = await getMarketData(p.symbol);
        if (!md) continue;
        const sigs = await generateRealtimeSignals(p.symbol, md, p);
        if (!sigs.length) continue;

        const price = md.price;
        let pnl = p.direction==='long' ? (price - p.entryPrice)*p.quantity : (p.entryPrice - price)*p.quantity;
        const pnlPct = (pnl / (p.quantity*p.entryPrice))*100;

        const { btc, note } = await divergenceNote(p.symbol);
        let btcBlock = '';
        if (btc) btcBlock = `\n📌 <b>BTC:</b> ${btc.trendLabel}, 1ч ${btc.ret1h.toFixed(2)}%, 24ч ${btc.ret24h.toFixed(2)}%\n${note?`• ${note}`:''}`;

        const text = `⚡ <b>Сигналы по ${p.symbol}</b>\n${sigs.map(s=>'• '+s.message).join('\n')}\n\nЦена: $${price}\nP&L: ${pnl>=0?'+':''}${pnl.toFixed(2)} (${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}%)${btcBlock}`;
        await bot.sendMessage(p.userId, text, { parse_mode:'HTML' });
      } catch(e){ /* noop */ }
    }
  }, 5*60*1000); // каждые 5 минут
}

// -----------------------------
// EXPRESS + /tick (Render Cron)
// -----------------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req,res)=> res.send(`<h1>🤖 AI Crypto Tracker</h1><p>Status: OK</p>`));
app.get('/health', (req,res)=> res.json({ status:'OK', uptime:process.uptime(), users:users.size, positions:[...positions.values()].filter(p=>p.isActive).length }));

app.get('/tick', async (req,res)=>{
  if (req.headers['x-cron-key'] !== CRON_KEY) return res.status(403).json({ ok:false, error:'Forbidden' });

  let sent = 0;
  for (const p of positions.values()) {
    if (!p.isActive) continue;
    try {
      const md = await getMarketData(p.symbol);
      if (!md) continue;
      const sigs = await generateRealtimeSignals(p.symbol, md, p);
      if (!sigs.length) continue;

      const price = md.price;
      let pnl = p.direction==='long' ? (price - p.entryPrice)*p.quantity : (p.entryPrice - price)*p.quantity;
      const pnlPct = (pnl / (p.quantity*p.entryPrice))*100;

      const { btc, note } = await divergenceNote(p.symbol);
      let btcBlock = '';
      if (btc) btcBlock = `\n📌 <b>BTC:</b> ${btc.trendLabel}, 1ч ${btc.ret1h.toFixed(2)}%, 24ч ${btc.ret24h.toFixed(2)}%\n${note?`• ${note}`:''}`;

      const text = `⚡ <b>Сигналы по ${p.symbol}</b>\n${sigs.map(s=>'• '+s.message).join('\n')}\n\nЦена: $${price}\nP&L: ${pnl>=0?'+':''}${pnl.toFixed(2)} (${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}%)${btcBlock}`;
      await bot.sendMessage(p.userId, text, { parse_mode:'HTML' });
      sent++;
    } catch(e){}
  }
  res.json({ ok:true, sent });
});

app.listen(PORT, ()=> console.log(`🌐 Server on :${PORT}`));

// -----------------------------
// ERROR HANDLERS
// -----------------------------
bot.on('error', (e)=> console.error('bot error', e.message));
bot.on('polling_error', (e)=> console.error('polling_error', e.message));

console.log('🤖 AI Crypto Tracker Bot v4.3 — Enhanced loaded');
