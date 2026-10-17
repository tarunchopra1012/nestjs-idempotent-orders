import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CreateOrderDto } from './create-order.dto';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('naive')
  @HttpCode(201)
  createNaive(@Body() dto: CreateOrderDto) {
    return this.orders.createNaive(dto);
  }

  @Post()
  async create(
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateOrderDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!key || key.length > 255) {
      throw new BadRequestException(
        'Send an Idempotency-Key header (1–255 characters), for example a UUID.',
      );
    }
    const result = await this.orders.createIdempotent(key, dto);
    res.status(result.status);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }
}
