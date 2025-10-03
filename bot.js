// =============================
// AI Crypto Tracker Bot v4.3 (enhanced)
// =============================

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');

// Замените на ваш токен от @BotFather
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Хранение данных пользователей (в продакшне используйте базу данных)
const users = new Map();
const positions = new Map();
const awaitingInput = new Map(); // Для отслеживания ожидающих ввода

// Админский пароль
const ADMIN_PASSWORD = 'crypto123';

// Маппинг символов для API (CoinGecko)
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
    'BCH': 'bitcoin-cash',
    'ONDO': 'ondoprotocol' // ✅ добавлен ONDO
};

// ===============
// === BTC CONTEXT helpers ===
// (добавлено; отдельный маркер рынка, не меняет уровни)
// ===============

// соответствие символов парам Binance для 1h-свечей
const binancePair = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', ADA: 'ADAUSDT',
  DOT: 'DOTUSDT', MATIC: 'MATICUSDT', LINK: 'LINKUSDT', UNI: 'UNIUSDT',
  AVAX: 'AVAXUSDT', ATOM: 'ATOMUSDT', XRP: 'XRPUSDT', DOGE: 'DOGEUSDT',
  LTC: 'LTCUSDT', BCH: 'BCHUSDT', ONDO: 'ONDOUSDT'
};

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

async function getKlines1h(symbol) {
  try {
    const pair = binancePair[symbol.toUpperCase()];
    if (!pair) return null;
    const resp = await axios.get('https://api.binance.com/api/v3/klines', {
      params: { symbol: pair, interval: '1h', limit: 72 }
    });
    return resp.data; // [[openTime,open,high,low,close,volume,...], ...]
  } catch (e) {
    // Binance иногда отдаёт 451 (гео-блок), тихо fallback’им
    return null;
  }
}

async function getBtcContext() {
  // Стандарт: берём 1h-свечи BTC, тренд по EMA20/EMA50, изменения 1h/24h
  const kl = await getKlines1h('BTC');
  if (!kl) {
    // fallback: на основе CoinGecko 24h-change
    try {
      const md = await getMarketData('BTC');
      if (!md) return null;
      const trendLabel = md.change24h >= 0 ? 'бычий' : 'медвежий';
      return { trendLabel, ret1h: 0, ret24h: md.change24h, price: md.price };
    } catch { return null; }
  }
  const closes = kl.map(k => +k[4]);
  const last = closes.at(-1);
  const c1h = closes.at(-2);
  const c24h = closes.at(-25) ?? closes[0];
  const ret1h = ((last - c1h) / c1h) * 100;
  const ret24h = ((last - c24h) / c24h) * 100;

  const ema20 = ema(closes, 20).pop();
  const ema50 = ema(closes, 50).pop();
  const trendLabel = ema20 > ema50 ? 'бычий' : (ema20 < ema50 ? 'медвежий' : 'флэт');

  return { trendLabel, ret1h, ret24h, price: last };
}

async function getAltRet1h(symbol) {
  const kl = await getKlines1h(symbol);
  if (!kl) return null;
  const closes = kl.map(k => +k[4]);
  const last = closes.at(-1);
  const c1h = closes.at(-2);
  return ((last - c1h) / c1h) * 100;
}

function altVsBtcNote(altRet1h, btcRet1h) {
  if (altRet1h == null || btcRet1h == null) return null;
  if (altRet1h >= 1 && btcRet1h <= -1) return '⚠️ Дивергенция: альт растёт при падении BTC';
  if (altRet1h <= -1 && btcRet1h >= 1) return '⚠️ Дивергенция: альт падает при росте BTC';
  return null;
}

// Получение цены и рыночных данных (CoinGecko, как было)
async function getMarketData(symbol) {
    try {
        const coinId = symbolMapping[symbol.toUpperCase()];
        if (!coinId) return null;

        // Получаем текущую цену и данные за 24ч
        const [priceResponse, historyResponse] = await Promise.all([
            axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`),
            axios.get(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=7`)
        ]);

        const priceData = priceResponse.data[coinId];
        const historyData = historyResponse.data;

        if (!priceData || !historyData) return null;

        // Расчет поддержек и сопротивлений
        const prices = historyData.prices.map(p => p[1]);
        const volumes = historyData.total_volumes.map(v => v[1]);
        
        const currentPrice = priceData.usd;
        const change24h = priceData.usd_24h_change || 0;
        const volume24h = priceData.usd_24h_vol || 0;

        const high7d = Math.max(...prices);
        const low7d = Math.min(...prices);
        const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;

        // Расчет волатильности
        const returns = [];
        for (let i = 1; i < prices.length; i++) {
            returns.push((prices[i] - prices[i-1]) / prices[i-1]);
        }
        const volatility = Math.sqrt(returns.reduce((a, b) => a + b*b, 0) / returns.length) * Math.sqrt(365) * 100;

        return {
            price: currentPrice,
            change24h: change24h,
            volume24h: volume24h,
            high7d: high7d,
            low7d: low7d,
            volatility: volatility,
            avgVolume: avgVolume,
            support: low7d * 1.02, // 2% выше минимума недели
            resistance: high7d * 0.98 // 2% ниже максимума недели
        };
    } catch (error) {
        console.error('Ошибка получения рыночных данных:', error);
        return null;
    }
}

