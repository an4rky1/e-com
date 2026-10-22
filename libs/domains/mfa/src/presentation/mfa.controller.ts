/**
 * @fileoverview HTTP transport for the MFA service.
 *
 * @remarks Talks only to {@link MfaService}. It holds no business rule of its own — a check
 * that belongs in the aggregate does not belong here, where it would be bypassed by the gRPC
 * entry point.
 *
 * @remarks Every route reads the subject from the authenticated principal, never from the
 * body. A user id in a request body is an invitation to verify someone else's factor, and the
 * endpoint would still have to refuse it correctly on every path.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
// Value import: constructor-injected. `emitDecoratorMetadata` reads the emitted value
// binding, so a type-only import erases the DI token and Nest cannot resolve it.
import { MfaService } from '../application/facade/mfa.service';
import { MfaGuard } from './guards/mfa.guard';
import { SkipMfa } from './decorators/skip-mfa.decorator';
import {
  type BeginEnrollmentRequestDto,
  type ConfirmEnrollmentRequestDto,
  type DisableMfaRequestDto,
  type RegenerateRecoveryCodesRequestDto,
  type VerifyFactorRequestDto,
  toEnrollmentSecretResponse,
  toFactorResponse,
  toMfaStatusResponse,
  toRecoveryCodeResponse,
  toVerificationResponse,
  type EnrollmentSecretResponseDto,
  type FactorVerificationResponseDto,
  type MfaFactorResponseDto,
  type MfaStatusResponseDto,
  type RecoveryCodeResponseDto,
} from './dto/mfa.dto';

/** The slice of the request this transport reads. */
interface MfaRequest {
  user?: { readonly userId?: string; readonly sub?: string };
}

@Controller('mfa')
@UseGuards(MfaGuard)
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  /**
   * Reads the caller's subject, refusing a request with no principal.
   *
   * @remarks A missing principal means the route was mounted without the authentication guard
   * upstream — a deployment bug. Saying so is better than silently serving an empty status for
   * `undefined`, which looks like a working response.
   */
  private subjectOf(request: MfaRequest): string {
    const userId = request.user?.userId ?? request.user?.sub;
    if (!userId) {
      throw new Error('no authenticated principal on an /mfa route');
    }
    return userId;
  }

  @Get('status')
  async status(@Req() request: MfaRequest): Promise<MfaStatusResponseDto> {
    return toMfaStatusResponse(await this.mfa.getStatus(this.subjectOf(request)));
  }

  @Post('enrollments')
  async beginEnrollment(
    @Body() body: BeginEnrollmentRequestDto,
    @Req() request: MfaRequest,
  ): Promise<EnrollmentSecretResponseDto> {
    const bundle = await this.mfa.beginEnrollment({
      userId: this.subjectOf(request),
      method: body.method ?? 'totp',
      accountLabel: body.accountLabel ?? null,
    });
    return toEnrollmentSecretResponse(bundle);
  }

  @Post('enrollments/:factorId/confirm')
  async confirmEnrollment(
    @Param('factorId', ParseUUIDPipe) factorId: string,
    @Body() body: ConfirmEnrollmentRequestDto,
    @Req() request: MfaRequest,
  ): Promise<MfaFactorResponseDto> {
    return toFactorResponse(
      await this.mfa.confirmEnrollment({
        userId: this.subjectOf(request),
        factorId,
        code: body.code,
      }),
    );
  }

  /**
   * The second step of sign-in, and the step-up path.
   *
   * @remarks `SkipMfa` because the caller is *here to present* the second factor — a guard
   * demanding one before the challenge has been answered would lock every user out.
   *
   * @remarks A code may also arrive in `x-mfa-code` instead of the body, for callers that
   * cannot put a credential in a JSON payload they might log. The guard reads either.
   */
  @SkipMfa()
  @Post('verify')
  @HttpCode(200)
  async verify(
    @Body() body: VerifyFactorRequestDto,
    @Headers('x-mfa-code') headerCode?: string,
    @Req() request?: MfaRequest,
  ): Promise<FactorVerificationResponseDto> {
    return toVerificationResponse(
      await this.mfa.verifyFactor({
        userId: this.subjectOf(request as MfaRequest),
        code: headerCode ?? body.code,
        method: body.method ?? 'totp',
        factorId: body.factorId,
      }),
    );
  }

  @Delete('factors/:factorId')
  @HttpCode(204)
  async disable(
    @Param('factorId', ParseUUIDPipe) factorId: string,
    @Body() body: DisableMfaRequestDto,
    @Req() request: MfaRequest,
  ): Promise<void> {
    await this.mfa.disableMfa({
      userId: this.subjectOf(request),
      factorId,
      code: body.code,
    });
  }

  @Post('recovery-codes')
  async regenerateRecoveryCodes(
    @Body() body: RegenerateRecoveryCodesRequestDto,
    @Req() request: MfaRequest,
  ): Promise<RecoveryCodeResponseDto> {
    return toRecoveryCodeResponse(
      await this.mfa.regenerateRecoveryCodes({
        userId: this.subjectOf(request),
        count: body.count,
      }),
    );
  }
}