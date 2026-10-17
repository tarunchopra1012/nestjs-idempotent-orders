# Architecture — Order Ops Copilot

A small NestJS + PostgreSQL service used to practise **distributed correctness**.
Right now it exposes two ways to create an order:

| Endpoint | What it shows |
|---|---|
| `POST /orders/naive` | The bug: check-then-insert creates duplicates under concurrency |
| `POST /orders` (with `Idempotency-Key`) | The fix: the database decides who goes first; retries get the same response |

---

## 1. System overview

```mermaid
flowchart LR
    subgraph Clients
        C1[HTTP client<br/>curl / Postman]
        C2[e2e tests<br/>test/idempotency.e2e-spec.ts]
        C3[Race demo<br/>scripts/race-demo.mjs]
    end

    subgraph API["NestJS API (port 3000)"]
        P[ValidationPipe<br/>app.setup.ts]
        CTRL[OrdersController]
        SVC[OrdersService]
        ORM[TypeORM<br/>Repository + DataSource]
    end

    subgraph Docker["Docker (docker-compose.yml)"]
        DB[(PostgreSQL 17<br/>host port 5433)]
    end

    C1 --> P
    C2 --> P
    C3 --> P
    P --> CTRL --> SVC --> ORM --> DB
```

- **ValidationPipe** rejects bad bodies before they reach the controller (unknown fields, negative totals, missing `externalRef`).
- **OrdersController** handles HTTP concerns only: reading the `Idempotency-Key` header, setting the status code and the `Idempotent-Replayed` header.
- **OrdersService** holds the business logic and the transaction.
- **PostgreSQL** runs in Docker and is the source of truth for "who claimed this key first".

---

## 2. NestJS modules and classes

```mermaid
classDiagram
    direction LR
    class AppModule {
        imports TypeOrmModule.forRoot(postgres)
        imports OrdersModule
    }
    class OrdersModule {
        imports TypeOrmModule.forFeature(Order, IdempotencyKey)
    }
    class OrdersController {
        +createNaive(dto) POST /orders/naive
        +create(key, dto, res) POST /orders
    }
    class OrdersService {
        +createNaive(dto)
        +createIdempotent(key, dto) IdempotentResult
    }
    class CreateOrderDto {
        +externalRef string
        +total number
    }
    class Order {
        <<entity orders>>
        +id uuid
        +externalRef string
        +total numeric
        +createdAt timestamptz
    }
    class IdempotencyKey {
        <<entity idempotency_keys>>
        +scope string  PK
        +key string  PK
        +requestHash string
        +responseStatus int
        +responseBody jsonb
        +createdAt timestamptz
    }

    AppModule --> OrdersModule : imports
    OrdersModule --> OrdersController : declares
    OrdersModule --> OrdersService : provides
    OrdersController --> OrdersService : uses
    OrdersController ..> CreateOrderDto : validates body
    OrdersService --> Order : writes
    OrdersService --> IdempotencyKey : claims / replays
```

---

## 3. Data model

```mermaid
erDiagram
    ORDERS {
        uuid id PK
        varchar external_ref "upstream id, e.g. Salesforce; NOT unique (on purpose)"
        numeric total "precision 12, scale 2"
        timestamptz created_at
    }
    IDEMPOTENCY_KEYS {
        varchar scope PK "e.g. 'POST /orders' (+ tenant in a real app)"
        varchar key PK "client-supplied Idempotency-Key"
        varchar request_hash "sha256 of the request body"
        int response_status "stored on first success"
        jsonb response_body "replayed on every retry"
        timestamptz created_at
    }
```

There is no foreign key between the tables: the stored `response_body` already contains the order id.
The **composite primary key `(scope, key)`** is the whole trick. Postgres allows only one transaction to insert a given pair.

---

## 4. The bug: `POST /orders/naive`

Two requests for the same upstream order arrive together. Both check, both see "not found", both insert.

```mermaid
sequenceDiagram
    autonumber
    participant A as Request A
    participant B as Request B
    participant S as OrdersService.createNaive
    participant DB as PostgreSQL

    A->>S: POST /orders/naive {externalRef: SF-1001}
    B->>S: POST /orders/naive {externalRef: SF-1001}
    S->>DB: SELECT … WHERE external_ref = 'SF-1001' (for A)
    DB-->>S: no row
    S->>DB: SELECT … WHERE external_ref = 'SF-1001' (for B)
    DB-->>S: no row
    Note over S: simulateUpstreamCall() — 50 ms gap<br/>(stands in for Salesforce / Stripe calls)
    S->>DB: INSERT order (for A)
    S->>DB: INSERT order (for B)
    Note over DB: ❌ two orders for SF-1001
```

