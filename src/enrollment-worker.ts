import { createServer } from 'node:http';
import { chmod, unlink } from 'node:fs/promises';
import { PhoneEnrollment, lanAddresses } from './enrollment.js';
import { controlPath } from './enrollment-control.js';
import { asObject } from './errors.js';
import { ENROLLMENT_MS } from './enrollment-profile.js';

const storage = process.argv[2];
if (!storage || !process.send) process.exit(1);
let session: PhoneEnrollment | undefined;
let ownedSocket = false;
let stopping = false;
const control = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(session?.status() ?? { state: 'starting' }));
  } else if (req.method === 'POST' && req.url === '/finish') {
    res.end(JSON.stringify({ state: 'idle' }));
    void stop();
  } else { res.writeHead(404); res.end(); }
});
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await session?.stop();
  control.close();
  if (ownedSocket) await unlink(controlPath(storage!)).catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
// This worker intentionally survives UI IPC disconnects, but never its enrollment deadline.
setTimeout(() => { void stop(); }, ENROLLMENT_MS + 5000).unref();
process.once('message', async (value: unknown) => {
  try {
    const input = asObject(value);
    if (typeof input.address !== 'string' || !lanAddresses().includes(input.address)
      || typeof input.ssid !== 'string' || typeof input.tokenPath !== 'string') throw new Error('Invalid setup.');
    await new Promise<void>((resolve, reject) => {
      control.once('error', reject);
      control.listen(controlPath(storage!), () => { ownedSocket = true; resolve(); });
    });
    await chmod(controlPath(storage!), 0o600);
    session = new PhoneEnrollment({ address: input.address, ssid: input.ssid, tokenPath: input.tokenPath,
      ...(typeof input.password === 'string' ? { password: input.password } : {}) });
    await session.start();
    if (process.connected) process.send?.(session.status(), () => {});
  } catch {
    if (process.connected) process.send?.({ state: 'error' }, () => { void stop(); });
    else await stop();
  }
});
