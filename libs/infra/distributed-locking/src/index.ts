export {
  Defaults,
  LOCKING_CONFIG,
  resolveLockingConfig,
  type LockingConfig,
  type LockingEnvConfig,
} from './distributed-locking.config';
export { DistributedLockingModule } from './distributed-locking.module';
export {
  DistributedLockingService,
  LockTimeoutError,
  type DistributedLock,
  type LockHandle,
} from './distributed-locking.service';