// ===============
// === IMPROVED LEVELS ===
// (улучшенный расчёт TP/SL: буфер от волатильности + R/R не ниже 2:1)
// ===============
function calculateOptimalLevels(entryPrice, direction, marketData, riskPercent = 4) {
    if (!marketData) return null;

    const { volatility, support, resistance } = marketData;
    
    let stopLoss, takeProfit;
    // волатильностный буфер (мягче прежнего)
    const volBuf = entryPrice * (volatility / 100) * 0.4;
    
    if (direction === 'long') {
        // стоп: ниже поддержки, с учётом волатильности и лимита риска
        const stopBySupport = support - volBuf;
        const stopByRisk = entryPrice * (1 - riskPercent / 100);
        stopLoss = Math.min(stopBySupport, stopByRisk);

        // тейк: либо сопротивление, либо 2:1 от риска
        const riskAmount = entryPrice - stopLoss;
        const tpByRR = entryPrice + riskAmount * 2;
        takeProfit = Math.max(resistance, tpByRR);
        
    } else { // short
        const stopByRes = resistance + volBuf;
        const stopByRisk = entryPrice * (1 + riskPercent / 100);
        stopLoss = Math.max(stopByRes, stopByRisk);
        
        const riskAmount = stopLoss - entryPrice;
        const tpByRR = entryPrice - riskAmount * 2;
        takeProfit = Math.min(support, tpByRR);
    }

    return {
        stopLoss: Math.round(stopLoss * 100) / 100,
        takeProfit: Math.round(takeProfit * 100) / 100,
        riskPercent: Math.abs((stopLoss - entryPrice) / entryPrice * 100)
    };
}

// Расчет размера позиции
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

// Генерация рыночных сигналов (как было)
function generateMarketSignals(position, marketData) {
    const signals = [];
    const { price, change24h, volume24h, avgVolume } = marketData;
    
    // Проверка приближения к ключевым уровням
    const stopDistance = Math.abs(price - position.stopLoss) / position.stopLoss * 100;
    const takeProfitDistance = Math.abs(price - position.takeProfit) / position.takeProfit * 100;
    
    if (stopDistance < 2) {
        signals.push({
            type: 'warning',
            message: '🔴 ВНИМАНИЕ! Приближение к стоп-лоссу'
        });
    }
    
    if (takeProfitDistance < 3) {
        signals.push({
            type: 'profit',
            message: '🎯 Близко к тейк-профиту! Рассмотрите частичную фиксацию'
        });
    }
    
    // Анализ объемов
    if (volume24h > avgVolume * 1.5) {
        signals.push({
            type: 'volume',
            message: '📈 Повышенные объемы - возможно сильное движение'
        });
    }
    
    // Анализ изменений за 24ч
    if (Math.abs(change24h) > 8) {
        const direction = change24h > 0 ? 'рост' : 'падение';
        signals.push({
            type: 'volatility',
            message: `⚡ Высокая волатильность: ${direction} ${Math.abs(change24h).toFixed(1)}%`
        });
    }
    
    return signals;
}

// Парсинг естественного языка для позиций
function parsePositionInput(text) {
    const normalizedText = text.toLowerCase().replace(/[,.$]/g, ' ');
    
    // Поиск символа
    const symbolMatch = normalizedText.match(/\b(btc|eth|sol|ada|dot|matic|link|uni|avax|atom|xrp|doge|ltc|bch|ondo)\b/);
    
    // Поиск направления
    const directionMatch = normalizedText.match(/\b(long|short|лонг|шорт)\b/);
    
    // Поиск цены входа
    const priceMatch = normalizedText.match(/\b(\d+(?:\.\d+)?)\b/);
    
    // Поиск депозита
    const depositMatch = normalizedText.match(/(?:депозит|deposit|деп)\s*(\d+(?:\.\d+)?)/);
    
    // Поиск размера позиции
    const sizeMatch = normalizedText.match(/(?:размер|size|количество)\s*(\d+(?:\.\d+)?)/);
    
    return {
        symbol: symbolMatch ? symbolMatch[1].toUpperCase() : null,
        direction: directionMatch ? (directionMatch[1] === 'long' || directionMatch[1] === 'лонг' ? 'long' : 'short') : null,
        entryPrice: priceMatch ? parseFloat(priceMatch[1]) : null,
        deposit: depositMatch ? parseFloat(depositMatch[1]) : null,
        size: sizeMatch ? parseFloat(sizeMatch[1]) : null
    };
}

// Команда /start (оставил тексты, обновил примеры)
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
🤖 <b>AI Crypto Tracker Bot (обновленная версия)</b>

🚀 Привет! Я AI Crypto Tracker.  
Я помогаю отслеживать ваши криптопозиции и даю персональные торговые сигналы на основе реальных рыночных данных.  

<b>Что я умею:</b>  
📊 Анализирую рынок и рекомендую стоп-лоссы/тейк-профиты  
💡 Даю сигналы когда пора добирать или закрывать  
📈 Считаю P&L по всему портфелю  
⚡ Присылаю важные уведомления  

<b>Поддерживаю:</b> BTC, ETH, SOL, ADA, DOT, MATIC, LINK, UNI, AVAX, ATOM, XRP, DOGE, LTC, BCH, ONDO

━━━━━━━━━━━━━━━━━━━━

🎯 <b>Добавим вашу первую позицию?</b>

Просто напишите:
<code>BTC long 114000</code>
<code>ETH short 3200, deposit 1000</code>

