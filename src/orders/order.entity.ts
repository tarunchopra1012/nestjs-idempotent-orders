import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('orders')
// Serves GET /orders: newest first, keyset pagination on (created_at, id).
@Index('idx_orders_created_at_id', ['createdAt', 'id'])
@Index('idx_orders_external_ref', ['externalRef'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // The order's id in the upstream system (e.g. a Salesforce order id).
  // Deliberately NOT unique, so the naive endpoint can show the duplicate bug.
  @Column({ name: 'external_ref' })
  externalRef: string;

  @Column('numeric', { precision: 12, scale: 2 })
  total: string;

  // Millisecond precision so the value round-trips exactly through a JS Date.
  // Pagination cursors carry this timestamp; with Postgres' default microseconds
  // a cursor built from a Date would not match the stored value.
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz', precision: 3 })
  createdAt: Date;
}
