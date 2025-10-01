const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// Замените на ваш токен от @BotFather
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Хранение данных пользователей (в продакшне используйте базу данных)
const users = new Map();
const positions = new Map();
const awaitingInput = new Map(); // Для отслеживания ожидающих ввода

// Админский пароль
const ADMIN_PASSWORD = 'crypto123';

// Маппинг символов для Binance API
const symbolMapping = {
    'BTC': 'BTCUSDT',
    'ETH': 'ETHUSDT', 
    'SOL': 'SOLUSDT',
    'ADA': 'ADAUSDT',
    'DOT': 'DOTUSDT',
    'MATIC': 'MATICUSDT',
    'LINK': 'LINKUSDT',
    'UNI': 'UNIUSDT',
    'AVAX': 'AVAXUSDT',
    'ATOM': 'ATOMUSDT',
    'XRP': 'XRPUSDT',
    'DOGE': 'DOGEUSDT',
    'LTC': 'LTCUSDT',
    'BCH': 'BCHUSDT'
};

// Получение цены и рыночных данных через Binance API
async function getMarketData(symbol) {
    try {
        const binanceSymbol = symbolMapping[symbol.toUpperCase()];
        if (!binanceSymbol) {
            console.log(`Символ ${symbol} не поддерживается`);
            return null;
        }

        console.log(`Получаю данные для ${symbol} (${binanceSymbol})...`);

        // Получаем текущую цену и статистику 24ч
        const ticker24h = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSymbol}`, {
            timeout: 10000
        });

        // Получаем исторические данные за 7 дней (свечи по 1 дню)
        const klines = await axios.get(`https://api.binance.com/api/v3/klines?symbol=${binanceSymbol}&interval=1d&limit=7`, {
            timeout: 10000
        });

        if (!ticker24h.data || !klines.data) {
            console.log(`Нет данных для ${symbol}`);
            return null;
        }

        const ticker = ticker24h.data;
        const candles = klines.data;

        // Извлекаем данные
        const currentPrice = parseFloat(ticker.lastPrice);
        const change24h = parseFloat(ticker.priceChangePercent);
        const volume24h = parseFloat(ticker.volume) * currentPrice;

        // Расчет high/low за 7 дней
        const prices = candles.map(c => [parseFloat(c[2]), parseFloat(c[3])]).flat(); // high и low каждой свечи
        const high7d = Math.max(...prices);
        const low7d = Math.min(...prices);

        // Средний объем за 7 дней
        const volumes = candles.map(c => parseFloat(c[5]) * parseFloat(c[4])); // volume * close price
        const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;

        // Расчет волатильности (стандартное отклонение цен закрытия)
        const closePrices = candles.map(c => parseFloat(c[4]));
        const returns = [];
        for (let i = 1; i < closePrices.length; i++) {
            returns.push((closePrices[i] - closePrices[i-1]) / closePrices[i-1]);
        }
        const volatility = Math.sqrt(returns.reduce((a, b) => a + b*b, 0) / returns.length) * Math.sqrt(365) * 100;

        console.log(`✅ Данные получены для ${symbol}: ${currentPrice}`);

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
        console.error(`❌ Ошибка получения данных для ${symbol}:`, error.message);
        return null;
    }
}

