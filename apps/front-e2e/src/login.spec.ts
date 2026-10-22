import { test, expect } from '@playwright/test';

// The same surface `tools/e2e-gateway.sh` drives over curl, now through the browser: the front
// is the only component whose bugs the API cannot catch — a form that posts the wrong field, a
// token that lands in the wrong place, a refusal that is never shown.
//
// The account is created and its password set out-of-band, exactly as the bash harness does it.
// The gateway deliberately refuses `POST /users/:id/password` to the account's own caller —
// that refusal is the privilege boundary — so a front cannot sign anyone in without a password
// that already exists somewhere else.

const email = `front-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.test`;
const password = 'Str0ng-Passw0rd!x';
// The account is created against the *gateway*, not against the front. `GATEWAY_URL` is the
// address the harness exported: a silent default here would post `/users` to whatever port
// happened to be free, and the failure would read as "the gateway refused the account".
const gatewayURL = process.env['GATEWAY_URL'];
if (!gatewayURL) {
  throw new Error('GATEWAY_URL must be set — tools/e2e-front.sh exports it');
}

test.describe('sign-in against the real api-gateway', () => {
  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ baseURL: gatewayURL });

    // identity creates the account over REST; the response carries the id the vault needs.
    const created = await request.post('/users', { data: { email } });
    expect(created.ok(), `account creation failed: ${created.status()}`).toBe(true);
    const { id } = (await created.json()) as { id: string };

    // credential-vault stores the password over gRPC. The front has no access to this port and
    // must not: a browser that could set its own password would make the privilege boundary a
    // client-side concern. This is the one place the test reaches past the edge, and it does
    // so with the same helper the bash harness uses.
    const { execFileSync } = await import('node:child_process');
    execFileSync(
      'npx',
      [
        'ts-node',
        '--transpile-only',
        '-r',
        'tsconfig-paths/register',
        'tools/e2e/grpc-flow.ts',
        'set-password',
        id,
        password,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TS_NODE_PROJECT: 'tsconfig.backend.base.json',
        },
        stdio: 'pipe',
      },
    );

    await request.dispose();
  });

  test('a wrong password is refused, and the refusal is shown', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Auth platform' })).toBeVisible();

    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // The gateway answers 401 with no token. The form must still be usable after it.
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByTestId('me-email')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  test('the correct password signs in and shows the caller', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByTestId('me-email')).toHaveText(email);
    // The caller is nested under `user` at the edge, so this is the same id the harness holds.
    await expect(page.getByTestId('me-id')).not.toBeEmpty();

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByLabel('Email')).toBeVisible();
  });
});
