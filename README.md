# 📈 Paper Trading Bot

A practice crypto trading bot that uses **fake money** and **real, live prices**.
You start with £10,000 of pretend money, pick a strategy, press **Start**, and watch the bot buy and sell coins such as Bitcoin, Ethereum and Solana.

**▶ Open it here: https://cbeamish4.github.io/paper-trading-bot/**

> ⚠️ **This is a simulation.** No real money is used, no accounts are needed, and no real orders are ever placed. Nothing here is financial advice.
> **The bot only runs while the page is open.** If you close the tab or your phone locks the browser, it stops. It carries on from where it left off when you open the page again.

---

## How to use it

1. Open the link above, on a computer or phone. There's nothing to install or sign up for.
2. Check the badge in the top corner. A green **Live** badge means prices are coming in. A red **Feed down** badge means prices aren't arriving, and the bot pauses until they return. It never trades on old prices.
3. In the **Bot** box, choose a **coin** and a **strategy**. A plain-English explanation of the strategy appears underneath.
4. Adjust the sliders if you like (see *Settings* below), then press **▶ Start bot**.
5. Watch the dashboard:
   - **Total portfolio value**: your cash plus the current value of the coins you hold.
   - **Profit / loss**: how much you're up or down since you started, in £ and %.
   - **Price chart**: live price, with ▲ green marks where you bought and ▼ red marks where you sold.
   - **Open positions**: the coins you currently own and how each is doing.
   - **Trade log**: every trade, with the time, coin, buy/sell, price, amount and the reason it happened.

You can also trade yourself with the **Manual trade** box. Type an amount in £ and press **Buy**, **Sell** or **Sell all**.

Every trade pays a pretend **0.1% fee**, like a real exchange, so very frequent trading slowly eats into your money. That's realistic.

## The strategies

### Moving-average crossover (trend following)
The bot compares the average price over a short time (the "fast" average, 9 minutes by default) with the average over a longer time (the "slow" average, 21 minutes).
- When the fast average rises **above** the slow one, the price is trending up, so the bot **buys**.
- When it falls back **below**, the trend has turned, so the bot **sells**.

It works best when prices move in clear trends, and it can lose a little when prices wobble sideways. Both averages are drawn on the chart when this strategy is selected.

### RSI "buy the dip"
RSI is a score from 0 to 100 showing how strongly the price has been rising or falling recently.
- RSI **below 30** means the coin looks *oversold*, so the bot **buys the dip**.
- RSI **above 70** means it looks *overbought*, so the bot **sells**.

It works best when prices bounce around within a range. In a long crash it can buy too early, which is what the stop-loss is for. You can move the 30 and 70 levels with the sliders.

### DCA (buy a fixed amount regularly)
"Dollar-cost averaging." The bot buys the same amount (default £100) every few minutes (default every 5), whatever the price. You buy more coins when the price is cheap and fewer when it's expensive. DCA never sells on its own. It only sells if your stop-loss or take-profit is hit, or if you sell manually.

## Settings

| Setting | What it means |
|---|---|
| **Amount per trade** | How much of your cash the bot spends on each buy (e.g. 10%). Applies to the crossover and RSI strategies. |
| **Stop-loss** | Sells automatically if the price falls this far below what you paid (e.g. 5%). Limits losses. Set it to 0 to turn it off. |
| **Take-profit** | Sells automatically once the price is this far above what you paid (e.g. 10%). Locks in gains. Set it to 0 to turn it off. |
| **Check the market every** | How often the bot looks at prices and decides what to do. |

Stop-loss and take-profit apply to the coin the bot is trading, whichever strategy you use.

## Saving, exporting and starting over

- Everything (your balance, coins, settings and trade history) is **saved automatically in your browser**, so refreshing the page loses nothing. It's saved on that one device and browser only.
- **Export trades to CSV** downloads your trade log as a file you can open in Excel or Google Sheets.
- **Reset everything** (in the *Account* box) wipes your trades and gives you a fresh balance. It asks you to confirm first. You can choose a different starting balance and currency (£, $ or €) there before resetting.

## Where the prices come from

Live prices come free from **Binance**'s public market data, with no account or key needed. If Binance can't be reached, the bot automatically switches to **Coinbase**, then to **CoinGecko**. The page footer shows which source is in use. Prices are in US dollars and converted to pounds using a live exchange rate.

---

## Turning on the website (one-time setup)

The link above only works once GitHub Pages is switched on for this repository:

1. On GitHub, open this repository and click **Settings**.
2. In the left menu, click **Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Under **Branch**, choose **`main`** and **`/ (root)`**, then click **Save**.

After a minute or two, the site is live at **https://cbeamish4.github.io/paper-trading-bot/**.

---

<details>
<summary>For the technically curious</summary>

- Plain HTML, CSS and JavaScript. There's no build step, no server and no libraries. The chart is drawn by hand on a canvas.
- `core.js` holds the strategies and the fake-money maths. `app.js` handles the live prices, the bot loop and the dashboard.
- To run the logic tests (needs Node.js): `node tests/core.test.js`
</details>
