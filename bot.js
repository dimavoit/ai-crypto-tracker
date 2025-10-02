/**
 * 🤖 AI Crypto Tracker Bot v4.3 (webhook + /tick + Render-friendly)
 * - Webhook (без polling) → нет 409
 * - /tick с проверкой CRON_KEY → для Render Cron Job
 * - Binance primary, CoinGecko fallback (COINGECKO_API_KEY)
 * - Команды: /start /help /subscribe /positions /signals /balance /close /admin
 * - Добавлен ONDO; примеры: BTC long 114000, ETH short 3200, deposit 1000
 * - На Free укажите DISABLE_INTERVALS=true (используем только Cron Job)
 */

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');

// ---------- ENV ----------
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const BASE_URL  = process.env.BASE_URL || '';                 // напр. https://ai-crypto-tracker.onrender.com
const PORT      = Number(process.env.PORT) || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASS || 'crypto123';
const CRON_KEY  = process.env.CRON_KEY || '';                 // напр. my-secret
const DISABLE_INTERVALS = !!process.env.DISABLE_INTERVALS;    // true на Free

axios.defaults.timeout = 12000;
axios.defaults.headers.common['User-Agent'] = 'AI-Crypto-Tracker/4.3 (+render.com)';

// ---------- STATE (in-memory) ----------
const users = new Map();
const positions = new Map();
const awaitingInput = new Map();

// ---------- SYMBOL MAPS ----------
const binancePair = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', ADA: 'ADAUSDT',
  DOT: 'DOTUSDT', MATIC: 'MATICUSDT', LINK: 'LINKUSDT', UNI: 'UNIUSDT',
  AVAX: 'AVAXUSDT', ATOM: 'ATOMUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT',
  LTC: 'LTCUSDT', BCH: 'BCHUSDT',
  ONDO: 'ONDOUSDT'
};
const symbolMapping = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', ADA: 'cardano',
  DOT: 'polkadot', MATIC: 'matic-network', LINK: 'chainlink', UNI: 'uniswap',
  AVAX: 'avalanche-2', ATOM: 'cosmos', XRP: 'ripple', DOGE: 'dogecoin',
  LTC: 'litecoin', BCH: 'bitcoin-cash',
  ONDO: 'ondo-finance'
};

// ---------- HELPERS ----------
const round = (v, d = 2) => Math.round(Number(v) * 10 ** d) / 10 ** d;

function calcVolatility(prices) {
  const rets = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1], cur = prices[i];
    if (prev > 0) {
      const r = (cur - prev) / prev;
      if (Number.isFinite(r)) rets.push(r);
    }
  }
  const variance = rets.length ? rets.reduce((a, b) => a + b * b, 0) / rets.length : 0;
  return Math.sqrt(variance) * Math.sqrt(365) * 100;
}

// ---------- MARKET DATA ----------
async function binanceGet(url, params) {
  try { return (await axios.get(url, { params })).data; }
  catch (e) { console.warn('Binance', url, e.response?.status || e.code || e.message); throw e; }
}

async function fetchFromBinance(symbol) {
  const pair = binancePair[symbol]; if (!pair) throw new Error('PAIR_NOT_SUPPORTED');
  const hosts = ['https://api.binance.com', 'https://data-api.binance.vision'];
  let t = null, kl = null;
  for (const h of hosts) {
    try {
      [t, kl] = await Promise.all([
        binanceGet(`${h}/api/v3/ticker/24hr`, { symbol: pair }),
        binanceGet(`${h}/api/v3/klines`, { symbol: pair, interval: '1h', limit: 168 })
      ]);
      break;
    } catch { t = kl = null; }
  }
  if (!t || !kl) throw new Error('BINANCE_UNAVAILABLE');

  const prices = kl.map(k => parseFloat(k[4])); // close
  const volumes = kl.map(k => parseFloat(k[7])); // quote volume

  return {
    provider: 'Binance',
    price: parseFloat(t.lastPrice),
    change24h: parseFloat(t.priceChangePercent),
    volume24h: parseFloat(t.quoteVolume),
    high7d: Math.max(...prices),
    low7d: Math.min(...prices),
    avgVolume: volumes.length ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0,
    volatility: calcVolatility(prices),
    support: Math.min(...prices) * 1.02,
    resistance: Math.max(...prices) * 0.98
  };
}

