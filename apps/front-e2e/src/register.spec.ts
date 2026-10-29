import { test, expect, type Page } from '@playwright/test';

// Registration, through the browser that has to live with it. Unlike sign-in this walk needs
// no out-of-band setup — creating the account *is* the thing under test — and there are three
// outcomes only a person clicking can catch: the form's own validation, a refusal actually
// being shown rather than swallowed, and the session the page hands back through the fragment
// turning into a signed-in screen.
//
// The OAuth row is asserted too, from the other side: with no provider configured at the
// gateway the buttons must be absent rather than present-and-broken, which is a property of
// the deployment's configuration read at runtime, not of the bundle.

const stamp = Date.now();
const email = `ui-${stamp}-${Math.floor(Math.random() * 100000)}@example.test`;
const password = 'Str0ng-Passw0rd!x';
const takenEmail = `taken-${stamp}-${Math.floor(Math.random() * 100000)}@example.test`;

// Next's route announcer is itself `role="alert"`, so a bare `getByRole('alert')` resolves to
// two elements once a navigation has happened. The refusal these pages render lives inside the
// form — which is also where the person who has to read it is looking.
const formAlert = (page: Page) => page.locator('form [role="alert"]');

test.describe('registration against the real api-gateway', () => {
  test.beforeAll(async ({ playwright }) => {
    // The duplicate test needs an account that already exists. It is created through the
    // front's own route, so the fixture and the test exercise the same code path and can
    // never disagree about what a well-formed registration is.
    // The front's own origin — the same `BASE_URL` the config resolves, so the fixture talks
    // to the server these tests are actually driving.
    const front = process.env['BASE_URL'] ?? 'http://localhost:3000';
    const request = await playwright.request.newContext({ baseURL: front });
    const created = await request.post('/api/register', {
      data: { email: takenEmail, password },
    });
    expect(created.ok(), `fixture registration failed: ${created.status()}`).toBe(true);
    await request.dispose();
  });

  test('creating an account signs the caller in, and no provider row appears unconfigured', async ({
    page,
  }) => {
    await page.goto('/register');
    await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();

    await page.getByLabel('Email address').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByLabel('Display name').fill('UI Registration');
    await page.getByRole('button', { name: 'Create account' }).click();

    // Registration *is* a sign-in: the answer crosses in the fragment and the sign-in page
    // adopts it, so the destination is the signed-in card, not the form that was submitted.
    await expect(page.getByTestId('me-email')).toHaveText(email);
    await expect(page).toHaveURL('/');

    // The gateway reports no configured provider, so the buttons are absent — an unconfigured
    // deployment still has a working password form instead of a link that ends in a 503.
    await expect(page.getByTestId('oauth-google')).toHaveCount(0);
    await expect(page.getByTestId('oauth-github')).toHaveCount(0);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByLabel('Email')).toBeVisible();
  });

  test('a password the form cannot accept is refused before any request is made', async ({
    page,
  }) => {
    await page.goto('/register');
    await page.getByLabel('Email address').fill(`short-${stamp}@example.test`);
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();

    // The browser's own validation holds the form on the page — no refusal alert, and no
    // navigation to a signed-in screen.
    await expect(page).toHaveURL('/register');
    await expect(formAlert(page)).toHaveCount(0);
    await expect(page.getByLabel('Email address')).toHaveValue(`short-${stamp}@example.test`);
  });

  test('a duplicate email shows the gateway\'s sentence, not a generic failure', async ({
    page,
  }) => {
    await page.goto('/register');
    await page.getByLabel('Email address').fill(takenEmail);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(formAlert(page)).toHaveText('the resource already exists');
    // The refusal lands on the form that caused it, ready to be corrected.
    await expect(page).toHaveURL('/register');
    await expect(page.getByTestId('me-email')).toHaveCount(0);
  });

  test('an oauth failure fragment is shown as the alert and stripped from the address', async ({
    page,
  }) => {
    await page.goto(`/#oauth_error=${encodeURIComponent('Provider refused the request')}`);

    await expect(formAlert(page)).toHaveText('Provider refused the request');
    await expect(page).toHaveURL('/');
  });
});
