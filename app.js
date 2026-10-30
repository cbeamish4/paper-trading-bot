/*
 * Paper Trading Bot - browser app: live prices, bot loop, dashboard and chart.
 * Fake money only. No API keys, no accounts, no real orders.
 */
(function () {
  'use strict';
  var C = window.PTCore;

  // ---------- Config ----------

  var COINS = {
    BTC: { name: 'Bitcoin', binance: 'BTCUSDT', coinbase: 'BTC-USD', gecko: 'bitcoin' },
    ETH: { name: 'Ethereum', binance: 'ETHUSDT', coinbase: 'ETH-USD', gecko: 'ethereum' },
    SOL: { name: 'Solana', binance: 'SOLUSDT', coinbase: 'SOL-USD', gecko: 'solana' },
    XRP: { name: 'XRP', binance: 'XRPUSDT', coinbase: 'XRP-USD', gecko: 'ripple' },
    ADA: { name: 'Cardano', binance: 'ADAUSDT', coinbase: 'ADA-USD', gecko: 'cardano' },
    DOGE: { name: 'Dogecoin', binance: 'DOGEUSDT', coinbase: 'DOGE-USD', gecko: 'dogecoin' },
    LTC: { name: 'Litecoin', binance: 'LTCUSDT', coinbase: 'LTC-USD', gecko: 'litecoin' },
    LINK: { name: 'Chainlink', binance: 'LINKUSDT', coinbase: 'LINK-USD', gecko: 'chainlink' }
  };
  var COIN_LIST = Object.keys(COINS);

  var POLL_MS = 5000;            // how often live prices are fetched
  var STALE_MS = 20000;          // prices older than this count as "feed down"
  var CANDLE_REFRESH_MS = 60000; // refresh 1-minute candle history
  var CANDLE_STALE_MS = 180000;  // never trade on candle history older than this
  var RETRY_PRIMARY_MS = 120000; // try Binance again after falling back
  var FX_REFRESH_MS = 15 * 60000;
  var FX_MAX_AGE_MS = 24 * 3600000;
  var FETCH_TIMEOUT_MS = 8000;
  var STORE_KEY = 'paperTradingBot.v1';
  var MAX_TRADES = 5000;
  var CURRENCY_SYMBOL = { GBP: '£', USD: '$', EUR: '€' };

  var DEFAULT_SETTINGS = {
    coin: 'BTC', strategy: 'ma', tradePct: 10, stopLoss: 5, takeProfit: 10, checkSec: 60,
    maFast: 9, maSlow: 21, rsiPeriod: 14, rsiBuy: 30, rsiSell: 70, dcaAmount: 100, dcaMinutes: 5
  };

  // ---------- Saved state ----------

  var state = {
    currency: 'GBP',
    settings: Object.assign({}, DEFAULT_SETTINGS),
    portfolio: C.newPortfolio(10000),
    trades: [],
    botRunning: false,
    memory: { lastDcaTime: 0, lastSignalKey: null },
    theme: 'auto',
    fx: null // {currency, rate, time}
  };

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* storage blocked or full */ }
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return;
      if (CURRENCY_SYMBOL[s.currency]) state.currency = s.currency;
      state.settings = Object.assign({}, DEFAULT_SETTINGS, s.settings || {});
      if (!COINS[state.settings.coin]) state.settings.coin = 'BTC';
      if (!C.STRATEGIES[state.settings.strategy]) state.settings.strategy = 'ma';
      if (s.portfolio && typeof s.portfolio.cash === 'number') state.portfolio = Object.assign(C.newPortfolio(10000), s.portfolio);
      if (Array.isArray(s.trades)) state.trades = s.trades;
      state.botRunning = !!s.botRunning;
      state.memory = Object.assign({ lastDcaTime: 0, lastSignalKey: null }, s.memory || {});
      if (s.theme) state.theme = s.theme;
      if (s.fx && s.fx.rate > 0) state.fx = s.fx;
    } catch (e) { /* corrupted or blocked storage: start fresh */ }
  }

  // ---------- Live market data ----------

  function fetchJSON(url) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, FETCH_TIMEOUT_MS);
    return fetch(url, { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .finally(function () { clearTimeout(timer); });
  }

  function num(x) {
    var n = parseFloat(x);
    if (!isFinite(n) || n <= 0) throw new Error('Bad price');
    return n;
  }

  function binanceSource(name, base) {
    return {
      name: name,
      prices: function (coins) {
        var syms = coins.map(function (c) { return COINS[c].binance; });
        return fetchJSON(base + '/api/v3/ticker/price?symbols=' + encodeURIComponent(JSON.stringify(syms))).then(function (rows) {
          var out = {};
          rows.forEach(function (r) {
            coins.forEach(function (c) { if (COINS[c].binance === r.symbol) out[c] = num(r.price); });
          });
          return out;
        });
      },
      candles: function (coin) {
        return fetchJSON(base + '/api/v3/klines?symbol=' + COINS[coin].binance + '&interval=1m&limit=240').then(function (rows) {
          return rows.map(function (k) { return { t: k[0], c: num(k[4]) }; });
        });
      }
    };
  }

  var SOURCES = [
    binanceSource('Binance', 'https://data-api.binance.vision'),
    binanceSource('Binance', 'https://api.binance.com'),
    {
      name: 'Coinbase',
      prices: function (coins) {
        return Promise.all(coins.map(function (c) {
          return fetchJSON('https://api.exchange.coinbase.com/products/' + COINS[c].coinbase + '/ticker').then(function (r) { return num(r.price); });
        })).then(function (vals) {
          var out = {};
          coins.forEach(function (c, i) { out[c] = vals[i]; });
          return out;
        });
      },
      candles: function (coin) {
        return fetchJSON('https://api.exchange.coinbase.com/products/' + COINS[coin].coinbase + '/candles?granularity=60').then(function (rows) {
          // [time(sec), low, high, open, close, volume], newest first
          return rows.map(function (k) { return { t: k[0] * 1000, c: num(k[4]) }; })
            .sort(function (a, b) { return a.t - b.t; }).slice(-240);
        });
      }
    },
    {
      name: 'CoinGecko',
      prices: function (coins) {
        var ids = coins.map(function (c) { return COINS[c].gecko; }).join(',');
        return fetchJSON('https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&ids=' + ids).then(function (r) {
          var out = {};
          coins.forEach(function (c) { if (r[COINS[c].gecko]) out[c] = num(r[COINS[c].gecko].usd); });
          return out;
        });
      },
      candles: function (coin) {
        // Free CoinGecko only offers ~5-minute points; good enough as a fallback.
        return fetchJSON('https://api.coingecko.com/api/v3/coins/' + COINS[coin].gecko + '/market_chart?vs_currency=usd&days=1').then(function (r) {
          return r.prices.map(function (p) { return { t: p[0], c: num(p[1]) }; }).slice(-240);
        });
      }
    }
  ];

  // USD -> account currency exchange rate (crypto prices come in US dollars).
  var FX_SOURCES = [
    function (cur) { return fetchJSON('https://api.coinbase.com/v2/exchange-rates?currency=USD').then(function (r) { return num(r.data.rates[cur]); }); },
    function (cur) { return fetchJSON('https://api.frankfurter.dev/v1/latest?base=USD&symbols=' + cur).then(function (r) { return num(r.rates[cur]); }); },
    function (cur) { return fetchJSON('https://open.er-api.com/v6/latest/USD').then(function (r) { return num(r.rates[cur]); }); }
  ];

  var feed = {
    sourceIdx: 0,
    pricesUsd: {},
    lastOk: 0,
    lastAttemptFailed: false,
    error: '',
    candles: [],           // [{t, c}] in USD for the selected coin; the last one is still forming
    candleCoin: null,
    candleSourceIdx: -1,
    candleTime: 0,
    fxError: ''
  };

  function fxRate() {
    if (state.currency === 'USD') return 1;
    return state.fx && state.fx.currency === state.currency ? state.fx.rate : 0;
  }
  function fxOk() {
    if (state.currency === 'USD') return true;
    return fxRate() > 0 && Date.now() - state.fx.time < FX_MAX_AGE_MS;
  }

  function refreshFx() {
    if (state.currency === 'USD') return Promise.resolve();
    var cur = state.currency, i = 0;
    function attempt() {
      if (i >= FX_SOURCES.length) {
        feed.fxError = 'Could not fetch the USD→' + cur + ' exchange rate';
        return;
      }
      return FX_SOURCES[i++](cur).then(function (rate) {
        state.fx = { currency: cur, rate: rate, time: Date.now() };
        feed.fxError = '';
        save();
      }, attempt);
    }
    return Promise.resolve(attempt());
  }

  // Try sources in the given order until one works.
  function tryPrices(order) {
    var k = 0, errors = [];
    function attempt() {
      if (k >= order.length) return Promise.reject(new Error(errors.join('; ')));
      var idx = order[k++];
      return SOURCES[idx].prices(COIN_LIST).then(function (p) {
        if (!p[state.settings.coin]) throw new Error('missing ' + state.settings.coin);
        return { idx: idx, prices: p };
      }).catch(function (e) {
        errors.push(SOURCES[idx].name + ': ' + ((e && e.message) || e));
        return attempt();
      });
    }
    return attempt();
  }

  var lastPrimaryTry = 0;
  var polling = false;

  function sourceOrder() {
    var order = [];
    for (var i = 0; i < SOURCES.length; i++) order.push((feed.sourceIdx + i) % SOURCES.length);
    // On a fallback source, try Binance first again every couple of minutes.
    if (feed.sourceIdx !== 0 && Date.now() - lastPrimaryTry > RETRY_PRIMARY_MS) {
      lastPrimaryTry = Date.now();
      order.splice(order.indexOf(0), 1);
      order.unshift(0);
    }
    return order;
  }

  function poll() {
    if (polling) return;
    polling = true;
    tryPrices(sourceOrder()).then(function (res) {
      feed.sourceIdx = res.idx;
      feed.pricesUsd = res.prices;
      feed.lastOk = Date.now();
      feed.lastAttemptFailed = false;
      feed.error = '';
      return maybeRefreshCandles();
    }).catch(function (e) {
      feed.lastAttemptFailed = true;
      feed.error = (e && e.message) || 'unknown error';
    }).then(function () {
      polling = false;
      renderAll();
    });
  }

  function maybeRefreshCandles(force) {
    var coin = state.settings.coin;
    var need = force || feed.candleCoin !== coin || feed.candleSourceIdx !== feed.sourceIdx ||
      Date.now() - feed.candleTime > CANDLE_REFRESH_MS;
    if (!need) { updateFormingCandle(); return Promise.resolve(); }
    var idx = feed.sourceIdx;
    return SOURCES[idx].candles(coin).then(function (c) {
      if (coin !== state.settings.coin) return; // coin changed meanwhile
      feed.candles = c;
      feed.candleCoin = coin;
      feed.candleSourceIdx = idx;
      feed.candleTime = Date.now();
      updateFormingCandle();
    }).catch(function () { /* keep old candles; they'll be treated as stale if too old */ });
  }

  // Keep the newest (still forming) candle in line with the live price.
  function updateFormingCandle() {
    var c = feed.candles, px = feed.pricesUsd[state.settings.coin];
    if (!c.length || !px || feed.candleCoin !== state.settings.coin) return;
    var step = SOURCES[feed.candleSourceIdx].name === 'CoinGecko' ? 300000 : 60000;
    var bucket = Math.floor(Date.now() / step) * step;
    if (bucket > c[c.length - 1].t) c.push({ t: bucket, c: px });
    else c[c.length - 1].c = px;
    if (c.length > 300) c.splice(0, c.length - 300);
  }

  function isLive() {
    return feed.lastOk > 0 && Date.now() - feed.lastOk < STALE_MS && fxOk();
  }

  function localPrice(coin) {
    var usd = feed.pricesUsd[coin];
    var fx = fxRate();
    return usd && fx ? usd * fx : 0;
  }

  function localPrices() {
    var out = {};
    COIN_LIST.forEach(function (c) { var p = localPrice(c); if (p) out[c] = p; });
    return out;
  }

  function candlesReady() {
    return feed.candleCoin === state.settings.coin && feed.candles.length > 0 &&
      Date.now() - feed.candleTime < CANDLE_STALE_MS;
  }

  // ---------- Trading ----------

  function record(trade) {
    if (!trade) return;
    state.trades.push(trade);
    if (state.trades.length > MAX_TRADES) state.trades.splice(0, state.trades.length - MAX_TRADES);
    save();
    renderAll();
  }

  var lastCheck = 0;

  function botCheck() {
    var s = state.settings;
    lastCheck = Date.now();
    if (!isLive()) { setBotMsg('Waiting: price feed is down, so the bot will not trade on old prices.'); return; }
    if (!candlesReady()) { setBotMsg('Waiting: loading price history…'); maybeRefreshCandles(true); return; }
    var fx = fxRate();
    var closed = feed.candles.slice(0, -1); // only completed candles
    var closes = closed.map(function (k) { return k.c * fx; });
    var decision = C.decide({
      settings: s,
      closes: closes,
      lastCandleTime: closed.length ? closed[closed.length - 1].t : 0,
      price: localPrice(s.coin),
      position: state.portfolio.positions[s.coin] || null,
      cash: state.portfolio.cash,
      memory: state.memory,
      now: Date.now()
    });
    var time = new Date().toLocaleTimeString('en-GB');
    if (decision.signalKey) state.memory.lastSignalKey = decision.signalKey;
    if (decision.action === 'buy') {
      if (decision.amount < C.MIN_TRADE) {
        setBotMsg(time + ' — wanted to buy but there is not enough cash.');
        if (decision.isDca) state.memory.lastDcaTime = Date.now();
        save();
        return;
      }
      var t = C.buy(state.portfolio, s.coin, localPrice(s.coin), decision.amount, 'Bot: ' + decision.reason);
      if (decision.isDca) state.memory.lastDcaTime = Date.now();
      setBotMsg(time + ' — BOUGHT ' + s.coin + '. ' + decision.reason);
      record(t);
    } else if (decision.action === 'sell') {
      var t2 = C.sell(state.portfolio, s.coin, localPrice(s.coin), null, 'Bot: ' + decision.reason);
      setBotMsg(time + ' — SOLD ' + s.coin + '. ' + decision.reason);
      record(t2);
    } else {
      setBotMsg(time + ' — no trade. ' + decision.reason);
      save();
    }
  }

  function startBot() {
    state.botRunning = true;
    lastCheck = 0;
    save();
    setBotMsg('Started. First check as soon as live prices are in…');
    renderAll();
  }
  function stopBot() {
    state.botRunning = false;
    save();
    setBotMsg('Stopped. Your positions are kept.');
    renderAll();
  }

  function manual(side) {
    var coin = state.settings.coin;
    if (!isLive()) { setManualMsg('The price feed is down — trading is paused until live prices return.'); return; }
    var price = localPrice(coin);
    var amount = parseFloat($('manualAmount').value);
    var t;
    if (side === 'sellAll') {
      t = C.sell(state.portfolio, coin, price, null, 'Manual sell (all)');
      if (!t) { setManualMsg('You don\'t own any ' + coin + '.'); return; }
    } else if (!(amount >= C.MIN_TRADE)) {
      setManualMsg('Enter an amount of at least ' + money(C.MIN_TRADE) + '.'); return;
    } else if (side === 'buy') {
      if (amount > state.portfolio.cash + 1e-9) { setManualMsg('Not enough cash. You have ' + money(state.portfolio.cash) + '.'); return; }
      t = C.buy(state.portfolio, coin, price, amount, 'Manual buy');
    } else {
      var pos = state.portfolio.positions[coin];
      if (!pos) { setManualMsg('You don\'t own any ' + coin + '.'); return; }
      t = C.sell(state.portfolio, coin, price, Math.min(pos.qty, amount / price), 'Manual sell');
    }
    if (t) {
      setManualMsg((t.side === 'BUY' ? 'Bought ' : 'Sold ') + fmtQty(t.qty) + ' ' + coin + ' at ' + money(price, { price: true }) + '.');
      record(t);
    }
  }

  function resetAll() {
    var bal = parseFloat($('startBal').value);
    var cur = $('currencySel').value;
    if (!(bal >= 100)) { alert('Please enter a starting balance of at least 100.'); return; }
    var sym = CURRENCY_SYMBOL[cur] || '';
    if (!confirm('Reset everything?\n\nThis deletes all your fake trades and positions and starts again with ' +
      sym + bal.toLocaleString('en-GB') + ' of fake ' + cur + '. This cannot be undone.')) return;
    state.currency = cur;
    state.portfolio = C.newPortfolio(bal);
    state.trades = [];
    state.botRunning = false;
    state.memory = { lastDcaTime: 0, lastSignalKey: null };
    save();
    refreshFx().then(renderAll);
    setBotMsg('Reset done. Press Start when you\'re ready.');
    setManualMsg('');
    renderAll();
  }

  function exportCsv() {
    if (!state.trades.length) { alert('There are no trades to export yet.'); return; }
    var csv = C.tradesToCSV(state.trades, state.currency);
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'paper-trades-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ---------- Formatting ----------

  function $(id) { return document.getElementById(id); }
  function money(v, opts) {
    opts = opts || {};
    var abs = Math.abs(v);
    var digits = opts.price && abs !== 0 && abs < 1 ? 4 : 2;
    try {
      var s = new Intl.NumberFormat('en-GB', { style: 'currency', currency: state.currency, minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: opts.sign ? 'exceptZero' : 'auto' }).format(v);
      return s;
    } catch (e) {
      return (opts.sign && v > 0 ? '+' : '') + (CURRENCY_SYMBOL[state.currency] || '') + v.toFixed(digits);
    }
  }
  function fmtQty(q) {
    if (q >= 1000) return q.toLocaleString('en-GB', { maximumFractionDigits: 2 });
    if (q >= 1) return q.toLocaleString('en-GB', { maximumFractionDigits: 4 });
    return q.toLocaleString('en-GB', { maximumSignificantDigits: 5 });
  }
  function pct(v) { if (Math.abs(v) < 0.005) v = 0; return (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }
  function cls(v) { return v > 0.0001 ? 'up' : v < -0.0001 ? 'down' : ''; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  function setBotMsg(m) { $('botMsg').textContent = m; }
  function setManualMsg(m) { $('manualMsg').textContent = m; }

  // ---------- Rendering ----------

  function renderStatus() {
    var el = $('feedStatus');
    var src = SOURCES[feed.sourceIdx].name;
    if (isLive()) {
      var ago = Math.round((Date.now() - feed.lastOk) / 1000);
      el.className = 'pill pill-live';
      el.textContent = 'Live · ' + src + ' · ' + ago + 's ago';
      el.title = 'Prices are live. Bot trading is allowed.';
    } else if (!feed.lastOk && !feed.lastAttemptFailed && !feed.error) {
      el.className = 'pill pill-wait';
      el.textContent = 'Connecting…';
    } else {
      el.className = 'pill pill-down';
      el.textContent = !fxOk() && feed.lastOk ? 'Feed down · no exchange rate' : 'Feed down · trading paused';
      el.title = (feed.error || feed.fxError || 'No recent prices') + '. Retrying automatically.';
    }
    $('sourceText').textContent = feed.lastOk
      ? SOURCES[feed.sourceIdx].name + ' (US dollar prices' + (state.currency !== 'USD' && fxRate() ? ', converted at 1 USD = ' + fxRate().toFixed(4) + ' ' + state.currency : '') + ')'
      : 'not connected yet';
  }

  function renderStats() {
    var prices = localPrices();
    var v = C.valuation(state.portfolio, prices);
    $('statTotal').textContent = money(v.total);
    $('statCash').textContent = money(v.cash);
    var pe = $('statPnl');
    pe.textContent = money(v.pnl, { sign: true });
    pe.className = 'stat-value ' + cls(v.pnl);
    $('statPnlPct').textContent = pct(v.pnlPct) + ' since start (' + money(state.portfolio.startBalance) + ')';
    var b = $('statBot');
    if (state.botRunning) {
      b.textContent = isLive() ? 'Running' : 'Paused';
      b.className = 'stat-value ' + (isLive() ? 'up' : 'down');
      $('statBotSub').textContent = C.STRATEGIES[state.settings.strategy].name.split(' (')[0] + ' on ' + state.settings.coin;
    } else {
      b.textContent = 'Stopped';
      b.className = 'stat-value';
      $('statBotSub').textContent = 'Press Start to begin';
    }
    var sb = $('startBtn');
    sb.textContent = state.botRunning ? '■ Stop bot' : '▶ Start bot';
    sb.className = 'btn btn-big ' + (state.botRunning ? 'btn-stop' : 'btn-primary');
    var live = isLive();
    ['buyBtn', 'sellBtn', 'sellAllBtn'].forEach(function (id) { $(id).disabled = !live; });
    var coin = state.settings.coin;
    $('livePrice').textContent = prices[coin] ? money(prices[coin], { price: true }) : '–';
    $('chartTitle').textContent = COINS[coin].name + ' (' + coin + ')';
    Array.prototype.forEach.call(document.querySelectorAll('.coinName'), function (e) { e.textContent = coin; });
    Array.prototype.forEach.call(document.querySelectorAll('.cur'), function (e) { e.textContent = CURRENCY_SYMBOL[state.currency]; });
  }

  function renderPositions() {
    var prices = localPrices();
    var rows = Object.keys(state.portfolio.positions).map(function (c) {
      var p = state.portfolio.positions[c];
      var px = prices[c];
      var value = px ? p.qty * px : null;
      var pnl = value === null ? null : value - p.cost;
      return '<tr><td><b>' + esc(c) + '</b></td>' +
        '<td class="num">' + fmtQty(p.qty) + '</td>' +
        '<td class="num">' + money(p.cost / p.qty, { price: true }) + '</td>' +
        '<td class="num">' + (px ? money(px, { price: true }) : '–') + '</td>' +
        '<td class="num">' + (value === null ? '–' : money(value)) + '</td>' +
        '<td class="num ' + (pnl === null ? '' : cls(pnl)) + '">' + (pnl === null ? '–' : money(pnl, { sign: true }) + ' (' + pct(pnl / p.cost * 100) + ')') + '</td></tr>';
    });
    $('positionsBody').innerHTML = rows.join('');
    $('positionsEmpty').hidden = rows.length > 0;
  }

  var renderedTradeCount = -1;
  function renderTrades() {
    if (renderedTradeCount === state.trades.length && renderedCurrency === state.currency) return;
    renderedTradeCount = state.trades.length;
    renderedCurrency = state.currency;
    var list = state.trades.slice(-200).reverse();
    $('tradesBody').innerHTML = list.map(function (t) {
      var d = new Date(t.time);
      return '<tr><td>' + d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB') + '</td>' +
        '<td>' + esc(t.coin) + '</td>' +
        '<td class="side-' + (t.side === 'BUY' ? 'buy' : 'sell') + '">' + t.side + '</td>' +
        '<td class="num">' + money(t.price, { price: true }) + '</td>' +
        '<td class="num">' + fmtQty(t.qty) + ' ' + esc(t.coin) + '<br><span class="muted">' + money(t.value) + '</span></td>' +
        '<td class="num ' + (t.pnl === null ? '' : cls(t.pnl)) + '">' + (t.pnl === null ? '' : money(t.pnl, { sign: true })) + '</td>' +
        '<td class="reason">' + esc(t.reason) + '</td></tr>';
    }).join('');
    $('tradesEmpty').hidden = list.length > 0;
  }
  var renderedCurrency = null;

  function renderAll() {
    renderStatus();
    renderStats();
    renderPositions();
    renderTrades();
    drawChart();
  }

  // ---------- Chart (plain canvas, no libraries) ----------

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function drawChart() {
    var canvas = $('chart');
    var box = canvas.parentNode;
    var dpr = window.devicePixelRatio || 1;
    var W = box.clientWidth, H = box.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var colText = cssVar('--muted'), colGrid = cssVar('--chart-grid');
    ctx.font = '11px system-ui, sans-serif';

    var fx = fxRate();
    var coin = state.settings.coin;
    if (feed.candleCoin !== coin || !feed.candles.length || !fx) {
      ctx.fillStyle = colText;
      ctx.textAlign = 'center';
      ctx.fillText(isLive() || !feed.lastAttemptFailed ? 'Loading price history…' : 'Price feed is down — retrying…', W / 2, H / 2);
      return;
    }
    var all = feed.candles.map(function (k) { return { t: k.t, c: k.c * fx }; });
    var showMa = state.settings.strategy === 'ma';
    var fastS = showMa ? C.smaSeries(all.map(function (k) { return k.c; }), state.settings.maFast) : null;
    var slowS = showMa ? C.smaSeries(all.map(function (k) { return k.c; }), state.settings.maSlow) : null;
    var n = Math.min(all.length, 120);
    var off = all.length - n;
    var pts = all.slice(off);
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    var trades = state.trades.filter(function (t) { return t.coin === coin && t.time >= t0 - 60000; });

    var lo = Infinity, hi = -Infinity;
    function ext(v) { if (v !== null && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
    pts.forEach(function (k, i) { ext(k.c); if (showMa) { ext(fastS[off + i]); ext(slowS[off + i]); } });
    trades.forEach(function (t) { ext(t.price); });
    if (hi === lo) { hi += hi * 0.001 || 1; lo -= lo * 0.001 || 1; }
    var pad = (hi - lo) * 0.08; hi += pad; lo -= pad;

    var padL = 8, padR = 72, padT = 10, padB = 22;
    var cw = W - padL - padR, ch = H - padT - padB;
    function X(t) { return padL + (t1 === t0 ? cw : (t - t0) / (t1 - t0) * cw); }
    function Y(v) { return padT + (hi - v) / (hi - lo) * ch; }

    // grid + price labels
    ctx.strokeStyle = colGrid; ctx.fillStyle = colText; ctx.lineWidth = 1; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (var g = 0; g <= 4; g++) {
      var v = lo + (hi - lo) * g / 4, y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke();
      ctx.fillText(money(v, { price: true }), padL + cw + 6, y);
    }
    // time labels
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (var tl = 0; tl <= 4; tl++) {
      var tt = t0 + (t1 - t0) * tl / 4;
      var lbl = new Date(tt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(lbl, Math.min(Math.max(X(tt), padL + 16), padL + cw - 16), padT + ch + 6);
    }

    // area + price line
    var line = cssVar('--chart-line');
    ctx.beginPath();
    pts.forEach(function (k, i) { var x = X(k.t), y = Y(k.c); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.lineTo(X(t1), padT + ch); ctx.lineTo(X(t0), padT + ch); ctx.closePath();
    ctx.fillStyle = cssVar('--chart-fill'); ctx.fill();
    ctx.beginPath();
    pts.forEach(function (k, i) { var x = X(k.t), y = Y(k.c); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.strokeStyle = line; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();

    function series(arr, color) {
      ctx.beginPath(); var started = false;
      pts.forEach(function (k, i) {
        var v = arr[off + i]; if (v === null) return;
        if (started) ctx.lineTo(X(k.t), Y(v)); else { ctx.moveTo(X(k.t), Y(v)); started = true; }
      });
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
    }
    if (showMa) { series(fastS, cssVar('--chart-fast')); series(slowS, cssVar('--chart-slow')); }
    $('legendMa').hidden = !showMa;

    // last price tag
    var last = pts[pts.length - 1];
    var ly = Y(last.c);
    ctx.fillStyle = line;
    ctx.beginPath(); ctx.arc(X(last.t), ly, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillRect(padL + cw + 2, ly - 9, padR - 4, 18);
    ctx.fillStyle = cssVar('--card'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(money(last.c, { price: true }), padL + cw + 6, ly);

    // buy / sell markers
    var up = cssVar('--up'), down = cssVar('--down');
    trades.forEach(function (t) {
      var x = X(Math.min(Math.max(t.time, t0), t1)), y = Y(t.price);
      var isBuy = t.side === 'BUY';
      ctx.fillStyle = isBuy ? up : down;
      ctx.beginPath();
      if (isBuy) { ctx.moveTo(x, y + 4); ctx.lineTo(x - 6, y + 14); ctx.lineTo(x + 6, y + 14); }
      else { ctx.moveTo(x, y - 4); ctx.lineTo(x - 6, y - 14); ctx.lineTo(x + 6, y - 14); }
      ctx.closePath(); ctx.fill();
    });
  }

  // ---------- Settings UI ----------

  function bindRange(id, key, fmt, after) {
    var el = $(id), out = $(id + 'Val');
    el.value = state.settings[key];
    function show() { if (out) out.textContent = fmt ? fmt(state.settings[key]) : state.settings[key]; }
    show();
    el.addEventListener('input', function () {
      state.settings[key] = parseFloat(el.value);
      if (after) after();
      show(); save(); renderAll();
    });
    return { el: el, show: show };
  }

  function offOr(suffix) { return function (v) { return v > 0 ? v + suffix : 'off'; }; }

  function updateStrategyUi() {
    var s = state.settings.strategy;
    $('stratDesc').textContent = C.STRATEGIES[s].description;
    Array.prototype.forEach.call(document.querySelectorAll('.strat-opts'), function (el) {
      el.hidden = el.getAttribute('data-strat').split(' ').indexOf(s) < 0;
    });
  }

  function applyTheme() {
    var r = document.documentElement;
    if (state.theme === 'auto') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', state.theme);
    $('themeBtn').textContent = 'Theme: ' + state.theme.charAt(0).toUpperCase() + state.theme.slice(1);
    drawChart();
  }

  function setupUi() {
    var coinSel = $('coinSel');
    COIN_LIST.forEach(function (c) {
      var o = document.createElement('option'); o.value = c; o.textContent = COINS[c].name + ' (' + c + ')'; coinSel.appendChild(o);
    });
    coinSel.value = state.settings.coin;
    coinSel.addEventListener('change', function () {
      state.settings.coin = coinSel.value;
      state.memory.lastSignalKey = null;
      feed.candles = []; feed.candleCoin = null;
      save(); renderAll();
      maybeRefreshCandles(true).then(renderAll);
    });

    var stratSel = $('stratSel');
    Object.keys(C.STRATEGIES).forEach(function (k) {
      var o = document.createElement('option'); o.value = k; o.textContent = C.STRATEGIES[k].name; stratSel.appendChild(o);
    });
    stratSel.value = state.settings.strategy;
    stratSel.addEventListener('change', function () {
      state.settings.strategy = stratSel.value;
      state.memory.lastSignalKey = null;
      updateStrategyUi(); save(); renderAll();
    });
    updateStrategyUi();

    var fast, slow;
    fast = bindRange('maFast', 'maFast', null, function () {
      if (state.settings.maSlow <= state.settings.maFast) { state.settings.maSlow = state.settings.maFast + 1; slow.el.value = state.settings.maSlow; slow.show(); }
    });
    slow = bindRange('maSlow', 'maSlow', null, function () {
      if (state.settings.maSlow <= state.settings.maFast) { state.settings.maFast = Math.max(3, state.settings.maSlow - 1); fast.el.value = state.settings.maFast; fast.show(); }
    });
    bindRange('rsiBuy', 'rsiBuy');
    bindRange('rsiSell', 'rsiSell');
    bindRange('dcaMinutes', 'dcaMinutes');
    bindRange('tradePct', 'tradePct');
    bindRange('stopLoss', 'stopLoss', offOr('% loss'));
    bindRange('takeProfit', 'takeProfit', offOr('% gain'));

    var dca = $('dcaAmount');
    dca.value = state.settings.dcaAmount;
    dca.addEventListener('input', function () {
      var v = parseFloat(dca.value);
      if (v > 0) { state.settings.dcaAmount = v; save(); }
    });

    var chk = $('checkSec');
    chk.value = String(state.settings.checkSec);
    chk.addEventListener('change', function () { state.settings.checkSec = parseInt(chk.value, 10); save(); });

    $('startBtn').addEventListener('click', function () { if (state.botRunning) stopBot(); else startBot(); });
    $('buyBtn').addEventListener('click', function () { manual('buy'); });
    $('sellBtn').addEventListener('click', function () { manual('sell'); });
    $('sellAllBtn').addEventListener('click', function () { manual('sellAll'); });
    $('exportBtn').addEventListener('click', exportCsv);
    $('resetBtn').addEventListener('click', resetAll);
    $('startBal').value = state.portfolio.startBalance;
    $('currencySel').value = state.currency;
    $('feeText').textContent = (C.FEE_RATE * 100).toFixed(1) + '%';

    $('themeBtn').addEventListener('click', function () {
      state.theme = state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto';
      save(); applyTheme();
    });
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', drawChart);
    }
    var rt;
    window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(drawChart, 100); });
  }

  // ---------- Start ----------

  load();
  setupUi();
  applyTheme();
  if (state.botRunning) setBotMsg('Bot resumed from your last visit.');
  renderAll();

  refreshFx().then(renderAll);
  poll();
  setInterval(poll, POLL_MS);
  setInterval(function () { if (!fxOk() || Date.now() - (state.fx ? state.fx.time : 0) > FX_REFRESH_MS) refreshFx(); }, 60000);
  setInterval(function () {
    renderStatus();
    renderStats();
    if (state.botRunning && Date.now() - lastCheck >= state.settings.checkSec * 1000) botCheck();
  }, 1000);

  // Expose for testing / curious users in the browser console.
  window.PTApp = { state: state, feed: feed, sources: SOURCES };
})();