async function fetchFromCoinGecko(symbol) {
  const id = symbolMapping[symbol]; if (!id) throw new Error('COIN_NOT_SUPPORTED');
  const headers = {};
  if (process.env.COINGECKO_API_KEY) headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;

  const [pr, hr] = await Promise.all([
    axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: { ids: id, vs_currencies: 'usd', include_24hr_change: 'true', include_24hr_vol: 'true' }, headers
    }),
    axios.get(`https://api.coingecko.com/api/v3/coins/${id}/market_chart`, {
      params: { vs_currency: 'usd', days: 7 }, headers
    })
  ]);
  const pd = pr.data[id]; const hd = hr.data;
  const prices = (hd.prices || []).map(p => p[1]);
  const volumes = (hd.total_volumes || []).map(v => v[1]);

  return {
    provider: 'CoinGecko',
    price: Number(pd.usd),
    change24h: Number(pd.usd_24h_change || 0),
    volume24h: Number(pd.usd_24h_vol || 0),
    high7d: prices.length ? Math.max(...prices) : 0,
    low7d: prices.length ? Math.min(...prices) : 0,
    avgVolume: volumes.length ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0,
    volatility: calcVolatility(prices),
    support: prices.length ? Math.min(...prices) * 1.02 : 0,
    resistance: prices.length ? Math.max(...prices) * 0.98 : 0
  };
}

async function getMarketData(sym) {
  const S = String(sym || '').toUpperCase();
  if (!binancePair[S] && !symbolMapping[S]) return null;
  try { return await fetchFromBinance(S); }
  catch { console.warn('Binance failed → fallback CoinGecko'); }
  try { return await fetchFromCoinGecko(S); }
  catch (e) { console.error('CoinGecko failed:', e.response?.status || e.code || e.message); return null; }
}

// ---------- ANALYTICS ----------
function calculateOptimalLevels(entry, dir, md, riskPercent = 4) {
  const { support, resistance, volatility } = md;
  let sl, tp;
  if (dir === 'long') {
    const buf = entry * (volatility / 100) * 0.5;
    sl = Math.min(support - buf, entry * (1 - riskPercent / 100));
    const risk = entry - sl;
    tp = Math.max(resistance, entry + risk * 2);
  } else {
    const buf = entry * (volatility / 100) * 0.5;
    sl = Math.max(resistance + buf, entry * (1 + riskPercent / 100));
    const risk = sl - entry;
    tp = Math.min(support, entry - risk * 2);
  }
  return { stopLoss: round(sl, 2), takeProfit: round(tp, 2), riskPercent: Math.abs((sl - entry) / entry * 100) };
}

function calculatePositionSize(deposit, entry, sl, riskPercent = 4) {
  const riskAmount = deposit * (riskPercent / 100);
  const priceRisk = Math.abs(entry - sl);
  const positionValue = priceRisk > 0 ? riskAmount / (priceRisk / entry) : 0;
  const qty = entry > 0 ? positionValue / entry : 0;
  return { quantity: round(qty, 5), positionValue: round(positionValue, 2), riskAmount: round(riskAmount, 2) };
}

const calculatePnL = (p, price) => p.direction === 'long'
  ? (price - p.entryPrice) * p.quantity
  : (p.entryPrice - price) * p.quantity;

function generateMarketSignals(position, md) {
  const signals = [];
  const price = md.price;
  const stopDistance = Math.abs(price - position.stopLoss) / Math.max(1e-9, position.stopLoss) * 100;
  const takeDist = Math.abs(price - position.takeProfit) / Math.max(1e-9, position.takeProfit) * 100;

  if (stopDistance < 2) signals.push({ type: 'warning', message: '🔴 ВНИМАНИЕ! Приближение к стоп-лоссу' });
  if (takeDist < 3) signals.push({ type: 'profit', message: '🎯 Близко к тейк-профиту! Возможна частичная фиксация' });
  if (md.avgVolume > 0 && md.volume24h > md.avgVolume * 1.5) signals.push({ type: 'volume', message: '📈 Повышенные объёмы — возможно сильное движение' });
  if (Math.abs(md.change24h) > 8) signals.push({ type: 'volatility', message: `⚡ Волатильность: ${md.change24h > 0 ? 'рост' : 'падение'} ${round(Math.abs(md.change24h), 1)}%` });
  return signals;
}

