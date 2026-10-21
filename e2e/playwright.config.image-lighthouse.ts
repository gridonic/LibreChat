import path from 'node:path';
import { defineConfig } from '@playwright/test';
import lighthouseConfig from './playwright.config.lighthouse';

if (process.env.E2E_BASE_URL !== 'http://127.0.0.1:3101') {
  throw new Error('Image acceptance requires E2E_BASE_URL=http://127.0.0.1:3101');
}

export default defineConfig({
  ...lighthouseConfig,
  webServer: (Array.isArray(lighthouseConfig.webServer) ? lighthouseConfig.webServer : []).map(
    (server) => ({
      ...server,
      command: `node ${path.resolve(__dirname, 'setup/start-image.js')}`,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15000 },
    }),
  ),
});
