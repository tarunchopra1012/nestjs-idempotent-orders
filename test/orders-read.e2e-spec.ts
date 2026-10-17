import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

interface OrderBody {
  id: string;
  externalRef: string;
  createdAt: string;
}
interface Page {
  data: OrderBody[];
  nextCursor: string | null;
}

describe('Order read endpoints', () => {
  let app: INestApplication<App>;
  let db: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(DataSource);
  });

  beforeEach(() => db.query('TRUNCATE orders, idempotency_keys'));
  afterAll(() => app.close());

  /** Inserts orders with explicit timestamps; equal timestamps create ties. */
  const seed = (rows: { ref: string; at: string }[]) =>
    db.query(
      `INSERT INTO orders (external_ref, total, created_at)
       SELECT ref, 10, at::timestamptz
       FROM unnest($1::text[], $2::text[]) AS t(ref, at)`,
      [rows.map((r) => r.ref), rows.map((r) => r.at)],
    );

  const getPage = async (query: string) =>
    (await request(app.getHttpServer()).get(`/orders${query}`).expect(200))
      .body as Page;

  async function readAll(limit: number, extra = ''): Promise<OrderBody[]> {
    const all: OrderBody[] = [];
    let page = await getPage(`?limit=${limit}${extra}`);
    all.push(...page.data);
    while (page.nextCursor) {
      page = await getPage(`?limit=${limit}&cursor=${page.nextCursor}${extra}`);
      all.push(...page.data);
    }
    return all;
  }

  it('pages through every order exactly once, newest first', async () => {
    await seed([
      { ref: 'A', at: '2026-10-01T10:00:00.001Z' },
      { ref: 'B', at: '2026-10-01T10:00:00.002Z' },
      { ref: 'C', at: '2026-10-01T10:00:00.003Z' },
      { ref: 'D', at: '2026-10-01T10:00:00.004Z' },
      { ref: 'E', at: '2026-10-01T10:00:00.005Z' },
    ]);

    const all = await readAll(2);
    expect(all.map((o) => o.externalRef)).toEqual(['E', 'D', 'C', 'B', 'A']);
  });

  it('does not skip or repeat orders that share the same timestamp', async () => {
    const same = '2026-10-02T09:00:00.000Z';
    await seed(
      Array.from({ length: 7 }, (_, i) => ({ ref: `T${i}`, at: same })),
    );

    const all = await readAll(3);
    expect(all).toHaveLength(7);
    expect(new Set(all.map((o) => o.id)).size).toBe(7);
  });

  it('filters by externalRef', async () => {
    await seed([
      { ref: 'SF-1', at: '2026-10-03T00:00:00.000Z' },
      { ref: 'SF-2', at: '2026-10-03T00:00:01.000Z' },
      { ref: 'SF-1', at: '2026-10-03T00:00:02.000Z' },
    ]);
    const all = await readAll(1, '&externalRef=SF-1');
    expect(all.map((o) => o.externalRef)).toEqual(['SF-1', 'SF-1']);
  });

  it('returns nextCursor null on the last page', async () => {
    await seed([{ ref: 'ONLY', at: '2026-10-04T00:00:00.000Z' }]);
    const page = await getPage('?limit=5');
    expect(page.data).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it.each([
    ['a malformed cursor', '?cursor=not-a-cursor'],
    ['a limit above 100', '?limit=101'],
    ['a limit of 0', '?limit=0'],
    ['an unknown query parameter', '?sort=asc'],
  ])('rejects %s with 400', async (_, query) => {
    await request(app.getHttpServer()).get(`/orders${query}`).expect(400);
  });

  it('GET /orders/:id returns the order, 404 when missing, 400 for a non-UUID', async () => {
    await seed([{ ref: 'ONE', at: '2026-10-05T00:00:00.000Z' }]);
    const [{ id }] = (await getPage('')).data;

    const found = await request(app.getHttpServer())
      .get(`/orders/${id}`)
      .expect(200);
    expect((found.body as OrderBody).externalRef).toBe('ONE');

    await request(app.getHttpServer())
      .get(`/orders/${randomUUID()}`)
      .expect(404);
    await request(app.getHttpServer()).get('/orders/123').expect(400);
  });
});
