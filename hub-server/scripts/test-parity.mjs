import {build} from 'esbuild';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {bundleOptions,outdir,root,copySchema} from './build.mjs';

// Freeze the pre-phase-3 Worker from git in a disposable directory. No runtime
// legacy dependency remains; this opt-in harness makes parity reproducible.
const baseline='c39a8f5',directory=await mkdtemp(path.join(tmpdir(),'pahub-worker-parity-'));
try {
 const read=(file)=>execFileSync('git',['show',baseline+':'+file],{cwd:root,encoding:'utf8'});
 await writeFile(path.join(directory,'index.ts'),read('worker/src/index.ts'));
 await writeFile(path.join(directory,'admin.html'),read('worker/src/admin.html'));
 await writeFile(path.join(directory,'d1.ts'),read('hub-server/src/d1.ts'));
 await build({entryPoints:[path.join(directory,'index.ts'),path.join(directory,'d1.ts')],bundle:true,platform:'node',target:'node24',format:'esm',loader:{'.html':'text'},outdir:directory,outExtension:{'.js':'.mjs'}});
 await copySchema();
 const modules=process.argv.slice(2);const files=(modules.length?modules:['project','activity','system','admin']).map(name=>name+'-migration.test');
 await build({...bundleOptions,packages:'external',entryPoints:files.map(name=>path.join(root,'hub-server/test',name+'.ts')),outdir,outExtension:{'.js':'.mjs'}});
 const code=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--test','--test-concurrency=1',...files.map(name=>path.join(outdir,name+'.mjs'))],{cwd:root,stdio:'inherit',env:{...process.env,PAHUB_WORKER_BASELINE:path.join(directory,'index.mjs')}});
  child.on('error',reject);child.on('exit',resolve);
 });
 process.exitCode=code || 0;
}finally {await rm(directory,{recursive:true,force:true});}
