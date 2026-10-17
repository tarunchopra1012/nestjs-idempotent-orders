import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * One row per (scope, key) the API has ever processed.
 * The composite primary key is what makes concurrent duplicates impossible:
 * Postgres lets exactly one transaction insert a given (scope, key).
 */
@Entity('idempotency_keys')
export class IdempotencyKey {
  // Which operation (and, in a real app, which client/tenant) the key belongs to.
  // Scoping stops the same key from colliding across endpoints or customers.
  @PrimaryColumn()
  scope: string;

  @PrimaryColumn()
  key: string;

  // Fingerprint of the request body, so a reused key with a different body is rejected.
  @Column({ name: 'request_hash' })
  requestHash: string;

  // The response we sent the first time; replayed verbatim on retries.
  @Column({ name: 'response_status', type: 'int', nullable: true })
  responseStatus: number | null;

  @Column({ name: 'response_body', type: 'jsonb', nullable: true })
  responseBody: unknown;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
