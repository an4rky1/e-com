/**
 * @fileoverview The public surface of the cart domain.
 *
 * @remarks The barrel is deliberately explicit rather than `export *`: a consumer
 * importing from here should be able to see, in one screen, the whole contract this
 * service offers — and a wildcard would quietly widen it every time a helper is added
 * under `src/`.
 *
 * @remarks Three audiences. {@link CartService} is what an application calls; the
 * controller and the module factory are what `apps/cart` wires; everything else exists so
 * a test in another service can assert against the same rules.
 */

// ---- configuration -------------------------------------------------------------
export {
  CART_CONFIG,
  Defaults as CartDefaults,
  cartSchema,
  resolveCartConfig,
  type CartConfig,
  type CartEnvConfig,
} from './cart.config';

// ---- module --------------------------------------------------------------------
export {
  CART_MODULE_OPTIONS,
  CartModule,
  createCartModule,
  type CartModuleOptions,
} from './cart.module';
export { CartHealthIndicator } from './cart.health';

// ---- commands ------------------------------------------------------------------
export {
  AddItemCommand,
  ClearCartCommand,
  RemoveItemCommand,
  UpdateItemQtyCommand,
} from './application/commands/cart.commands';
export { AddItemHandler } from './application/commands/add-item.handler';
export { UpdateItemQtyHandler } from './application/commands/update-item-qty.handler';
export { RemoveItemHandler } from './application/commands/remove-item.handler';
export { ClearCartHandler } from './application/commands/clear-cart.handler';

// ---- queries -------------------------------------------------------------------
export {
  GetCartHandler,
  GetCartQuery,
  GetCheckoutLinesHandler,
  GetCheckoutLinesQuery,
  ValidateForCheckoutHandler,
  ValidateForCheckoutQuery,
} from './application/queries/cart.queries';

// ---- application ---------------------------------------------------------------
export { CartService } from './application/facade/cart.service';
export { CartWorkspace } from './application/cart-workspace';
export {
  buildCartReadModel,
  buildCheckoutLines,
  buildCheckoutValidation,
  type CartItemReadModel,
  type CartReadModel,
  type CartViewDeps,
  type CheckoutLineReadModel,
  type CheckoutLinesReadModel,
  type CheckoutValidationReadModel,
  type PriceChangeReadModel,
} from './application/cart-read-model';

// ---- domain --------------------------------------------------------------------
export {
  CART_STATUSES,
  Cart,
  isCartStatus,
  type CartAddress,
  type CartLimits,
  type CartStatus,
  type StoredCart,
  type StoredCartItem,
} from './domain/cart.aggregate';
export {
  CartItem,
  type CartItemLimits,
  type CartItemProps,
  type NewCartItemInput,
} from './domain/cart-item';
export {
  lockNamesFor,
  resolveCartOwner,
  type CartIdentity,
  type CartOwner,
} from './domain/cart-owner';
export {
  CART_LOCK,
  type CartLockPort,
} from './domain/ports/cart-lock.port';
export {
  CART_STORE,
  type CartStorePort,
  type SaveCartInput,
} from './domain/ports/cart-store.port';
export {
  PRODUCT_PRICING,
  type CurrentPrice,
  type ProductPricingPort,
  type SellableSku,
} from './domain/ports/product-pricing.port';

// ---- money ---------------------------------------------------------------------
export { parseShopMoney, toShopMoney } from './money';

// ---- presentation --------------------------------------------------------------
export { CartGrpcController } from './presentation/grpc/cart.grpc.controller';

// ---- infrastructure ------------------------------------------------------------
export { RedisCartStore } from './infrastructure/persistence/redis-cart.store';
export { CartLockAdapter } from './infrastructure/locking/cart-lock.adapter';
export { GrpcCatalogPricing } from './infrastructure/pricing/grpc-catalog-pricing';
