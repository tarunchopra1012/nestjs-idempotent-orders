import { BadRequestException } from '@nestjs/common';

/** Position after the last order on a page: newest-first, ties broken by id. */
export interface OrderCursor {
  createdAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque to clients: base64url of [createdAtIso, id]. */
export function encodeCursor(order: OrderCursor): string {
  return Buffer.from(
    JSON.stringify([order.createdAt.toISOString(), order.id]),
  ).toString('base64url');
}

export function decodeCursor(raw: string): OrderCursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('Invalid cursor.');
  }
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'string' &&
    UUID.test(value[1])
  ) {
    const createdAt = new Date(value[0]);
    if (!Number.isNaN(createdAt.getTime())) {
      return { createdAt, id: value[1] };
    }
  }
  throw new BadRequestException('Invalid cursor.');
}
