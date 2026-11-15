import { request } from 'node:http';
import { fork } from 'node:child_process';
import { chmod, mkdir, unlink, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { EnrollmentOptions } from './enrollment.js';
import { asObject } from './errors.js';

export function controlPath(storage: string): string { return join(storage, '.myq-enrollment', 'control.sock'); }

export async function setupRequest(storage: string, path: '/status' | '/finish'): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: controlPath(storage), agent: false, path, method: path === '/finish' ? 'POST' : 'GET', timeout: 3000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; if (body.length > 32_000) res.destroy(); });
      res.on('error', reject);
      res.on('end', () => { try { resolve(asObject(JSON.parse(body) as unknown)); } catch { reject(new Error('Invalid setup status.')); } });
    });
    req.on('timeout', () => req.destroy(new Error('Setup status timed out.')));
    req.on('error', error => {
      if ('code' in error && ['ENOENT', 'ECONNREFUSED'].includes(String(error.code))) resolve({ state: 'idle' });
      else reject(error);
    });
    req.end();
  });
}

/** The timed worker survives closing Homebridge settings or switching phone apps. */
export async function startSetup(storage: string, options: EnrollmentOptions): Promise<Record<string, unknown>> {
  const directory = join(storage, '.myq-enrollment');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const startup = join(directory, 'starting');
  const previous = await stat(startup).catch(() => undefined);
  if (previous && Date.now() - previous.mtimeMs > 30_000) await unlink(startup).catch(() => {});
  const lock = await open(startup, 'wx', 0o600).catch(() => { throw new Error('Another myQ setup session is starting. Try again shortly.'); });
  try {
  if ((await setupRequest(storage, '/status')).state !== 'idle') throw new Error('Another myQ setup session is active. Finish it before starting again.');
  await unlink(controlPath(storage)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return await new Promise((resolve, reject) => {
    const child = fork(new URL('./enrollment-worker.js', import.meta.url), [storage], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
    });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Phone setup could not start.')); }, 15_000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('Phone setup worker failed.')); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Phone setup worker stopped.')); });
    child.once('message', (message: unknown) => {
      clearTimeout(timer);
      const data = asObject(message);
      if (data.state === 'error') { child.kill('SIGTERM'); reject(new Error('Unable to start phone setup. Check your LAN address and token directory.')); }
      else { child.disconnect(); child.unref(); resolve(data); }
    });
    child.send(options);
  });
  } finally { await lock.close(); await unlink(startup).catch(() => {}); }
}
