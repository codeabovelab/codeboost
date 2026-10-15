import { defineConfig } from '@playwright/test';
// The review server runs in the test process. Its review loads no longer block that process, so test and assertion
// timeouts now include the server's real Git work (a merge click runs several review loads); allow for it.
export default defineConfig({ testDir: './test/browser', fullyParallel: false, workers: 1, timeout: 60_000, expect: { timeout: 15_000 }, use: { browserName:'chromium', viewport:{width:1512,height:982}, trace:'retain-on-failure' } });
