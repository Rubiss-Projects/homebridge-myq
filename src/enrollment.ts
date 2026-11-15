import { renameSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Socket } from 'node:net';
import { CLIENT_ID, saveTokens, tokenResponse } from './auth.js';
import { MyQClient } from './client.js';
import { enrollmentActive } from './enrollment-lock.js';
import { AUTH_HOSTS, MYQ_DOMAINS, ENROLLMENT_MS, enrollmentCertificate, iphoneProfile, pacFile, xml } from './enrollment-profile.js';

const POST_PATHS = new Set(['/connect/token', '/connect/authorize', '/connect/revocation', '/connect/endsession',
  '/account/login', '/account/logout', '/account/verify', '/account/verifycode', '/account/sendverificationcode',
  '/api/v1.0/externalaccounts/isssoenabledfordomain', '/account/loginwithemail', '/accountmfa/verifyotp']);
const MAX_BODY = 2 * 1024 * 1024;
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'accept-encoding']);

export function myqHost(host: string): boolean {
  return MYQ_DOMAINS.some(domain => host === domain || (host.endsWith(`.${domain}`)
    && /^[a-z0-9-]+$/.test(host.slice(0, -(domain.length + 1)))));
}

export function allowedSignIn(host: string, method: string, pathname: string): boolean {
  if (!myqHost(host) || /%(?:2f|5c|2e)/i.test(pathname)) return false;
  const path = pathname.toLowerCase().replace(/\/$/, '');
  if (/\/(open|close|toggle|commands?|actions?|execute|setstate)(\/|$)/.test(path)) return false;
  return ['GET', 'HEAD', 'OPTIONS'].includes(method)
    || (AUTH_HOSTS.includes(host) && method === 'POST' && (POST_PATHS.has(path) || path.startsWith('/cdn-cgi/challenge-platform/')));
}

export function lanAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap(list => list ?? [])
    .filter(n => n.family === 'IPv4' && !n.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address))
    .map(n => n.address);
}


async function limitedBody(message: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of message) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Response exceeded setup limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export interface EnrollmentOptions { address: string; ssid: string; password?: string; tokenPath: string }
export type EnrollmentState = 'waiting' | 'phone-connected' | 'signing-in' | 'validating' | 'connected' | 'failed' | 'cancelled' | 'expired';

/** A short-lived, one-phone listener. It never accepts arbitrary forwarding targets. */
export class PhoneEnrollment {
  readonly id = randomBytes(24).toString('hex');
  readonly expiresAt = Date.now() + ENROLLMENT_MS;
  private state: EnrollmentState = 'waiting';
  private message = 'Scan the QR code with your iPhone.';
  private phoneAddress: string | undefined;
  private certificate = enrollmentCertificate(this.expiresAt);
  private readonly sockets = new Set<Socket>();
  private readonly abort = new AbortController();
  private readonly web = createServer((req, res) => { void this.page(req, res).catch(() => this.reply(res, 500, 'Setup request failed.')); });
  private readonly tls = createTlsServer({ key: this.certificate.key, cert: this.certificate.cert, minVersion: 'TLSv1.2' },
    (req, res) => { void this.forward(req, res).catch(() => {
      this.diagnostics.upstreamErrors++;
      this.reply(res, 502, 'myQ sign-in could not be reached.');
    }); });
  private timer: NodeJS.Timeout | undefined;
  private port = 0;
  private busy = false;
  private profile = '';
  private diagnostics = { profileDownloads: 0, pacRequests: 0, phoneRebindings: 0, connectAllowed: 0, connectBlocked: 0, tlsErrors: 0, requestsAllowed: 0, requestsBlocked: 0, upstreamErrors: 0, lastHost: '', lastMethod: '', lastStatus: 0 };

  constructor(private readonly options: EnrollmentOptions, private readonly fetcher: typeof fetch = fetch) {}

