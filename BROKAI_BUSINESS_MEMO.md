# Brok.ai Business Memo: Vision, Model, And Global Expansion

**Version:** 1.0
**Reference date:** July 22, 2026
**Current state:** functional paper-trading MVP; no real orders are sent

## 1. Vision

Brok.ai is intended to become a global intelligent multibroker terminal, not a broker. The user connects an account they already hold at a supported broker or exchange. Brok.ai interprets the user's intent, resolves the asset, calculates the order impact, displays a preview, and only after explicit confirmation transmits the order to the selected institution's API.

The broker remains responsible for onboarding, KYC, custody, balance, suitability, execution, settlement, statements, and official records. Brok.ai acts as the software layer for command, normalization, monitoring, risk, and audit.

> **Core principle:** Brok.ai does not accept deposits, hold balances, custody assets, or request withdrawal/transfer permissions.

## 2. User Problem

Users should not need to learn different interfaces, symbols, and order flows for every institution. Brok.ai aims to provide one consistent operating layer across brokers and asset classes.

Example requests:

- "Buy US$1,000 of Apple at market, with a 5% stop and a 12% target."
- "Open a short position in the S&P 500 with 1% of available cash."
- "Reduce my PayPal position by 50%."
- "Buy 10% of cash in crude oil and add a 5% stop."
- "Show aggregate risk across all open positions and brokers."

The defensible value is not merely using an LLM. The durable value is reliable intent interpretation, correct instrument resolution, multibroker normalization, deterministic preview, mandatory human confirmation, risk controls, duplicate-order prevention, reconciliation with the broker of record, and auditable logs.

## 3. Role Split

Brok.ai should own:

- text, voice, and form interpretation;
- conversion of intent into a canonical order model;
- instrument resolution and market-data enrichment;
- indicative price, size, cost, and portfolio-impact preview;
- explicit confirmation capture;
- routing to approved broker adapters;
- monitoring of status, fills, positions, and risk;
- audit records for original text, interpreted JSON, preview, confirmation, and broker response.

The broker should own:

- onboarding, KYC, AML, and suitability;
- account restrictions and permissions;
- custody of cash and assets;
- official market access;
- routing, execution, and settlement;
- confirmations, statements, and tax documents;
- regulated obligations assigned to the intermediary.

## 4. Connection Architecture

Two connection modes should exist.

### OAuth Broker Connect

The user is redirected to the broker, authenticates there, and grants specific scopes to Brok.ai. Brok.ai receives a revocable token without knowing the user's password.

Minimum scopes:

- account read;
- positions, orders, and fills read;
- order creation and cancellation.

Never request withdrawal, transfer, or profile-change scopes.

### Local API-Key Agent

When OAuth is unavailable, the key can remain encrypted on the user's device. A small local service receives a signed intent from Brok.ai, validates confirmation, and calls the broker API directly. This reduces centralized credential exposure, but scheduled orders and continuous monitoring depend on the user's device being online.

Tokens, secrets, and API keys must never enter model prompts, model logs, or Ollama context. The model produces only structured intent. Deterministic code owns validation, calculation, authorization, and transmission.

## 5. Multibroker Standard

Every integration should implement a canonical adapter interface for account snapshots, quotes, order placement, cancellation, and fill reconciliation. Each adapter must declare supported countries, account types, asset classes, order types, long/short availability, fractional trading, extended-hours trading, OCO/native protections, market-data availability, rate limits, and authentication requirements.

The interface should block or explain unsupported operations instead of silently approximating them.

## 6. Integration Strategy

- Alpaca Paper and Alpaca OAuth are good first candidates for validating account sync and paper/live order routing.
- Binance validates crypto precision, symbol normalization, and permission separation.
- Interactive Brokers provides broad international coverage, but third-party access requires onboarding and compliance approval.
- Regional brokers should be prioritized based on real user demand.

## 7. Global Strategy

Global does not mean enabling real orders everywhere at once. The architecture and brand can be global from day one, while execution should be enabled by broker, country of residence, regulated entity, asset class, account permission, and local rule set.

Brok.ai should maintain an availability matrix and use feature flags. When a jurisdiction or broker is not enabled, users can still use paper trading, monitoring, and analysis without live order transmission.

Required global capabilities include internationalization, local market calendars, time zones, regional privacy policies, retention controls, broker-specific terms, and logged consent/confirmation versions.

## 8. Regulatory Framing

