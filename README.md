# Brok.ai

<img width="110" height="96" alt="image" src="https://github.com/user-attachments/assets/e65828a9-de16-4aec-9f86-16d8a5ee6426" />


Brok.ai is a local-first paper trading terminal for simulated orders, positions, risk, news, and portfolio P&L. Financial records stay in the local D1/SQLite database, and the current MVP does not send real broker orders.

Primary creator: **Gustavo S. M.** (`gustavosmede`).

For architecture, financial rules, integrations, APIs, limitations, and AI-agent guidance, read the [Brok.ai Technical Memo](./BROKAI_TECHNICAL_MEMO.md).

## Disclaimer

Brok.ai is not a broker, investment adviser, exchange, or custodian. It is a local-first interface for simulation, audit, and order preparation. Any future live-broker integration must preserve preview, explicit confirmation, and auditable logs.

## Run Locally

Requires Node.js `>=22.13.0`.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). While this session is running, the dashboard refreshes quotes and records snapshots.

## Market News And Economic Calendar

The **5 NEWS** menu combines complementary sources with a local cache:

- FinancialJuice free stream as the primary delayed feed for market, geopolitics, and calendar updates;
- GDELT for broader global and geopolitical coverage;
- official feeds from the Federal Reserve, ECB, BLS, EIA, and recent SEC EDGAR filings;
- Yahoo Finance as an automatic fallback for each ticker currently held in the portfolio;
- the public Nasdaq snapshot as a free economic-calendar fallback, refreshed at most every 6 hours;
- local D1/SQLite persistence, preserving previously received data when the internet is unavailable.

A deterministic classifier marks news as `HIGH`, `MEDIUM`, or `LOW`. Only objectively high-impact signals, such as rate decisions, inflation or labor data, conflict, sanctions, bankruptcy, trading halts, or guidance for an open position, receive the red high-impact treatment and can be isolated through the **HIGH IMPACT** filter.

To enable FinancialJuice, generate a free key and configure it once:

```bash
cp .env.example .env.local
```

Edit `.env.local`, replace `your_financialjuice_api_key_here` with your own key, and restart Brok.ai. The key stays in the local process and is never sent to the browser. In manual mode (`npm run dev`), open another terminal to keep the stream collector active:

```bash
npm run news:collect
```

The daily service installed by `npm run collector:install` starts this collector automatically. Without a key, or during a stream outage, the rest of Brok.ai keeps working; GDELT, official feeds, and Yahoo remain available.

## Run Daily In The Background On macOS

```bash
npm run collector:install
```

This command builds the app and installs a `LaunchAgent` for the current macOS user. After that:

- Brok.ai starts automatically when you log into macOS;
- the collector checks positions every 5 minutes even when the browser is closed;
- the FinancialJuice stream stays connected when a key is configured;
- the dashboard remains available at `http://localhost:3000`;
- logs are written under `.paperdesk/logs/`.

To remove the service without deleting the portfolio:

```bash
npm run collector:uninstall
```

## Local Voice Dictation For New Orders

Install the local Whisper service once. The multilingual `small` model is roughly 500 MB:

```bash
npm run voice:install
```

The installer builds `whisper.cpp` for Apple Silicon and creates a `LaunchAgent`, so the voice service starts again when you log into macOS. In the **New Order** ticket, press the microphone, speak for up to 30 seconds, and press it again to transcribe.

- audio is sent only to Whisper at `127.0.0.1` and is not stored;
- the transcription fills the command field as editable text;
- the flow continues through Ollama, Binance/Yahoo, preview, and mandatory manual confirmation;
- the browser asks for microphone permission the first time.

To stop the service without deleting the downloaded model:

```bash
npm run voice:uninstall
```

## Mac Offline, Asleep, Or Without Internet

Brok.ai does not invent prices during missing periods. When it comes back online, it:

1. detects gaps longer than 15 minutes;
2. downloads historical bars from Binance Spot for cryptocurrencies and Yahoo Finance for other assets, with automatic Yahoo fallback;
3. reconstructs cash, positions, and P&L using only the latest price known at each timestamp, without looking ahead;
4. records reconstructed points as `MARKET_BACKFILL` and keeps gaps visible when an asset lacks enough coverage.

The chart breaks the line across unreconstructed gaps instead of drawing a misleading diagonal. Brok.ai retries automatically every minute through the interface and every 5 minutes through the collector.

## Binance + Yahoo Finance

Cryptocurrencies with a USDT spot pair, such as `BTC-USD` and `ETH-USD`, use Binance public market-data APIs for quotes and history. No API key is required. If the pair does not exist, rate limits apply, or Binance is unavailable, Yahoo Finance automatically takes over. Name/ticker search and all other asset types continue to use Yahoo.

## Verification

```bash
npm run lint
npm test
```

## License

Apache-2.0. See [LICENSE](./LICENSE).

<img width="3008" height="1706" alt="image" src="https://github.com/user-attachments/assets/a7a80ebe-98ee-44a8-adae-3ae1a3d4380a" />
<img width="3010" height="1568" alt="image" src="https://github.com/user-attachments/assets/1994bbce-5722-477f-95a1-9e0136857676" />
<img width="3020" height="1716" alt="image" src="https://github.com/user-attachments/assets/323c5181-8393-4b3f-957f-af8319f218ff" />
<img width="3024" height="1708" alt="image" src="https://github.com/user-attachments/assets/4318d647-236c-4fab-b47f-735382434032" />




