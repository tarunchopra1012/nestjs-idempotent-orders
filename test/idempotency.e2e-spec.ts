import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

const CONCURRENT = 20;

describe('Idempotency (real Postgres, concurrent requests)', () => {
  let app: INestApplication<App>;
  let db: DataSource;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.listen(0); // a real port, so concurrent requests really overlap
    db = app.get(DataSource);
  });

  beforeEach(() => db.query('TRUNCATE orders, idempotency_keys'));
  afterAll(() => app.close());

  const countOrders = async (ref: string) => {
    const rows: { count: string }[] = await db.query(
      'SELECT count(*) FROM orders WHERE external_ref = $1',
      [ref],
    );
    return Number(rows[0].count);
  };

  it('naive check-then-insert creates duplicates under concurrency (the Lesson 1 bug)', async () => {
    const body = { externalRef: 'SF-1001', total: 49.99 };
    await Promise.all(
      Array.from({ length: CONCURRENT }, () =>
        request(app.getHttpServer()).post('/orders/naive').send(body),
      ),
    );
    expect(await countOrders('SF-1001')).toBeGreaterThan(1);
  });

  it('same Idempotency-Key fired 20 times at once creates exactly one order', async () => {
    const key = randomUUID();
    const body = { externalRef: 'SF-2002', total: 120 };
    const responses = await Promise.all(
      Array.from({ length: CONCURRENT }, () =>
        request(app.getHttpServer())
          .post('/orders')
          .set('Idempotency-Key', key)
          .send(body),
      ),
    );

    expect(await countOrders('SF-2002')).toBe(1);
    expect(responses.every((r) => r.status === 201)).toBe(true);
    const ids = responses.map((r) => (r.body as { id: string }).id);
    expect(new Set(ids).size).toBe(1); // everyone got the same order back
    expect(
      responses.filter((r) => r.headers['idempotent-replayed'] === 'true'),
    ).toHaveLength(CONCURRENT - 1);
  });

  it('rejects a reused key with a different body (422)', async () => {
    const key = randomUUID();
    await request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', key)
      .send({ externalRef: 'SF-3003', total: 10 })
      .expect(201);
    await request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', key)
      .send({ externalRef: 'SF-3003', total: 99 })
      .expect(422);
  });

  it('different keys create different orders', async () => {
    const body = { externalRef: 'SF-4004', total: 5 };
    await request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(201);
    await request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(201);
    expect(await countOrders('SF-4004')).toBe(2);
  });

  it('requires the Idempotency-Key header (400)', async () => {
    await request(app.getHttpServer())
      .post('/orders')
      .send({ externalRef: 'SF-5005', total: 5 })
      .expect(400);
  });
});
