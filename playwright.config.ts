import { defineConfig } from '@playwright/test';
// The review server runs in the test process. Its review loads no longer block that process, so test and assertion
// timeouts now include the server's real Git work (a merge click runs several review loads); allow for it.
// `forbidOnly` makes Playwright refuse a `test.only` (or `describe.only`) left in a spec, which would otherwise run
// only that test and let the CI `test` job pass. `test/vitest-config.test.ts` pins this whole config.
export default defineConfig({ testDir: './test/browser', forbidOnly: true, fullyParallel: false, workers: 1, timeout: 60_000, expect: { timeout: 15_000 }, use: { browserName:'chromium', viewport:{width:1512,height:982}, trace:'retain-on-failure' } });
