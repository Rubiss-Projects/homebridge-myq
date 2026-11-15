// Development probe: stdout from the native helper contains a one-use callback and is never logged.
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LoginSession} from '../dist/login.js';
import {saveTokens} from '../dist/auth.js';

if (process.platform !== 'darwin' || !process.argv[2] || !isAbsolute(process.argv[2])) {
  console.error('Usage on macOS: npm run login:macos -- /absolute/private/token-file.json');
  process.exit(1);
}
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const temporary=await mkdtemp(join(tmpdir(),'homebridge-myq-login-'));
try {
  const contents=join(temporary,'MyQ Login.app','Contents');
  await mkdir(join(contents,'MacOS'),{recursive:true});
  await writeFile(join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>MyQLogin</string>
<key>CFBundleIdentifier</key><string>dev.homebridge.myq.login</string>
<key>CFBundleName</key><string>MyQ Login</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>`);
  const binary=join(contents,'MacOS','MyQLogin');
  await promisify(execFile)('xcrun',['swiftc',join(root,'login-helper/macos/main.swift'),'-o',binary,
    '-framework','Cocoa','-framework','AuthenticationServices']);
  const session=new LoginSession();
  const child=spawn(binary,[],{stdio:['pipe','pipe','pipe']});
  const completed=new Promise((resolve,reject)=>{
    let output='';
    child.stdout.on('data',chunk=>{
      output+=chunk;
      if(output.length>32768){child.kill();reject(new Error('Invalid helper response.'));}
    });
    child.stderr.resume();
    child.on('error',()=>reject(new Error('Could not start system sign-in.')));
    child.on('close',()=>{
      try { const result=JSON.parse(output); output='';
        if(typeof result.callback!=='string')throw Error();
        resolve(result.callback);
      } catch {reject(new Error('Sign-in was cancelled or could not complete.'));}
    });
  });
  child.stdin.end(JSON.stringify({authorizationURL:session.authorizationURL})+'\n');
  const timeout=setTimeout(()=>child.kill(),10*60_000);
  try {
    const tokens=await session.complete(await completed);
    await saveTokens(process.argv[2],tokens);
    console.log('Signed in; renewable credentials saved privately.');
  } finally {clearTimeout(timeout);}
} catch(error) {
  console.error(error instanceof Error && !('cmd' in error) ? error.message : 'Could not build the native login helper.');
  process.exitCode=1;
} finally {await rm(temporary,{recursive:true,force:true});}
