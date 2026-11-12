/**
 * @fileoverview The Prisma implementation of the order port, including the outbox.
 *
 * @remarks This is where atomicity lives. The order header, its lines and its `outbox_events`
 * rows go in through one interactive transaction, so either a consumer eventually hears about
 * the order or nothing about it exists at all — and a status change can never ship without
 * the event that announces it.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type PrismaService } from '@auth/infra/prisma';
import { Topics } from '@auth/contracts';
import type { PrismaClient } from '../../generated/prisma/client';
import { Order } from '../../domain/order.aggregate';
import {
  ORDER_REPOSITORY,
  type OrderPage,
  type OrderRepositoryPort,
} from '../../domain/ports/order-repository.port';
import { ORDER_PRISMA } from '../../order.config';
import { enqueueEvents } from './outbox-enqueue';

/**
 * The `order.*` -> `platform.order.*.v1` mapping.
 *
 * @remarks Domain events name facts in the domain's language; topics are a transport
 * contract. Keeping the translation in one function means adding an event cannot accidentally
 * invent a topic name that no consumer subscribes to.
 */
const ORDER_TOPICS: Readonly<Record<string, string>> = {
  'order.created': Topics.ORDER_CREATED,
  'order.paid': Topics.ORDER_PAID,
  'order.confirmed': Topics.ORDER_CONFIRMED,
  'order.canceled': Topics.ORDER_CANCELED,
};

@Injectable()
export class PrismaOrderRepository implements OrderRepositoryPort {
  private readonly logger = new Logger(PrismaOrderRepository.name);

  constructor(
    @Inject(ORDER_PRISMA) private readonly prisma: PrismaService<PrismaClient>,
  ) {}

  /**
   * Writes the order, its lines and its events atomically.
   *
   * @remarks Events are drained *before* the transaction opens: an event buffer that
   * survived a rollback would be written by the *next* save and attributed to a different
   * order.
   */
  async save(order: Order): Promise<void> {
    const events = order.clearDomainEvents();
    const row = order.toRow();
    const lineRows = order.toLineRows();

    await this.prisma.runInTransaction(async (client) => {
      // Header first: the unique `idempotency_key` is the race that makes two concurrent
      // CreateOrder calls collapse to one order, and the loser must see the winner's row.
      await client.orders.upsert({
        where: { id: row.id },
        create: row,
        update: {
          status: row.status,
          payment_id: row.payment_id,
          cancel_reason: row.cancel_reason,
          version: row.version,
          updated_at: row.updated_at,
        },
      });

      // Lines are a full replace: the set is frozen at creation and a re-save of a
      // rehydrated order must not leave a stale line behind after a (hypothetical) edit.
      await client.order_lines.deleteMany({ where: { order_id: row.id } });
      if (lineRows.length > 0) {
        await client.order_lines.createMany({ data: lineRows });
      }

      await enqueueEvents(events, {
        client,
        logger: this.logger,
        topics: ORDER_TOPICS,
      });
    });
  }

  async findById(orderId: string): Promise<Order | null> {
    const row = await this.prisma.tx.orders.findUnique({
      where: { id: orderId },
      include: { lines: { orderBy: { sku: 'asc' } } },
    });
    return row ? Order.fromRow(row, row.lines) : null;
  }

  async findByIdempotencyKey(key: string): Promise<Order | null> {
    const row = await this.prisma.tx.orders.findUnique({
      where: { idempotency_key: key },
      include: { lines: { orderBy: { sku: 'asc' } } },
    });
    return row ? Order.fromRow(row, row.lines) : null;
  }

  async listForUser(userId: string, page: number, pageSize: number): Promise<OrderPage> {
    const where = { user_id: userId };
    const [rows, total] = await Promise.all([
      this.prisma.tx.orders.findMany({
        where,
        include: { lines: { orderBy: { sku: 'asc' } } },
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.tx.orders.count({ where }),
    ]);

    return {
      orders: rows.map((row) => Order.fromRow(row, row.lines)),
      total,
    };
  }

  async probe(): Promise<number> {
    // A count of a non-existent user: exercises the same path a real list does, without
    // loading rows or depending on any order existing.
    return this.prisma.tx.orders.count({
      where: { user_id: '00000000-0000-0000-0000-000000000000' },
    });
  }
}

export { ORDER_REPOSITORY };
