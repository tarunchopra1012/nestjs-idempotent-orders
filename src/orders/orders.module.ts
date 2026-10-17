import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyKeyCleanupService } from './idempotency-key-cleanup.service';
import { IdempotencyKey } from './idempotency-key.entity';
import { Order } from './order.entity';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [TypeOrmModule.forFeature([Order, IdempotencyKey])],
  controllers: [OrdersController],
  providers: [OrdersService, IdempotencyKeyCleanupService],
})
export class OrdersModule {}
