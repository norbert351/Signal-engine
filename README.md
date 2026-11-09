# Signal Engine

A rule-based market analysis and trading signal platform for crypto perpetual futures and forex. The system publishes signals for human review and paper tracking. It does not execute trades.

## Project status

Initial backend scaffold is being established. Strategy configurations are disabled by default until their data, risk assumptions, and out-of-sample results have been reviewed.

## Planned stack

- TypeScript monorepo managed by pnpm and Turborepo
- NestJS API
- PostgreSQL with Drizzle ORM
- Redis and BullMQ workers
- Python research and backtesting service
- Telegram Bot API notifications
- Docker-based local development

## Safety and research standards

Backtests must avoid lookahead bias and account for fees, spread, slippage, and funding where applicable. Historical results are not guarantees of future performance. Signal Engine never submits orders or requests exchange trading permissions.

See `docs/architecture.md` and `docs/implementation-plan.md` for the initial design.