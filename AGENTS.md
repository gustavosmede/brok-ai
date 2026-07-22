# Agent instructions

Before reviewing or changing this project, read [`BROKAI_TECHNICAL_MEMO.md`](./BROKAI_TECHNICAL_MEMO.md) in full. It describes the product, architecture, financial flow, providers, persistence, APIs, limitations, and sources of truth.

Non-negotiable rules:

- no real broker orders are sent by the current MVP;
- preview and explicit confirmation remain mandatory;
- the LLM interprets text, but never calculates or executes trades;
- positions are derived from fills, and cash is derived from the ledger;
- `.env.local` secrets never enter code, docs, logs, commits, or responses;
- preserve Binance for crypto, Yahoo as fallback, and sub-cent price precision;
- make the smallest correct diff and run `npm run lint` and `npm test` before completing functional changes;
- if code and memo diverge, validate the source code and update the memo in the same diff.