🤖 <b>Я сам проанализирую рынок и предложу оптимальные уровни!</b>
    `;
    
    bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML' });
});

// Обработка текстовых сообщений (парсинг позиций)
bot.on('message', async (msg) => {
    if (msg.text && !msg.text.startsWith('/')) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        // Проверяем, есть ли пользователь
        if (!users.has(userId)) {
            bot.sendMessage(chatId, 'Пожалуйста, начните с команды /start');
            return;
        }
        
        const user = users.get(userId);
        
        // Проверка лимитов для бесплатных пользователей
        if (!user.isPremium && user.positionCount >= 3) {
            bot.sendMessage(chatId, `
❌ <b>Лимит бесплатных позиций исчерпан!</b>

Бесплатно: до 3 позиций
Premium: безлимит позиций + продвинутая аналитика

Для оформления подписки: /subscribe
            `, { parse_mode: 'HTML' });
            return;
        }
        
        // Парсим ввод пользователя
        const parsed = parsePositionInput(msg.text);
        
        if (!parsed.symbol || !parsed.direction || !parsed.entryPrice) {
            bot.sendMessage(chatId, `
❌ <b>Не могу понять формат позиции</b>

Попробуйте так:
<code>BTC long 114000</code>
<code>ETH short 3200, deposit 1000</code>
<code>SOL long 180, size 5</code>

Нужно указать: актив, направление (long/short), цену входа
            `, { parse_mode: 'HTML' });
            return;
        }
        
        // Отправляем сообщение о начале анализа
        const analysisMsg = await bot.sendMessage(chatId, '🤖 <b>AI Crypto Tracker анализирует...</b>\n\n⏳ Получаю рыночные данные...', { parse_mode: 'HTML' });
        
        // Получаем рыночные данные
        const marketData = await getMarketData(parsed.symbol);
        
        if (!marketData) {
            await bot.editMessageText(`❌ Не удалось получить данные по ${parsed.symbol}.\nПроверьте символ или попробуйте позже.`, {
                chat_id: chatId,
                message_id: analysisMsg.message_id
            });
            return;
        }
        
        // Обновляем сообщение с анализом
        await bot.editMessageText('🤖 <b>AI Crypto Tracker анализирует...</b>\n\n📊 Анализирую технические индикаторы...', {
            chat_id: chatId,
            message_id: analysisMsg.message_id,
            parse_mode: 'HTML'
        });
        
        // Рассчитываем оптимальные уровни (улучшенный алгоритм)
        const optimalLevels = calculateOptimalLevels(parsed.entryPrice, parsed.direction, marketData);
        
        if (!optimalLevels) {
            await bot.editMessageText('❌ Ошибка при расчете оптимальных уровней', {
                chat_id: chatId,
                message_id: analysisMsg.message_id
            });
            return;
        }
        
        // Рассчитываем размер позиции если указан депозит
        let positionSize = null;
        if (parsed.deposit) {
            positionSize = calculatePositionSize(parsed.deposit, parsed.entryPrice, optimalLevels.stopLoss);
        }
        
        // Формируем итоговое сообщение
        const currentPrice = marketData.price;
        const priceChange = ((currentPrice - parsed.entryPrice) / parsed.entryPrice * 100).toFixed(2);
        const priceChangeText = parseFloat(priceChange) >= 0 ? `+${priceChange}%` : `${priceChange}%`;
        const priceEmoji = parseFloat(priceChange) >= 0 ? '📈' : '📉';
        
        const volumeStatus = marketData.volume24h > marketData.avgVolume * 1.2 ? 'высокий' : 'средний';
        const volatilityLevel = marketData.volatility > 50 ? 'высокая' : marketData.volatility > 30 ? 'средняя' : 'низкая';
        
        let analysisText = `
📊 <b>${parsed.symbol}USDT - ${parsed.direction.toUpperCase()} позиция</b>
💰 <b>Цена входа:</b> $${parsed.entryPrice}
${parsed.deposit ? `💵 <b>Депозит:</b> $${parsed.deposit}` : ''}

━━━━━━━━━━━━━━━━━━━━

📈 <b>Рыночный анализ ${parsed.symbol}:</b>
• Текущая цена: $${currentPrice} (${priceChangeText} от входа) ${priceEmoji}
• 24ч изменение: ${marketData.change24h.toFixed(2)}%
• 24ч объем: ${volumeStatus}
• Волатильность: ${volatilityLevel} (${marketData.volatility.toFixed(1)}%)
• Ближайшая поддержка: $${marketData.support.toFixed(2)}
• Ближайшее сопротивление: $${marketData.resistance.toFixed(2)}

━━━━━━━━━━━━━━━━━━━━

🎯 <b>Мои рекомендации для вашей позиции:</b>

<b>🛑 Стоп-лосс:</b> $${optimalLevels.stopLoss} (-${optimalLevels.riskPercent.toFixed(1)}%)
<i>Уровень рассчитан с учетом поддержки и волатильности</i>

<b>🎯 Тейк-профит:</b> $${optimalLevels.takeProfit} (+${(((optimalLevels.takeProfit - parsed.entryPrice) / parsed.entryPrice) * 100).toFixed(1)}%)
<i>Зона сопротивления с соотношением риск/прибыль 2:1</i>
        `;
        
        if (positionSize) {
            analysisText += `
