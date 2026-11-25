import { Logger } from '@nestjs/common';
import { DEFAULT_SIGNUP_ROLE } from '@auth/contracts';
import type { AccessControlClientPort } from './ports/peer-clients.port';

export async function grantSignupRole(
  accessControl: AccessControlClientPort,
  logger: Logger,
  userId: string,
  grantedBy: string,
): Promise<void> {
  try {
    await accessControl.grantRole({
      userId,
      role: DEFAULT_SIGNUP_ROLE,
      grantedBy,
    });
  } catch (error) {
    logger.warn(
      `default role "${DEFAULT_SIGNUP_ROLE}" was not granted to user ${userId}: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
  }
}
