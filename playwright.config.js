const { defineConfig } = require('@playwright/test');

const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const executablePath = EDGE_PATHS.find((p) => require('fs').existsSync(p));

module.exports = defineConfig({
  testDir: './test/browser',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:3900',
    headless: true,
    launchOptions: executablePath ? { executablePath } : { channel: 'msedge' },
  },
  webServer: {
    command: 'node server.js',
    url: 'http://127.0.0.1:3900',
    reuseExistingServer: true,
    env: { PORT: '3900' },
    timeout: 30000,
  },
});