<b>📦 Рекомендуемый размер:</b> ${positionSize.quantity} ${parsed.symbol} (~$${positionSize.positionValue})
<i>Риск: $${positionSize.riskAmount} (${((positionSize.riskAmount / parsed.deposit) * 100).toFixed(1)}% от депозита)</i>
            `;
        }

        // === BTC CONTEXT block ===
        try {
            const btc = await getBtcContext();
            const alt1h = await getAltRet1h(parsed.symbol);
            const note = btc ? altVsBtcNote(alt1h, btc.ret1h) : null;
            if (btc) {
              analysisText += `
━━━━━━━━━━━━━━━━━━━━
📌 <b>Контекст BTC:</b>
• Тренд: ${btc.trendLabel}
• 1ч: ${btc.ret1h.toFixed(2)}% | 24ч: ${btc.ret24h.toFixed(2)}%
${note ? `• ${note}` : '• Дивергенций не замечено'}
              `;
            }
        } catch (e) {
            // молча пропускаем, если Binance недоступен
        }

        analysisText += `
━━━━━━━━━━━━━━━━━━━━

<b>✅ Добавить позицию с этими параметрами?</b>
        `;
        
        // Удаляем старое сообщение и отправляем новое с кнопками
        await bot.deleteMessage(chatId, analysisMsg.message_id);
        
        bot.sendMessage(chatId, analysisText, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Да, добавить', callback_data: `add_position_${userId}_${Date.now()}` },
                        { text: '⚙️ Изменить', callback_data: `modify_position_${userId}_${Date.now()}` }
                    ],
                    [
                        { text: '📊 Подробнее', callback_data: `details_position_${userId}_${Date.now()}` }
                    ]
                ]
            }
        });
        
        // Сохраняем временные данные позиции
        awaitingInput.set(userId, {
            symbol: parsed.symbol,
            direction: parsed.direction,
            entryPrice: parsed.entryPrice,
            deposit: parsed.deposit,
            size: parsed.size,
            marketData: marketData,
            optimalLevels: optimalLevels,
            positionSize: positionSize
        });
    }
});

// Обработка callback кнопок
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;
    
    if (data.startsWith('add_position_')) {
        const tempPosition = awaitingInput.get(userId);
        if (!tempPosition) {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Данные позиции устарели, создайте новую' });
            return;
        }
        
        // Создаем позицию
        const positionId = `${userId}_${Date.now()}`;
        const position = {
            id: positionId,
            userId: userId,
            symbol: tempPosition.symbol,
            direction: tempPosition.direction,
            entryPrice: tempPosition.entryPrice,
            stopLoss: tempPosition.optimalLevels.stopLoss,
            takeProfit: tempPosition.optimalLevels.takeProfit,
            quantity: tempPosition.positionSize ? tempPosition.positionSize.quantity : 1,
            deposit: tempPosition.deposit || 0,
            createdAt: new Date(),
            isActive: true
        };
        
        positions.set(positionId, position);
        const user = users.get(userId);
        user.positionCount++;
        
        // Удаляем временные данные
        awaitingInput.delete(userId);
        
        // Получаем актуальные данные для отчета
        const currentMarketData = await getMarketData(tempPosition.symbol);
        const currentPrice = currentMarketData ? currentMarketData.price : tempPosition.entryPrice;
        
        let pnl = 0;
        if (tempPosition.direction === 'long') {
            pnl = (currentPrice - tempPosition.entryPrice) * position.quantity;
        } else {
            pnl = (tempPosition.entryPrice - currentPrice) * position.quantity;
        }
        
        const pnlPercent = ((pnl / (position.quantity * tempPosition.entryPrice)) * 100);
        
        // Генерируем текущие сигналы
        const signals = currentMarketData ? generateMarketSignals(position, currentMarketData) : [];
        
        let signalsText = '';
        if (signals.length > 0) {
            signalsText = '\n<b>Рыночные сигналы:</b>\n';
            signals.forEach(signal => {
                signalsText += `• ${signal.message}\n`;
            });
        } else {
            signalsText = '\n• 🟡 <b>Консолидация</b> - цена в стабильном диапазоне\n• 📊 <b>Объемы средние</b> - нет активных движений\n• ⏳ <b>Ожидание</b> - следим за пробоем ключевых уровней';
        }

        // === BTC CONTEXT block (подтверждение добавления) ===
        let btcBlock = '';
        try {
          const btc = await getBtcContext();
          const alt1h = await getAltRet1h(tempPosition.symbol);
          const note = btc ? altVsBtcNote(alt1h, btc.ret1h) : null;
          if (btc) {
            btcBlock = `
━━━━━━━━━━━━━━━━━━━━
📌 <b>Контекст BTC:</b>
• Тренд: ${btc.trendLabel}
• 1ч: ${btc.ret1h.toFixed(2)}% | 24ч: ${btc.ret24h.toFixed(2)}%
${note ? `• ${note}` : ''}`;
          }
        } catch {}

        const responseText = `
✅ <b>Позиция добавлена в отслеживание!</b>

📊 <b>${tempPosition.symbol}USDT ${tempPosition.direction.toUpperCase()} #${user.positionCount}</b>
💰 Вход: $${tempPosition.entryPrice} | Размер: ${position.quantity} ${tempPosition.symbol}
🛑 Стоп: $${position.stopLoss} | 🎯 Тейк: $${position.takeProfit}

━━━━━━━━━━━━━━━━━━━━