// Расчет оптимальных стоп-лосса и тейк-профита
function calculateOptimalLevels(entryPrice, direction, marketData, riskPercent = 4) {
    if (!marketData) return null;

    const { volatility, support, resistance } = marketData;
    
    let stopLoss, takeProfit;
    
    if (direction === 'long') {
        // Для лонга стоп ниже поддержки с учетом волатильности
        const volatilityBuffer = entryPrice * (volatility / 100) * 0.5;
        stopLoss = Math.min(support - volatilityBuffer, entryPrice * (1 - riskPercent / 100));
        
        // Тейк-профит к сопротивлению или 2:1 риск/прибыль
        const riskRewardRatio = 2;
        const riskAmount = entryPrice - stopLoss;
        takeProfit = Math.max(resistance, entryPrice + (riskAmount * riskRewardRatio));
        
    } else { // short
        // Для шорта стоп выше сопротивления
        const volatilityBuffer = entryPrice * (volatility / 100) * 0.5;
        stopLoss = Math.max(resistance + volatilityBuffer, entryPrice * (1 + riskPercent / 100));
        
        const riskRewardRatio = 2;
        const riskAmount = stopLoss - entryPrice;
        takeProfit = Math.min(support, entryPrice - (riskAmount * riskRewardRatio));
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

// Генерация рыночных сигналов
function generateMarketSignals(position, marketData) {
    const signals = [];
    const { price, change24h, volume24h, avgVolume } = marketData;
    
    // Проверка приближения к ключевым уровням
    const entryPrice = position.entryPrice;
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
    const symbolMatch = normalizedText.match(/\b(btc|eth|sol|ada|dot|matic|link|uni|avax|atom|xrp|doge|ltc|bch)\b/);
    
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

// Команда /start
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
🚀 <b>Привет! Я AI Crypto Tracker</b>

Я помогаю отслеживать ваши криптопозиции и даю персональные торговые сигналы на основе реальных рыночных данных.

<b>Что я умею:</b>
• 📊 Анализирую рынок и рекомендую стоп-лоссы/тейк-профиты
• 💡 Даю сигналы когда пора добирать или закрывать
• 📈 Считаю P&L по всему портфелю
• ⚡ Присылаю важные уведомления

<b>Поддерживаю:</b> BTC, ETH, SOL, ADA, DOT, MATIC, LINK, UNI, AVAX, ATOM

━━━━━━━━━━━━━━━━━━━━

🎯 <b>Добавим вашу первую позицию?</b>

Мне нужно знать только самое основное:
• <b>Какой актив?</b> (BTC, ETH, SOL...)
• <b>Long или Short?</b>
• <b>По какой цене зашли?</b>
• <b>Размер депозита?</b> (опционально)

<b>Например, просто напишите:</b>
<code>BTC long 45000</code>
<code>ETH short 3200, депозит 1000</code>

🤖 <b>Я сам проанализирую рынок и предложу оптимальные уровни!</b>

Готовы? Расскажите про вашу позицию! 🚀
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
<code>BTC long 45000</code>
<code>ETH short 3200, депозит 1000</code>
<code>SOL long 180, размер 5</code>

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
        
        // Рассчитываем оптимальные уровни
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

// Команда /positions - показать все позиции
bot.onText(/\/positions/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const userPositions = Array.from(positions.values()).filter(p => p.userId === userId && p.isActive);
    
    if (userPositions.length === 0) {
        bot.sendMessage(chatId, `
📭 <b>У вас нет активных позиций.</b>

Добавьте позицию просто написав:
<code>BTC long 45000</code>
<code>ETH short 3200, депозит 1000</code>
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
    
    bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
});

// Команда /signals - получить торговые сигналы
bot.onText(/\/signals/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const userPositions = Array.from(positions.values()).filter(p => p.userId === userId && p.isActive);
    
    if (userPositions.length === 0) {
        bot.sendMessage(chatId, `
📭 <b>У вас нет активных позиций для анализа.</b>

Добавьте позицию просто написав:
<code>BTC long 45000</code>
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
        message += '<i>Я пришлю уведомление при важных изменениях</i>';
    }
    
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
    
    const message = `
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
<code>BTC long 45000</code>
<code>ETH short 3200, депозит 1000</code>
<code>SOL long 180, размер 5</code>

<b>📊 Основные команды:</b>
/positions - Показать все позиции
/signals - Получить торговые сигналы
/balance - Общий P&L портфеля
/subscribe - Информация о Premium

━━━━━━━━━━━━━━━━━━━━

<b>📈 Поддерживаемые криптовалюты:</b>
BTC, ETH, SOL, ADA, DOT, MATIC, LINK, UNI, AVAX, ATOM, XRP, DOGE, LTC, BCH

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

// Автоматические уведомления (каждые 30 минут)
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
                
                const message = `
🚨 <b>Важное уведомление по ${position.symbol}!</b>

📊 <b>Текущая цена:</b> ${currentPrice}
📈 <b>P&L:</b> ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%)

<b>Сигналы:</b>
${criticalSignals.map(s => `• ${s.message}`).join('\n')}

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

// Обработка ошибок
bot.on('error', (error) => {
    console.error('Ошибка бота:', error);
});

bot.on('polling_error', (error) => {
    console.error('Ошибка polling:', error);
});

// Для деплоя на Render.com
const express = require('express');
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

app.listen(PORT, () => {
    console.log(`🚀 AI Crypto Tracker Bot запущен!`);
    console.log(`🌐 Server running on port ${PORT}`);
    console.log(`💡 Для получения токена напишите @BotFather в Telegram`);
    console.log(`🔧 Не забудьте заменить YOUR_BOT_TOKEN_HERE на ваш токен!`);
});

console.log('🤖 AI Crypto Tracker Bot v2.0 готов к работе!');
