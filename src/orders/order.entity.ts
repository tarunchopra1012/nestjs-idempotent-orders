import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // The order's id in the upstream system (e.g. a Salesforce order id).
  // Deliberately NOT unique, so the naive endpoint can show the duplicate bug.
  @Column({ name: 'external_ref' })
  externalRef: string;

  @Column('numeric', { precision: 12, scale: 2 })
  total: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