🔔 <b>Я начинаю мониторинг!</b>
Буду присылать сигналы при важных изменениях:
• Приближение к стоп-лоссу/тейк-профиту
• Возможности для добора позиции
• Изменения в техническом анализе
• Важные рыночные события

━━━━━━━━━━━━━━━━━━━━

📈 <b>Текущая картина по ${tempPosition.symbol}:</b>

<b>Цена сейчас:</b> $${currentPrice} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}% от входа)
<b>P&L:</b> ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} ${pnl >= 0 ? '📈' : '📉'}

<b>Рыночные сигналы:</b>${signalsText}
${btcBlock}

━━━━━━━━━━━━━━━━━━━━

💡 <b>Пока держим позицию, никаких действий не требуется.</b>

Используйте:
• /positions - посмотреть все позиции
• /signals - получить актуальные сигналы
• /balance - общий P&L портфеля

<b>Приятной торговли! 🚀</b>
        `;
        
        bot.editMessageText(responseText, {
            chat_id: chatId,
            message_id: callbackQuery.message.message_id,
            parse_mode: 'HTML'
        });
        
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Позиция добавлена!' });
        
    } else if (data.startsWith('modify_position_')) {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Функция изменения будет доступна в следующем обновлении' });
        
    } else if (data.startsWith('details_position_')) {
        const tempPosition = awaitingInput.get(userId);
        if (!tempPosition) {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Данные позиции устарели' });
            return;
        }
        
        const detailsText = `
📊 <b>Подробный анализ для ${tempPosition.symbol}</b>

<b>🎯 Почему именно эти уровни:</b>

<b>Стоп-лосс $${tempPosition.optimalLevels.stopLoss}:</b>
• Находится ниже технической поддержки ($${tempPosition.marketData.support.toFixed(2)})
• Учитывает волатильность актива (${tempPosition.marketData.volatility.toFixed(1)}%)
• Ограничивает риск на уровне ${tempPosition.optimalLevels.riskPercent.toFixed(1)}%

<b>Тейк-профит $${tempPosition.optimalLevels.takeProfit}:</b>
• Зона технического сопротивления ($${tempPosition.marketData.resistance.toFixed(2)})
• Соотношение риск/прибыль 2:1
• Учитывает исторические максимумы недели

<b>📈 Рыночный контекст:</b>
• Недельный диапазон: $${tempPosition.marketData.low7d.toFixed(2)} - $${tempPosition.marketData.high7d.toFixed(2)}
• Средний объем 7 дней: ${(tempPosition.marketData.avgVolume / 1000000).toFixed(1)}M
• Текущий объем vs средний: ${((tempPosition.marketData.volume24h / tempPosition.marketData.avgVolume) * 100).toFixed(0)}%

<i>Анализ основан на данных за последние 7 дней и текущих рыночных условиях.</i>
        `;
        
        bot.sendMessage(chatId, detailsText, { parse_mode: 'HTML' });
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Детальный анализ отправлен' });
    }
});

// Команда /positions - показать все позиции (+ BTC контекст в конце)
bot.onText(/\/positions/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const userPositions = Array.from(positions.values()).filter(p => p.userId === userId && p.isActive);
    
    if (userPositions.length === 0) {
        bot.sendMessage(chatId, `
📭 <b>У вас нет активных позиций.</b>

Добавьте позицию просто написав:
<code>BTC long 114000</code>
<code>ETH short 3200, deposit 1000</code>
        `, { parse_mode: 'HTML' });
        return;
    }

    let message = '📊 <b>Ваши активные позиции:</b>\n\n';
    
    for (const position of userPositions) {
        const marketData = await getMarketData(position.symbol);
        let pnl = 0;
        let pnlPercent = 0;
        let currentPrice = 'N/A';
        
        if (marketData) {
            currentPrice = `$${marketData.price}`;
            if (position.direction === 'long') {
                pnl = (marketData.price - position.entryPrice) * position.quantity;
                pnlPercent = ((marketData.price - position.entryPrice) / position.entryPrice) * 100;
            } else {
                pnl = (position.entryPrice - marketData.price) * position.quantity;
                pnlPercent = ((position.entryPrice - marketData.price) / position.entryPrice) * 100;
            }
        }

        const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
        const positionNumber = Array.from(positions.values()).filter(p => p.userId === userId && p.isActive).indexOf(position) + 1;
        
        message += `${pnlEmoji} <b>${position.symbol} ${position.direction.toUpperCase()} #${positionNumber}</b>\n`;
        message += `💰 Вход: ${position.entryPrice} | Текущая: ${currentPrice}\n`;
        message += `📈 P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)\n`;
        message += `🛑 SL: ${position.stopLoss} | 🎯 TP: ${position.takeProfit}\n\n`;
    }

    // === BTC CONTEXT block (короткая сводка в конце) ===
    try {
      const btc = await getBtcContext();
      if (btc) {
        message += `📌 <b>Контекст BTC:</b> тренд ${btc.trendLabel}, 1ч ${btc.ret1h.toFixed(2)}%, 24ч ${btc.ret24h.toFixed(2)}%\n`;
      }
    } catch {}

    bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
});

