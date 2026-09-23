import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './test/browser', fullyParallel: false, workers: 1, use: { browserName:'chromium', viewport:{width:1512,height:982}, trace:'retain-on-failure' } });
