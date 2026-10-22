import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { workspaceRoot } from '@nx/devkit';

// For CI, you may want to set BASE_URL to the deployed application.
const baseURL = process.env['BASE_URL'] || 'http://localhost:3000';

// The address the *harness* uses to reach the gateway. The browser never sees it: the front
// proxies through its own origin, so this is only for the setup that creates an account and
// stores a password before a test signs in. Exported by `tools/e2e-front.sh`.
const gatewayURL = process.env['GATEWAY_URL'] ?? 'http://127.0.0.1:37000';

/**
 * See https://playwright.dev/docs/test-configuration.
 *
 * Generated as a .mts file so Node forces ESM regardless of workspace
 * `type`. Playwright routes `.mts` through its ESM loader (dynamic import,
 * bypassing the pirates CJS-compile path), and Nx's native TS strip loads
 * `.mts` directly. Playwright's configLoader auto-discovers
 * `playwright.config.mts` via its extension list
 * (.ts/.js/.mts/.mjs/.cts/.cjs).
 */
export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './src' }),
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    baseURL,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },
  /* Run your local dev server before starting the tests */
  webServer: {
    command: 'npx nx run @front/front:dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    cwd: workspaceRoot,
    env: {
      // The front refuses to build its rewrite without a gateway address, and the browser
      // only ever reaches `/api/*` on its own origin — so this is where the port is bound.
      GATEWAY_URL: gatewayURL,
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // On NixOS the browsers Playwright downloads do not link: the shared libraries they
        // need (`libglib`, `libnss`, …) are not on the system. A chromium built by nixpkgs
        // carries its own; when the harness exports `CHROMIUM_EXECUTABLE` Playwright runs
        // that binary instead of the cached one.
        ...(process.env['CHROMIUM_EXECUTABLE']
          ? {
              launchOptions: {
                executablePath: process.env['CHROMIUM_EXECUTABLE'],
                args: ['--no-sandbox'],
              },
            }
          : {}),
      },
    },
  ],
});