// Команда /signals - получить торговые сигналы (+ BTC контекст)
bot.onText(/\/signals/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const userPositions = Array.from(positions.values()).filter(p => p.userId === userId && p.isActive);
    
    if (userPositions.length === 0) {
        bot.sendMessage(chatId, `
📭 <b>У вас нет активных позиций для анализа.</b>

Добавьте позицию просто написав:
<code>BTC long 114000</code>
        `, { parse_mode: 'HTML' });
        return;
    }

    let message = '🎯 <b>Торговые сигналы по вашим позициям:</b>\n\n';
    let hasSignals = false;
    
    for (const position of userPositions) {
        const marketData = await getMarketData(position.symbol);
        
        if (marketData) {
            const signals = generateMarketSignals(position, marketData);
            
            if (signals.length > 0) {
                hasSignals = true;
                const positionNumber = Array.from(positions.values()).filter(p => p.userId === userId && p.isActive).indexOf(position) + 1;
                message += `📊 <b>${position.symbol} #${positionNumber}</b> (${marketData.price}):\n`;
                signals.forEach(signal => {
                    message += `${signal.message}\n`;
                });
                message += '\n';
            }
        }
    }
    
    if (!hasSignals) {
        message += '✅ <b>Все позиции в норме</b>\n\n';
        message += '📊 Специальных сигналов нет, рынок в спокойном состоянии\n';
        message += '💡 Продолжайте следить за рынком!\n\n';
        message += '<i>Я пришлю уведомление при важных изменениях</i>\n';
    }

    // === BTC CONTEXT block ===
    try {
      const btc = await getBtcContext();
      if (btc) {
        message += `\n📌 <b>Контекст BTC:</b> тренд ${btc.trendLabel}, 1ч ${btc.ret1h.toFixed(2)}%, 24ч ${btc.ret24h.toFixed(2)}%`;
      }
    } catch {}

    bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
});

// Команда /balance - общий P&L
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const userPositions = Array.from(positions.values()).filter(p => p.userId === userId && p.isActive);
    
    if (userPositions.length === 0) {
        bot.sendMessage(chatId, '📭 <b>У вас нет активных позиций.</b>', { parse_mode: 'HTML' });
        return;
    }

    let totalPnL = 0;
    let totalInvested = 0;
    let positionsCount = userPositions.length;
    let profitablePositions = 0;
    
    const analysisMsg = await bot.sendMessage(chatId, '📊 <b>Анализирую портфель...</b>', { parse_mode: 'HTML' });
    
    for (const position of userPositions) {
        const marketData = await getMarketData(position.symbol);
        
        if (marketData) {
            const invested = position.entryPrice * position.quantity;
            totalInvested += invested;
            
            let pnl = 0;
            if (position.direction === 'long') {
                pnl = (marketData.price - position.entryPrice) * position.quantity;
            } else {
                pnl = (position.entryPrice - marketData.price) * position.quantity;
            }
            totalPnL += pnl;
            
            if (pnl > 0) profitablePositions++;
        }
    }
    
    const totalPnLPercent = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;
    const winRate = positionsCount > 0 ? (profitablePositions / positionsCount) * 100 : 0;
    const emoji = totalPnL >= 0 ? '🟢' : '🔴';
    const trendEmoji = totalPnL >= 0 ? '📈' : '📉';
    
    // Определяем статус портфеля
    let portfolioStatus = '';
    if (totalPnLPercent > 5) {
        portfolioStatus = '🔥 Отличная работа!';
    } else if (totalPnLPercent > 0) {
        portfolioStatus = '✅ Портфель в плюсе';
    } else if (totalPnLPercent > -5) {
        portfolioStatus = '⚠️ Небольшие потери';
    } else {
        portfolioStatus = '🔴 Требует внимания';
    }
    
    let message = `
${emoji} <b>Общий баланс портфеля:</b>

━━━━━━━━━━━━━━━━━━━━

💰 <b>Общий P&L:</b> ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)} ${trendEmoji}
📊 <b>Процент:</b> ${totalPnLPercent >= 0 ? '+' : ''}${totalPnLPercent.toFixed(2)}%
💵 <b>Инвестировано:</b> ${totalInvested.toFixed(2)}
📈 <b>Активных позиций:</b> ${positionsCount}
🎯 <b>Прибыльных позиций:</b> ${profitablePositions}/${positionsCount} (${winRate.toFixed(0)}%)

━━━━━━━━━━━━━━━━━━━━

${portfolioStatus}

<b>Рекомендации:</b>
${totalPnLPercent > 10 ? '• 💡 Рассмотрите частичную фиксацию прибыли' : ''}
${totalPnLPercent < -10 ? '• ⚠️ Проверьте стоп-лоссы по убыточным позициям' : ''}
${winRate < 40 ? '• 📚 Возможно стоит пересмотреть стратегию входов' : ''}
${winRate > 70 ? '• 🎯 Отличный winrate! Можно увеличить размеры позиций' : ''}

Используйте /signals для получения актуальных рекомендаций
    `;

    // Короткая вставка о BTC
    try {
      const btc = await getBtcContext();
      if (btc) {
        message += `\n📌 <b>Контекст BTC:</b> тренд ${btc.trendLabel}, 1ч ${btc.ret1h.toFixed(2)}%, 24ч ${btc.ret24h.toFixed(2)}%`;
      }
    } catch {}

    bot.editMessageText(message, {
        chat_id: chatId,
        message_id: analysisMsg.message_id,
        parse_mode: 'HTML'
    });
});

