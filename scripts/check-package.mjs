import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {cwd, encoding:'utf8'});
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
};
const directory = await mkdtemp(join(tmpdir(),'myq-package-'));
try {
  const pkg = JSON.parse(await readFile('package.json','utf8'));
  const [packed] = JSON.parse(run('npm',['pack','--json','--ignore-scripts','--pack-destination',directory],process.cwd()));
  const paths = packed.files.map(file=>file.path);
  for(const required of ['dist/index.js','dist/auth.js','dist/enrollment-worker.js','dist/ui-server.js',
    'homebridge-ui/public/index.html','homebridge-ui/public/setup.js','homebridge-ui/server.js',
    'config.schema.json','LICENSE','assets/icon.svg']) assert.ok(paths.includes(required),`Missing ${required}`);
  for(const file of paths) assert.ok(/^(dist\/|homebridge-ui\/|assets\/|package\.json$|config\.schema\.json$|README\.md$|LICENSE$)/.test(file),`Unexpected published file: ${file}`);
  run('npm',['install','--prefix',directory,'--ignore-scripts','--omit=dev','--no-audit','--no-fund',join(directory,packed.filename)],process.cwd());
  const installed = resolve(directory,'node_modules',pkg.name);
  let registration;
  const plugin = await import(pathToFileURL(join(installed,pkg.main)).href);
  plugin.default({registerPlatform:(...args)=>{registration=args;}});
  assert.equal(registration[0],pkg.name);
  const schema = JSON.parse(await readFile(join(installed,'config.schema.json'),'utf8'));
  assert.equal(registration[1],schema.pluginAlias);
  assert.equal(typeof registration[2],'function');
  run(process.execPath,['--check',join(installed,'homebridge-ui/public/setup.js')],directory);
  console.log(`Package verified: ${pkg.name}@${pkg.version}; production-only install and platform registration passed.`);
} finally { await rm(directory,{recursive:true,force:true}); }
