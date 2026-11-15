import { TokenManager } from './auth.js';
import { enrollmentActive } from './enrollment-lock.js';
import { asObject as object, MyQError, retryAfter } from './errors.js';
export { MyQError } from './errors.js';

export type DoorState = 'open' | 'closed' | 'opening' | 'closing' | 'stopped' | 'unknown';
export type DoorAction = 'open' | 'close';

export interface Door {
  id: string;
  serialNumber: string;
  accountId: string;
  state: DoorState;
  canOpen: boolean;
  canClose: boolean;
  obstruction: boolean | undefined;
  name: string;
  model: string;
  closed: boolean | undefined;
  online: boolean;
}

export function parseDoors(payload: unknown, accountId: string): Door[] {
  const data = object(payload);
  if (!Array.isArray(data.items) || (typeof data.count === 'number' && data.count > data.items.length)) {
    throw new MyQError('Incomplete myQ device response.');
  }
  const doors: Door[] = [];
  for (const item of data.items) {
    const device = object(item);
    const state = object(device.state);
    // Hubs and cameras share this endpoint but do not expose a door state.
    if (!('door_state' in state)) continue;
    if (typeof device.serial_number !== 'string' || !device.serial_number) {
      throw new MyQError('Door is missing its stable identifier.');
    }
    const doorState = typeof state.door_state === 'string' ? state.door_state.toLowerCase() : '';
    const closed = doorState === 'closed' ? true
      : ['open', 'opening', 'closing', 'stopped'].includes(doorState) ? false : undefined;
    doors.push({
      id: `${accountId}:${device.serial_number}`,
      serialNumber: device.serial_number,
      accountId,
      state: ['open', 'closed', 'opening', 'closing', 'stopped'].includes(doorState) ? doorState as DoorState : 'unknown',
      canOpen: state.is_unattended_open_allowed === true,
      canClose: state.is_unattended_close_allowed === true,
      obstruction: typeof state.obstruction_detected === 'boolean' ? state.obstruction_detected : undefined,
      name: typeof device.name === 'string' ? device.name : 'Garage Door',
      model: typeof device.device_model === 'string' ? device.device_model : 'myQ Garage',
      closed,
      online: state.online === true,
    });
  }
  return doors;
}

/** Account/device reads and explicit garage commands; no discovery can issue a command. */
export class MyQClient {
  readonly auth: TokenManager;
  private readonly commands = new Set<string>();

  constructor(tokenFile: string, private readonly fetcher: typeof fetch = fetch) {
    this.auth = new TokenManager(tokenFile, fetcher);
  }

  private async request(url: URL, method: 'GET' | 'PUT'): Promise<Response> {
    let token = await this.auth.accessToken();
    const send = async (): Promise<Response> => {
      try {
        return await this.fetcher(url, {
          method, redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
      } catch {
        throw new MyQError(method === 'PUT'
          ? 'Door command result is unknown. It will not be retried; check the door status.'
          : 'myQ read failed or timed out.');
      }
    };
    let response = await send();
    // Only reads may be replayed. Commands are never automatically repeated.
    if (response.status === 401 && method === 'GET') {
      token = await this.auth.recover(token);
      response = await send();
    }
    if (response.status === 401 || response.status === 403) {
      if (method === 'GET') this.auth.reject(token);
      throw new MyQError(method === 'PUT'
        ? 'myQ rejected the door command. Refresh status before trying again.'
        : 'myQ access token expired or was rejected. Sign in again.');
    }
    if (response.status === 429) throw new MyQError('myQ rate limited requests.', retryAfter(response));
    if (!response.ok) throw new MyQError(`myQ ${method === 'PUT' ? 'command' : 'read'} returned HTTP ${response.status}.`);
    return response;
  }

  async doors(): Promise<Door[]> {
    const get = async (url: URL): Promise<unknown> => {
      const response = await this.request(url, 'GET');
      try { return await response.json() as unknown; }
      catch { throw new MyQError('myQ returned an unreadable response.'); }
    };
    const accounts = object(await get(new URL('https://accounts.myq-cloud.com/api/v6.0/accounts')));
    if (!Array.isArray(accounts.accounts)) throw new MyQError('Unexpected myQ accounts response.');
    const doors: Door[] = [];
    for (const entry of accounts.accounts) {
      const account = object(entry);
      if (typeof account.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(account.id)) {
        throw new MyQError('Unexpected myQ account identifier.');
      }
      const url = new URL(`https://devices.myq-cloud.com/api/v6.2/Accounts/${account.id}/Devices`);
      doors.push(...parseDoors(await get(url), account.id));
    }
    return doors;
  }

  /** Uses the v6.0 route verified by a supervised Homebridge open/close test. */
  async setDoor(id: string, action: DoorAction, controlEnabled: boolean): Promise<void> {
    if (!controlEnabled) throw new MyQError('Door controls are disabled.');
    if (await enrollmentActive(this.auth.path)) throw new MyQError('Door controls are paused during myQ phone setup. Finish setup first.');
    if (action !== 'open' && action !== 'close') throw new MyQError('Unsupported door action.');
    if (this.commands.has(id)) throw new MyQError('A command for this door is already in progress.');
    this.commands.add(id);
    try {
      // Re-read permissions and state immediately before considering a command.
      const door = (await this.doors()).find(door => door.id === id);
      if (!door?.online || door.state === 'unknown') throw new MyQError('Door status is unavailable.');
      if (door.state === (action === 'open' ? 'open' : 'closed')) return;
      if (door.state === 'opening' || door.state === 'closing') throw new MyQError('The door is already moving.');
      if ((action === 'open' && !door.canOpen) || (action === 'close' && !door.canClose)) {
        throw new MyQError('myQ does not permit this unattended door action.');
      }
      if (action === 'close' && door.obstruction === true) throw new MyQError('myQ reports a door obstruction.');
      const url = new URL(`https://account-devices-gdo.myq-cloud.com/api/v6.0/Accounts/${door.accountId}/door_openers/${encodeURIComponent(door.serialNumber)}/${action}`);
      if (await enrollmentActive(this.auth.path)) throw new MyQError('Door controls are paused during myQ phone setup.');
      await this.request(url, 'PUT');
    } finally {
      this.commands.delete(id);
    }
  }
}
