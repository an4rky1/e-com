/**
 * Stable name for the notification worker queue.
 *
 * @remarks The name is stable so that the consumer worker and any producer resolve the same name
 * from the BullMQ registry. Putting it in the infra lib — rather than in `notification` — keeps
 * the constant on the side of the system that owns queue naming, and out of the domain that owns
 * what a notification means.
 */
export const NOTIFICATION_WORKER_QUEUE = 'notification-worker' as const;

/**
 * Stable name for the notification dispatch queue.
 *
 * @remarks Deliberately not the same queue as {@link NOTIFICATION_WORKER_QUEUE}. The worker
 * queue runs resends and cancellations under a rate limiter — ten a minute, so a buggy client
 * cannot flood a provider. The dispatch queue carries the hot path: one job per consumed
 * Kafka event. Sharing a queue would put every welcome email behind the resend limiter.
 */
export const NOTIFICATION_DISPATCH_QUEUE = 'notification-dispatch' as const;
