import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {LoginSession} from '../dist/login.js';

function callback(session, extras = {}) {
 const state = new URL(session.authorizationURL).searchParams.get('state');
 return `com.myqops://ios?${new URLSearchParams({state,code:'test-code',iss:'https://partner-identity.myq-cloud.com',...extras})}`;
}

test('PKCE exchange matches the authorization challenge and requires renewable credentials', async () => {
 let calls=0;
 const session=new LoginSession(async (url,options)=>{
  calls++;
  assert.equal(url,'https://partner-identity.myq-cloud.com/connect/token');
  assert.equal(options.redirect,'error');
  assert.equal(options.body.get('code'),'test-code');
  assert.equal(options.body.get('redirect_uri'),'com.myqops://ios');
  assert.equal(createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'),
    new URL(session.authorizationURL).searchParams.get('code_challenge'));
  return Response.json({access_token:'access',refresh_token:'refresh',expires_in:43200});
 });
 const tokens=await session.complete(callback(session));
 assert.equal(tokens.refreshToken,'refresh');
 await assert.rejects(session.complete(callback(session)),/expired/);
 assert.equal(calls,1);
});

test('foreign callback, state, issuer, duplicate code, and expired sessions never exchange',async()=>{
 let now=0;
 const session=new LoginSession(async()=>{throw Error('Must not fetch');},()=>now);
 await assert.rejects(session.complete('https://evil.example/callback'),/Invalid sign-in/);
 await assert.rejects(session.complete(callback(session,{state:'foreign'})),/does not match/);
 await assert.rejects(session.complete(callback(session,{iss:'https://evil.example'})),/provider/);
 await assert.rejects(session.complete(callback(session)+'&code=second'),/Invalid authorization/);
 now=600001;
 await assert.rejects(session.complete(callback(session)),/expired/);
});

test('cancelled and ambiguously exchanged sessions cannot be replayed',async()=>{
 const cancelled=new LoginSession();cancelled.cancel();
 await assert.rejects(cancelled.complete(callback(cancelled)),/expired/);
 let calls=0;
 const session=new LoginSession(async()=>{calls++;throw Error('connection lost');});
 await assert.rejects(session.complete(callback(session)),/Could not finish/);
 await assert.rejects(session.complete(callback(session)),/expired/);
 assert.equal(calls,1);
});

test('access-only response cannot replace a renewable session',async()=>{
 const session=new LoginSession(async()=>Response.json({access_token:'access',expires_in:43200}));
 await assert.rejects(session.complete(callback(session)),/did not grant automatic renewal/);
});

test('application authorization rejection is distinct from a user login failure',async()=>{
 const session=new LoginSession(async()=>Response.json({code:'401.122',description:'provider details'}, {status:401}));
 await assert.rejects(session.complete(callback(session)),e=>e.message.includes('401.122')&&!e.message.includes('provider details'));
});
