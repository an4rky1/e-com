/**
 * @fileoverview The persisted record of one issued refresh token.
 *
 * @remarks This is the entity, not the secret. The plaintext lives in
 * {@link RefreshToken} for the length of one request; this row is what survives it, holding
 * only the digest. It is deliberately kept as a separate entity rather than a column or a
 * JSON blob on `sessions`, because a rotated token has its own lifecycle: it outlives the
 * session's usefulness to authenticate precisely so that its re-presentation can be
 * detected.
 */
import { Ensure } from '@auth/core';
import type { RefreshToken } from './value-objects/refresh-token.vo';
import { TokenDigester } from './value-objects/token-digester.vo';
import {
  CONSUMED_TOKEN_STATUSES,
  TokenStatus,
  TokenType,
} from './value-objects/token-status.vo';

export interface RefreshTokenProps {
  id: string;
  familyId: string;
  tokenType: TokenType;
  jti: string;
  digest: string;
  status: TokenStatus;
  issuedAt: Date;
  expiresAt: Date;
  /** Set when this token is exchanged: the id of the token that replaced it. */
  rotatedToTokenId: string | null;
  /** When the token stopped being usable — rotation or revocation, whichever came first. */
  retiredAt: Date | null;
  revokedAt: Date | null;
  version: number;
}

export interface NewRefreshToken {
  /** The secret. Never persisted, never logged, never returned from storage. */
  readonly token: RefreshToken;
  /** Supplied so replaying a write reproduces the original row. */
  readonly id?: string;
  readonly jti?: string;
}

export class IssuedRefreshToken {
  private constructor(private readonly props: RefreshTokenProps) {}

  static issue(input: {
    id?: string;
    familyId: string;
    /** The secret itself; the digest is derived here so no caller can skip it. */
    token: RefreshToken;
    /** Supplied by tests and by replay; otherwise a fresh `jti` is minted. */
    jti?: string;
    expiresAt: Date;
    now?: Date;
  }): IssuedRefreshToken {
    Ensure.notEmpty(input.familyId, 'token family id');

    const now = input.now ?? new Date();
    return new IssuedRefreshToken({
      id: input.id ?? crypto.randomUUID(),
      familyId: input.familyId,
      tokenType: TokenType.REFRESH,
      jti: input.jti ?? crypto.randomUUID(),
      // Computed here rather than by the caller: the one rule that must never be bypassed is
      // that a plaintext token never reaches storage.
      digest: TokenDigester.digest(input.token),
      status: TokenStatus.ACTIVE,
      issuedAt: now,
      expiresAt: input.expiresAt,
      rotatedToTokenId: null,
      retiredAt: null,
      revokedAt: null,
      version: 1,
    });
  }

  /** Rehydration from persistence. Does not validate: the row is already the truth. */
  static fromRow(row: {
    id: string;
    session_id: string;
    family_id: string;
    token_type: string;
    jti: string;
    token_digest: string | null;
    status: string;
    issued_at: Date;
    expires_at: Date;
    rotated_to_token_id: string | null;
    retired_at: Date | null;
    revoked_at: Date | null;
    version: number;
  }): IssuedRefreshToken {
    return new IssuedRefreshToken({
      id: row.id,
      familyId: row.family_id,
      tokenType: row.token_type as TokenType,
      jti: row.jti,
      // Nullable in the schema because a token may be recorded before it is hashed; a row
      // without a digest can never match a presented token, which is the safe direction.
      digest: row.token_digest ?? '',
      status: row.status as TokenStatus,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      rotatedToTokenId: row.rotated_to_token_id,
      retiredAt: row.retired_at,
      revokedAt: row.revoked_at,
      version: row.version,
    });
  }

  get id(): string {
    return this.props.id;
  }

  get familyId(): string {
    return this.props.familyId;
  }

  get jti(): string {
    return this.props.jti;
  }

  get digest(): string {
    return this.props.digest;
  }

  get tokenType(): TokenType {
    return this.props.tokenType;
  }

  get status(): TokenStatus {
    return this.props.status;
  }

  get issuedAt(): Date {
    return this.props.issuedAt;
  }

  get expiresAt(): Date {
    return this.props.expiresAt;
  }

  get rotatedToTokenId(): string | null {
    return this.props.rotatedToTokenId;
  }

  get retiredAt(): Date | null {
    return this.props.retiredAt;
  }

  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }

  get version(): number {
    return this.props.version;
  }

  isExpired(now: Date): boolean {
    return this.props.expiresAt.getTime() <= now.getTime();
  }

  /** Already exchanged or withdrawn. Its re-presentation is token reuse. */
  isConsumed(): boolean {
    return CONSUMED_TOKEN_STATUSES.has(this.props.status);
  }

  /**
   * Exchanges this token for its successor.
   *
   * @remarks Idempotence is refused rather than tolerated: a rotation that silently succeeds
   * twice would hand out two live tokens for one refresh, and the whole point of the family
   * chain is that a token is exchanged at most once.
   */
  rotateTo(nextTokenId: string, now: Date): void {
    Ensure.notEmpty(nextTokenId, 'next token id');

    this.props.status = TokenStatus.RETIRED;
    this.props.rotatedToTokenId = nextTokenId;
    this.props.retiredAt = now;
    this.props.version += 1;
  }

  /** Idempotent — logout paths race, and a second revoke must not bump the row version. */
  revoke(now: Date): void {
    if (this.props.status === TokenStatus.REVOKED) return;

    this.props.status = TokenStatus.REVOKED;
    this.props.revokedAt = now;
    this.props.retiredAt = this.props.retiredAt ?? now;
    this.props.version += 1;
  }
}