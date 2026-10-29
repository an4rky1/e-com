/**
 * @fileoverview Every `@Body()` parameter must reach Nest as its DTO class, not as an erasure.
 *
 * @remarks `emitDecoratorMetadata` reads the *value* binding of a parameter's type, and an
 * `import type` binding has no value — the metadata degrades to `Function`, ValidationPipe
 * then strips the body to `{}` and skips validation, and a sign-in arrives carrying no
 * credentials while everything reports success. The comment that claimed "a DTO class needs
 * nothing at runtime here" shipped exactly that bug; this pins the property it was wrong
 * about for every handler that reads a body, so the next import reshuffle fails here rather
 * than in a login nobody can perform.
 */
import 'reflect-metadata';
import { AuthController } from '../src/presentation/auth.controller';
import { UsersController } from '../src/presentation/users.controller';
import {
  CreateUserRequestDto,
  LoginRequestDto,
  LogoutRequestDto,
  RefreshRequestDto,
  RegisterRequestDto,
  SetPasswordRequestDto,
} from '../src/presentation/dto/gateway.dto';

interface BodyCase {
  readonly name: string;
  readonly controller: { prototype: object };
  readonly method: string;
  readonly dto: unknown;
}

const BODY_CASES: readonly BodyCase[] = [
  {
    name: 'AuthController.login',
    controller: AuthController,
    method: 'login',
    dto: LoginRequestDto,
  },
  {
    name: 'AuthController.register',
    controller: AuthController,
    method: 'register',
    dto: RegisterRequestDto,
  },
  {
    name: 'AuthController.refresh',
    controller: AuthController,
    method: 'refresh',
    dto: RefreshRequestDto,
  },
  {
    name: 'AuthController.logout',
    controller: AuthController,
    method: 'logout',
    dto: LogoutRequestDto,
  },
  {
    name: 'UsersController.create',
    controller: UsersController,
    method: 'create',
    dto: CreateUserRequestDto,
  },
  {
    name: 'UsersController.setPassword',
    controller: UsersController,
    method: 'setPassword',
    dto: SetPasswordRequestDto,
  },
];

/** How Nest reads it: `ContextUtils.reflectCallbackParamtypes` — metadata keyed by method. */
const paramtypesOf = (bodyCase: BodyCase): unknown[] | undefined =>
  Reflect.getMetadata(
    'design:paramtypes',
    bodyCase.controller.prototype,
    bodyCase.method,
  );

describe('@Body() parameters carry their DTO class into the metadata', () => {
  it.each(BODY_CASES)('$name takes its body as the DTO class', (bodyCase) => {
    expect(paramtypesOf(bodyCase)).toContain(bodyCase.dto);
  });

  it('has six body-reading handlers to check', () => {
    // An empty table would make every assertion above pass for the wrong reason.
    expect(BODY_CASES.length).toBe(6);
  });
});
