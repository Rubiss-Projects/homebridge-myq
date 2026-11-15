import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import tls from 'node:tls';
import {once} from 'node:events';
import vm from 'node:vm';
import {PhoneEnrollment, allowedSignIn} from '../dist/enrollment.js';
import {enrollmentActive} from '../dist/enrollment-lock.js';
import {pacFile, iphoneProfile, enrollmentCertificate} from '../dist/enrollment-profile.js';
import {MyQClient} from '../dist/client.js';

function connect(url, target) {
  return new Promise((resolve,reject) => {
    const req=http.request({hostname:url.hostname,port:url.port,method:'CONNECT',path:target});
    req.on('connect',(res,socket)=>resolve({res,socket}));req.on('error',reject);req.end();
  });
}

async function identityRequest(session, path, body, host='partner-identity.myq-cloud.com', method='POST') {
  const {res,socket}=await connect(new URL(session.url),`${host}:443`);
  assert.equal(res.statusCode,200);
  const secure=tls.connect({socket,servername:host,ca:session.certificate.ca});
  await once(secure,'secureConnect');
  const chunks=[];
  secure.on('data',chunk=>chunks.push(chunk));
  const done=once(secure,'end');
  secure.write(`${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  await done;
  secure.destroy();
  return Buffer.concat(chunks).toString();
}

const form='client_id=IOS_CGI_MYQ&grant_type=authorization_code&code=synthetic';
const reply={access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600};
const account='11111111-1111-1111-1111-111111111111';

async function fixture(fetcher) {
  const dir=await mkdtemp(join(tmpdir(),'myq-enrollment-test-'));
  const path=join(dir,'token.json');
  await writeFile(path,JSON.stringify({accessToken:'old-access',refreshToken:'old-refresh'}),{mode:0o600});
  const session=new PhoneEnrollment({address:'127.0.0.1',ssid:'Test Wi-Fi',tokenPath:path},fetcher);
  await session.start();
  return {session,path,async close(){await session.stop();await rm(dir,{recursive:true,force:true});}};
}

const waitFor=async (session,state)=>{
  for(let i=0;i<100;i++){
    if(session.status().state===state)return;
    await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(session.status().state,state);
};

test('phone enrollment validates and imports renewable credentials over a real TLS proxy, without commands',async()=>{
  const requests=[];
  const f=await fixture(async(url,options)=>{
    requests.push({url:String(url),method:options.method});
    if(String(url).endsWith('/connect/token'))return Response.json(reply);
    if(String(url).endsWith('/accounts'))return Response.json({accounts:[{id:account}]});
    return Response.json({items:[]});
  });
  try{
    const address=new URL(f.session.url);
    const denied=await connect(address,'partner-identity.myq-cloud.com:443');
    assert.equal(denied.res.statusCode,403);denied.socket.destroy();
    assert.equal((await fetch(f.session.url)).status,200);
    const profile=await(await fetch(f.session.url+'/profile.mobileconfig')).text();
    assert.match(profile,/RemovalDate/);assert.match(profile,/DurationUntilRemoval/);
    assert.match(profile,/Test Wi-Fi/);assert.doesNotMatch(profile,/PRIVATE KEY/);
    const device=await connect(address,'account-devices-gdo.myq-cloud.com:443');
    assert.equal(device.res.statusCode,200);device.socket.destroy();
    const command=await identityRequest(f.session,'/api/v6.0/Accounts/test/door_openers/test/open','', 'account-devices-gdo.myq-cloud.com','PUT');
    assert.match(command,/403 Forbidden/);
    const rejected=await identityRequest(f.session,'/api/door/open','');
    assert.match(rejected,/403 Forbidden/);assert.equal(requests.length,0);
    const result=await identityRequest(f.session,'/connect/token',form);
    assert.match(result,/200 OK/);
    await waitFor(f.session,'connected');
    const saved=JSON.parse(await readFile(f.path,'utf8'));
    assert.equal(saved.refreshToken,reply.refresh_token);
    assert.equal((await stat(f.path)).mode&0o777,0o600);
    assert.equal(requests.length,3);
    assert.deepEqual(requests.map(r=>r.method),['POST','GET','GET']);
    assert.ok(await enrollmentActive(f.path));
    assert.doesNotMatch(JSON.stringify(f.session.status()),/synthetic-access|synthetic-refresh/);
    const after=await connect(address,'partner-identity.myq-cloud.com:443');
    assert.equal(after.res.statusCode,403);after.socket.destroy();
    await f.session.stop();assert.equal(await enrollmentActive(f.path),false);
  }finally{await f.close();}
});

test('failed account validation preserves existing credentials and stops capture',async()=>{
 const f=await fixture(async(url)=>String(url).endsWith('/connect/token')?Response.json(reply):new Response('',{status:403}));
 try{
  await fetch(f.session.url);await identityRequest(f.session,'/connect/token',form);
  await waitFor(f.session,'failed');
  assert.equal(JSON.parse(await readFile(f.path,'utf8')).accessToken,'old-access');
 }finally{await f.close();}
});

test('a cancelled enrollment cannot replace credentials when validation finishes late',async()=>{
 let release;
 const pending=new Promise(resolve=>{release=resolve;});
 const f=await fixture(async(url)=>{
   if(String(url).endsWith('/connect/token'))return Response.json(reply);
   await pending;return Response.json({accounts:[]});
 });
 try{
  await fetch(f.session.url);await identityRequest(f.session,'/connect/token',form);
  await waitFor(f.session,'validating');await f.session.stop();release();
  await new Promise(r=>setTimeout(r,50));
  assert.equal(JSON.parse(await readFile(f.path,'utf8')).accessToken,'old-access');
 }finally{release();await f.close();}
});

test('setup lock blocks commands before account or device requests',async()=>{
 const f=await fixture(async()=>{throw Error('No network request expected');});
 try{
  const client=new MyQClient(f.path,async()=>{throw Error('No network request expected');});
  await assert.rejects(client.setDoor('door','open',true),/paused during myQ phone setup/);
 }finally{await f.close();}
});

test('PAC targets only myQ domains and auth policy rejects arbitrary destinations and command routes',()=>{
 const context=vm.createContext({});vm.runInContext(pacFile('192.168.1.10',12345,true),context);
 assert.equal(context.FindProxyForURL('','partner-identity.myq-cloud.com'),'PROXY 192.168.1.10:12345');
 assert.equal(context.FindProxyForURL('','account-devices-gdo.myq-cloud.com'),'PROXY 192.168.1.10:12345');
 assert.equal(context.FindProxyForURL('','evilmyq-cloud.com'),'DIRECT');
 assert.equal(context.FindProxyForURL('','example.com'),'DIRECT');
 assert.equal(allowedSignIn('partner-identity.myq-cloud.com','POST','/cdn-cgi/challenge-platform/x'),true);
 assert.equal(allowedSignIn('example.com','GET','/'),false);
 assert.equal(allowedSignIn('partner-identity.myq-cloud.com','PUT','/connect/token'),false);
 assert.equal(allowedSignIn('partner-identity.myq-cloud.com','GET','/door/open'),false);
 assert.equal(allowedSignIn('partner-identity.myq-cloud.com','GET','/door/%2e%2e/open'),false);
});

test('enrollment worker survives UI disconnection and can be finished by a new UI process',async t=>{
 const {lanAddresses}=await import('../dist/enrollment.js');
 const {startSetup,setupRequest}=await import('../dist/enrollment-control.js');
 const address=lanAddresses()[0];
 if(!address){t.skip('No private LAN interface');return;}
 const dir=await mkdtemp(join(tmpdir(),'myq-worker-test-'));
 try{
  const started=await startSetup(dir,{address,ssid:'Synthetic setup test',tokenPath:join(dir,'credentials.json')});
  assert.equal(started.state,'waiting');
  await new Promise(r=>setTimeout(r,50));
  const status=await setupRequest(dir,'/status');
  assert.equal(status.url,started.url);
  assert.equal((await setupRequest(dir,'/finish')).state,'idle');
  for(let i=0;i<50;i++){
   if((await setupRequest(dir,'/status')).state==='idle')break;
   await new Promise(r=>setTimeout(r,10));
  }
  assert.equal((await setupRequest(dir,'/status')).state,'idle');
  assert.equal(await enrollmentActive(join(dir,'credentials.json')),false);
 }finally{await setupRequest(dir,'/finish');await rm(dir,{recursive:true,force:true});}
});

test('expiry closes the listener and removes the control lock without changing credentials',async()=>{
 const f=await fixture(async()=>{throw Error('No network request expected');});
 try{
  await f.session.stop('expired');
  assert.equal(f.session.status().state,'expired');
  await assert.rejects(fetch(f.session.url));
  assert.equal(await enrollmentActive(f.path),false);
  assert.equal(JSON.parse(await readFile(f.path,'utf8')).accessToken,'old-access');
 }finally{await f.close();}
});

 test('phone startup reads pass through myQ API hosts while device changes remain blocked',async()=>{
  const requests=[];
  const f=await fixture(async(url,options)=>{requests.push({url:String(url),method:options.method});return Response.json({ok:true});});
  try{
    await fetch(f.session.url);
    const result=await identityRequest(f.session,'/api/v6.0/accounts','', 'accounts.myq-cloud.com','GET');
    assert.match(result,/200 OK/);
    assert.deepEqual(requests,[{url:'https://accounts.myq-cloud.com/api/v6.0/accounts',method:'GET'}]);
    const result2=await identityRequest(f.session,'/api/v6.0/accounts','x=1', 'accounts.myq-cloud.com','POST');
    assert.match(result2,/403 Forbidden/);
    assert.equal(requests.length,1);
    assert.equal(f.session.status().diagnostics.requestsBlocked,1);
  }finally{await f.close();}
});

test('profile PAC capability rebinds the phone after its Wi-Fi address changes',async()=>{
 const f=await fixture(async()=>{throw Error('No upstream request expected');});
 try{
  await fetch(f.session.url);
  // Simulate the previous DHCP lease; requests now arrive from localhost.
  f.session.phoneAddress='192.0.2.100';
  assert.equal((await fetch(f.session.url+'/status')).status,403);
  assert.equal((await fetch(f.session.url+'/proxy.pac')).status,200);
  assert.equal(f.session.status().diagnostics.phoneRebindings,1);
  assert.equal((await fetch(f.session.url+'/status')).status,200);
 }finally{await f.close();}
});
