# Signal Engine

A rule-based market analysis and trading signal platform for crypto perpetual futures and forex. It publishes signals for human review and paper tracking. It does not execute trades.

## Current implementation status

The first repository foundation is committed on main. It includes the pnpm/Turborepo workspace, Docker services for PostgreSQL and Redis, a NestJS API skeleton, Drizzle schema, reusable technical-analysis primitives, a Binance USD-M public candle adapter, and a Python research foundation with cost-model utilities. This is an early scaffold, not a production-ready backend. Persistence wiring, OANDA/Twelve Data integration, strategy evaluation, full backtest simulation, BullMQ workers, Telegram delivery, paper tracking, authentication, and deployment hardening remain in progress.

Strategy configurations are disabled by default. No exchange order execution is implemented or planned.

## Stack

- TypeScript monorepo managed by pnpm and Turborepo
- NestJS API
- PostgreSQL with Drizzle ORM
- Redis and BullMQ planned for workers
- Python research and backtesting service
- Telegram Bot API notifications
- Docker-based local development

## Research and safety standards

Backtests must avoid lookahead bias and account for fees, spread, slippage, and funding where applicable. Historical results do not guarantee future performance. Signal Engine never submits orders or requests exchange trading permissions.

See docs/architecture.md and docs/implementation-plan.md for the design and build sequence.