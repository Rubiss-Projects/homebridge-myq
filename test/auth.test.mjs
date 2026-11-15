import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TokenManager,saveTokens} from '../dist/auth.js';

async function credentials(t,tokens={accessToken:'old-access',refreshToken:'old-refresh',expiresAt:0}){
 const root=await mkdtemp(join(tmpdir(),'myq-auth-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'token.json');await saveTokens(path,tokens);return path;
}

test('concurrent callers share one refresh and atomically persist rotated tokens',async t=>{
 const path=await credentials(t);let calls=0;
 const manager=new TokenManager(path,async(url,options)=>{
  calls++;assert.equal(url,'https://partner-identity.myq-cloud.com/connect/token');
  assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
  assert.equal(options.body.get('refresh_token'),'old-refresh');
  assert.equal(options.body.get('grant_type'),'refresh_token');
  await new Promise(r=>setTimeout(r,10));
  return Response.json({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600});
 });
 assert.deepEqual(await Promise.all([manager.accessToken(),manager.accessToken(),manager.accessToken()]),['new-access','new-access','new-access']);
 assert.equal(calls,1);
 const saved=JSON.parse(await readFile(path,'utf8'));assert.equal(saved.refreshToken,'new-refresh');
 assert.equal((await stat(path)).mode&0o777,0o600);
 assert.equal(await manager.accessToken(),'new-access');assert.equal(calls,1);
});

test('invalid refresh tokens are not repeatedly submitted and replacement credentials recover',async t=>{
 const path=await credentials(t);let calls=0;
 const manager=new TokenManager(path,async()=>{calls++;return Response.json({error:'invalid_grant'},{status:400});});
 await assert.rejects(manager.accessToken(),/Sign in again/);
 await assert.rejects(manager.accessToken(),/Sign in again/);assert.equal(calls,1);
 await saveTokens(path,{accessToken:'replacement',refreshToken:'replacement-refresh',expiresAt:Date.now()+3600000});
 assert.equal(await manager.accessToken(),'replacement');
});

test('429 honors server retry time and leaves the old token file intact',async t=>{
 const path=await credentials(t);let calls=0;
 const manager=new TokenManager(path,async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'7200'}});});
 await assert.rejects(manager.accessToken(),e=>e.retryAfterSeconds===7200);
 await assert.rejects(manager.accessToken(),/backing off/);assert.equal(calls,1);
 assert.equal(JSON.parse(await readFile(path,'utf8')).refreshToken,'old-refresh');
});

test('a manual sign-in during refresh is not overwritten',async t=>{
 const path=await credentials(t);
 const manager=new TokenManager(path,async()=>{
  await saveTokens(path,{accessToken:'manual-access',refreshToken:'manual-refresh',expiresAt:Date.now()+3600000});
  return Response.json({access_token:'late-response',refresh_token:'late-refresh',expires_in:3600});
 });
 assert.equal(await manager.accessToken(),'manual-access');
 assert.equal(JSON.parse(await readFile(path,'utf8')).refreshToken,'manual-refresh');
});

test('legacy access-only file is accepted, then rejected without retry after 401',async t=>{
 const path=await credentials(t,{accessToken:'legacy'});
 const manager=new TokenManager(path,async()=>{throw Error('Must not fetch');});
 assert.equal(await manager.accessToken(),'legacy');
 await assert.rejects(manager.recover('legacy'),/legacy access token expired/);
 await assert.rejects(manager.accessToken(),/Sign in again/);
});

test('a successful but malformed refresh response does not replay a potentially consumed token', async t => {
  const path = await credentials(t);
  let calls = 0;
  const manager = new TokenManager(path, async () => { calls++; return Response.json({access_token: 'new-access'}); });
  await assert.rejects(manager.accessToken(), /invalid token response/);
  await assert.rejects(manager.accessToken(), /Sign in again/);
  assert.equal(calls, 1);
});
