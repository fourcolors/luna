/**
 * WebdriverIO against Moon's embedded WebDriver (tauri-plugin-wdio-webdriver).
 *
 * We spawn the binary ourselves (see spawn-app.mjs) instead of @wdio/tauri-service,
 * which currently pulls a broken @wdio/native-utils@2.4 pin (missing export).
 *
 * Docs: https://v2.tauri.app/develop/tests/webdriver/
 */
import { spawnMoonWithWebDriver, stopMoon, resolveWebDriverPort } from './spawn-app.mjs';

/** @type {import('node:child_process').ChildProcess | null} */
let appChild = null;

/** @type {import('@wdio/types').Options.Testrunner} */
export const config = {
  runner: 'local',
  specs: ['./specs/**/*.spec.mjs'],
  maxInstances: 1,
  hostname: '127.0.0.1',
  port: resolveWebDriverPort(),
  path: '/',
  capabilities: [
    {
      // Embedded server accepts a session without a remote browser binary.
      browserName: 'w3c',
      // Some drivers want empty browserName; plugin docs use connection only.
    },
  ],
  logLevel: process.env.MOON_E2E_LOG || 'info',
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 60_000,
  connectionRetryCount: 2,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 120_000,
  },

  onPrepare: async () => {
    const { child, port, binary } = await spawnMoonWithWebDriver();
    appChild = child;
    console.log(`[moon-e2e] spawned ${binary} (WebDriver :${port}, pid ${child.pid})`);
  },

  onComplete: async () => {
    stopMoon(appChild);
    appChild = null;
  },

  before: async () => {
    await browser.pause(400);
  },
};
