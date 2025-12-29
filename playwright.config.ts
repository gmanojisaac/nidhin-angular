import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  webServer: {
    command: 'npm run start -- --host 127.0.0.1 --port 4200',
    url: 'http://localhost:4200',
    reuseExistingServer: true
  },
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:4200',
    headless: true
  }
});
