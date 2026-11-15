import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import { isAbsolute, join } from 'node:path';
import { MyQClient, MyQError, type Door } from './client.js';

const PLUGIN = 'homebridge-myq-connect';
const PLATFORM = 'MyQReadOnly';

export class MyQReadOnlyPlatform implements DynamicPlatformPlugin {
  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly readings = new Map<string, Door>();
  private readonly client: MyQClient;
  private readonly interval: number;
  private readonly controlEnabled: boolean;
  private readonly pending = new Map<string, { target: number; until: number }>();
  private readonly writing = new Set<string>();
  private polling = false;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private lastError: string | undefined;
  private lastSuccess = 0;

  constructor(private readonly log: Logging, config: PlatformConfig, private readonly api: API) {
    const tokenFile: unknown = config.tokenFile;
    const interval: unknown = config.pollIntervalSeconds;
    const path = typeof tokenFile === 'string' && isAbsolute(tokenFile)
      ? tokenFile : join(api.user.storagePath(), 'myq-readonly-token.json');
    this.interval = typeof interval === 'number' && Number.isFinite(interval)
      ? Math.max(30, Math.min(3600, interval)) : 60;
    this.client = new MyQClient(path);
    this.controlEnabled = config.enableControl === true;
    api.on('didFinishLaunching', () => { void this.poll(); });
    api.on('shutdown', () => { this.stopped = true; clearTimeout(this.timer); });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
    this.configureServices(accessory);
  }

