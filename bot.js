/**
 * 🤖 AI Crypto Tracker Bot v3.0
 * - Поддержка позиций
 * - Binance primary API, CoinGecko fallback
 * - Сигналы, P&L, баланс портфеля
 * - Deploy на Render
 */

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const express = require("express");

// ---------------- CONFIG -----------------
const BOT_TOKEN = process.env.BOT_TOKEN || "YOUR_BOT_TOKEN_HERE";
const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASS || "crypto123";

// ---------------- STATE -----------------
const users = new Map();       // userId → user info
const positions = new Map();   // posId → position

// Binance trading pairs
const binancePair = {
  BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT", ADA: "ADAUSDT",
  DOT: "DOTUSDT", MATIC: "MATICUSDT", LINK: "LINKUSDT", UNI: "UNIUSDT",
  AVAX: "AVAXUSDT", ATOM: "ATOMUSDT", XRP: "XRPUSDT", DOGE: "DOGEUSDT",
  LTC: "LTCUSDT", BCH: "BCHUSDT"
};

// CoinGecko mapping
const symbolMapping = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana", ADA: "cardano",
  DOT: "polkadot", MATIC: "matic-network", LINK: "chainlink", UNI: "uniswap",
  AVAX: "avalanche-2", ATOM: "cosmos", XRP: "ripple", DOGE: "dogecoin",
  LTC: "litecoin", BCH: "bitcoin-cash"
};

// ---------------- HELPERS ----------------
function round(v, d = 2) {
  return Math.round(v * Math.pow(10, d)) / Math.pow(10, d);
}

function calcVolatility(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    const r = (prices[i] - prices[i - 1]) / prices[i - 1];
    if (Number.isFinite(r)) returns.push(r);
  }
  const variance = returns.reduce((a, b) => a + b * b, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(365) * 100;
}

// ---------------- MARKET DATA ----------------
async function fetchFromBinance(symbol) {
  const pair = binancePair[symbol];
  if (!pair) throw new Error("PAIR_NOT_SUPPORTED");

  const [tickerRes, klinesRes] = await Promise.all([
    axios.get("https://api.binance.com/api/v3/ticker/24hr", { params: { symbol: pair } }),
    axios.get("https://api.binance.com/api/v3/klines", { params: { symbol: pair, interval: "1h", limit: 168 } })
  ]);

  const t = tickerRes.data;
  const kl = klinesRes.data;
  const prices = kl.map(k => parseFloat(k[4]));
  const volumes = kl.map(k => parseFloat(k[7]));

  return {
    price: parseFloat(t.lastPrice),
    change24h: parseFloat(t.priceChangePercent),
    volume24h: parseFloat(t.quoteVolume),
    high7d: Math.max(...prices),
    low7d: Math.min(...prices),
    avgVolume: volumes.reduce((a, b) => a + b, 0) / volumes.length,
    volatility: calcVolatility(prices),
    support: Math.min(...prices) * 1.02,
    resistance: Math.max(...prices) * 0.98
  };
}

