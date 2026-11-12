/**
 * @fileoverview gRPC transport for inventory, implementing `InventoryGrpcClient` server-side.
 *
 * @remarks It extends {@link GrpcControllerBase} because `mergeMicroservice` requires a
 * controller with no HTTP routes; deriving from it keeps that invariant from being
 * forgotten when a method is added.
 *
 * @remarks **Its own `@Controller()` is mandatory.** `emitDecoratorMetadata` does not
 * inherit across class inheritance: a subclass with no decorator of its own gets no
 * `design:paramtypes`, so Nest constructs it with zero arguments, the service boots
 * cleanly and the first request fails on an `undefined` facade.
 *
 * @remarks The controller translates and nothing else. Every rule about stock lives
 * behind {@link InventoryService}, so a second transport (HTTP, an internal caller) cannot
 * reach a different answer.
 */
import { Controller } from '@nestjs/common';
import { GrpcControllerBase, GrpcMethod } from '@auth/infra/grpc';
import type {
  AdjustStockRequest,
  AdjustStockResponse,
  GetAvailableRequest,
  GetAvailableResponse,
  ReleaseRequest,
  ReleaseResponse,
  ReserveRequest,
  ReserveResponse,
  ShipRequest,
} from '@auth/contracts';
// Value import on purpose — see the note in `session.grpc.controller.ts`.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- DI resolves the parameter from this value binding (emitDecoratorMetadata)
import { InventoryService } from '../../application/facade/inventory.service';

/** Service name exactly as `libs/contracts/proto/inventory.proto` declares it. */
const SERVICE = 'InventoryService';

@Controller()
export class InventoryGrpcController extends GrpcControllerBase {
  constructor(private readonly inventory: InventoryService) {
    super();
  }

  @GrpcMethod(SERVICE, 'Reserve')
  async reserve(request: ReserveRequest): Promise<ReserveResponse> {
    const result = await this.inventory.reserve({
      orderId: request.orderId,
      lines: request.lines ?? [],
      warehouseId: request.warehouseId,
    });

    return {
      fullyAccepted: result.fullyAccepted,
      reserved: result.reserved.map((line) => ({
        sku: line.sku,
        qty: line.qty,
        reservationId: line.reservationId,
      })),
      rejected: result.rejected.map((line) => ({
        sku: line.sku,
        qty: line.qty,
        reason: line.reason,
      })),
    };
  }

  @GrpcMethod(SERVICE, 'Release')
  async release(request: ReleaseRequest): Promise<ReleaseResponse> {
    const result = await this.inventory.release({
      orderId: request.orderId,
      warehouseId: request.warehouseId,
    });

    return { releasedLines: result.releasedLines };
  }

  @GrpcMethod(SERVICE, 'Ship')
  async ship(request: ShipRequest): Promise<{ shipped: boolean }> {
    const result = await this.inventory.ship({
      orderId: request.orderId,
      lines: request.lines ?? [],
      warehouseId: request.warehouseId,
    });

    return { shipped: result.shipped };
  }

  @GrpcMethod(SERVICE, 'AdjustStock')
  async adjustStock(request: AdjustStockRequest): Promise<AdjustStockResponse> {
    const result = await this.inventory.adjustStock({
      sku: request.sku,
      delta: request.delta,
      adjustmentId: request.adjustmentId,
      reason: request.reason,
      warehouseId: request.warehouseId,
    });

    return { onHand: result.onHand, available: result.available };
  }

  @GrpcMethod(SERVICE, 'GetAvailable')
  async getAvailable(request: GetAvailableRequest): Promise<GetAvailableResponse> {
    const availability = await this.inventory.getAvailable({
      sku: request.sku,
      warehouseId: request.warehouseId,
    });

    return {
      sku: availability.sku,
      warehouseId: availability.warehouseId,
      onHand: availability.onHand,
      reserved: availability.reserved,
      safety: availability.safety,
      available: availability.available,
    };
  }
}