  private configureServices(accessory: PlatformAccessory): void {
    const { Service, Characteristic, HapStatusError, HAPStatus } = this.api.hap;
    const existing = accessory.getService(Service.GarageDoorOpener);
    if (!this.controlEnabled) {
      if (existing) accessory.removeService(existing);
      const sensor = accessory.getService(Service.ContactSensor)
        ?? accessory.addService(Service.ContactSensor, accessory.displayName);
      sensor.getCharacteristic(Characteristic.ContactSensorState).onGet(() => {
        const door = this.readings.get(accessory.UUID);
        if (!door?.online || door.closed === undefined || Date.now() - this.lastSuccess > (this.interval + 30) * 1000) {
          throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return door.closed ? Characteristic.ContactSensorState.CONTACT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
      });
      sensor.getCharacteristic(Characteristic.StatusFault).updateValue(Characteristic.StatusFault.GENERAL_FAULT);
      sensor.setPrimaryService();
      return;
    }
    const sensor = accessory.getService(Service.ContactSensor);
    if (sensor) accessory.removeService(sensor);
    const garage = existing ?? accessory.addService(Service.GarageDoorOpener, accessory.displayName);
    garage.setPrimaryService();
    garage.getCharacteristic(Characteristic.CurrentDoorState).onGet(() => this.currentState(accessory.UUID));
    garage.getCharacteristic(Characteristic.TargetDoorState).onGet(() => this.targetState(accessory.UUID))
      .onSet(async value => {
        if (value !== Characteristic.TargetDoorState.OPEN && value !== Characteristic.TargetDoorState.CLOSED) {
          throw new HapStatusError(HAPStatus.INVALID_VALUE_IN_REQUEST);
        }
        const uuid = accessory.UUID;
        const door = this.healthyDoor(uuid);
        if (this.writing.has(uuid) || this.pending.has(uuid)) {
          throw new HapStatusError(HAPStatus.RESOURCE_BUSY);
        }
        this.writing.add(uuid);
        try {
          await this.client.setDoor(door.id, value === Characteristic.TargetDoorState.OPEN ? 'open' : 'close', this.controlEnabled);
          this.pending.set(uuid, { target: value, until: Date.now() + 90_000 });
          clearTimeout(this.timer);
          this.timer = setTimeout(() => { void this.poll(); }, 1000);
        } catch (error) {
          this.log.warn(error instanceof MyQError ? error.message : 'Door command failed.');
          this.markFault(accessory);
          throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        } finally {
          this.writing.delete(uuid);
        }
      });
    garage.getCharacteristic(Characteristic.ObstructionDetected).onGet(() => {
      // The API may omit this field; false means no reported obstruction, not a safety guarantee.
      return this.healthyDoor(accessory.UUID).obstruction === true;
    });
  }

  private healthyDoor(uuid: string): Door {
    const door = this.readings.get(uuid);
    if (!door?.online || door.closed === undefined || Date.now() - this.lastSuccess > (this.interval + 30) * 1000) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return door;
  }

  private currentState(uuid: string): number {
    const state = this.healthyDoor(uuid).state;
    const values = this.api.hap.Characteristic.CurrentDoorState;
    switch (state) {
      case 'open': return values.OPEN;
      case 'closed': return values.CLOSED;
      case 'opening': return values.OPENING;
      case 'closing': return values.CLOSING;
      default: return values.STOPPED;
    }
  }

  private targetState(uuid: string): number {
    const door = this.healthyDoor(uuid);
    const target = this.api.hap.Characteristic.TargetDoorState;
    return this.pending.get(uuid)?.target
      ?? (door.state === 'closed' || door.state === 'closing' ? target.CLOSED : target.OPEN);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    clearTimeout(this.timer);
    let delay = this.interval;
    try {
      const doors = await this.client.doors();
      if (this.stopped) return;
      this.lastSuccess = Date.now();
      const { Service, Characteristic, HapStatusError, HAPStatus } = this.api.hap;
      const current = new Set<string>();
      for (const door of doors) {
        const uuid = this.api.hap.uuid.generate(`myq-readonly:${door.id}`);
        current.add(uuid);
        const name = this.controlEnabled ? door.name : `${door.name} Status`;
        let accessory = this.accessories.get(uuid);
        if (!accessory) {
          accessory = new this.api.platformAccessory(name, uuid);
          this.configureServices(accessory);
          this.accessories.set(uuid, accessory);
          this.api.registerPlatformAccessories(PLUGIN, PLATFORM, [accessory]);
          this.log.info('Registered myQ garage accessory.');
        }
        if (accessory.displayName !== name) {
          accessory.displayName = name;
          accessory.getService(Service.AccessoryInformation)!
            .setCharacteristic(Characteristic.Name, name);
          const service = accessory.getService(this.controlEnabled ? Service.GarageDoorOpener : Service.ContactSensor);
          if (service) {
            service.displayName = name;
            service.setCharacteristic(Characteristic.Name, name);
          }
          this.api.updatePlatformAccessories([accessory]);
        }
        this.readings.set(uuid, door);
        const pending = this.pending.get(uuid);
        if (pending) {
          const reached = door.state === (pending.target === Characteristic.TargetDoorState.OPEN ? 'open' : 'closed');
          if (reached || Date.now() >= pending.until) {
            this.pending.delete(uuid);
            if (!reached) this.log.warn('Door did not report its requested state within 90 seconds. Command will not be repeated.');
          }
        }
        const garage = accessory.getService(Service.GarageDoorOpener);
        if (garage) {
          if (door.online && door.closed !== undefined) {
            garage.updateCharacteristic(Characteristic.CurrentDoorState, this.currentState(uuid));
            garage.updateCharacteristic(Characteristic.TargetDoorState, this.targetState(uuid));
            garage.updateCharacteristic(Characteristic.ObstructionDetected, door.obstruction === true);
          } else {
            this.markFault(accessory);
          }
        }
        accessory.getService(Service.AccessoryInformation)!
          .setCharacteristic(Characteristic.Manufacturer, 'Chamberlain / myQ')
          .setCharacteristic(Characteristic.Model, door.model)
          .setCharacteristic(Characteristic.SerialNumber, door.serialNumber);
        const sensor = accessory.getService(Service.ContactSensor);
        const healthy = door.online && door.closed !== undefined;
        sensor?.updateCharacteristic(Characteristic.StatusFault, healthy
          ? Characteristic.StatusFault.NO_FAULT : Characteristic.StatusFault.GENERAL_FAULT);
        sensor?.getCharacteristic(Characteristic.ContactSensorState).updateValue(healthy
          ? door.closed ? Characteristic.ContactSensorState.CONTACT_DETECTED : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      }
      for (const [uuid, accessory] of this.accessories) {
        if (!current.has(uuid)) this.markFault(accessory);
      }
      if (this.lastError) this.log.info('myQ status polling recovered.');
      this.lastError = undefined;
      this.log.debug(`Updated ${doors.length} garage accessory(s).`);
      if (this.pending.size) delay = 5;
    } catch (error) {
      for (const accessory of this.accessories.values()) this.markFault(accessory);
      const message = error instanceof MyQError ? error.message : 'Unable to update myQ status.';
      if (message !== this.lastError) this.log.warn(message);
      this.lastError = message;
      if (error instanceof MyQError) delay = Math.max(delay, error.retryAfterSeconds);
    } finally {
      this.polling = false;
      if (!this.stopped) this.timer = setTimeout(() => { void this.poll(); }, delay * 1000);
    }
  }

  private markFault(accessory: PlatformAccessory): void {
    this.readings.delete(accessory.UUID);
    const { Service, Characteristic, HapStatusError, HAPStatus } = this.api.hap;
    const garage = accessory.getService(Service.GarageDoorOpener);
    for (const characteristic of [Characteristic.CurrentDoorState, Characteristic.TargetDoorState, Characteristic.ObstructionDetected]) {
      garage?.getCharacteristic(characteristic).updateValue(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
    }
    const service = accessory.getService(Service.ContactSensor);
    service?.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT);
    service?.getCharacteristic(Characteristic.ContactSensorState)
      .updateValue(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
  }
}

export default (api: API): void => { api.registerPlatform(PLUGIN, PLATFORM, MyQReadOnlyPlatform); };
