/*
 * Paper Trading Bot - core logic (indicators, strategies, fake-money portfolio).
 * No browser or network code lives here, so it can be tested with Node:
 *   node tests/core.test.js
 * In the browser it is available as window.PTCore.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PTCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FEE_RATE = 0.001; // 0.1% per trade, similar to a typical crypto exchange
  var MIN_TRADE = 1;    // smallest trade, in account currency

  // ---------- Indicators ----------

  function sma(values, period) {
    if (!values || values.length < period || period <= 0) return null;
    var sum = 0;
    for (var i = values.length - period; i < values.length; i++) sum += values[i];
    return sum / period;
  }

  // Simple moving average series (null until enough data).
  function smaSeries(values, period) {
    var out = [], sum = 0;
    for (var i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      out.push(i >= period - 1 ? sum / period : null);
    }
    return out;
  }

  // Relative Strength Index (Wilder's smoothing). Returns 0-100 or null.
  function rsi(values, period) {
    period = period || 14;
    if (!values || values.length < period + 1) return null;
    var gain = 0, loss = 0, i, d;
    for (i = 1; i <= period; i++) {
      d = values[i] - values[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    var avgGain = gain / period, avgLoss = loss / period;
    for (i = period + 1; i < values.length; i++) {
      d = values[i] - values[i - 1];
      avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    }
    if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
    var rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  // ---------- Strategies ----------

  var STRATEGIES = {
    ma: {
      name: 'Moving-average crossover (trend following)',
      description:
        'Compares the average price over a short window with the average over a longer window. ' +
        'When the short average climbs above the long one, prices are trending up, so the bot buys. ' +
        'When it drops back below, the trend has turned, so the bot sells. ' +
        'Works best in markets that move in clear trends; it can get whipsawed when prices go sideways.'
    },
    rsi: {
      name: 'RSI "buy the dip"',
      description:
        'RSI is a 0-100 score of how strongly the price has been rising or falling recently. ' +
        'When RSI falls below the "buy" level (default 30) the coin looks oversold, so the bot buys the dip. ' +
        'When RSI rises above the "sell" level (default 70) it looks overbought, so the bot sells. ' +
        'Works best when prices bounce around a range; in a strong crash it can buy too early.'
    },
    dca: {
      name: 'DCA (buy a fixed amount regularly)',
      description:
        'Dollar-cost averaging: the bot buys the same fixed amount every few minutes, whatever the price. ' +
        'You end up buying more when it is cheap and less when it is expensive, and you never have to time the market. ' +
        'It only sells if your stop-loss or take-profit is hit (or you sell manually).'
    }
  };

  /*
   * Decide what the bot should do right now.
   *   closes:   closing prices of completed 1-minute candles, oldest first
   *   price:    latest live price
   *   position: {qty, cost} for this coin, or null
   *   cash:     available cash
   *   s:        settings
   *   memory:   {lastDcaTime, lastSignalKey}
   * Returns {action: 'buy'|'sell'|'hold', amount?, reason, signalKey?}
   */
  function decide(opts) {
    var s = opts.settings, price = opts.price, pos = opts.position;
    var mem = opts.memory || {};
    var now = opts.now || Date.now();
    var closes = opts.closes || [];
    var holding = !!(pos && pos.qty > 0);

    if (!(price > 0)) return { action: 'hold', reason: 'No price yet' };

    // 1. Safety exits apply to every strategy.
    if (holding) {
      var avg = pos.cost / pos.qty;
      var change = (price - avg) / avg * 100;
      if (s.stopLoss > 0 && change <= -s.stopLoss)
        return { action: 'sell', reason: 'Stop-loss: price ' + change.toFixed(2) + '% below average buy price' };
      if (s.takeProfit > 0 && change >= s.takeProfit)
        return { action: 'sell', reason: 'Take-profit: price +' + change.toFixed(2) + '% above average buy price' };
    }

    var buyAmount = opts.cash * (s.tradePct / 100);

    if (s.strategy === 'ma') {
      var fast = s.maFast || 9, slow = s.maSlow || 21;
      if (closes.length < slow + 1) return { action: 'hold', reason: 'Collecting price history (' + closes.length + '/' + (slow + 1) + ')' };
      var prev = closes.slice(0, -1);
      var f1 = sma(closes, fast), s1 = sma(closes, slow), f0 = sma(prev, fast), s0 = sma(prev, slow);
      // One trade per crossover candle, even if the bot checks several times per minute.
      var key = 'ma:' + (opts.lastCandleTime || closes.length);
      if (f0 <= s0 && f1 > s1 && !holding && key !== mem.lastSignalKey)
        return { action: 'buy', amount: buyAmount, signalKey: key, reason: 'Fast average (' + fast + ') crossed above slow average (' + slow + ') - uptrend' };
      if (f0 >= s0 && f1 < s1 && holding)
        return { action: 'sell', signalKey: key, reason: 'Fast average (' + fast + ') crossed below slow average (' + slow + ') - downtrend' };
      return { action: 'hold', reason: 'Fast avg ' + (f1 > s1 ? 'above' : 'below') + ' slow avg, no new crossover' };
    }

    if (s.strategy === 'rsi') {
      var period = s.rsiPeriod || 14;
      var r = rsi(closes, period);
      if (r === null) return { action: 'hold', reason: 'Collecting price history (' + closes.length + '/' + (period + 1) + ')' };
      if (r < s.rsiBuy && !holding)
        return { action: 'buy', amount: buyAmount, reason: 'RSI ' + r.toFixed(1) + ' below ' + s.rsiBuy + ' - oversold, buying the dip' };
      if (r > s.rsiSell && holding)
        return { action: 'sell', reason: 'RSI ' + r.toFixed(1) + ' above ' + s.rsiSell + ' - overbought, taking profit' };
      return { action: 'hold', reason: 'RSI ' + r.toFixed(1) + ' (buy below ' + s.rsiBuy + ', sell above ' + s.rsiSell + ')' };
    }

    if (s.strategy === 'dca') {
      var everyMs = (s.dcaMinutes || 5) * 60000;
      if (!mem.lastDcaTime || now - mem.lastDcaTime >= everyMs)
        return { action: 'buy', amount: Math.min(s.dcaAmount, opts.cash), isDca: true, reason: 'DCA: regular buy every ' + s.dcaMinutes + ' min' };
      var mins = Math.ceil((everyMs - (now - mem.lastDcaTime)) / 60000);
      return { action: 'hold', reason: 'Next DCA buy in about ' + mins + ' min' };
    }

    return { action: 'hold', reason: 'Unknown strategy' };
  }

  // ---------- Fake-money portfolio ----------

  function newPortfolio(startBalance) {
    return { cash: startBalance, startBalance: startBalance, positions: {}, realised: 0, fees: 0 };
  }

  // Spend `amount` cash (fee included) on `coin` at `price`. Returns trade or null.
  function buy(p, coin, price, amount, reason, time, feeRate) {
    feeRate = feeRate === undefined ? FEE_RATE : feeRate;
    amount = Math.min(amount, p.cash);
    if (!(price > 0) || !(amount >= MIN_TRADE)) return null;
    var fee = amount * feeRate;
    var qty = (amount - fee) / price;
    p.cash -= amount;
    p.fees += fee;
    var pos = p.positions[coin] || (p.positions[coin] = { qty: 0, cost: 0 });
    pos.qty += qty;
    pos.cost += amount; // cost basis includes the fee
    return { time: time || Date.now(), coin: coin, side: 'BUY', price: price, qty: qty, value: amount, fee: fee, pnl: null, reason: reason || '' };
  }

  // Sell `qty` of `coin` (all of it if qty is omitted). Returns trade or null.
  function sell(p, coin, price, qty, reason, time, feeRate) {
    feeRate = feeRate === undefined ? FEE_RATE : feeRate;
    var pos = p.positions[coin];
    if (!pos || !(pos.qty > 0) || !(price > 0)) return null;
    if (qty === undefined || qty === null || qty >= pos.qty * 0.999999) qty = pos.qty;
    if (!(qty > 0)) return null;
    var gross = qty * price;
    var fee = gross * feeRate;
    var costPart = pos.cost * (qty / pos.qty);
    var pnl = gross - fee - costPart;
    p.cash += gross - fee;
    p.fees += fee;
    p.realised += pnl;
    pos.qty -= qty;
    pos.cost -= costPart;
    if (pos.qty <= 1e-12) delete p.positions[coin];
    return { time: time || Date.now(), coin: coin, side: 'SELL', price: price, qty: qty, value: gross - fee, fee: fee, pnl: pnl, reason: reason || '' };
  }

  // prices: {COIN: price}. Returns {total, invested, cash, pnl, pnlPct}
  function valuation(p, prices) {
    var invested = 0;
    for (var c in p.positions) {
      var pos = p.positions[c];
      var px = prices[c];
      invested += px > 0 ? pos.qty * px : pos.cost; // fall back to cost if price unknown
    }
    var total = p.cash + invested;
    var pnl = total - p.startBalance;
    return { total: total, invested: invested, cash: p.cash, pnl: pnl, pnlPct: p.startBalance ? pnl / p.startBalance * 100 : 0 };
  }

  function csvEscape(v) {
    var s = String(v === null || v === undefined ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function tradesToCSV(trades, currency) {
    var head = ['Time', 'Coin', 'Side', 'Price (' + currency + ')', 'Quantity', 'Value (' + currency + ')', 'Fee (' + currency + ')', 'Profit/Loss (' + currency + ')', 'Reason'];
    var rows = trades.map(function (t) {
      return [new Date(t.time).toISOString(), t.coin, t.side, t.price.toFixed(6), t.qty.toFixed(8), t.value.toFixed(2), t.fee.toFixed(2), t.pnl === null ? '' : t.pnl.toFixed(2), t.reason].map(csvEscape).join(',');
    });
    return [head.join(',')].concat(rows).join('\n');
  }

  return {
    FEE_RATE: FEE_RATE, MIN_TRADE: MIN_TRADE, STRATEGIES: STRATEGIES,
    sma: sma, smaSeries: smaSeries, rsi: rsi, decide: decide,
    newPortfolio: newPortfolio, buy: buy, sell: sell, valuation: valuation, tradesToCSV: tradesToCSV
  };
});