// Команда /subscribe - подписка
bot.onText(/\/subscribe/, (msg) => {
    const chatId = msg.chat.id;
    
    const message = `
💎 <b>AI Crypto Tracker Premium</b>

━━━━━━━━━━━━━━━━━━━━

🆓 <b>Бесплатный план:</b>
• До 3 позиций
• Базовые сигналы
• Общие уведомления
• Простой технический анализ

💎 <b>Premium ($15/месяц):</b>
• ✅ Безлимит позиций
• ✅ Продвинутые AI-сигналы
• ✅ Персональные рекомендации
• ✅ Уведомления в реальном времени
• ✅ Детальная аналитика рынка
• ✅ Приоритетная поддержка
• ✅ Интеграция с биржами (скоро)

━━━━━━━━━━━━━━━━━━━━

🎁 <b>Специальное предложение:</b>
Первая неделя бесплатно!

🚀 <b>Для оформления подписки:</b>
Напишите @your_username

<i>Premium подписка поможет максимизировать прибыль от торговли криптовалютами</i>
    `;
    
    bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
});

// Команда /help
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    
    const message = `
📋 <b>Помощь по AI Crypto Tracker</b>

━━━━━━━━━━━━━━━━━━━━

<b>🎯 Добавление позиций:</b>
Просто напишите в свободной форме:
<code>BTC long 114000</code>
<code>ETH short 3200, deposit 1000</code>
<code>SOL long 180, size 5</code>

<b>📊 Основные команды:</b>
/positions - Показать все позиции
/signals - Получить торговые сигналы
/balance - Общий P&L портфеля
/subscribe - Информация о Premium

━━━━━━━━━━━━━━━━━━━━

<b>📈 Поддерживаемые криптовалюты:</b>
BTC, ETH, SOL, ADA, DOT, MATIC, LINK, UNI, AVAX, ATOM, XRP, DOGE, LTC, BCH, ONDO

<b>💡 Типы позиций:</b> long, short

━━━━━━━━━━━━━━━━━━━━

<b>🤖 Что делает бот:</b>
• Анализирует рынок в реальном времени
• Рассчитывает оптимальные стоп-лоссы и тейк-профиты
• Присылает персональные торговые сигналы
• Считает P&L по всему портфелю
• Отправляет важные уведомления

❓ <b>Нужна помощь?</b> Напишите @your_username
    `;
    
    bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
});

// Команда удаления позиции
bot.onText(/\/close (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const positionNumber = parseInt(match[1]);
    
    const userPositions = Array.from(positions.values()).filter(p => p.userId === userId && p.isActive);
    
    if (positionNumber < 1 || positionNumber > userPositions.length) {
        bot.sendMessage(chatId, `❌ Позиция #${positionNumber} не найдена.\n\nИспользуйте /positions чтобы посмотреть номера позиций.`);
        return;
    }
    
    const position = userPositions[positionNumber - 1];
    position.isActive = false;
    
    const user = users.get(userId);
    user.positionCount--;
    
    bot.sendMessage(chatId, `✅ Позиция ${position.symbol} ${position.direction.toUpperCase()} #${positionNumber} закрыта и удалена из отслеживания.`);
});

// Админские команды
bot.onText(/\/admin (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const params = match[1].split(' ');
    
    if (params[0] !== ADMIN_PASSWORD) {
        bot.sendMessage(chatId, '❌ Неверный пароль');
        return;
    }
    
    const command = params[1];
    
    if (command === 'stats') {
        const totalUsers = users.size;
        const totalPositions = Array.from(positions.values()).filter(p => p.isActive).length;
        const premiumUsers = Array.from(users.values()).filter(u => u.isPremium).length;
        const dailyActiveUsers = Array.from(users.values()).filter(u => {
            const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            return u.registeredAt > dayAgo;
        }).length;
        
        const message = `
📊 <b>Статистика AI Crypto Tracker:</b>

👥 <b>Всего пользователей:</b> ${totalUsers}
💎 <b>Premium пользователей:</b> ${premiumUsers}
📈 <b>Активных позиций:</b> ${totalPositions}
📅 <b>Новых за 24ч:</b> ${dailyActiveUsers}
💰 <b>Conversion rate:</b> ${totalUsers > 0 ? ((premiumUsers / totalUsers) * 100).toFixed(1) : 0}%

<b>Дата запуска:</b> ${new Date().toLocaleDateString()}
        `;
        
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
        
    } else if (command === 'broadcast' && params[2]) {
        const broadcastMessage = params.slice(2).join(' ');
        let sentCount = 0;
        
        bot.sendMessage(chatId, '📤 Начинаю рассылку...');
        
        (async () => {
            for (const user of users.values()) {
                try {
                    await bot.sendMessage(user.id, `📢 <b>Уведомление от AI Crypto Tracker:</b>\n\n${broadcastMessage}`, { parse_mode: 'HTML' });
                    sentCount++;
                    await new Promise(resolve => setTimeout(resolve, 100)); // Задержка между отправками
                } catch (error) {
                    console.error(`Ошибка отправки пользователю ${user.id}:`, error);
                }
            }
            
            bot.sendMessage(chatId, `✅ Сообщение отправлено ${sentCount} пользователям`);
        })();
    }
});

