import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MyQClient, parseDoors } from '../dist/client.js';

const accountId = '11111111-1111-1111-1111-111111111111';
const device = (state) => ({ serial_number: 'test-door', name: 'Garage', state });

async function tokenFile(t) {
  const dir = await mkdtemp(join(tmpdir(), 'myq-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'token.json');
  await writeFile(path, JSON.stringify({ accessToken: 'test-token' }), { mode: 0o600 });
  return path;
}

test('only confirmed closed is closed; unknown and offline remain unavailable', () => {
  const doors = parseDoors({ count: 5, items: [
    device({door_state:'closed', online:true}), device({door_state:'opening', online:true}),
    device({door_state:'unexpected', online:true}), device({door_state:'closed', online:false}),
    { state: { online: true } },
  ] }, accountId);
  assert.equal(doors.length, 4);
  assert.deepEqual(doors.map(d => [d.closed, d.online]), [[true,true],[false,true],[undefined,true],[true,false]]);
  assert.throws(() => parseDoors({count:2,items:[]}, accountId), /Incomplete/);
});

test('discovery uses only verified GET URLs, bearer auth, and refuses redirects', async t => {
  const requests=[];
  const client=new MyQClient(await tokenFile(t), async (url, options) => {
    requests.push([url.toString(),options]);
    return Response.json(requests.length===1 ? {accounts:[{id:accountId}]} : {items:[device({door_state:'closed',online:true})]});
  });
  assert.equal((await client.doors())[0].closed,true);
  assert.deepEqual(requests.map(([url])=>url),['https://accounts.myq-cloud.com/api/v6.0/accounts',`https://devices.myq-cloud.com/api/v6.2/Accounts/${accountId}/Devices`]);
  for (const [,options] of requests) {
    assert.equal(options.method,'GET'); assert.equal(options.body,undefined);
    assert.equal(options.redirect,'error'); assert.equal(options.headers.Authorization,'Bearer test-token');
  }
});

test('an invalid token is not retried until replaced, and token values never appear in errors', async t => {
  const path=await tokenFile(t);let calls=0;
  const client=new MyQClient(path,async()=>{calls++;return new Response('',{status:401});});
  await assert.rejects(client.doors(),/expired|rejected/);
  await assert.rejects(client.doors(),/expired|rejected/);
  assert.equal(calls,1);
  await writeFile(path,JSON.stringify({accessToken:'replacement'}));
  await assert.rejects(client.doors(),e=>!e.message.includes('replacement'));
  assert.equal(calls,2);
});

test('rate limits preserve server Retry-After backoff',async t=>{
 const client=new MyQClient(await tokenFile(t),async()=>new Response('',{status:429,headers:{'Retry-After':'600'}}));
 await assert.rejects(client.doors(),e=>e.retryAfterSeconds===600);
});

test('malformed account IDs cannot create additional destinations or paths',async t=>{
 const client=new MyQClient(await tokenFile(t),async()=>Response.json({accounts:[{id:'../../actions'}]}));
 await assert.rejects(client.doors(),/account identifier/);
});

test('commands require opt-in and fresh online capability; an ambiguous PUT is never repeated', async t => {
  const path = await tokenFile(t);
  let puts = 0;
  let online = false;
  let allowed = false;
  const client = new MyQClient(path, async (url, options) => {
    if (options.method === 'PUT') {
      puts++;
      assert.equal(options.body, undefined);
      throw new Error('Connection lost after dispatch');
    }
    return Response.json(url.hostname === 'accounts.myq-cloud.com'
      ? {accounts: [{id: accountId}]}
      : {items: [device({door_state: 'closed', online, is_unattended_open_allowed: allowed})]});
  });
  const id = `${accountId}:test-door`;
  await assert.rejects(client.setDoor(id, 'open', false), /disabled/);
  await assert.rejects(client.setDoor(id, 'open', true), /unavailable/);
  online = true;
  await assert.rejects(client.setDoor(id, 'open', true), /does not permit/);
  assert.equal(puts, 0);
  allowed = true;
  await assert.rejects(client.setDoor(id, 'open', true), /result is unknown/);
  assert.equal(puts, 1);
});

test('commands do not actuate a door already at target or moving', async t => {
  let state = 'closed';
  let puts = 0;
  const client = new MyQClient(await tokenFile(t), async (url, options) => {
    if (options.method === 'PUT') { puts++; return new Response(null, {status: 204}); }
    return Response.json(url.hostname === 'accounts.myq-cloud.com'
      ? {accounts: [{id: accountId}]}
      : {items: [device({door_state: state, online: true, is_unattended_close_allowed: true})]});
  });
  await client.setDoor(`${accountId}:test-door`, 'close', true);
  state = 'opening';
  await assert.rejects(client.setDoor(`${accountId}:test-door`, 'close', true), /already moving/);
  assert.equal(puts, 0);
});
