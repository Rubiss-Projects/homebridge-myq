import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HomebridgeAPI} from '../node_modules/homebridge/dist/api.js';
import {MyQReadOnlyPlatform} from '../dist/index.js';

test('HomeKit receives only a read-only contact sensor; failed reads invalidate its state',async()=>{
 const api=new HomebridgeAPI();const registered=[];
 api.registerPlatformAccessories=(_plugin,_platform,accessories)=>registered.push(...accessories);
 const log=Object.assign(()=>{}, {info(){},warn(){},debug(){},error(){}});
 const platform=new MyQReadOnlyPlatform(log,{platform:'MyQReadOnly'},api);
 platform.client={doors:async()=>[{id:'test:door',name:'Garage',serialNumber:'test-door',model:'test',closed:true,online:true}]};
 try{
  await platform.poll();
  assert.equal(registered.length,1);
  const {Service,Characteristic,Perms}=api.hap;
  const accessory=registered[0];const sensor=accessory.getService(Service.ContactSensor);
  assert.ok(sensor);assert.equal(accessory.getService(Service.GarageDoorOpener),undefined);
  const state=sensor.getCharacteristic(Characteristic.ContactSensorState);
  assert.ok(!state.props.perms.includes(Perms.PAIRED_WRITE));
  assert.equal(await state.handleGetRequest(),Characteristic.ContactSensorState.CONTACT_DETECTED);
  clearTimeout(platform.timer);
  platform.client={doors:async()=>{throw new Error('network failed');}};
  await platform.poll();
  assert.equal(sensor.getCharacteristic(Characteristic.StatusFault).value,Characteristic.StatusFault.GENERAL_FAULT);
  await assert.rejects(state.handleGetRequest());
 }finally{api.emit('shutdown');}
});

test('garage targets issue only explicit writes and current state comes from observations', async () => {
  const api = new HomebridgeAPI();
  const registered = [];
  api.registerPlatformAccessories = (_plugin, _platform, accessories) => registered.push(...accessories);
  const log = Object.assign(() => {}, {info(){}, warn(){}, debug(){}, error(){}});
  const platform = new MyQReadOnlyPlatform(log, {platform: 'MyQReadOnly', enableControl: true}, api);
  let door = {id: 'test:door', name: 'Garage', serialNumber: 'test-door', model: 'test',
    closed: true, state: 'closed', online: true, canOpen: true, canClose: true};
  const commands = [];
  platform.client = {doors: async () => [door], setDoor: async (...args) => {commands.push(args);}};
  try {
    await platform.poll();
    assert.equal(commands.length, 0);
    const {Service, Characteristic} = api.hap;
    const garage = registered[0].getService(Service.GarageDoorOpener);
    assert.ok(garage);
    assert.equal(registered[0].getService(Service.ContactSensor), undefined);
    const current = garage.getCharacteristic(Characteristic.CurrentDoorState);
    const target = garage.getCharacteristic(Characteristic.TargetDoorState);
    assert.equal(await current.handleGetRequest(), Characteristic.CurrentDoorState.CLOSED);
    await target.handleSetRequest(Characteristic.TargetDoorState.OPEN);
    assert.deepEqual(commands, [['test:door', 'open', true]]);
    assert.equal(await current.handleGetRequest(), Characteristic.CurrentDoorState.CLOSED);
    await assert.rejects(target.handleSetRequest(Characteristic.TargetDoorState.CLOSED));
    assert.equal(commands.length, 1);
    door = {...door, closed: false, state: 'opening'};
    await platform.poll();
    assert.equal(await current.handleGetRequest(), Characteristic.CurrentDoorState.OPENING);
    door = {...door, state: 'open'};
    await platform.poll();
    assert.equal(platform.pending.size, 0);
    assert.equal(await current.handleGetRequest(), Characteristic.CurrentDoorState.OPEN);
    door = {...door, online: false};
    await platform.poll();
    await assert.rejects(current.handleGetRequest());
    await assert.rejects(target.handleSetRequest(Characteristic.TargetDoorState.CLOSED));
    assert.equal(commands.length, 1);
  } finally { api.emit('shutdown'); }
});

 test('cached accessories migrate between contact and garage services without changing identity', () => {
  const api = new HomebridgeAPI();
  const {Service} = api.hap;
  const log = Object.assign(() => {}, {info(){}, warn(){}, debug(){}, error(){}});
  const accessory = new api.platformAccessory('Garage', api.hap.uuid.generate('migration'));
  const uuid = accessory.UUID;
  accessory.addService(Service.ContactSensor, 'Garage');
  const control = new MyQReadOnlyPlatform(log, {platform: 'MyQReadOnly', enableControl: true}, api);
  const readonly = new MyQReadOnlyPlatform(log, {platform: 'MyQReadOnly'}, api);
  try {
    control.configureAccessory(accessory);
    assert.equal(accessory.getService(Service.ContactSensor), undefined);
    assert.equal(accessory.getService(Service.GarageDoorOpener).isPrimaryService, true);
    readonly.configureAccessory(accessory);
    assert.equal(accessory.getService(Service.GarageDoorOpener), undefined);
    assert.equal(accessory.getService(Service.ContactSensor).isPrimaryService, true);
    assert.equal(accessory.UUID, uuid);
  } finally { api.emit('shutdown'); }
});
