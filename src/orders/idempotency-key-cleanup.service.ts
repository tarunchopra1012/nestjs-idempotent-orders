import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

const BATCH_SIZE = 1000;

/**
 * Deletes expired idempotency keys in small batches, so one run never holds
 * long locks or bloats a single transaction on a large table.
 */
@Injectable()
export class IdempotencyKeyCleanupService {
  private readonly logger = new Logger(IdempotencyKeyCleanupService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'idempotency-key-cleanup' })
  async handleCron(): Promise<void> {
    const deleted = await this.deleteExpired();
    if (deleted > 0)
      this.logger.log(`Deleted ${deleted} expired idempotency keys`);
  }

  /** Returns how many rows were deleted. Safe to run concurrently. */
  async deleteExpired(batchSize = BATCH_SIZE): Promise<number> {
    let total = 0;
    for (;;) {
      // For DELETE, TypeORM's Postgres driver returns [rows, affectedCount], not just rows.
      const [, deleted]: [unknown[], number] = await this.dataSource.query(
        `DELETE FROM idempotency_keys
         WHERE (scope, key) IN (
           SELECT scope, key FROM idempotency_keys
           WHERE expires_at <= now()
           ORDER BY expires_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )`,
        [batchSize],
      );
      total += deleted;
      if (deleted < batchSize) return total;
    }
  }
}
