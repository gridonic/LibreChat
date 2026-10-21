import path from 'node:path';
import { defineConfig } from '@playwright/test';
import mockConfig from './playwright.config.mock';

if (process.env.E2E_BASE_URL !== 'http://127.0.0.1:3101') {
  throw new Error('Image acceptance requires E2E_BASE_URL=http://127.0.0.1:3101');
}

export default defineConfig({
  ...mockConfig,
  workers: 1,
  retries: 0,
  testMatch: ['**/mcp-oauth-subagent.spec.ts', '**/mcp-oauth-resume.spec.ts'],
  webServer: (Array.isArray(mockConfig.webServer) ? mockConfig.webServer : []).map((server) =>
    server.command.endsWith('start-server.js')
      ? { ...server, command: `node ${path.resolve(__dirname, 'setup/start-image.js')}` }
      : server,
  ),
});
