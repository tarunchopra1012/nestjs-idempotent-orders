# nestjs-idempotent-orders

A NestJS + PostgreSQL practice project for distributed-correctness patterns: race conditions, idempotency keys, locking, outbox and reconciliation.

**Architecture and diagrams:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /orders/naive` | Check-then-insert. Creates duplicates under concurrency (the bug) |
| `POST /orders` | Requires an `Idempotency-Key` header. One order per key; retries get the stored response |

Body for both: `{ "externalRef": "SF-1001", "total": 49.99 }`

## Run it

Requires Docker (Colima) and Node 20+.

```bash
npm install
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

Connection settings are in `.env.example`; the defaults already match `docker-compose.yml`.