async function fetchFromCoinGecko(symbol) {
  const coinId = symbolMapping[symbol];
  if (!coinId) throw new Error("COIN_NOT_SUPPORTED");

  const [priceRes, historyRes] = await Promise.all([
    axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`),
    axios.get(`https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=7`)
  ]);

  const pd = priceRes.data[coinId];
  const hd = historyRes.data;
  const prices = hd.prices.map(p => p[1]);
  const volumes = hd.total_volumes.map(v => v[1]);

  return {
    price: pd.usd,
    change24h: pd.usd_24h_change,
    volume24h: pd.usd_24h_vol,
    high7d: Math.max(...prices),
    low7d: Math.min(...prices),
    avgVolume: volumes.reduce((a, b) => a + b, 0) / volumes.length,
    volatility: calcVolatility(prices),
    support: Math.min(...prices) * 1.02,
    resistance: Math.max(...prices) * 0.98
  };
}

async function getMarketData(symbol) {
  try {
    return await fetchFromBinance(symbol);
  } catch {
    try {
      return await fetchFromCoinGecko(symbol);
    } catch {
      return null;
    }
  }
}

// ---------------- POSITION LOGIC ----------------
function calculateOptimalLevels(entryPrice, direction, marketData, riskPercent = 4) {
  const { support, resistance, volatility } = marketData;
  let stopLoss, takeProfit;

  if (direction === "long") {
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
  return { stopLoss: round(stopLoss, 2), takeProfit: round(takeProfit, 2) };
}

function calculatePnL(pos, price) {
  let pnl = 0;
  if (pos.direction === "long") pnl = (price - pos.entryPrice) * pos.quantity;
  else pnl = (pos.entryPrice - price) * pos.quantity;
  return pnl;
}

// ---------------- BOT ----------------
if (!BOT_TOKEN || BOT_TOKEN === "YOUR_BOT_TOKEN_HERE") {
  console.warn("⚠️ BOT_TOKEN not set!");
} else {
  const bot = new TelegramBot(BOT_TOKEN, { polling: true });

  // --- START ---
  bot.onText(/\/start/, (msg) => {
    const welcomeMessage = `
🤖 <b>AI Crypto Tracker Bot</b> (обновленная версия)

🚀 <b>Привет!</b> Я AI Crypto Tracker.  
Я помогаю отслеживать ваши криптопозиции и даю персональные торговые сигналы на основе реальных рыночных данных.  

<b>Что я умею:</b>  
📊 Анализирую рынок и рекомендую стоп-лоссы/тейк-профиты  
💡 Даю сигналы когда пора добирать или закрывать  
📈 Считаю P&L по всему портфелю  
⚡ Присылаю важные уведомления  

<b>Поддерживаю:</b> BTC, ETH, SOL, ADA, DOT, MATIC, LINK, UNI, AVAX, ATOM  

━━━━━━━━━━━━━━━━━━━━

🎯 <b>Добавим вашу первую позицию?</b>  

Просто напишите:  
<code>BTC long 45000</code>  
<code>ETH short 3200, депозит 1000</code>  
<code>SOL long 180, размер 5</code>  

🤖 Я сам проанализирую рынок и предложу оптимальные уровни! 🚀
    `;
    bot.sendMessage(msg.chat.id, welcomeMessage, { parse_mode: "HTML" });
  });

  // --- ADD POSITION ---
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const text = msg.text.toUpperCase();
    const symbol = Object.keys(binancePair).find(s => text.includes(s));
    const direction = text.includes("LONG") ? "long" : text.includes("SHORT") ? "short" : null;
    const priceMatch = text.match(/(\d+(\.\d+)?)/);
    const depositMatch = text.match(/DEPOSIT\s*(\d+)/i) || text.match(/ДЕПОЗИТ\s*(\d+)/i);

    if (!symbol || !direction || !priceMatch) {
      bot.sendMessage(msg.chat.id, "❌ Неверный формат. Пример: BTC long 45000 deposit 1000");
      return;
    }

    const entry = parseFloat(priceMatch[1]);
    const deposit = depositMatch ? parseFloat(depositMatch[1]) : null;

    const marketData = await getMarketData(symbol);
    if (!marketData) {
      bot.sendMessage(msg.chat.id, "❌ Ошибка загрузки данных");
      return;
    }

    const levels = calculateOptimalLevels(entry, direction, marketData);
    const qty = deposit ? round(deposit / entry, 4) : 1;

    const posId = `${msg.from.id}_${Date.now()}`;
    const position = {
      id: posId, userId: msg.from.id, symbol,
      direction, entryPrice: entry, stopLoss: levels.stopLoss, takeProfit: levels.takeProfit,
      quantity: qty, isActive: true
    };
    positions.set(posId, position);

    bot.sendMessage(msg.chat.id,
      `✅ Позиция добавлена: ${symbol} ${direction.toUpperCase()}\nВход: $${entry}\nSL: $${levels.stopLoss}\nTP: $${levels.takeProfit}\nРазмер: ${qty}`
    );
  });

  // --- POSITIONS ---
  bot.onText(/\/positions/, async (msg) => {
    const userPos = Array.from(positions.values()).filter(p => p.userId === msg.from.id && p.isActive);
    if (!userPos.length) return bot.sendMessage(msg.chat.id, "📭 У вас нет активных позиций.");
    let text = "📊 <b>Ваши позиции:</b>\n\n";
    for (const [i, p] of userPos.entries()) {
      const md = await getMarketData(p.symbol);
      const pnl = md ? calculatePnL(p, md.price) : 0;
      const pnlPct = md ? (pnl / (p.entryPrice * p.quantity)) * 100 : 0;
      text += `${i+1}. ${p.symbol} ${p.direction.toUpperCase()} | Вход $${p.entryPrice} | Текущая $${md?.price || "N/A"}\nP&L: ${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%) | SL $${p.stopLoss} | TP $${p.takeProfit}\n\n`;
    }
    bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
  });

  // --- BALANCE ---
  bot.onText(/\/balance/, async (msg) => {
    const userPos = Array.from(positions.values()).filter(p => p.userId === msg.from.id && p.isActive);
    if (!userPos.length) return bot.sendMessage(msg.chat.id, "📭 У вас нет активных позиций.");
    let total = 0, invested = 0;
    for (const p of userPos) {
      const md = await getMarketData(p.symbol);
      if (!md) continue;
      invested += p.entryPrice * p.quantity;
      total += calculatePnL(p, md.price);
    }
    const pct = invested > 0 ? (total / invested) * 100 : 0;
    bot.sendMessage(msg.chat.id, `💰 Общий P&L: ${total.toFixed(2)} USD (${pct.toFixed(2)}%)`);
  });

  // --- HELP ---
  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id, `
📋 <b>Помощь</b>

/positions - список позиций  
/balance - общий P&L  
/close N - закрыть позицию  
/subscribe - премиум  

Просто напиши позицию:  
<code>BTC long 45000</code>  
<code>ETH short 3200 deposit 1000</code>  
    `, { parse_mode: "HTML" });
  });
}

// ---------------- EXPRESS ----------------
const appServer = express();
appServer.get("/", (req, res) => res.send("🤖 AI Crypto Tracker Bot is running"));
appServer.get("/health", (req, res) => res.json({ status: "OK", uptime: process.uptime(), users: users.size, positions: positions.size }));
appServer.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
