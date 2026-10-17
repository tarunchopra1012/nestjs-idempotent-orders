import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { IdempotencyKeyCleanupService } from '../src/orders/idempotency-key-cleanup.service';

describe('Idempotency key expiry and cleanup', () => {
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

  const expire = (key: string) =>
    db.query(
      `UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE key = $1`,
      [key],
    );

  it('sets expires_at about 24 hours ahead on a new key', async () => {
    const key = randomUUID();
    await request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', key)
      .send({ externalRef: 'SF-6006', total: 1 })
      .expect(201);

    const rows: { hours: string }[] = await db.query(
      `SELECT extract(epoch FROM expires_at - created_at) / 3600 AS hours
       FROM idempotency_keys WHERE key = $1`,
      [key],
    );
    expect(Number(rows[0].hours)).toBeCloseTo(24, 1);
  });

  it('lets an expired key be reused, even with a different body', async () => {
    const key = randomUUID();
    const first = await request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', key)
      .send({ externalRef: 'SF-7007', total: 10 })
      .expect(201);

    await expire(key);

    const second = await request(app.getHttpServer())
      .post('/orders')
      .set('Idempotency-Key', key)
      .send({ externalRef: 'SF-7007', total: 99 })
      .expect(201);

    expect(second.headers['idempotent-replayed']).toBeUndefined();
    expect((second.body as { id: string }).id).not.toBe(
      (first.body as { id: string }).id,
    );
  });

  it('cleanup deletes only expired keys, across several batches', async () => {
    const keys = [randomUUID(), randomUUID(), randomUUID()];
    for (const key of keys) {
      await request(app.getHttpServer())
        .post('/orders')
        .set('Idempotency-Key', key)
        .send({ externalRef: `SF-${key.slice(0, 6)}`, total: 1 })
        .expect(201);
    }
    await expire(keys[0]);
    await expire(keys[1]);

    const deleted = await app
      .get(IdempotencyKeyCleanupService)
      .deleteExpired(1); // batch size 1 forces the loop to run more than once

    const remaining: { key: string }[] = await db.query(
      'SELECT key FROM idempotency_keys',
    );
    expect(deleted).toBe(2);
    expect(remaining.map((r) => r.key)).toEqual([keys[2]]);
  });
});
