# nestjs-idempotent-orders

A NestJS + PostgreSQL practice project for distributed-correctness patterns: race conditions, idempotency keys, locking, outbox and reconciliation.

**Architecture and diagrams:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /orders/naive` | Check-then-insert. Creates duplicates under concurrency (the bug) |
| `POST /orders` | Requires an `Idempotency-Key` header. One order per key; retries get the stored response |
| `GET /orders` | Newest first, cursor pagination (`limit` 1–100, `cursor`, optional `externalRef`) |
| `GET /orders/:id` | One order; 404 if missing, 400 if the id isn't a UUID |

Body for both `POST` endpoints: `{ "externalRef": "SF-1001", "total": 49.99 }`

## Run it

Requires Docker (Colima) and Node 20+.

```bash
npm install
cp .env.example .env  # optional: the defaults already match docker-compose.yml
npm run db:start      # PostgreSQL 17 in Docker on port 5433
npm run start:dev     # API on http://localhost:3000
```

In a second terminal:

```bash
npm run demo:race     # 20 concurrent requests: naive vs idempotent
```

## Tests

```bash
npm run test:e2e      # needs the database running
npm test              # unit tests
```

## Database scripts

| Script | What it does |
|---|---|
| `npm run db:start` | Start PostgreSQL and wait until it's healthy |
| `npm run db:stop` | Stop it (data is kept) |
| `npm run db:reset` | Delete all data and start fresh |
| `npm run db:psql` | Open a SQL prompt in the container |

Settings are read from environment variables, loaded from `.env` at startup (and by the e2e tests) when that file exists. See `.env.example` for every variable; the defaults already match `docker-compose.yml`.
