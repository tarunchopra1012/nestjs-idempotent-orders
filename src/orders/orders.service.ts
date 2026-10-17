import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { CreateOrderDto } from './create-order.dto';
import { IdempotencyKey } from './idempotency-key.entity';
import { ListOrdersQuery } from './list-orders.query';
import { decodeCursor, encodeCursor } from './order-cursor';
import { Order } from './order.entity';

export interface IdempotentResult {
  status: number;
  body: unknown;
  replayed: boolean;
}

// How long a key protects against retries. Stripe uses 24 hours.
export const IDEMPOTENCY_KEY_TTL_HOURS = Number(
  process.env.IDEMPOTENCY_KEY_TTL_HOURS ?? 24,
);

// Stands in for the slow work real code does between "check" and "write"
// (calling Salesforce, Stripe, ShipStation…). It widens the race window.
const simulateUpstreamCall = () => new Promise((r) => setTimeout(r, 50));

// Same body => same hash, regardless of key order in the JSON.
function fingerprint(body: object): string {
  const sorted = JSON.stringify(body, Object.keys(body).sort());
  return createHash('sha256').update(sorted).digest('hex');
}

function toResponse(order: Order) {
  return {
    id: order.id,
    externalRef: order.externalRef,
    total: order.total,
    createdAt: order.createdAt,
  };
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async findOne(id: string) {
    const order = await this.orders.findOneBy({ id });
    if (!order) throw new NotFoundException(`Order ${id} not found.`);
    return toResponse(order);
  }

  /**
   * Newest first, keyset pagination: each page continues strictly after the
   * cursor's (createdAt, id), so inserts between requests never cause skipped
   * or repeated rows the way OFFSET pagination can.
   */
  async list(query: ListOrdersQuery) {
    const qb = this.orders
      .createQueryBuilder('o')
      .orderBy('o.createdAt', 'DESC')
      .addOrderBy('o.id', 'DESC')
      .limit(query.limit + 1); // one extra row tells us whether another page exists

    if (query.externalRef) {
      qb.andWhere('o.externalRef = :externalRef', {
        externalRef: query.externalRef,
      });
    }
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      qb.andWhere('(o.createdAt, o.id) < (:createdAt, :id)', cursor);
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    return {
      data: page.map(toResponse),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  /** Lesson 1: check-then-insert. Looks correct, breaks under concurrency. */
  async createNaive(dto: CreateOrderDto) {
    const existing = await this.orders.findOneBy({
      externalRef: dto.externalRef,
    }); // CHECK
    if (existing) return toResponse(existing);

    await simulateUpstreamCall(); // ← another request can do its CHECK right here

    const order = await this.orders.save(
      this.orders.create({ ...dto, total: dto.total.toFixed(2) }),
    ); // ACT
    return toResponse(order);
  }

  /** Lesson 2: Idempotency-Key. The database, not the application, decides who goes first. */
  async createIdempotent(
    key: string,
    dto: CreateOrderDto,
  ): Promise<IdempotentResult> {
    const scope = 'POST /orders'; // in a real app: include the client or tenant id too
    const requestHash = fingerprint(dto);

    return this.dataSource.transaction(async (tx) => {
      // 1. Claim the key. If another transaction holds the same (scope, key),
      //    Postgres makes this INSERT wait until that transaction commits or rolls back.
      //    An expired key is taken over (its old response is cleared); a live one is left alone.
      const claimed: unknown[] = await tx.query(
        `INSERT INTO idempotency_keys (scope, key, request_hash, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(hours => $4))
         ON CONFLICT (scope, key) DO UPDATE
           SET request_hash    = EXCLUDED.request_hash,
               response_status = NULL,
               response_body   = NULL,
               created_at      = now(),
               expires_at      = EXCLUDED.expires_at
           WHERE idempotency_keys.expires_at <= now()
         RETURNING key`,
        [scope, key, requestHash, IDEMPOTENCY_KEY_TTL_HOURS],
      );

      // 2. Someone already processed this key: replay their response.
      if (claimed.length === 0) {
        const previous = await tx.findOneByOrFail(IdempotencyKey, {
          scope,
          key,
        });
        if (previous.requestHash !== requestHash) {
          throw new UnprocessableEntityException(
            'This Idempotency-Key was already used with a different request body.',
          );
        }
        return {
          status: previous.responseStatus ?? 200,
          body: previous.responseBody,
          replayed: true,
        };
      }

      // 3. We own the key: do the real work inside the same transaction.
      await simulateUpstreamCall();
      const order = await tx.save(
        tx.create(Order, { ...dto, total: dto.total.toFixed(2) }),
      );
      const body = toResponse(order);

      // 4. Store the response so every retry gets exactly the same answer.
      await tx.update(
        IdempotencyKey,
        { scope, key },
        { responseStatus: 201, responseBody: body },
      );
      return { status: 201, body, replayed: false };
    });
  }
}