// Автоматические уведомления (каждые 30 минут) — сохраняем,
// но при необходимости можешь отключить в Render переменной DISABLE_INTERVALS=true
if (String(process.env.DISABLE_INTERVALS).toLowerCase() !== 'true') {
  setInterval(async () => {
      console.log('Проверка позиций для уведомлений...');
      
      for (const position of positions.values()) {
          if (!position.isActive) continue;
          
          try {
              const marketData = await getMarketData(position.symbol);
              if (!marketData) continue;
              
              const signals = generateMarketSignals(position, marketData);
              
              // Отправляем только критичные сигналы в автоуведомлениях
              const criticalSignals = signals.filter(s => s.type === 'warning' || s.type === 'profit');
              
              if (criticalSignals.length > 0) {
                  const currentPrice = marketData.price;
                  let pnl = 0;
                  
                  if (position.direction === 'long') {
                      pnl = (currentPrice - position.entryPrice) * position.quantity;
                  } else {
                      pnl = (position.entryPrice - currentPrice) * position.quantity;
                  }
                  
                  const pnlPercent = ((pnl / (position.quantity * position.entryPrice)) * 100);
                  
                  // === BTC CONTEXT block ===
                  let btcBlock = '';
                  try {
                    const btc = await getBtcContext();
                    const alt1h = await getAltRet1h(position.symbol);
                    const note = btc ? altVsBtcNote(alt1h, btc.ret1h) : null;
                    if (btc) {
                      btcBlock = `
📌 <b>Контекст BTC:</b> тренд ${btc.trendLabel}, 1ч ${btc.ret1h.toFixed(2)}%, 24ч ${btc.ret24h.toFixed(2)}%
${note ? `• ${note}` : ''}`;
                    }
                  } catch {}

                  const message = `
🚨 <b>Важное уведомление по ${position.symbol}!</b>

📊 <b>Текущая цена:</b> ${currentPrice}
📈 <b>P&L:</b> ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)

<b>Сигналы:</b>
${criticalSignals.map(s => `• ${s.message}`).join('\n')}
${btcBlock}

Проверьте позицию: /positions
                  `;
                  
                  await bot.sendMessage(position.userId, message, { parse_mode: 'HTML' });
                  
                  // Небольшая задержка между уведомлениями
                  await new Promise(resolve => setTimeout(resolve, 1000));
              }
          } catch (error) {
              console.error('Ошибка при отправке автоуведомления:', error);
          }
      }
  }, 30 * 60 * 1000); // 30 минут
}

// Обработка ошибок
bot.on('error', (error) => {
    console.error('Ошибка бота:', error);
});

bot.on('polling_error', (error) => {
    console.error('Ошибка polling:', error);
});

// Для деплоя на Render.com
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send(`
        <h1>🤖 AI Crypto Tracker Bot</h1>
        <p>Bot is running successfully!</p>
        <p>Find the bot: <a href="https://t.me/AICryptoTrackerBot">@AICryptoTrackerBot</a></p>
        <p>Status: ✅ Online</p>
        <p>Users: ${users.size}</p>
        <p>Active Positions: ${Array.from(positions.values()).filter(p => p.isActive).length}</p>
    `);
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        uptime: process.uptime(),
        users: users.size,
        positions: Array.from(positions.values()).filter(p => p.isActive).length
    });
});

// Cron endpoint — если используешь Render Cron Jobs
app.get('/tick', async (req, res) => {
  const key = req.headers['x-cron-key'];
  if (!process.env.CRON_KEY || key !== process.env.CRON_KEY) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  let checked = 0;
  const btc = await getBtcContext();

  for (const position of positions.values()) {
    if (!position.isActive) continue;
    checked++;
    try {
      const md = await getMarketData(position.symbol);
      if (!md) continue;
      const sigs = generateMarketSignals(position, md).filter(s => s.type === 'warning' || s.type === 'profit');

      if (sigs.length) {
        const price = md.price;
        let pnl = position.direction === 'long'
          ? (price - position.entryPrice) * position.quantity
          : (position.entryPrice - price) * position.quantity;
        const pnlPct = (pnl / (position.quantity * position.entryPrice)) * 100;

        let btcBlock = '';
        try {
          const alt1h = await getAltRet1h(position.symbol);
          const note = btc ? altVsBtcNote(alt1h, btc.ret1h) : null;
          if (btc) {
            btcBlock = `
📌 <b>Контекст BTC:</b> тренд ${btc.trendLabel}, 1ч ${btc.ret1h.toFixed(2)}%, 24ч ${btc.ret24h.toFixed(2)}%
${note ? `• ${note}` : ''}`;
          }
        } catch {}

        const text = `
🚨 <b>${position.symbol} ${position.direction.toUpperCase()}</b>
Цена: $${price} | SL: ${position.stopLoss} | TP: ${position.takeProfit}
P&L: ${pnl>=0?'+':''}${pnl.toFixed(2)} (${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}%)

<b>Сигналы:</b>
${sigs.map(s => '• ' + s.message).join('\n')}
${btcBlock}
        `;
        await bot.sendMessage(position.userId, text, { parse_mode: 'HTML' });
      }
    } catch (e) {
      console.error('tick error', e.message);
    }
  }
  res.json({ ok: true, checked });
});

app.listen(PORT, () => {
    console.log(`🚀 AI Crypto Tracker Bot запущен!`);
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`💡 Для получения токена напишите @BotFather в Telegram`);
    console.log(`🔧 Не забудьте заменить YOUR_BOT_TOKEN_HERE на ваш токен!`);
});

console.log('🤖 AI Crypto Tracker Bot v4.3 (enhanced) готов к работе!');
