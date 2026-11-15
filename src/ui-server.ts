import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import QRCode from 'qrcode';
import { lanAddresses } from './enrollment.js';
import { setupRequest, startSetup } from './enrollment-control.js';
import { asObject } from './errors.js';

class MyQUiServer extends HomebridgePluginUiServer {
  private starting = false;

  constructor() {
    super();
    this.onRequest('/setup/options', () => ({ addresses: lanAddresses() }));
    this.onRequest('/setup/status', async () => {
      if (!this.homebridgeStoragePath) return { state: 'idle' };
      const status = await setupRequest(this.homebridgeStoragePath, '/status');
      return typeof status.url === 'string' ? { ...status, qr: await QRCode.toDataURL(status.url, { width: 280, margin: 2 }) } : status;
    });
    this.onRequest('/setup/start', async (value: unknown) => {
      if (this.starting) throw new Error('Setup is already starting.');
      this.starting = true;
      try {
        const input = asObject(value);
        if (typeof input.address !== 'string' || !lanAddresses().includes(input.address)) throw new Error('Choose a Homebridge LAN address.');
        if (typeof input.ssid !== 'string') throw new Error('Enter the Wi-Fi network name.');
        if (input.password !== undefined && typeof input.password !== 'string') throw new Error('Invalid Wi-Fi password.');
        if (!this.homebridgeStoragePath || !this.homebridgeConfigPath) throw new Error('Homebridge storage is unavailable.');
        const config = asObject(JSON.parse(await readFile(this.homebridgeConfigPath, 'utf8')) as unknown);
        const platforms = Array.isArray(config.platforms) ? config.platforms : [];
        const platform = platforms.map(asObject).find(p => p.platform === 'MyQReadOnly');
        if (!platform) throw new Error('Save the myQ plugin configuration before connecting.');
        const tokenPath = typeof platform.tokenFile === 'string' && isAbsolute(platform.tokenFile)
          ? platform.tokenFile : join(this.homebridgeStoragePath, 'myq-readonly-token.json');
        const status = await startSetup(this.homebridgeStoragePath, {
          address: input.address, ssid: input.ssid,
          ...(typeof input.password === 'string' && input.password ? { password: input.password } : {}), tokenPath });
        return { ...status, qr: await QRCode.toDataURL(String(status.url), { width: 280, margin: 2 }) };
      } catch (error) {
        throw new Error(error instanceof Error && /^(Choose|Enter|Invalid|Save|Another|Homebridge)/.test(error.message)
          ? error.message : 'Unable to start phone setup. Check the selected network address and token-file directory permissions.');
      } finally { this.starting = false; }
    });
    this.onRequest('/setup/finish', async () => {
      if (this.homebridgeStoragePath) await setupRequest(this.homebridgeStoragePath, '/finish');
      return { state: 'idle' };
    });
    this.ready();
  }
}
new MyQUiServer();
