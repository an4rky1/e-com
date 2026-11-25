/**
 * @fileoverview The administrative role routes' composition.
 *
 * @remarks The guards are covered by `permissions.guard.spec` and the paths by the route
 * contract; what this file pins is the part only this controller owns — the paging defaults,
 * the wire shape, and the fact that the grant's `grantedBy` is the authenticated principal
 * rather than anything a caller can send.
 */
import { RoleAdministrationController } from '../src/presentation/role-administration.controller';
import type { GatewayService } from '../src/application/facade/gateway.service';
import type { GatewayPrincipal } from '../src/application/ports/gateway-principal';
import { USER_ID } from './testing/peer-doubles';

const principal: GatewayPrincipal = {
  userId: USER_ID,
  email: 'admin@example.com',
  sessionId: 'session-1',
};

const controllerWith = () => {
  const gateway = {
    listRoles: jest.fn().mockResolvedValue({
      roles: [
        {
          name: 'moderator',
          permissions: ['catalog:product.create'],
          description: 'Catalogue',
          isSystem: true,
        },
      ],
      total: 1,
      page: 2,
      limit: 5,
    }),
    grantRole: jest.fn().mockResolvedValue({ userId: USER_ID, roles: ['user', 'moderator'] }),
    revokeRole: jest.fn().mockResolvedValue({ userId: USER_ID, roles: ['user'] }),
  };

  return {
    controller: new RoleAdministrationController(gateway as unknown as GatewayService),
    gateway,
  };
};

describe('RoleAdministrationController', () => {
  it('maps the catalogue and applies the paging defaults', async () => {
    const { controller, gateway } = controllerWith();

    const response = await controller.list({ search: '  mod  ' });

    expect(gateway.listRoles).toHaveBeenCalledWith({
      search: 'mod',
      page: 1,
      limit: 20,
    });
    expect(response).toEqual({
      roles: [
        {
          name: 'moderator',
          permissions: ['catalog:product.create'],
          description: 'Catalogue',
          isSystem: true,
        },
      ],
      total: 1,
      page: 2,
      limit: 5,
    });
  });

  it('passes explicit paging through and refuses a non-positive value', async () => {
    const { controller, gateway } = controllerWith();

    await controller.list({ page: '3', limit: '0' });

    expect(gateway.listRoles).toHaveBeenCalledWith({
      search: undefined,
      page: 3,
      limit: 20,
    });
  });

  it('grants on behalf of the verified principal, never a body field', async () => {
    const { controller, gateway } = controllerWith();

    const response = await controller.grant(principal, USER_ID, { role: 'moderator' });

    expect(gateway.grantRole).toHaveBeenCalledWith(principal, {
      userId: USER_ID,
      role: 'moderator',
    });
    expect(response).toEqual({ userId: USER_ID, roles: ['user', 'moderator'] });
  });

  it('revokes the named role and answers with what remains', async () => {
    const { controller, gateway } = controllerWith();

    const response = await controller.revoke(USER_ID, { role: 'moderator' });

    expect(gateway.revokeRole).toHaveBeenCalledWith({
      userId: USER_ID,
      role: 'moderator',
    });
    expect(response).toEqual({ userId: USER_ID, roles: ['user'] });
  });
});