// ---------- PARSER ----------
function parsePositionInput(raw) {
  const normalized = String(raw || '')
    .replace(/[,]/g, ' ')
    .replace(/\$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const upper = normalized.toUpperCase();
  const symbol = Object.keys(binancePair).find(s => new RegExp(`\\b${s}\\b`).test(upper)) || null;
  const direction = /\b(LONG|ЛОНГ)\b/i.test(normalized) ? 'long'
    : (/\b(SHORT|ШОРТ)\b/i.test(normalized) ? 'short' : null);

  const depositMatch = normalized.match(/(?:DEPOSIT|ДЕПОЗИТ|DEP|ДЕП)\s*([\d.]+)/i);
  const sizeMatch    = normalized.match(/(?:SIZE|РАЗМЕР|КОЛИЧЕСТВО)\s*([\d.]+)/i);
  const deposit = depositMatch ? parseFloat(depositMatch[1]) : null;
  const size    = sizeMatch ? parseFloat(sizeMatch[1]) : null;

  // числа, исключая депозит/размер — первое оставшееся считаем ценой входа
  const nums = (normalized.match(/(\d+(?:\.\d+)?)/g) || []).map(Number);
  const candidates = nums.filter(n => n !== deposit && n !== size);
  const entryPrice = candidates.length ? parseFloat(candidates[0]) : null;

  return { symbol, direction, entryPrice, deposit, size };
}

// ---------- TELEGRAM (WEBHOOK MODE) ----------
let bot = null;
if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
  console.warn('⚠️ BOT_TOKEN не задан. Установите его в Environment.');
} else {
  bot = new TelegramBot(BOT_TOKEN); // без polling
}

// ---------- EXPRESS ----------
const app = express();
app.use(express.json());

