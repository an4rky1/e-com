/**
 * @fileoverview Full gRPC method paths, so a mistyped service name fails here rather than
 * at the broker.
 *
 * @remarks Shared by the auth and shop adapters: both name paths from this one map, and a
 * renamed proto method becomes a compile error in both files at once instead of a runtime
 * "method is absent from the loaded proto definition" that only appears in production.
 */
export const METHOD = {
  START_FLOW: '/auth_flow.v1.AuthFlowService/StartFlow',
  ADVANCE_FLOW: '/auth_flow.v1.AuthFlowService/AdvanceFlow',
  CREATE_USER: '/identity.v1.IdentityService/CreateUser',
  ACQUIRE_GUEST_USER: '/identity.v1.IdentityService/AcquireGuestUser',
  GET_USER: '/identity.v1.IdentityService/GetUser',
  RESOLVE_OAUTH_USER: '/identity.v1.IdentityService/ResolveOauthUser',
  GET_PERMISSIONS: '/access_control.v1.AccessControlService/GetPermissions',
  CHECK_PERMISSION: '/access_control.v1.AccessControlService/CheckPermission',
  GRANT_ROLE: '/access_control.v1.AccessControlService/GrantRole',
  REVOKE_ROLE: '/access_control.v1.AccessControlService/RevokeRole',
  LIST_ROLES: '/access_control.v1.AccessControlService/ListRoles',
  ISSUE_TOKENS: '/session.v1.SessionService/IssueTokens',
  ROTATE_TOKENS: '/session.v1.SessionService/RotateTokens',
  REVOKE_SESSION: '/session.v1.SessionService/RevokeSession',
  REVOKE_ALL_SESSIONS: '/session.v1.SessionService/RevokeAllSessions',
  SET_PASSWORD: '/credential_vault.v1.CredentialVaultService/SetPassword',
  REVOKE_ALL_CREDENTIALS: '/credential_vault.v1.CredentialVaultService/RevokeAllCredentials',
  LIST_PRODUCTS: '/catalog.v1.CatalogService/ListByCategory',
  SEARCH_PRODUCTS: '/catalog.v1.CatalogService/SearchProducts',
  GET_PRODUCT: '/catalog.v1.CatalogService/GetProduct',
  CREATE_PRODUCT: '/catalog.v1.CatalogService/CreateProduct',
  SET_VARIANT_PRICE: '/catalog.v1.CatalogService/SetVariantPrice',
  CART_GET: '/cart.v1.CartService/GetCart',
  CART_ADD_ITEM: '/cart.v1.CartService/AddItem',
  CART_UPDATE_QTY: '/cart.v1.CartService/UpdateItemQty',
  CART_REMOVE_ITEM: '/cart.v1.CartService/RemoveItem',
  CART_CLEAR: '/cart.v1.CartService/ClearCart',
  CART_MERGE_GUEST: '/cart.v1.CartService/MergeGuestCart',
  CART_CHECKOUT_LINES: '/cart.v1.CartService/GetCheckoutLines',
  CART_VALIDATE: '/cart.v1.CartService/ValidateForCheckout',
  ORDER_CREATE: '/order.v1.OrderService/CreateOrder',
  ORDER_GET: '/order.v1.OrderService/GetOrder',
  ORDER_LIST: '/order.v1.OrderService/ListUserOrders',
  ORDER_CANCEL: '/order.v1.OrderService/CancelOrder',
  BILLING_PREVIEW: '/billing.v1.BillingService/PreviewTotals',
  BILLING_HANDLE_WEBHOOK: '/billing.v1.BillingService/HandlePaymentWebhook',
} as const;
