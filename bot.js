/**
 * 🤖 AI Crypto Tracker Bot v3.2 (Render-ready)
 * - Сохраняет весь функционал твоей прошлой версии:
 *   /start /help /subscribe /positions /signals /balance /close /admin + автоуведомления
 * - Устойчивые рыночные данные: Binance primary, CoinGecko fallback (с COINGECKO_API_KEY)
 * - Улучшенный парсинг входных сообщений (entry/депозит/размер)
 * - Единый express-сервер для Render (/, /health)
 * - Подробные логи ошибок
 */

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');

// ---------------- CONFIG -----------------
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const PORT = Number(process.env.PORT) || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASS || 'crypto123';

// HTTP/axios дружелюбность к публичным API
axios.defaults.timeout = 10000;
axios.defaults.headers.common['User-Agent'] = 'AI-Crypto-Tracker/3.2 (+render.com)';

// ---------------- STATE -----------------
// В продакшене лучше всё это вынести в БД (SQLite/Mongo). Здесь для MVP — память.
const users = new Map();       // userId -> { id, username, isPremium, registeredAt, positionCount }
const positions = new Map();   // positionId -> { ... }
const awaitingInput = new Map(); // userId -> temp draft (если нужно будет расширить flow)

// ---------------- SYMBOL MAPS ----------------
// Binance USDT пары (primary provider)
const binancePair = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', ADA: 'ADAUSDT',
  DOT: 'DOTUSDT', MATIC: 'MATICUSDT', LINK: 'LINKUSDT', UNI: 'UNIUSDT',
  AVAX: 'AVAXUSDT', ATOM: 'ATOMUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT',
  LTC: 'LTCUSDT', BCH: 'BCHUSDT'
};

// CoinGecko ID (fallback)
const symbolMapping = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', ADA: 'cardano',
  DOT: 'polkadot', MATIC: 'matic-network', LINK: 'chainlink', UNI: 'uniswap',
  AVAX: 'avalanche-2', ATOM: 'cosmos', XRP: 'ripple', DOGE: 'dogecoin',
  LTC: 'litecoin', BCH: 'bitcoin-cash'
};

// ---------------- HELPERS ----------------
function round(v, d = 2) {
  if (v === null || v === undefined || isNaN(v)) return 0;
  return Math.round(Number(v) * Math.pow(10, d)) / Math.pow(10, d);
}

function calcVolatility(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    const cur = prices[i];
    if (prev > 0) {
      const r = (cur - prev) / prev;
      if (Number.isFinite(r)) returns.push(r);
    }
  }
  const variance = returns.length
    ? returns.reduce((a, b) => a + b * b, 0) / returns.length
    : 0;
  return Math.sqrt(variance) * Math.sqrt(365) * 100;
}

// ---------------- MARKET DATA (RESILIENT) ----------------
async function binanceFetchJson(url, params) {
  try {
    const res = await axios.get(url, { params });
    return res.data;
  } catch (e) {
    if (e.response) console.warn(`Binance ${url} → ${e.response.status}`);
    else console.warn(`Binance ${url} → ${e.code || e.message}`);
    throw e;
  }
}