// Webhook эндпоинт
if (bot) {
  if (BASE_URL) {
    bot.setWebHook(`${BASE_URL}/bot${BOT_TOKEN}`)
      .then(() => console.log('✅ Webhook set:', `${BASE_URL}/bot${BOT_TOKEN}`))
      .catch(e => console.error('setWebHook error:', e.message));
  } else {
    console.warn('⚠️ BASE_URL не задан — webhook не будет установлен.');
  }
  app.post(`/bot${BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

// Health (проверка живости)
app.get('/', (_req,res)=>res.send('🤖 AI Crypto Tracker: Webhook mode OK'));
app.get('/health', (_req,res)=>res.json({
  status:'OK', uptime:process.uptime(),
  users: users.size,
  positions: Array.from(positions.values()).filter(p=>p.isActive).length
}));

// ----- /tick для Cron Job (с проверкой CRON_KEY) -----
async function checkPositionsAndNotify() {
  console.log('⏱ Tick: checking positions...');
  for (const position of positions.values()) {
    if (!position.isActive) continue;
    try {
      const md = await getMarketData(position.symbol);
      if (!md) continue;

      const sigs = generateMarketSignals(position, md)
        .filter(s => s.type === 'warning' || s.type === 'profit');
      if (!sigs.length) continue;

      const price = md.price;
      const pnl = calculatePnL(position, price);
      const pnlPct = (pnl / Math.max(1e-9, position.entryPrice * position.quantity)) * 100;

      const text = `
🚨 <b>${position.symbol}</b>
Цена: $${round(price,2)} | P&L: ${pnl>=0?'+':''}${round(pnl,2)} (${pnlPct>=0?'+':''}${round(pnlPct,2)}%)
<b>Сигналы:</b>
${sigs.map(s => `• ${s.message}`).join('\n')}
      `;
      await bot.sendMessage(position.userId, text, { parse_mode: 'HTML' });
      await new Promise(r => setTimeout(r, 300)); // лёгкий троттлинг
    } catch (e) {
      console.error('tick loop error:', e.response?.status || e.message);
    }
  }
}

app.get('/tick', async (req, res) => {
  try {
    if (CRON_KEY) {
      const key = req.headers['x-cron-key'];
      if (key !== CRON_KEY) return res.status(403).json({ ok:false, error:'Forbidden' });
    }
    await checkPositionsAndNotify();
    res.json({ ok:true, checked: Array.from(positions.values()).filter(p=>p.isActive).length });
  } catch (e) {
    console.error('tick error:', e.message);
    res.status(500).json({ ok:false });
  }
});

// ---------- COMMANDS ----------
if (bot) {
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id; const userId = msg.from.id;
    if (!users.has(userId)) {
      users.set(userId, { id:userId, username:msg.from.username, isPremium:false, registeredAt:new Date(), positionCount:0 });
    }
    const welcome = `
🤖 <b>AI Crypto Tracker Bot</b>

🚀 <b>Привет!</b> Я помогаю отслеживать криптопозиции и присылаю персональные сигналы.
<b>Поддерживаю:</b> BTC, ETH, SOL, ADA, DOT, MATIC, LINK, UNI, AVAX, ATOM, XRP, DOGE, LTC, BCH, <b>ONDO</b>

━━━━━━━━━━━━━━━━━━━━
🎯 <b>Добавим позицию?</b>

Просто напишите:
<code>BTC long 114000</code>
<code>ETH short 3200, deposit 1000</code>

🤖 Я проанализирую рынок и предложу оптимальные SL/TP.
    `;
    bot.sendMessage(chatId, welcome, { parse_mode:'HTML' });
  });

  // Свободный ввод — добавление позиции
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id; const userId = msg.from.id;

    if (!users.has(userId)) { bot.sendMessage(chatId, 'Пожалуйста, начните с /start'); return; }
    const user = users.get(userId);
    if (!user.isPremium && user.positionCount >= 3) {
      bot.sendMessage(chatId, `
❌ <b>Лимит бесплатных позиций исчерпан</b>
Бесплатно: до 3 позиций
Premium: безлимит + продвинутая аналитика
/subscribe
      `, { parse_mode:'HTML' }); return;
    }

    const parsed = parsePositionInput(msg.text);
    if (!parsed.symbol || !parsed.direction || !parsed.entryPrice) {
      bot.sendMessage(chatId, `
❌ <b>Не могу понять формат</b>
Примеры:
<code>BTC long 114000</code>
<code>ETH short 3200, deposit 1000</code>
      `, { parse_mode:'HTML' }); return;
    }

    const wait = await bot.sendMessage(chatId, '🤖 <b>AI Crypto Tracker анализирует...</b>\n⏳ Получаю рыночные данные...', { parse_mode:'HTML' });
    const md = await getMarketData(parsed.symbol);
    if (!md) {
      await bot.editMessageText('❌ Ошибка загрузки данных. Добавьте COINGECKO_API_KEY или попробуйте позже.', { chat_id:chatId, message_id:wait.message_id });
      return;
    }

    await bot.editMessageText('🤖 <b>AI Crypto Tracker анализирует...</b>\n📊 Считаю уровни...', { chat_id:chatId, message_id:wait.message_id, parse_mode:'HTML' });
    const levels = calculateOptimalLevels(parsed.entryPrice, parsed.direction, md);
    if (!levels) {
      await bot.editMessageText('❌ Ошибка при расчёте уровней', { chat_id:chatId, message_id:wait.message_id });
      return;
    }

    let posSize = null;
    if (parsed.deposit) posSize = calculatePositionSize(parsed.deposit, parsed.entryPrice, levels.stopLoss);
    else if (parsed.size) posSize = { quantity: parsed.size, positionValue: round(parsed.size * parsed.entryPrice,2), riskAmount: 0 };

    const diffPct = ((md.price - parsed.entryPrice)/parsed.entryPrice)*100;
    const volumeStatus = md.avgVolume>0 && md.volume24h>md.avgVolume*1.2 ? 'высокий' : 'средний';
    const volLevel = md.volatility>50?'высокая': md.volatility>30?'средняя':'низкая';

    let text = `
📊 <b>${parsed.symbol}USDT — ${parsed.direction.toUpperCase()} позиция</b>
💰 <b>Вход:</b> $${parsed.entryPrice}
${parsed.deposit ? `💵 <b>Депозит:</b> $${parsed.deposit}` : parsed.size ? `📦 <b>Размер:</b> ${parsed.size} ${parsed.symbol}` : ''}

<b>Данные: ${md.provider}</b>
• Текущая: $${round(md.price,2)} (${diffPct>=0?'+':''}${round(diffPct,2)}%)
• 24ч: ${round(md.change24h,2)}%
• Объём 24ч: ${volumeStatus}
• Волатильность: ${round(md.volatility,1)}% (${volLevel})
• Поддержка: $${round(md.support,2)} | Сопротивление: $${round(md.resistance,2)}

🎯 <b>Рекомендации:</b>
🛑 SL: $${levels.stopLoss} (риск ~${round(levels.riskPercent,1)}%)
🎯 TP: $${levels.takeProfit} (R:R ≈ 1:2)

<b>✅ Добавить позицию?</b>
    `;
    if (posSize) text += `\n<b>📦 Рекомендуемый размер:</b> ${posSize.quantity} ${parsed.symbol} (~$${posSize.positionValue})`;

    await bot.editMessageText(text, {
      chat_id: chatId, message_id: wait.message_id, parse_mode:'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text:'✅ Да, добавить', callback_data:`add_position_${userId}_${Date.now()}` },
           { text:'⚙️ Изменить', callback_data:`modify_position_${userId}_${Date.now()}` }],
          [{ text:'📊 Подробнее', callback_data:`details_position_${userId}_${Date.now()}` }]
        ]
      }
    });

    awaitingInput.set(userId, {
      symbol: parsed.symbol, direction: parsed.direction, entryPrice: parsed.entryPrice,
      deposit: parsed.deposit, size: parsed.size, marketData: md,
      optimalLevels: levels, positionSize: posSize
    });
  });

  bot.on('callback_query', async (cbq) => {
    const chatId = cbq.message.chat.id;
    const userId = cbq.from.id;
    const data = cbq.data || '';

    if (data.startsWith('add_position_')) {
      const temp = awaitingInput.get(userId);
      if (!temp) { bot.answerCallbackQuery(cbq.id, { text:'Данные устарели' }); return; }

      const posId = `${userId}_${Date.now()}`;
      const qty = temp.positionSize ? temp.positionSize.quantity : (temp.size || 1);
      const position = {
        id: posId, userId, symbol: temp.symbol, direction: temp.direction,
        entryPrice: temp.entryPrice, stopLoss: temp.optimalLevels.stopLoss,
        takeProfit: temp.optimalLevels.takeProfit, quantity: qty,
        deposit: temp.deposit || 0, createdAt: new Date(), isActive: true
      };
      positions.set(posId, position);

      const user = users.get(userId); user.positionCount = (user.positionCount||0)+1;
      awaitingInput.delete(userId);

      const md = await getMarketData(temp.symbol);
      const priceNow = md ? md.price : temp.entryPrice;
      const pnl = calculatePnL(position, priceNow);
      const pnlPct = (pnl / Math.max(1e-9, position.entryPrice * position.quantity)) * 100;

      const sigs = md ? generateMarketSignals(position, md) : [];
      const sigsText = sigs.length ? sigs.map(s=>`• ${s.message}`).join('\n') : '• 🟡 Консолидация — явных сигналов нет';

      const resp = `
✅ <b>Позиция добавлена!</b>

📊 ${temp.symbol}USDT ${temp.direction.toUpperCase()} #${user.positionCount}
Вход: $${temp.entryPrice} | Размер: ${qty} ${temp.symbol}
SL: $${position.stopLoss} | TP: $${position.takeProfit}

📈 Текущая: $${round(priceNow,2)} (${pnlPct>=0?'+':''}${round(pnlPct,2)}%)
P&L: ${pnl>=0?'+':''}$${round(pnl,2)}

<b>Сигналы:</b>
${sigsText}

Команды: /positions /signals /balance
      `;
      bot.editMessageText(resp, { chat_id:chatId, message_id:cbq.message.message_id, parse_mode:'HTML' });
      bot.answerCallbackQuery(cbq.id, { text:'OK' });

    } else if (data.startsWith('modify_position_')) {
      bot.answerCallbackQuery(cbq.id, { text:'Изменение будет добавлено позже' });

    } else if (data.startsWith('details_position_')) {
      const temp = awaitingInput.get(userId);
      if (!temp) { bot.answerCallbackQuery(cbq.id, { text:'Данные устарели' }); return; }
      const md = temp.marketData;
      const details = `
📊 <b>Подробный анализ ${temp.symbol}</b>
• SL $${temp.optimalLevels.stopLoss} с учётом поддержки $${round(md.support,2)} и волатильности ${round(md.volatility,1)}%
• TP $${temp.optimalLevels.takeProfit} — зона сопротивления $${round(md.resistance,2)}, R:R≈1:2
Диапазон 7д: $${round(md.low7d,2)} — $${round(md.high7d,2)}
Объём 24ч vs ср.: ${md.avgVolume?round(md.volume24h/md.avgVolume*100,0):0}%
      `;
      bot.sendMessage(chatId, details, { parse_mode:'HTML' });
      bot.answerCallbackQuery(cbq.id, { text:'Отправлено' });
    }
  });

  // /positions
  bot.onText(/\/positions/, async (msg) => {
    const chatId = msg.chat.id; const userId = msg.from.id;
    const list = Array.from(positions.values()).filter(p=>p.userId===userId && p.isActive);
    if (!list.length) { bot.sendMessage(chatId, '📭 У вас нет активных позиций.'); return; }

    let text = '📊 <b>Ваши активные позиции:</b>\n\n';
    for (const [i,p] of list.entries()) {
      const md = await getMarketData(p.symbol);
      const cur = md ? round(md.price,2) : 'N/A';
      const pnl = md ? calculatePnL(p, md.price) : 0;
      const pct = md ? (pnl / Math.max(1e-9, p.entryPrice*p.quantity))*100 : 0;
      text += `${pnl>=0?'🟢':'🔴'} <b>${p.symbol} ${p.direction.toUpperCase()} #${i+1}</b>\n`;
      text += `Вход: $${p.entryPrice} | Текущая: $${cur}\n`;
      text += `P&L: ${pnl>=0?'+':''}${round(pnl,2)} (${pct>=0?'+':''}${round(pct,2)}%)\n`;
      text += `SL: $${p.stopLoss} | TP: $${p.takeProfit}\n\n`;
    }
    bot.sendMessage(chatId, text, { parse_mode:'HTML' });
  });

  // /signals
  bot.onText(/\/signals/, async (msg) => {
    const chatId = msg.chat.id; const userId = msg.from.id;
    const list = Array.from(positions.values()).filter(p=>p.userId===userId && p.isActive);
    if (!list.length) { bot.sendMessage(chatId, '📭 Нет активных позиций.'); return; }

    let message = '🎯 <b>Торговые сигналы:</b>\n\n'; let has=false;
    for (const [i,p] of list.entries()) {
      const md = await getMarketData(p.symbol); if (!md) continue;
      const sigs = generateMarketSignals(p, md);
      if (sigs.length) {
        has=true; message += `📊 <b>${p.symbol} #${i+1}</b> ($${round(md.price,2)}):\n`;
        sigs.forEach(s=>message += `${s.message}\n`); message += '\n';
      }
    }
    if (!has) message += '✅ Все позиции в норме\n';
    bot.sendMessage(chatId, message, { parse_mode:'HTML' });
  });

  // /balance
  bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id; const userId = msg.from.id;
    const list = Array.from(positions.values()).filter(p=>p.userId===userId && p.isActive);
    if (!list.length) { bot.sendMessage(chatId, '📭 У вас нет активных позиций.'); return; }

    const wait = await bot.sendMessage(chatId, '📊 <b>Анализирую портфель...</b>', { parse_mode:'HTML' });
    let total=0, invested=0;
    for (const p of list) {
      const md = await getMarketData(p.symbol); if (!md) continue;
      invested += p.entryPrice * p.quantity;
      total += calculatePnL(p, md.price);
    }
    const pct = invested>0 ? (total/invested)*100 : 0;
    const emoji = total>=0?'🟢':'🔴'; const trend = total>=0?'📈':'📉';
    const status = pct>5?'🔥 Отличная работа!': pct>0?'✅ Портфель в плюсе': pct<-5?'🔴 Требует внимания':'⚠️ Небольшие потери';

    const text = `
${emoji} <b>Общий баланс</b>
P&L: ${total>=0?'+':''}${round(total,2)} ${trend}
Процент: ${pct>=0?'+':''}${round(pct,2)}%
Инвестировано: $${round(invested,2)}

${status}

Команда: /signals — свежие подсказки
    `;
    bot.editMessageText(text, { chat_id:chatId, message_id:wait.message_id, parse_mode:'HTML' });
  });

  // /subscribe
  bot.onText(/\/subscribe/, (msg)=>{
    bot.sendMessage(msg.chat.id, `
💎 <b>AI Crypto Tracker Premium</b>
Free: до 3 позиций, базовые сигналы
Premium ($15/мес): безлимит позиций, продвинутые сигналы, realtime-алёрты
Оформление: @your_username
    `, { parse_mode:'HTML' });
  });

  // /help
  bot.onText(/\/help/, (msg)=>{
    bot.sendMessage(msg.chat.id, `
📋 <b>Помощь</b>

Примеры:
<code>BTC long 114000</code>
<code>ETH short 3200, deposit 1000</code>

Команды:
/positions — список позиций
/signals — торговые сигналы
/balance — общий P&L
/close N — закрыть позицию №N
/subscribe — премиум
    `, { parse_mode:'HTML' });
  });

  // /close N
  bot.onText(/\/close (.+)/, (msg, match) => {
    const chatId = msg.chat.id; const userId = msg.from.id; const n = parseInt(match[1],10);
    const list = Array.from(positions.values()).filter(p=>p.userId===userId && p.isActive);
    if (!list.length || !Number.isFinite(n) || n<1 || n>list.length) {
      bot.sendMessage(chatId, `❌ Позиция #${match[1]} не найдена. /positions чтобы увидеть номера.`);
      return;
    }
    const pos = list[n-1]; pos.isActive = false;
    const user = users.get(userId); if (user && user.positionCount>0) user.positionCount--;
    bot.sendMessage(chatId, `✅ Позиция ${pos.symbol} ${pos.direction.toUpperCase()} #${n} закрыта.`);
  });

  // /admin
  bot.onText(/\/admin (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const parts = (match[1]||'').split(' ');
    const pass = parts.shift();
    if (pass !== ADMIN_PASSWORD) { bot.sendMessage(chatId, '❌ Неверный пароль'); return; }
    const cmd = parts.shift();

    if (cmd === 'stats') {
      const totalUsers = users.size;
      const totalPos   = Array.from(positions.values()).filter(p=>p.isActive).length;
      const premium    = Array.from(users.values()).filter(u=>u.isPremium).length;
      const dayAgo     = new Date(Date.now()-24*60*60*1000);
      const daily      = Array.from(users.values()).filter(u=>u.registeredAt>dayAgo).length;
      bot.sendMessage(chatId, `
📊 <b>Статистика</b>
👥 Пользователи: ${totalUsers}
💎 Premium: ${premium}
📈 Активных позиций: ${totalPos}
🗓 Новых за 24ч: ${daily}
Conv: ${totalUsers? round((premium/totalUsers)*100,1):0}%
      `, { parse_mode:'HTML' });
    } else if (cmd === 'broadcast' && parts.length) {
      const text = parts.join(' ');
      (async ()=>{
        let sent=0; bot.sendMessage(chatId, '📤 Рассылка начата...');
        for (const u of users.values()) {
          try { await bot.sendMessage(u.id, `📢 <b>Уведомление:</b>\n\n${text}`, { parse_mode:'HTML' }); sent++; await new Promise(r=>setTimeout(r,100)); }
          catch(e){ console.error('broadcast error', u.id, e.message); }
        }
        bot.sendMessage(chatId, `✅ Отправлено ${sent} пользователям`);
      })();
    } else {
      bot.sendMessage(chatId, 'Команды: stats | broadcast <text>');
    }
  });

  // Интервальный мониторинг (выключите на Free через DISABLE_INTERVALS=true)
  if (!DISABLE_INTERVALS) {
    setInterval(()=>{ checkPositionsAndNotify().catch(()=>{}); }, 30*60*1000);
  }

  // Ошибки
  bot.on('error', e=>console.error('bot error:', e.response?.status || e.code || e.message));
}

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`🚀 Server on ${PORT}`);
  console.log(`Mode: webhook${DISABLE_INTERVALS?' (intervals disabled)':''}`);
  if (BASE_URL) console.log(`Webhook URL: ${BASE_URL}/bot${BOT_TOKEN}`);
  console.log('Endpoints: /health, /tick');
});