The race demo shows it at scale: **20 concurrent requests → 20 orders**.

---

## 5. The fix: `POST /orders` with `Idempotency-Key`

Everything happens inside **one database transaction**. The second request is not rejected; Postgres makes it **wait** on the primary key until the first transaction finishes, then it reads the stored response.

```mermaid
sequenceDiagram
    autonumber
    participant A as Request A
    participant B as Request B
    participant S as OrdersService.createIdempotent
    participant DB as PostgreSQL

    A->>S: POST /orders  Idempotency-Key: k1
    B->>S: POST /orders  Idempotency-Key: k1
    S->>DB: BEGIN (A) · INSERT key k1 ON CONFLICT DO NOTHING RETURNING key
    DB-->>S: 1 row → A owns k1
    S->>DB: BEGIN (B) · INSERT key k1 ON CONFLICT DO NOTHING …
    Note over DB: B waits: A holds an uncommitted row for (scope, k1)
    S->>DB: INSERT order · UPDATE key k1 SET response (A)
    S->>DB: COMMIT (A)
    S-->>A: 201 {id: …}
    DB-->>S: conflict → 0 rows (B)
    S->>DB: SELECT key k1 (B) → stored response, same request_hash
    S->>DB: COMMIT (B)
    S-->>B: 201 {same id}  +  Idempotent-Replayed: true
    Note over DB: ✅ exactly one order
```

### Decision flow inside `createIdempotent`

```mermaid
flowchart TD
    Start([POST /orders]) --> H{Idempotency-Key<br/>header present?}
    H -- no --> E400[400 Bad Request]
    H -- yes --> V{Body valid?<br/>ValidationPipe}
    V -- no --> E400b[400 Bad Request]
    V -- yes --> T[BEGIN transaction]
    T --> I["INSERT (scope, key, request_hash)<br/>ON CONFLICT DO NOTHING"]
    I -- "1 row: we own the key" --> W[Create order<br/>+ store response on key row]
    W --> C[COMMIT] --> R201[201 Created]
    I -- "0 rows: key already used" --> L[Load stored key row]
    L --> M{Same request_hash?}
    M -- no --> E422[422 Unprocessable Entity<br/>key reused with a different body]
    M -- yes --> RP[Replay stored status + body<br/>Idempotent-Replayed: true]
```

---

## 6. Folder map

| Path | Role |
|---|---|
| `src/main.ts` | Boots the app on `PORT` (default 3000) |
| `src/app.setup.ts` | Global `ValidationPipe`, shared by `main.ts` and the e2e tests |
| `src/app.module.ts` | Root module; TypeORM connection (env vars, defaults match Docker) |
| `src/orders/orders.controller.ts` | HTTP layer: header check, status code, replay header |
| `src/orders/orders.service.ts` | Naive path, idempotent path, request fingerprinting |
| `src/orders/order.entity.ts` | `orders` table |
| `src/orders/idempotency-key.entity.ts` | `idempotency_keys` table with composite primary key |
| `src/orders/create-order.dto.ts` | Request body rules (class-validator) |
| `test/idempotency.e2e-spec.ts` | Fires 20 concurrent requests against real Postgres |
| `scripts/race-demo.mjs` | Prints naive vs idempotent results against a running API |
| `docker-compose.yml` | PostgreSQL 17 on host port 5433 with a named volume |

---

## 7. Known limits (next lessons)

| Limit | Why it matters | Lesson |
|---|---|---|
| The whole operation runs in one DB transaction | Can't hold a transaction open around a Stripe or Salesforce call; needs an *in-progress* state and recovery | `/idempotency` 2 |
| `orders.external_ref` has no unique constraint | A second safety net at the business-key level | `/idempotency` 3 |
| No expiry on `idempotency_keys` | The table grows forever; keys usually expire after 24–72 h | `/idempotency` 2 |
| `scope` is a fixed string | In a multi-tenant API it must include the client or tenant id | `/idempotency` 2 |
| No outbox | Events to other systems can be lost or sent twice | `/idempotency` 6 |
| `synchronize: true` | Fine for learning; production uses migrations | — |