Not custodying funds reduces operational risk, but it does not eliminate regulatory risk. Regulators evaluate the actual user flow, not only marketing language.

Brok.ai must avoid selecting assets for the user, giving personalized trade recommendations, trading discretionarily without specific confirmation, controlling funds or assets, or charging in ways that create broker-dealer risk without legal review.

Before live orders, Brok.ai should obtain jurisdiction-specific legal advice and validate the operating model contractually with each broker partner.

## 9. Recommended Business Model

The basic product can remain free for users. Priority monetization should be B2B2C, paid by institutions that benefit from the interface and customer flow.

Potential revenue sources:

1. broker-paid technology fee;
2. white-label deployments for banks, exchanges, and financial institutions;
3. managed cloud workspace for users who do not want to run locally;
4. implementation and maintenance of private adapters;
5. broker-approved revenue share within a regulated framework;
6. enterprise audit, compliance, and risk modules.

Brok.ai should not start by charging users directly per order. That model can strengthen broker-dealer classification risk, creates an incentive to stimulate trading, and complicates international expansion.

If a transactional fee exists later, the preferred structure is for the partner broker to contract, disclose, and settle it, with clear preview disclosure and legal validation in the client's jurisdiction.

## 10. Mandatory Controls For Real Money

- mandatory preview before every new order;
- explicit and specific confirmation;
- raw user text and interpreted JSON shown before confirmation;
- short preview expiration;
- revalidation of price, cash, position, and broker capability;
- idempotency key for each order;
- no withdrawal or transfer permissions;
- per-account risk limits;
- periodic reconciliation with the broker;
- immutable intent and broker-response logs;
- clear delayed/unavailable data indicators;
- explicit handling of partial fills, rejections, and closed markets;
- no autonomous decision based only on LLM output.

## 11. Roadmap

### Phase 1: Public Paper Trading

Open-source the local MVP, document setup, collect usage feedback, and measure simulated-order activation, preview abandonment, and interpretation accuracy.

### Phase 2: Multibroker Core

Define the canonical adapter interface, broker-capability matrix, account/credential separation, audit model, and idempotency guarantees.

### Phase 3: Paper Broker Integrations

Start with Alpaca Paper and Binance test flows, synchronize external orders/positions, and test reconciliation/network failures.

### Phase 4: Legal And Partnership Readiness

Create the legal entity, publish policies, obtain legal opinions in priority jurisdictions, and define contracts, responsibilities, and compensation.

### Phase 5: Controlled Live Execution

Enable a small user group, low order limits, strict logging, manual incident review, and expansion by broker/country only after evidence of safety.

## 12. Key Metrics

- users connecting accounts;
- users generating and confirming previews;
- interpretation success rate;
- manual corrections before confirmation;
- rejected or unsupported intents;
- time from intent to preview;
- reconciliation errors;
- weekly and monthly retention;
- infrastructure and support cost per user;
- security incidents or excessive permissions.

## 13. Positioning

> **Brok.ai is the intelligent interface that connects investors to the brokers they already use, translating natural language into safe, verifiable, confirmed orders.**

Brok.ai does not compete for custody. It competes for the best decision, command, and monitoring experience across multiple financial institutions.

## 14. Recorded Decisions

- Brok.ai does not intend to become a broker.
- The user remains a direct client of the chosen broker.
- The broker remains the official source of balance, position, and execution.
- The product is built for global reach, with gradual jurisdiction-by-jurisdiction release.
- OAuth is preferred; API keys must use minimum scope and ideally remain in a local connector.
- Preview and confirmation remain mandatory.
- Priority monetization is B2B2C, not a mandatory user subscription.
- Direct per-order fees require partnership and regulatory analysis first.

## 15. Initial Official References

- [Alpaca Broker API](https://alpaca.markets/broker)
- [Alpaca OAuth](https://docs.alpaca.markets/docs/oauth-integrations)
- [Binance Spot API](https://developers.binance.com/en/docs/products/spot/rest-api)
- [Interactive Brokers API](https://www.interactivebrokers.com/en/trading/ib-api.php)
- [SEC broker-dealer guide](https://www.sec.gov/about/reports-publications/investor-publications/guide-broker-dealer-registration)
- [ESMA MiCA definitions](https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/mica/article-3-definitions)
- [ESMA MiCA authorization](https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/mica/article-59-authorisation)

This memo records strategic and technical direction. It is not legal, regulatory, tax, or investment advice.