async function fetchFromBinance(symbol) {
  const pair = binancePair[symbol];
  if (!pair) throw new Error('PAIR_NOT_SUPPORTED');

  // основной и резервный хосты Binance
  const hosts = ['https://api.binance.com', 'https://data-api.binance.vision'];
  let ticker = null, klines = null;

  for (const host of hosts) {
    try {
      const [t, kl] = await Promise.all([
        binanceFetchJson(`${host}/api/v3/ticker/24hr`, { symbol: pair }),
        binanceFetchJson(`${host}/api/v3/klines`, { symbol: pair, interval: '1h', limit: 168 })
      ]);
      ticker = t; klines = kl;
      break;
    } catch {
      // пробуем следующий хост
      ticker = klines = null;
    }
  }
  if (!ticker || !klines) throw new Error('BINANCE_UNAVAILABLE');

  const prices = klines.map(k => parseFloat(k[4]));   // close
  const volumes = klines.map(k => parseFloat(k[7]));  // quote asset volume (USDT)

  return {
    provider: 'Binance',
    price: parseFloat(ticker.lastPrice),
    change24h: parseFloat(ticker.priceChangePercent),
    volume24h: parseFloat(ticker.quoteVolume),
    high7d: Math.max(...prices),
    low7d: Math.min(...prices),
    avgVolume: volumes.length ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0,
    volatility: calcVolatility(prices),
    support: Math.min(...prices) * 1.02,
    resistance: Math.max(...prices) * 0.98
  };
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

  const pd = priceRes.data[coinId];
  const hd = historyRes.data;

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

// Унифицированный фетчер с fallback и логами
async function getMarketData(inputSymbol) {
  const symbol = String(inputSymbol || '').toUpperCase();
  if (!binancePair[symbol] && !symbolMapping[symbol]) return null;

  try {
    const md = await fetchFromBinance(symbol);
    return md;
  } catch (e) {
    console.warn('Binance failed → fallback CoinGecko');
    try {
      const md = await fetchFromCoinGecko(symbol);
      return md;
    } catch (err) {
      console.error('CoinGecko failed:', err?.response?.status || err?.code || err?.message);
      return null;
    }
  }
}

// ---------------- POSITION & ANALYTICS ----------------
function calculateOptimalLevels(entryPrice, direction, marketData, riskPercent = 4) {
  if (!marketData) return null;
  const { support, resistance, volatility } = marketData;

  let stopLoss, takeProfit;
  if (direction === 'long') {
    const buffer = entryPrice * (volatility / 100) * 0.5;
    stopLoss = Math.min(support - buffer, entryPrice * (1 - riskPercent / 100));
    const risk = entryPrice - stopLoss;
    takeProfit = Math.max(resistance, entryPrice + risk * 2);
  } else {
    const buffer = entryPrice * (volatility / 100) * 0.5;
    stopLoss = Math.max(resistance + buffer, entryPrice * (1 + riskPercent / 100));
    const risk = stopLoss - entryPrice;
    takeProfit = Math.min(support, entryPrice - risk * 2);
  }

  return {
    stopLoss: round(stopLoss, 2),
    takeProfit: round(takeProfit, 2),
    riskPercent: Math.abs((stopLoss - entryPrice) / entryPrice * 100)
  };
}

function calculatePositionSize(deposit, entryPrice, stopLoss, riskPercent = 4) {
  const riskAmount = deposit * (riskPercent / 100);
  const priceRisk = Math.abs(entryPrice - stopLoss);
  const positionValue = priceRisk > 0 ? riskAmount / (priceRisk / entryPrice) : 0;
  const quantity = entryPrice > 0 ? positionValue / entryPrice : 0;
  return {
    quantity: round(quantity, 5),
    positionValue: round(positionValue, 2),
    riskAmount: round(riskAmount, 2)
  };
}

function calculatePnL(position, currentPrice) {
  if (position.direction === 'long') {
    return (currentPrice - position.entryPrice) * position.quantity;
  }
  return (position.entryPrice - currentPrice) * position.quantity;
}

function generateMarketSignals(position, marketData) {
  const signals = [];
  const { price, change24h, volume24h, avgVolume } = {
    price: marketData.price,
    change24h: marketData.change24h,
    volume24h: marketData.volume24h,
    avgVolume: marketData.avgVolume
  };

  const stopDistance = Math.abs(price - position.stopLoss) / Math.max(1e-9, position.stopLoss) * 100;
  const takeProfitDistance = Math.abs(price - position.takeProfit) / Math.max(1e-9, position.takeProfit) * 100;

  if (stopDistance < 2) {
    signals.push({ type: 'warning', message: '🔴 ВНИМАНИЕ! Приближение к стоп-лоссу' });
  }
  if (takeProfitDistance < 3) {
    signals.push({ type: 'profit', message: '🎯 Близко к тейк-профиту! Возможна частичная фиксация' });
  }
  if (avgVolume > 0 && volume24h > avgVolume * 1.5) {
    signals.push({ type: 'volume', message: '📈 Повышенные объёмы — возможно сильное движение' });
  }
  if (Math.abs(change24h) > 8) {
    const dir = change24h > 0 ? 'рост' : 'падение';
    signals.push({ type: 'volatility', message: `⚡ Высокая волатильность: ${dir} ${Math.abs(change24h).toFixed(1)}%` });
  }
  return signals;
}

// ---------------- PARSER ----------------
// Умный парсер: выделяет символ, направление, депозит/размер и старается не путать entry c депозитом.
function parsePositionInput(raw) {
  const text = String(raw || '');
  const normalized = text
    .replace(/[,]/g, ' ')
    .replace(/\$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const upper = normalized.toUpperCase();

  const symbol = Object.keys(binancePair).find(s => new RegExp(`\\b${s}\\b`).test(upper)) || null;
  const direction = /\b(LONG|ЛОНГ)\b/i.test(normalized)
    ? 'long'
    : (/\b(SHORT|ШОРТ)\b/i.test(normalized) ? 'short' : null);

  // депозит / размер — вырезаем их числа заранее
  const depositMatch = normalized.match(/(?:DEPOSIT|ДЕПОЗИТ|DEP|ДЕП)\s*([\d.]+)/i);
  const sizeMatch = normalized.match(/(?:SIZE|РАЗМЕР|КОЛИЧЕСТВО)\s*([\d.]+)/i);

  const deposit = depositMatch ? parseFloat(depositMatch[1]) : null;
  const size = sizeMatch ? parseFloat(sizeMatch[1]) : null;

  // теперь ищем кандидат(ы) на entry price — числа, ИСКЛЮЧАЯ числа после ключевых слов deposit/size
  // простая стратегия: берём все числа и исключаем совпавшие deposit/size
  const allNums = (normalized.match(/(\d+(?:\.\d+)?)/g) || []).map(Number);
  const candidates = allNums.filter(n => n !== deposit && n !== size);

  // эвристика: если есть направление, обычно entry стоит рядом. Но без сложного NLP берём первое допустимое число.
  const entryPrice = candidates.length ? parseFloat(candidates[0]) : null;

  return { symbol, direction, entryPrice, deposit, size };
}

// ---------------- BOT SETUP ----------------
let bot = null;
if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
  console.warn('⚠️ BOT_TOKEN не задан. Установите переменную окружения BOT_TOKEN в Render.');
} else {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });

  // /start — красивое приветствие
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!users.has(userId)) {
      users.set(userId, {
        id: userId,
        username: msg.from.username,
        isPremium: false,
        registeredAt: new Date(),
        positionCount: 0
      });
    }

    const welcomeMessage = `
🤖 <b>AI Crypto Tracker Bot</b> (обновленная версия)

🚀 <b>Привет!</b> Я AI Crypto Tracker.  
Я помогаю отслеживать ваши криптопозиции и даю персональные торговые сигналы на основе реальных рыночных данных.  

<b>Что я умею:</b>  
📊 Анализирую рынок и рекомендую стоп-лоссы/тейк-профиты  
💡 Даю сигналы когда пора добирать или закрывать  
📈 Считаю P&L по всему портфелю  
⚡ Присылаю важные уведомления  

<b>Поддерживаю:</b> BTC, ETH, SOL, ADA, DOT, MATIC, LINK, UNI, AVAX, ATOM, XRP, DOGE, LTC, BCH

━━━━━━━━━━━━━━━━━━━━

🎯 <b>Добавим вашу первую позицию?</b>  

Просто напишите:
<code>BTC long 45000</code>
<code>ETH short 3200, депозит 1000</code>
<code>SOL long 180, размер 5</code>

🤖 Я сам проанализирую рынок и предложу оптимальные уровни! 🚀
    `;
    bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML' });
  });

  // Глобальный обработчик текстов (добавление позиции в свободной форме)
  bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (!users.has(userId)) {
      bot.sendMessage(chatId, 'Пожалуйста, начните с команды /start');
      return;
    }

    const user = users.get(userId);

    // Лимиты бесплатного тарифа
    if (!user.isPremium && user.positionCount >= 3) {
      bot.sendMessage(chatId, `
❌ <b>Лимит бесплатных позиций исчерпан</b>

Бесплатно: до 3 позиций
Premium: безлимит + продвинутая аналитика

Оформить: /subscribe
      `, { parse_mode: 'HTML' });
      return;
    }

    // Парсим ввод
    const parsed = parsePositionInput(msg.text);
    if (!parsed.symbol || !parsed.direction || !parsed.entryPrice) {
      bot.sendMessage(chatId, `
❌ <b>Не могу понять формат позиции</b>

Примеры:
<code>BTC long 45000</code>
<code>ETH short 3200, депозит 1000</code>
<code>SOL long 180, размер 5</code>
      `, { parse_mode: 'HTML' });
      return;
    }

    // Сообщение "анализирую..."
    const analysisMsg = await bot.sendMessage(chatId, '🤖 <b>AI Crypto Tracker анализирует...</b>\n\n⏳ Получаю рыночные данные...', { parse_mode: 'HTML' });

    // Рынок
    const marketData = await getMarketData(parsed.symbol);
    if (!marketData) {
      await bot.editMessageText(
        '❌ Ошибка загрузки данных.\nПопробуйте позже или другой тикер.\nЕсли это Render, добавьте COINGECKO_API_KEY в env.',
        { chat_id: chatId, message_id: analysisMsg.message_id }
      );
      return;
    }

    await bot.editMessageText('🤖 <b>AI Crypto Tracker анализирует...</b>\n\n📊 Анализирую технические индикаторы...', {
      chat_id: chatId, message_id: analysisMsg.message_id, parse_mode: 'HTML'
    });

    const optimal = calculateOptimalLevels(parsed.entryPrice, parsed.direction, marketData);
    if (!optimal) {
      await bot.editMessageText('❌ Ошибка при расчёте уровней', { chat_id: chatId, message_id: analysisMsg.message_id });
      return;
    }

    let positionSize = null;
    if (parsed.deposit) {
      positionSize = calculatePositionSize(parsed.deposit, parsed.entryPrice, optimal.stopLoss);
    } else if (parsed.size) {
      positionSize = {
        quantity: parsed.size,
        positionValue: round(parsed.size * parsed.entryPrice, 2),
        riskAmount: round(parsed.size * Math.abs(parsed.entryPrice - optimal.stopLoss) / parsed.entryPrice * parsed.entryPrice * 0.04, 2) // приблизительно
      };
    }

    const currentPrice = marketData.price;
    const diffPct = ((currentPrice - parsed.entryPrice) / parsed.entryPrice) * 100;
    const volumeStatus = marketData.avgVolume > 0 && marketData.volume24h > marketData.avgVolume * 1.2 ? 'высокий' : 'средний';
    const volatilityLevel = marketData.volatility > 50 ? 'высокая' : marketData.volatility > 30 ? 'средняя' : 'низкая';

    let analysisText = `
📊 <b>${parsed.symbol}USDT — ${parsed.direction.toUpperCase()} позиция</b>
💰 <b>Цена входа:</b> $${parsed.entryPrice}
${parsed.deposit ? `💵 <b>Депозит:</b> $${parsed.deposit}` : parsed.size ? `📦 <b>Размер:</b> ${parsed.size} ${parsed.symbol}` : ''}

━━━━━━━━━━━━━━━━━━━━
<b>Данные: ${marketData.provider}</b>

📈 <b>Рыночный анализ ${parsed.symbol}:</b>
• Текущая цена: $${round(currentPrice, 2)} (${diffPct >= 0 ? '+' : ''}${round(diffPct, 2)}%)  
• 24ч изменение: ${round(marketData.change24h, 2)}%  
• 24ч объём: ${volumeStatus}  
• Волатильность (год): ${round(marketData.volatility, 1)}% (${volatilityLevel})  
• Поддержка: $${round(marketData.support, 2)}  
• Сопротивление: $${round(marketData.resistance, 2)}  

━━━━━━━━━━━━━━━━━━━━

🎯 <b>Рекомендации:</b>
🛑 Стоп-лосс: $${optimal.stopLoss} (-${round(optimal.riskPercent, 1)}%)  
🎯 Тейк-профит: $${optimal.takeProfit} (+${round(((optimal.takeProfit - parsed.entryPrice) / parsed.entryPrice) * 100, 1)}%)
<i>Уровни на основе поддержки/сопротивления и волатильности; целевое соотношение риск/прибыль ≈ 1:2</i>
    `;

    if (positionSize) {
      analysisText += `
<b>📦 Рекомендуемый размер:</b> ${positionSize.quantity} ${parsed.symbol} (~$${positionSize.positionValue})
<i>Оценка риска: ~$${positionSize.riskAmount}</i>
      `;
    }

    analysisText += `
━━━━━━━━━━━━━━━━━━━━
<b>✅ Добавить позицию с этими параметрами?</b>
    `;

    // Заменяем "анализирую" на итоговое + кнопки
    await bot.editMessageText(analysisText, {
      chat_id: chatId,
      message_id: analysisMsg.message_id,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Да, добавить', callback_data: `add_position_${userId}_${Date.now()}` },
            { text: '⚙️ Изменить', callback_data: `modify_position_${userId}_${Date.now()}` }
          ],
          [{ text: '📊 Подробнее', callback_data: `details_position_${userId}_${Date.now()}` }]
        ]
      }
    });

    // Сохраняем временно для callback
    awaitingInput.set(userId, {
      symbol: parsed.symbol,
      direction: parsed.direction,
      entryPrice: parsed.entryPrice,
      deposit: parsed.deposit,
      size: parsed.size,
      marketData,
      optimalLevels: optimal,
      positionSize
    });
  });

  // Callback кнопки
  bot.on('callback_query', async (cbq) => {
    const chatId = cbq.message.chat.id;
    const userId = cbq.from.id;
    const data = cbq.data || '';

    if (data.startsWith('add_position_')) {
      const temp = awaitingInput.get(userId);
      if (!temp) {
        bot.answerCallbackQuery(cbq.id, { text: 'Данные позиции устарели, создайте новую' });
        return;
      }

      const posId = `${userId}_${Date.now()}`;
      const qty = temp.positionSize ? temp.positionSize.quantity : (temp.size || 1);

      const position = {
        id: posId,
        userId,
        symbol: temp.symbol,
        direction: temp.direction,
        entryPrice: temp.entryPrice,
        stopLoss: temp.optimalLevels.stopLoss,
        takeProfit: temp.optimalLevels.takeProfit,
        quantity: qty,
        deposit: temp.deposit || 0,
        createdAt: new Date(),
        isActive: true
      };

      positions.set(posId, position);
      const user = users.get(userId);
      user.positionCount = (user.positionCount || 0) + 1;
      awaitingInput.delete(userId);

      // Текущая картина
      const md = await getMarketData(temp.symbol);
      const priceNow = md ? md.price : temp.entryPrice;
      const pnl = calculatePnL(position, priceNow);
      const pnlPct = (pnl / Math.max(1e-9, position.entryPrice * position.quantity)) * 100;

      // Сигналы
      const signals = md ? generateMarketSignals(position, md) : [];
      const signalsText = signals.length
        ? signals.map(s => `• ${s.message}`).join('\n')
        : '• 🟡 Консолидация — явных сигналов нет';

      const responseText = `
✅ <b>Позиция добавлена в отслеживание!</b>

📊 <b>${temp.symbol}USDT ${temp.direction.toUpperCase()} #${user.positionCount}</b>
💰 Вход: $${temp.entryPrice} | Размер: ${qty} ${temp.symbol}
🛑 SL: $${position.stopLoss} | 🎯 TP: $${position.takeProfit}

━━━━━━━━━━━━━━━━━━━━
🔔 <b>Я начинаю мониторинг</b>

📈 <b>Текущая картина:</b>
Цена: $${round(priceNow, 2)} (${pnl >= 0 ? '+' : ''}${round(pnlPct, 2)}%)
P&L: ${pnl >= 0 ? '+' : ''}$${round(pnl, 2)}

<b>Рыночные сигналы:</b>
${signalsText}

Используйте:
• /positions — все позиции
• /signals — свежие сигналы
• /balance — P&L портфеля
      `;
      bot.editMessageText(responseText, {
        chat_id: chatId,
        message_id: cbq.message.message_id,
        parse_mode: 'HTML'
      });
      bot.answerCallbackQuery(cbq.id, { text: 'Позиция добавлена!' });
    } else if (data.startsWith('modify_position_')) {
      bot.answerCallbackQuery(cbq.id, { text: 'Изменение параметров появится в следующем апдейте' });
    } else if (data.startsWith('details_position_')) {
      const temp = awaitingInput.get(userId);
      if (!temp) {
        bot.answerCallbackQuery(cbq.id, { text: 'Данные позиции устарели' });
        return;
      }
      const md = temp.marketData;
      const detailsText = `
📊 <b>Подробный анализ ${temp.symbol}</b>

<b>Почему эти уровни:</b>
• Стоп-лосс $${temp.optimalLevels.stopLoss} ниже/выше ключевого уровня ($${round(md.support, 2)} / $${round(md.resistance, 2)}) с учётом волатильности (${round(md.volatility, 1)}%)
• Тейк-профит $${temp.optimalLevels.takeProfit} у сопротивления/поддержки, R:R ≈ 1:2

<b>Контекст рынка (7д):</b>
• Диапазон: $${round(md.low7d, 2)} — $${round(md.high7d, 2)}
• Средний объём: $${round(md.avgVolume, 0)}
• Объём 24ч: $${round(md.volume24h, 0)} (${md.avgVolume ? round(md.volume24h / md.avgVolume * 100, 0) : 0}% от среднего)
      `;
      bot.sendMessage(chatId, detailsText, { parse_mode: 'HTML' });
      bot.answerCallbackQuery(cbq.id, { text: 'Детальный анализ отправлен' });
    }
  });

  // /positions — список позиций
  bot.onText(/\/positions/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const list = Array.from(positions.values()).filter(p => p.userId === userId && p.isActive);
    if (!list.length) {
      bot.sendMessage(chatId, `
📭 <b>У вас нет активных позиций</b>

Добавьте позицию:
<code>BTC long 45000</code>
<code>ETH short 3200, депозит 1000</code>
      `, { parse_mode: 'HTML' });
      return;
    }

    let text = '📊 <b>Ваши активные позиции:</b>\n\n';
    for (const [i, p] of list.entries()) {
      const md = await getMarketData(p.symbol);
      const cur = md ? round(md.price, 2) : 'N/A';
      let pnl = 0, pnlPct = 0;
      if (md) {
        pnl = calculatePnL(p, md.price);
        pnlPct = (pnl / Math.max(1e-9, p.entryPrice * p.quantity)) * 100;
      }
      const emoji = pnl >= 0 ? '🟢' : '🔴';
      text += `${emoji} <b>${p.symbol} ${p.direction.toUpperCase()} #${i + 1}</b>\n`;
      text += `Вход: $${p.entryPrice} | Текущая: $${cur}\n`;
      text += `P&L: ${pnl >= 0 ? '+' : ''}${round(pnl, 2)} (${pnlPct >= 0 ? '+' : ''}${round(pnlPct, 2)}%)\n`;
      text += `SL: $${p.stopLoss} | TP: $${p.takeProfit}\n\n`;
    }
    bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
  });

  // /signals — торговые сигналы
  bot.onText(/\/signals/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const list = Array.from(positions.values()).filter(p => p.userId === userId && p.isActive);
    if (!list.length) {
      bot.sendMessage(chatId, `
📭 <b>У вас нет активных позиций для анализа</b>

Добавьте позицию:
<code>BTC long 45000</code>
      `, { parse_mode: 'HTML' });
      return;
    }

    let message = '🎯 <b>Торговые сигналы по вашим позициям:</b>\n\n';
    let hasSignals = false;

    for (const [i, p] of list.entries()) {
      const md = await getMarketData(p.symbol);
      if (!md) continue;
      const sigs = generateMarketSignals(p, md);
      if (sigs.length) {
        hasSignals = true;
        message += `📊 <b>${p.symbol} #${i + 1}</b> ($${round(md.price, 2)}):\n`;
        sigs.forEach(s => message += `${s.message}\n`);
        message += '\n';
      }
    }

    if (!hasSignals) {
      message += '✅ <b>Все позиции в норме</b>\n';
      message += '📊 Специальных сигналов нет, рынок спокоен\n';
      message += '💡 Я пришлю уведомление при важных изменениях\n';
    }

    bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
  });

  // /balance — суммарный P&L
  bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    const list = Array.from(positions.values()).filter(p => p.userId === userId && p.isActive);
    if (!list.length) {
      bot.sendMessage(chatId, '📭 <b>У вас нет активных позиций</b>', { parse_mode: 'HTML' });
      return;
    }

    let totalPnL = 0;
    let totalInvested = 0;

    const waitMsg = await bot.sendMessage(chatId, '📊 <b>Анализирую портфель...</b>', { parse_mode: 'HTML' });

    for (const p of list) {
      const md = await getMarketData(p.symbol);
      if (!md) continue;
      totalInvested += p.entryPrice * p.quantity;
      totalPnL += calculatePnL(p, md.price);
    }

    const pct = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;
    const emoji = totalPnL >= 0 ? '🟢' : '🔴';
    const trend = totalPnL >= 0 ? '📈' : '📉';

    let status = '⚠️ Небольшие потери';
    if (pct > 5) status = '🔥 Отличная работа!';
    else if (pct > 0) status = '✅ Портфель в плюсе';
    else if (pct <= -5) status = '🔴 Требует внимания';

    const summary = `
${emoji} <b>Общий баланс портфеля</b>

💰 P&L: ${totalPnL >= 0 ? '+' : ''}${round(totalPnL, 2)} ${trend}
📊 Процент: ${pct >= 0 ? '+' : ''}${round(pct, 2)}%
💵 Инвестировано: ${round(totalInvested, 2)}

${status}

Рекомендации:
${pct > 10 ? '• 💡 Частичная фиксация прибыли может быть уместна\n' : ''}${pct < -10 ? '• ⚠️ Проверьте SL по убыточным позициям\n' : ''}Используйте /signals для свежих подсказок
    `;

    bot.editMessageText(summary, {
      chat_id: chatId,
      message_id: waitMsg.message_id,
      parse_mode: 'HTML'
    });
  });

  // /subscribe — инфо по премиуму (как было)
  bot.onText(/\/subscribe/, (msg) => {
    const chatId = msg.chat.id;
    const message = `
💎 <b>AI Crypto Tracker Premium</b>

🆓 <b>Бесплатно</b>:
• До 3 позиций
• Базовые сигналы

💎 <b>Premium ($15/мес)</b>:
• ✅ Безлимит позиций
• ✅ Продвинутые AI-сигналы
• ✅ Уведомления в реальном времени
• ✅ Детальная аналитика
• ✅ Поддержка

Оформление: напишите @your_username
    `;
    bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
  });

  // /help — помощь
  bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    const message = `
📋 <b>Помощь</b>

Добавление в свободной форме:
<code>BTC long 45000</code>
<code>ETH short 3200, депозит 1000</code>

Команды:
• /positions — список позиций
• /signals — торговые сигналы
• /balance — общий P&L
• /close N — закрыть позицию №N
• /subscribe — премиум
    `;
    bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
  });

  // /close N — закрыть позицию
  bot.onText(/\/close (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const n = parseInt(match[1], 10);

    const list = Array.from(positions.values()).filter(p => p.userId === userId && p.isActive);
    if (!list.length || !Number.isFinite(n) || n < 1 || n > list.length) {
      bot.sendMessage(chatId, `❌ Позиция #${match[1]} не найдена.\nИспользуйте /positions, чтобы посмотреть номера.`);
      return;
    }

    const pos = list[n - 1];
    pos.isActive = false;

    const user = users.get(userId);
    if (user && user.positionCount > 0) user.positionCount--;

    bot.sendMessage(chatId, `✅ Позиция ${pos.symbol} ${pos.direction.toUpperCase()} #${n} закрыта и удалена из отслеживания.`);
  });

  // /admin <pass> stats|broadcast text...
  bot.onText(/\/admin (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const args = (match[1] || '').split(' ');
    const pass = args.shift();
    if (pass !== ADMIN_PASSWORD) {
      bot.sendMessage(chatId, '❌ Неверный пароль');
      return;
    }
    const command = args.shift();

    if (command === 'stats') {
      const totalUsers = users.size;
      const totalPositions = Array.from(positions.values()).filter(p => p.isActive).length;
      const premiumUsers = Array.from(users.values()).filter(u => u.isPremium).length;
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const dailyActive = Array.from(users.values()).filter(u => u.registeredAt > dayAgo).length;

      const message = `
📊 <b>Статистика AI Crypto Tracker</b>

👥 Пользователей: ${totalUsers}
💎 Premium: ${premiumUsers}
📈 Активных позиций: ${totalPositions}
🗓 Новых за 24ч: ${dailyActive}
Conv: ${totalUsers ? round((premiumUsers / totalUsers) * 100, 1) : 0}%
      `;
      bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
    } else if (command === 'broadcast' && args.length) {
      const text = args.join(' ');
      bot.sendMessage(chatId, '📤 Начинаю рассылку...');
      (async () => {
        let sent = 0;
        for (const u of users.values()) {
          try {
            await bot.sendMessage(u.id, `📢 <b>Уведомление:</b>\n\n${text}`, { parse_mode: 'HTML' });
            sent++;
            await new Promise(r => setTimeout(r, 100));
          } catch (e) {
            console.error(`Ошибка отправки ${u.id}:`, e?.response?.status || e?.message);
          }
        }
        bot.sendMessage(chatId, `✅ Сообщение отправлено ${sent} пользователям`);
      })();
    } else {
      bot.sendMessage(chatId, 'Доступные admin-команды: stats | broadcast <text>');
    }
  });

  // Автоуведомления (каждые 30 минут) — как в прошлой версии
  setInterval(async () => {
    console.log('⏱ Проверка позиций для автоуведомлений...');
    for (const position of positions.values()) {
      if (!position.isActive) continue;

      try {
        const md = await getMarketData(position.symbol);
        if (!md) continue;

        const signals = generateMarketSignals(position, md)
          .filter(s => s.type === 'warning' || s.type === 'profit');

        if (signals.length) {
          const price = md.price;
          const pnl = calculatePnL(position, price);
          const pnlPct = (pnl / Math.max(1e-9, position.entryPrice * position.quantity)) * 100;

          const message = `
🚨 <b>Важное уведомление по ${position.symbol}!</b>

📊 Текущая цена: $${round(price, 2)}
📈 P&L: ${pnl >= 0 ? '+' : ''}${round(pnl, 2)} (${pnlPct >= 0 ? '+' : ''}${round(pnlPct, 2)}%)

<b>Сигналы:</b>
${signals.map(s => `• ${s.message}`).join('\n')}

Проверить позиции: /positions
          `;
          await bot.sendMessage(position.userId, message, { parse_mode: 'HTML' });
          await new Promise(r => setTimeout(r, 500)); // лёгкая пауза
        }
      } catch (e) {
        console.error('Ошибка автоуведомлений:', e?.response?.status || e?.message);
      }
    }
  }, 30 * 60 * 1000);

  // Логи ошибок бота
  bot.on('error', (error) => console.error('Ошибка бота:', error?.response?.status || error?.message));
  bot.on('polling_error', (error) => console.error('Ошибка polling:', error?.response?.status || error?.message));
}

// ---------------- EXPRESS (Render) ----------------
const app = express();
app.get('/', (_req, res) => {
  res.send(`
    <h1>🤖 AI Crypto Tracker Bot</h1>
    <p>Status: ✅ Online</p>
    <p>Users: ${users.size}</p>
    <p>Active Positions: ${Array.from(positions.values()).filter(p => p.isActive).length}</p>
  `);
});
app.get('/health', (_req, res) => {
  res.json({
    status: 'OK',
    uptime: process.uptime(),
    users: users.size,
    positions: Array.from(positions.values()).filter(p => p.isActive).length,
    region_hint: process.env.RENDER_REGION || 'unknown'
  });
});
app.listen(PORT, () => {
  console.log(`🚀 AI Crypto Tracker Bot запущен!`);
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`💡 В Telegram /start для приветствия, или напишите позицию: "BTC long 45000"`);
  console.log(`🔧 Для стабильного fallback добавьте COINGECKO_API_KEY в Render env`);
});
console.log('🤖 AI Crypto Tracker Bot v3.2 готов к работе!');
