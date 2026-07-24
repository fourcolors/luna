/**
 * Spawn Moon with embedded WebDriver (feature wdio-e2e) and wait until ready.
 * Avoids @wdio/tauri-service (broken nested dep on @wdio/native-utils@2.4).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');

export function resolveAppBinary() {
  const binaryName = process.platform === 'win32' ? 'luna-moon-ui.exe' : 'luna-moon-ui';
  const profile = process.env.MOON_E2E_PROFILE === 'release' ? 'release' : 'debug';
  return path.join(appRoot, 'src-tauri', 'target', profile, binaryName);
}

export function resolveWebDriverPort() {
  return Number(process.env.TAURI_WEBDRIVER_PORT || 4445);
}

function waitForPort(port, host = '127.0.0.1', timeoutMs = 60_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.connect({ port, host }, () => {
        socket.end();
        resolve();
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`WebDriver port ${port} not open within ${timeoutMs}ms`));
          return;
        }
        setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

/**
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, port: number, binary: string }>}
 */
export async function spawnMoonWithWebDriver() {
  const binary = resolveAppBinary();
  if (!fs.existsSync(binary)) {
    throw new Error(
      `Moon binary missing: ${binary}\nRun: bun run test:e2e:build  (cargo --features wdio-e2e)`,
    );
  }
  const port = resolveWebDriverPort();
  const env = {
    ...process.env,
    TAURI_WEBDRIVER_PORT: String(port),
    // Reduce noise / avoid reusing a second profile if set
    RUST_LOG: process.env.RUST_LOG || 'info',
  };

  const child = spawn(binary, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => {
    stdout += d.toString();
    if (process.env.MOON_E2E_LOG === 'debug') process.stdout.write(d);
  });
  child.stderr?.on('data', (d) => {
    stderr += d.toString();
    if (process.env.MOON_E2E_LOG === 'debug') process.stderr.write(d);
  });

  child.on('exit', (code, signal) => {
    if (process.env.MOON_E2E_LOG === 'debug') {
      console.error(`[moon-e2e] app exited code=${code} signal=${signal}`);
    }
  });

  try {
    await waitForPort(port);
  } catch (err) {
    try {
      child.kill('SIGTERM');
    } catch (_) {}
    const tail = (stdout + '\n' + stderr).slice(-4000);
    throw new Error(`${err.message}\n--- app output (tail) ---\n${tail}`);
  }

  // Brief settle for first webview paint
  await new Promise((r) => setTimeout(r, 600));

  return { child, port, binary };
}

export function stopMoon(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch (_) {}
  // Hard kill after a short grace if needed
  setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL');
    } catch (_) {}
  }, 2000).unref?.();
}
