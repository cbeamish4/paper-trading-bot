// Run with: node tests/core.test.js   (no installs needed)
'use strict';
var assert = require('assert');
var C = require('../core.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
function near(a, b, eps) { assert.ok(Math.abs(a - b) < (eps || 1e-9), a + ' != ' + b); }
function settings(extra) {
  return Object.assign({ strategy: 'ma', tradePct: 10, stopLoss: 5, takeProfit: 10, maFast: 3, maSlow: 5,
    rsiPeriod: 14, rsiBuy: 30, rsiSell: 70, dcaAmount: 100, dcaMinutes: 5 }, extra || {});
}

// Sample price data
var flatThenUp = [100, 100, 100, 100, 100, 100, 100, 100, 100, 104];
var upThenDown = [100, 101, 102, 103, 104, 105, 106, 107, 105, 100];
var falling = []; for (var i = 0; i < 30; i++) falling.push(100 - i * 1.5 + (i % 2 ? 0.3 : 0));
var rising = []; for (i = 0; i < 30; i++) rising.push(100 + i * 1.5 - (i % 2 ? 0.3 : 0));

console.log('Indicators');
test('sma averages the last N values', function () {
  near(C.sma([1, 2, 3, 4, 5], 3), 4);
  assert.strictEqual(C.sma([1, 2], 3), null);
});
test('smaSeries matches sma at each point', function () {
  var s = C.smaSeries([1, 2, 3, 4, 5], 3);
  assert.deepStrictEqual(s.slice(0, 2), [null, null]);
  near(s[2], 2); near(s[4], 4);
});
test('rsi is low when falling, high when rising, null without data', function () {
  assert.ok(C.rsi(falling, 14) < 30, 'falling rsi ' + C.rsi(falling, 14));
  assert.ok(C.rsi(rising, 14) > 70, 'rising rsi ' + C.rsi(rising, 14));
  assert.strictEqual(C.rsi([1, 2, 3], 14), null);
  near(C.rsi([5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5], 14), 50);
});
test('rsi matches a known reference value', function () {
  // Classic Wilder example data (Investopedia / StockCharts), RSI(14) on first 15 closes ~ 70.46 (70.53 in the textbook, which rounds intermediate values)
  var d = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  near(C.rsi(d, 14), 70.46, 0.05);
});

console.log('Moving-average crossover');
test('buys on an upward crossover when flat', function () {
  var d = C.decide({ settings: settings(), closes: flatThenUp, price: 104, position: null, cash: 10000, memory: {} });
  assert.strictEqual(d.action, 'buy', d.reason);
  near(d.amount, 1000);
});
test('does not buy again on the same crossover candle', function () {
  var d1 = C.decide({ settings: settings(), closes: flatThenUp, lastCandleTime: 123, price: 104, position: null, cash: 10000, memory: {} });
  var d2 = C.decide({ settings: settings(), closes: flatThenUp, lastCandleTime: 123, price: 104, position: null, cash: 10000, memory: { lastSignalKey: d1.signalKey } });
  assert.strictEqual(d2.action, 'hold');
});
test('sells on a downward crossover when holding', function () {
  var d = C.decide({ settings: settings({ stopLoss: 0, takeProfit: 0 }), closes: upThenDown, price: 100, position: { qty: 1, cost: 101 }, cash: 0, memory: {} });
  assert.strictEqual(d.action, 'sell', d.reason);
});
test('waits while collecting history', function () {
  var d = C.decide({ settings: settings(), closes: [1, 2], price: 2, position: null, cash: 100, memory: {} });
  assert.strictEqual(d.action, 'hold');
  assert.ok(/Collecting/.test(d.reason));
});

console.log('RSI buy the dip');
test('buys when oversold and not holding', function () {
  var d = C.decide({ settings: settings({ strategy: 'rsi' }), closes: falling, price: 57, position: null, cash: 5000, memory: {} });
  assert.strictEqual(d.action, 'buy', d.reason); near(d.amount, 500);
});
test('does not buy more when already holding', function () {
  var d = C.decide({ settings: settings({ strategy: 'rsi', stopLoss: 0 }), closes: falling, price: 57, position: { qty: 1, cost: 57 }, cash: 5000, memory: {} });
  assert.strictEqual(d.action, 'hold');
});
test('sells when overbought and holding', function () {
  var d = C.decide({ settings: settings({ strategy: 'rsi', takeProfit: 0 }), closes: rising, price: 143, position: { qty: 1, cost: 140 }, cash: 0, memory: {} });
  assert.strictEqual(d.action, 'sell', d.reason);
});

console.log('DCA');
test('buys the fixed amount when due, then waits', function () {
  var s = settings({ strategy: 'dca', dcaAmount: 250, dcaMinutes: 5 });
  var d = C.decide({ settings: s, closes: [], price: 50, position: null, cash: 1000, memory: {}, now: 1e9 });
  assert.strictEqual(d.action, 'buy'); assert.strictEqual(d.amount, 250); assert.ok(d.isDca);
  var d2 = C.decide({ settings: s, closes: [], price: 50, position: null, cash: 1000, memory: { lastDcaTime: 1e9 }, now: 1e9 + 2 * 60000 });
  assert.strictEqual(d2.action, 'hold');
  var d3 = C.decide({ settings: s, closes: [], price: 50, position: null, cash: 1000, memory: { lastDcaTime: 1e9 }, now: 1e9 + 5 * 60000 });
  assert.strictEqual(d3.action, 'buy');
});
test('never spends more than the cash left', function () {
  var d = C.decide({ settings: settings({ strategy: 'dca', dcaAmount: 250 }), closes: [], price: 50, position: null, cash: 40, memory: {} });
  assert.strictEqual(d.amount, 40);
});

console.log('Stop-loss / take-profit');
test('stop-loss sells regardless of strategy', function () {
  ['ma', 'rsi', 'dca'].forEach(function (st) {
    var d = C.decide({ settings: settings({ strategy: st, stopLoss: 5 }), closes: rising, price: 94, position: { qty: 1, cost: 100 }, cash: 0, memory: { lastDcaTime: Date.now() } });
    assert.strictEqual(d.action, 'sell', st); assert.ok(/Stop-loss/.test(d.reason));
  });
});
test('take-profit sells at target', function () {
  var d = C.decide({ settings: settings({ strategy: 'dca', takeProfit: 10 }), closes: [], price: 110.5, position: { qty: 1, cost: 100 }, cash: 0, memory: { lastDcaTime: Date.now() } });
  assert.strictEqual(d.action, 'sell'); assert.ok(/Take-profit/.test(d.reason));
});
test('0 switches stop-loss and take-profit off', function () {
  var d = C.decide({ settings: settings({ strategy: 'dca', stopLoss: 0, takeProfit: 0 }), closes: [], price: 10, position: { qty: 1, cost: 100 }, cash: 0, memory: { lastDcaTime: Date.now() } });
  assert.strictEqual(d.action, 'hold');
});
test('holds with no price', function () {
  assert.strictEqual(C.decide({ settings: settings(), closes: rising, price: 0, position: null, cash: 1, memory: {} }).action, 'hold');
});

console.log('Portfolio');
test('buy charges 0.1% fee and tracks cost', function () {
  var p = C.newPortfolio(10000);
  var t = C.buy(p, 'BTC', 50000, 1000, 'test', 1);
  near(p.cash, 9000); near(t.fee, 1); near(t.qty, 999 / 50000); near(p.positions.BTC.cost, 1000);
});
test('sell returns cash minus fee and records P/L', function () {
  var p = C.newPortfolio(10000);
  C.buy(p, 'BTC', 100, 1000);
  var t = C.sell(p, 'BTC', 110);
  near(t.qty, 9.99); near(t.fee, 9.99 * 110 * 0.001);
  near(p.cash, 9000 + 9.99 * 110 * 0.999);
  near(t.pnl, 9.99 * 110 * 0.999 - 1000);
  assert.ok(!p.positions.BTC);
  near(C.valuation(p, {}).total, p.cash);
});
test('partial sell keeps proportional cost', function () {
  var p = C.newPortfolio(1000);
  C.buy(p, 'ETH', 10, 1000, '', 0, 0);
  C.sell(p, 'ETH', 10, 40, '', 0, 0);
  near(p.positions.ETH.qty, 60); near(p.positions.ETH.cost, 600); near(p.cash, 400);
});
test('cannot overspend, sell nothing, or trade tiny amounts', function () {
  var p = C.newPortfolio(100);
  var t = C.buy(p, 'SOL', 10, 500);
  near(t.value, 100); near(p.cash, 0);
  assert.strictEqual(C.buy(p, 'SOL', 10, 50), null);
  assert.strictEqual(C.sell(p, 'BTC', 10), null);
  assert.strictEqual(C.buy(C.newPortfolio(100), 'SOL', 10, 0.5), null);
});
test('valuation and P/L %', function () {
  var p = C.newPortfolio(10000);
  C.buy(p, 'BTC', 100, 5000, '', 0, 0);
  var v = C.valuation(p, { BTC: 120 });
  near(v.total, 11000); near(v.pnl, 1000); near(v.pnlPct, 10);
});
test('CSV export escapes and includes headers', function () {
  var p = C.newPortfolio(1000);
  var trades = [C.buy(p, 'BTC', 100, 100, 'Reason, with "quotes"', Date.UTC(2026, 0, 1))];
  var csv = C.tradesToCSV(trades, 'GBP').split('\n');
  assert.ok(/^Time,Coin,Side,Price \(GBP\)/.test(csv[0]));
  assert.ok(csv[1].indexOf('"Reason, with ""quotes"""') > 0, csv[1]);
  assert.ok(csv[1].indexOf('2026-01-01T00:00:00.000Z,BTC,BUY') === 0);
});

console.log('Full simulated run on sample data');
test('strategies run end-to-end without going negative', function () {
  ['ma', 'rsi', 'dca'].forEach(function (st) {
    var prices = [];
    for (var i = 0; i < 400; i++) prices.push(100 + 15 * Math.sin(i / 20) + 5 * Math.sin(i / 3));
    var p = C.newPortfolio(10000), mem = {}, trades = 0;
    var s = settings({ strategy: st, maFast: 5, maSlow: 20, dcaMinutes: 5, dcaAmount: 200 });
    for (i = 25; i < prices.length; i++) {
      var pos = p.positions.X || null;
      var d = C.decide({ settings: s, closes: prices.slice(0, i), lastCandleTime: i, price: prices[i], position: pos, cash: p.cash, memory: mem, now: i * 60000 });
      if (d.signalKey) mem.lastSignalKey = d.signalKey;
      var t = null;
      if (d.action === 'buy') { t = C.buy(p, 'X', prices[i], d.amount); if (d.isDca) mem.lastDcaTime = i * 60000; }
      if (d.action === 'sell') t = C.sell(p, 'X', prices[i]);
      if (t) trades++;
      assert.ok(p.cash >= -1e-9, 'cash went negative');
    }
    assert.ok(trades > 2, st + ' made only ' + trades + ' trades');
    var v = C.valuation(p, { X: prices[prices.length - 1] });
    console.log('       ' + st + ': ' + trades + ' trades, final value ' + v.total.toFixed(2) + ', fees ' + p.fees.toFixed(2));
  });
});

console.log('\n' + passed + ' tests passed' + (process.exitCode ? ', some FAILED' : ''));
