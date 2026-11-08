import {build} from 'esbuild';
import {spawn} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {bundleOptions,outdir,root,copySchema,typecheck} from './build.mjs';

await typecheck();
await copySchema();
const files=[];
for (const directory of ['hub-server/test','lib']) {
  for (const name of (await readdir(path.join(root,directory))).filter(name=>name.endsWith('.test.ts')).sort()) {
    files.push({source:`${directory}/${name}`,name:(directory==='lib'?'lib-':'')+name.replace(/\.ts$/, '')});
  }
}
// Optional exact filenames/paths make small changes testable without rebuilding the frontend.
const requested=process.argv.slice(2);
const selected=requested.length ? files.filter(file=>requested.some(name=>name===file.source || name===file.name || name===path.basename(file.source))) : files;
if (requested.some(name=>!selected.some(file=>name===file.source || name===file.name || name===path.basename(file.source)))) throw new Error('Unknown test filename');
await build({...bundleOptions,packages:'external',define:{'import.meta.env':JSON.stringify({MODE:'hub',VITE_DATA_API_BASE_URL:'/api',VITE_DATA_API_TOKEN:''})},entryPoints:Object.fromEntries(selected.map(file=>[file.name,path.join(root,file.source)])),outdir,outExtension:{'.js':'.mjs'}});
const child=spawn(process.execPath,['--test','--test-concurrency=1',...selected.map(file=>path.join(outdir,file.name+'.mjs'))],{cwd:root,stdio:'inherit'});
child.on('error',error=>{throw error;});
child.on('exit',code=>{process.exitCode=code || 0;});