  async start(): Promise<void> {
    if (!this.options.ssid.trim() || Buffer.byteLength(this.options.ssid) > 32) throw new Error('Enter your iPhone Wi-Fi network name (up to 32 bytes).');
    await mkdir(dirname(this.options.tokenPath), { recursive: true, mode: 0o700 });
    if (await enrollmentActive(this.options.tokenPath)) throw new Error('Another myQ setup session is active. Finish it or wait 15 minutes.');
    await writeFile(`${this.options.tokenPath}.enrollment-lock`, JSON.stringify({ id: this.id, expiresAt: this.expiresAt }), { mode: 0o600 });
    this.web.on('connection', socket => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.setTimeout(30_000, () => socket.destroy());
    });
    this.web.on('connect', (req, socket, head) => {
      const allowed = this.capturing() && req.socket.remoteAddress === this.phoneAddress
        && !!req.url?.endsWith(':443') && myqHost(req.url.slice(0, -4));
      if (allowed) this.diagnostics.connectAllowed++;
      else this.diagnostics.connectBlocked++;
      if (!allowed) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nmyQ setup allows sign-in only.'); return; }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.unshift(head);
      this.tls.emit('connection', socket);
    });
    this.web.on('upgrade', (_req, socket) => socket.destroy());
    this.tls.on('upgrade', (_req, socket) => socket.destroy());
    this.tls.on('tlsClientError', () => {
      this.diagnostics.tlsErrors++;
      if (this.capturing()) this.message = 'Enable full trust for the temporary setup certificate in Settings → General → About → Certificate Trust Settings.';
    });
    try {
      await new Promise<void>((resolve, reject) => {
        this.web.once('error', reject);
        this.web.listen(0, this.options.address, () => { this.web.removeListener('error', reject); resolve(); });
      });
      const address = this.web.address();
      if (!address || typeof address === 'string') throw new Error('Unable to start phone setup.');
      this.port = address.port;
      this.profile = iphoneProfile({ id: this.id, ssid: this.options.ssid,
        ...(this.options.password ? { password: this.options.password } : {}),
        pacUrl: `${this.url}/proxy.pac`, certificate: this.certificate.der,
        certificateName: this.certificate.name, expiresAt: this.expiresAt });
      delete this.options.password;
      this.timer = setTimeout(() => { void this.stop('expired'); }, ENROLLMENT_MS);
      this.timer.unref();
    } catch (error) { await this.stop('failed'); throw error; }
  }

  get url(): string { return `http://${this.options.address}:${this.port}/${this.id}`; }

  status() {
    return { state: this.state, message: this.message, expiresAt: this.expiresAt,
      url: this.url, certificateName: this.certificate.name, diagnostics: { ...this.diagnostics } };
  }

  private capturing(): boolean { return !['connected', 'cancelled', 'expired', 'failed'].includes(this.state) && Date.now() < this.expiresAt; }

  private reply(res: ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8'): void {
    if (res.headersSent || res.destroyed) { res.end(); return; }
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  }

  private async page(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' || !req.url || (req.url !== `/${this.id}` && !req.url.startsWith(`/${this.id}/`))) {
      this.reply(res, 404, 'Not found.'); return;
    }
    // A Wi-Fi profile may change the phone's private MAC and DHCP address. The
    // unguessable PAC URL proves possession of the installed profile after reconnecting.
    if (req.url === `/${this.id}/proxy.pac`) {
      this.diagnostics.pacRequests++;
      if (this.phoneAddress && this.phoneAddress !== req.socket.remoteAddress) this.diagnostics.phoneRebindings++;
      this.phoneAddress = req.socket.remoteAddress;
      if (this.capturing()) this.message = 'Temporary Wi-Fi routing is connected. Enable certificate trust, then sign into myQ.';
      this.reply(res, 200, pacFile(this.options.address, this.port, this.capturing()), 'application/x-ns-proxy-autoconfig');
      return;
    }
    // The QR's random capability may be claimed by one device on the private LAN.
    if (!this.phoneAddress) { this.phoneAddress = req.socket.remoteAddress; this.state = 'phone-connected'; }
    if (req.socket.remoteAddress !== this.phoneAddress) { this.reply(res, 403, 'This setup is already open on another device.'); return; }
    if (req.url.endsWith('/profile.mobileconfig')) {
      this.diagnostics.profileDownloads++;
      res.setHeader('Content-Disposition', 'attachment; filename="myq-setup.mobileconfig"');
      this.reply(res, 200, this.profile, 'application/x-apple-aspen-config'); return;
    }
    if (req.url.endsWith('/status')) { this.reply(res, 200, JSON.stringify(this.status()), 'application/json'); return; }
    this.reply(res, 200, `<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect myQ</title>
<style>body{font:17px system-ui;max-width:38rem;padding:24px;margin:auto;line-height:1.5}li{margin:16px 0}a{color:#1765ba}#state{padding:16px;background:#e7f1ff;color:#172b40;border-radius:12px}</style>
<h1>Connect myQ</h1><p>Use your trusted home Wi-Fi. These temporary settings let Homebridge receive your myQ sign-in credentials. They expire in 15 minutes.</p>
<ol><li><a href="${this.id}/profile.mobileconfig">Download temporary settings</a>. Then open <b>Settings → General → VPN &amp; Device Management</b> and install <b>myQ Temporary Setup</b>. Your iPhone may ask for its passcode and Wi-Fi password.</li>
<li>Open <b>Settings → General → About → Certificate Trust Settings</b>. Enable full trust for <b>${xml(this.certificate.name)}</b>.</li>
<li>Open the official <b>myQ</b> app. <b>Sign out, then sign back in</b> and complete verification. Do not use door controls. The device list may be unavailable until you remove these temporary settings.</li>
<li>Return here. When connected, remove <b>myQ Temporary Setup</b> in <b>Settings → General → VPN &amp; Device Management</b>. This removes its certificate and Wi-Fi proxy settings. Verify your normal Wi-Fi connection afterward.</li></ol>
<p id="state">Waiting for sign-in…</p><p>No tokens to copy. Homebridge renews this session automatically while myQ permits it.</p>
<script>const state=document.getElementById('state');async function poll(){try{const r=await fetch(location.pathname+'/status');if(!r.ok)throw Error();const s=await r.json();state.textContent=s.message;if(s.state==='connected')state.textContent+=' Remove the temporary profile now.';}catch{state.textContent='Setup ended or the connection was lost. Remove myQ Temporary Setup in Settings, then check Homebridge.';}}poll();setInterval(poll,2500);</script></html>`, 'text/html; charset=utf-8');
  }

  private async forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = (req.headers.host ?? '').replace(/:443$/, '');
    const rawPath = req.url ?? '/';
    if (!rawPath.startsWith('/') || rawPath.startsWith('//') || !this.capturing() || req.socket.remoteAddress !== this.phoneAddress) {
      this.reply(res, 403, 'Setup is not accepting sign-in requests.'); return;
    }
    const url = new URL(rawPath, `https://${host}`);
    if (url.hostname !== host || !allowedSignIn(host, req.method ?? '', url.pathname)) {
      this.diagnostics.requestsBlocked++;
      this.diagnostics.lastHost = myqHost(host) ? host : '';
      this.diagnostics.lastMethod = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method ?? '') ? req.method! : '';
      this.reply(res, 403, 'myQ setup blocks device changes.'); return;
    }
    this.diagnostics.requestsAllowed++;
    this.diagnostics.lastHost = host;
    this.diagnostics.lastMethod = req.method ?? '';
    if (AUTH_HOSTS.includes(host)) {
      this.state = this.busy ? 'validating' : 'signing-in';
      this.message = 'myQ sign-in reached Homebridge. Complete login and verification in the app.';
    }
    const body = await limitedBody(req);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_HEADERS.has(key) && value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    headers.set('Accept-Encoding', 'identity');
    const upstream = await this.fetcher(url, { method: req.method ?? 'GET', headers,
      ...(body.length ? { body: new Uint8Array(body) } : {}), redirect: 'manual',
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]) });
    this.diagnostics.lastStatus = upstream.status;
    const bytes = upstream.body ? await limitedBody(upstream.body) : Buffer.alloc(0);
    const outgoing: Record<string, string | string[]> = {};
    upstream.headers.forEach((value, key) => {
      if (!HOP_HEADERS.has(key) && !['content-encoding', 'set-cookie'].includes(key)) outgoing[key] = value;
    });
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length) outgoing['set-cookie'] = cookies;
    res.writeHead(upstream.status, outgoing);
    res.end(bytes);
    if (host === AUTH_HOSTS[0] && url.pathname === '/connect/token' && req.method === 'POST' && upstream.status === 200) {
      const form = new URLSearchParams(body.toString('utf8'));
      if (form.get('client_id') === CLIENT_ID && form.get('grant_type') === 'authorization_code') {
        await this.importResponse(bytes);
      } else {
        this.message = 'Existing session detected. Sign out and sign back into myQ to create a fresh Homebridge session.';
      }
    }
  }

  private async importResponse(bytes: Buffer): Promise<void> {
    if (this.busy || !this.capturing()) return;
    this.busy = true;
    this.state = 'validating';
    this.message = 'Sign-in received. Checking account access without moving the door…';
    const candidate = `${this.options.tokenPath}.${this.id}.candidate`;
    try {
      const tokens = tokenResponse(JSON.parse(bytes.toString('utf8')) as unknown);
      if (!tokens.refreshToken) throw new Error('No renewable credential.');
      await saveTokens(candidate, tokens);
      const doors = await new MyQClient(candidate, this.fetcher).doors();
      if (!this.capturing()) return;
      // The validated candidate is already private and atomically written. Commit without
      // yielding so cancellation cannot interleave between the final check and replacement.
      renameSync(candidate, this.options.tokenPath);
      this.state = 'connected';
      this.message = `Connected. Found ${doors.length} garage door${doors.length === 1 ? '' : 's'}. Credentials are saved and will renew automatically.`;
      this.profile = '';
      // Keep the landing page available for cleanup, but stop accepting proxy traffic.
      for (const socket of this.sockets) socket.end();
    } catch {
      if (this.capturing()) {
        this.state = 'failed';
        this.message = 'Sign-in could not be validated. Existing Homebridge credentials were kept. Remove the temporary profile and start setup again.';
      }
    } finally {
      await unlink(candidate).catch(() => {});
      this.busy = false;
      // Controls remain paused until the setup is explicitly finished or expires.
    }
  }

  async stop(state: 'cancelled' | 'expired' | 'failed' = 'cancelled'): Promise<void> {
    clearTimeout(this.timer);
    if (this.state !== 'connected') {
      this.state = state;
      this.message = 'Setup ended. Remove the temporary iPhone profile before trying again.';
    }
    this.abort.abort();
    for (const socket of this.sockets) socket.destroy();
    this.web.close();
    this.tls.close();
    this.profile = '';
    this.certificate.key = '';
    try {
      const lock: unknown = JSON.parse(await readFile(`${this.options.tokenPath}.enrollment-lock`, 'utf8'));
      if (typeof lock === 'object' && lock !== null && 'id' in lock && lock.id === this.id) await unlink(`${this.options.tokenPath}.enrollment-lock`);
    } catch { /* A missing lock is already cleaned up. */ }
  }
}
